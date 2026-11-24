"""Housetory background worker.

Runs durable maintenance jobs from PostgreSQL. The worker has no HTTP port and
is intentionally able to run on CPU-only hosts.
"""

import contextlib
import json
import logging
import multiprocessing
import os
import signal
import socket
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from housetory_api import __version__
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.domain import JobStatus
from housetory_api.jobs import (
    DOCUMENT_AI_QUEUE,
    DOCUMENT_LOCAL_QUEUE,
    claim_job,
    enqueue,
    has_active_job,
    mark_failed,
    mark_succeeded,
    requeue_stale_jobs,
    route_legacy_ai_jobs,
)
from housetory_api.models import AuthSession, Job, WorkerHeartbeat
from housetory_api.services.assistant_tools import TASK as ASSISTANT_TASK
from housetory_api.services.assistant_tools import run_job as run_assistant
from housetory_api.services.assistant_tools.review_jobs import (
    TASK as ASSISTANT_REVIEW_TASK,
)
from housetory_api.services.assistant_tools.review_jobs import (
    run_job as run_assistant_review,
)
from housetory_api.services.document_ocr import OCR_TASK
from housetory_api.services.document_ocr import run_job as run_document_ocr
from housetory_api.services.document_pages import (
    MAP_TASK as DOCUMENT_MAP_TASK,
)
from housetory_api.services.document_pages import (
    READ_TASK as DOCUMENT_READ_TASK,
)
from housetory_api.services.document_pages import (
    run_map_job as run_document_map,
)
from housetory_api.services.document_pages import (
    run_read_job as run_document_read,
)
from housetory_api.services.enrichment import TASK as ENRICHMENT_TASK
from housetory_api.services.enrichment import run_enhancement
from housetory_api.services.evidence_export import (
    EVIDENCE_EXPORT_TASK,
    EVIDENCE_PRUNE_TASK,
    prune_expired_exports,
    run_evidence_export,
)
from housetory_api.services.import_pipeline import (
    IMPORT_TASK,
    run_import_job,
)
from housetory_api.services.insurance import (
    ESTIMATE_TASK as INSURANCE_ESTIMATE_TASK,
)
from housetory_api.services.insurance import (
    LIST_TASK as INSURANCE_LIST_TASK,
)
from housetory_api.services.insurance import (
    process_estimate as run_insurance_estimate,
)
from housetory_api.services.insurance import (
    process_list as run_insurance_list,
)
from housetory_api.services.inventory_review_schedule import (
    SCHEDULED_REVIEW_TASK,
    dispatch_due_reviews,
    run_scheduled_review_job,
)
from housetory_api.services.item_image_generation import (
    BATCH_TASK as ITEM_IMAGE_BATCH_TASK,
)
from housetory_api.services.item_image_generation import (
    NEW_ITEM_TASK as ITEM_IMAGE_NEW_ITEM_TASK,
)
from housetory_api.services.item_image_generation import (
    run_batch_job as run_item_image_batch,
)
from housetory_api.services.item_image_generation import (
    run_new_item_job as run_item_image_new_item,
)
from housetory_api.services.recognition import (
    RECOGNITION_TASK,
)
from housetory_api.services.recognition import (
    run_job as run_recognition_job,
)
from housetory_api.services.voice import (
    TRANSCRIBE_TASK as VOICE_TRANSCRIBE_TASK,
)
from housetory_api.services.voice import (
    process_transcription as run_voice_transcription,
)
from sqlalchemy import delete, func, select

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("housetory.worker")

PRUNE_TASK = "maintenance.prune_expired_sessions"
PRUNE_FINISHED_TASK = "maintenance.prune_finished_jobs"
PRUNE_ITEM_IMAGES_TASK = "maintenance.prune_item_images"
# Voice interpretation was removed; jobs queued before that finish without doing anything.
RETIRED_VOICE_INTERPRET_TASK = "voice.interpret"
HEARTBEAT_FILE = Path(
    os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat")
)
POLL_SECONDS = float(os.environ.get("WORKER_POLL_SECONDS", "2"))
MAINTENANCE_INTERVAL_HOURS = 6


def _heartbeat() -> None:
    HEARTBEAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_FILE.write_text(
        json.dumps({"pid": os.getpid(), "time": time.time()}), encoding="utf-8"
    )


def _record_worker_heartbeat(worker_id: str) -> None:
    """Persist worker liveness for the owner-facing system status screen."""
    with SessionLocal() as db:
        row = db.get(WorkerHeartbeat, worker_id)
        if row is None:
            row = WorkerHeartbeat(worker_id=worker_id, version=__version__)
            db.add(row)
        else:
            row.version = __version__
            row.updated_at = datetime.now(UTC)
        db.commit()


def _queue_heartbeat_file(queue: str) -> Path:
    if queue == "default":
        return Path(
            os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat")
        )
    base = Path(
        os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat")
    )
    return base.with_name(f"{base.name}-{queue}")


def _interrupt_on_termination(_signum, _frame) -> None:
    raise KeyboardInterrupt


def _stop_process(child, *, timeout: float = 10) -> None:
    if child.is_alive():
        with contextlib.suppress(ProcessLookupError):
            child.terminate()
        child.join(timeout=timeout)
        if child.is_alive():
            with contextlib.suppress(ProcessLookupError):
                child.kill()
            child.join(timeout=2)


def _run_document_child(target, args) -> None:
    if os.name == "posix":
        os.setsid()
    target(*args)


def _stop_document_process(child) -> None:
    pid = child.pid
    if os.name == "posix" and pid is not None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGTERM)
    _stop_process(child, timeout=2)
    if os.name == "posix" and pid is not None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGKILL)


def _fail_document_job(job: Job, error: str, *, reason: str, terminal: bool = False) -> None:
    """Fail this attempt and, only if the job ends as failed, its document.

    Both changes commit in one transaction under the claim's row lock, so a
    supervisor whose job was recovered and reclaimed changes neither.
    """
    from housetory_api.services.document_processing import fail_processing_for_job

    with SessionLocal() as db:
        mark_failed(
            db,
            job.id,
            error,
            claim=job,
            terminal=terminal,
            on_terminal=lambda session, current: fail_processing_for_job(
                session, current, reason=reason
            ),
        )


def _fail_interrupted_job(job: Job) -> None:
    _fail_document_job(
        job, "interactive_worker_interrupted", reason="worker_interrupted", terminal=True
    )


def _fail_document_of_failed_attempt(job: Job) -> None:
    """The handler recorded this attempt as failed; fail its document to match."""
    from housetory_api.services.document_processing import fail_processing_for_job

    with SessionLocal() as db:
        current = db.scalar(
            select(Job)
            .where(
                Job.id == job.id,
                Job.status == JobStatus.FAILED.value,
                Job.attempts == job.attempts,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if current is None:
            db.rollback()
            return
        fail_processing_for_job(db, current, reason="worker_interrupted")
        db.commit()


def process_interactive_job(
    job: Job,
    *,
    process_context=None,
    process_target=None,
    process_args=None,
) -> None:
    """Run document work in a killable child, bounded by its persisted deadline."""
    from housetory_api.services.document_processing import INTERACTIVE_DEADLINE_SECONDS

    deadline_value = (job.payload or {}).get("deadline_at")
    if deadline_value:
        try:
            deadline = datetime.fromisoformat(deadline_value)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=UTC)
            timeout = max(0.0, (deadline - datetime.now(UTC)).total_seconds())
        except (TypeError, ValueError):
            timeout = 0.0
    else:
        timeout = 15 * 60 if (job.payload or {}).get("mode") == "background" else 0
    if (job.payload or {}).get("mode") != "background":
        timeout = min(timeout, INTERACTIVE_DEADLINE_SECONDS)
    if timeout <= 0:
        _fail_document_job(job, "interactive_deadline_exceeded", reason="deadline_exceeded")
        return

    expires_at = time.monotonic() + timeout
    context = process_context or multiprocessing.get_context("spawn")
    child = None
    try:
        child = context.Process(
            target=_run_document_child,
            args=(
                process_target or process_job,
                tuple(process_args) if process_args is not None else (job,),
            ),
            daemon=True,
        )
        child.start()
    except Exception:
        logger.exception("Could not start supervised document job %s", job.id)
        if child is not None:
            _stop_document_process(child)
        _fail_interrupted_job(job)
        return
    try:
        while child.is_alive():
            child.join(timeout=min(0.5, max(0.0, expires_at - time.monotonic())))
            if time.monotonic() >= expires_at and child.is_alive():
                _stop_document_process(child)
                _fail_document_job(
                    job, "interactive_deadline_exceeded", reason="deadline_exceeded"
                )
                return
            with SessionLocal() as db:
                current = db.get(Job, job.id)
                if current is None or current.status == JobStatus.CANCELLED.value:
                    _stop_document_process(child)
                    return
        if child.exitcode not in {0, None}:
            _fail_interrupted_job(job)
        else:
            # Each helper acts only on this attempt: one if the handler already
            # recorded its failure, the other if it exited without recording anything.
            _fail_document_of_failed_attempt(job)
            with SessionLocal() as db:
                still_running = db.scalar(select(Job.status).where(Job.id == job.id)) == (
                    JobStatus.RUNNING.value
                )
            if still_running:
                _fail_interrupted_job(job)
    except KeyboardInterrupt:
        _stop_document_process(child)
        _fail_interrupted_job(job)
        raise
    finally:
        _stop_document_process(child)


def prune_expired_sessions(payload: dict) -> dict:
    del payload
    with SessionLocal() as db:
        result = db.execute(
            delete(AuthSession).where(AuthSession.expires_at < func.now())
        )
        db.commit()
        return {"deleted": int(result.rowcount or 0)}


def prune_finished_jobs(payload: dict) -> dict:
    del payload
    interval_days = 30
    with SessionLocal() as db:
        result = db.execute(
            delete(Job).where(
                Job.status.in_([JobStatus.SUCCEEDED.value, JobStatus.FAILED.value]),
                Job.finished_at.is_not(None),
                Job.finished_at
                < func.now() - func.make_interval(0, 0, 0, interval_days),
            )
        )
        db.commit()
        return {"deleted": int(result.rowcount or 0)}


def ping(payload: dict) -> dict:
    return {"pong": True, "echo": payload}


HANDLERS = {
    ASSISTANT_TASK: run_assistant,
    ASSISTANT_REVIEW_TASK: run_assistant_review,
    ENRICHMENT_TASK: run_enhancement,
    PRUNE_TASK: prune_expired_sessions,
    PRUNE_FINISHED_TASK: prune_finished_jobs,
    EVIDENCE_PRUNE_TASK: lambda payload: {"expired": prune_expired_exports()},
    EVIDENCE_EXPORT_TASK: run_evidence_export,
    INSURANCE_ESTIMATE_TASK: run_insurance_estimate,
    INSURANCE_LIST_TASK: run_insurance_list,
    "maintenance.ping": ping,
    OCR_TASK: run_document_ocr,
    DOCUMENT_READ_TASK: run_document_read,
    DOCUMENT_MAP_TASK: run_document_map,
    IMPORT_TASK: run_import_job,
    RECOGNITION_TASK: run_recognition_job,
    VOICE_TRANSCRIBE_TASK: lambda payload: run_voice_transcription(
        payload.get("voice_note_id")
    ),
    RETIRED_VOICE_INTERPRET_TASK: lambda payload: {
        "status": "retired",
        "message": "Voice interpretation was retired; the transcript is preserved.",
    },
    ITEM_IMAGE_NEW_ITEM_TASK: run_item_image_new_item,
    ITEM_IMAGE_BATCH_TASK: lambda payload: run_item_image_batch(
        payload, uuid.UUID(str(payload["job_id"]))
    ),
    PRUNE_ITEM_IMAGES_TASK: lambda payload: {
        "status": "retired",
        "deleted": 0,
        "message": "Pending-illustration pruning was retired; existing media is preserved.",
    },
    SCHEDULED_REVIEW_TASK: run_scheduled_review_job,
}


def process_job(job: Job) -> None:
    handler = HANDLERS.get(job.task)
    if handler is None:
        with SessionLocal() as db:
            mark_failed(
                db, job.id, f"No handler registered for task {job.task!r}.", claim=job
            )
        logger.error("No handler for job %s (%s)", job.id, job.task)
        return

    logger.info("Running job %s (%s), attempt %s", job.id, job.task, job.attempts)
    try:
        result = handler(job.payload or {})
    except Exception as exc:
        logger.exception("Job %s failed", job.id)
        with SessionLocal() as db:
            mark_failed(db, job.id, f"{type(exc).__name__}: {exc}", claim=job)
        return

    with SessionLocal() as db:
        mark_succeeded(
            db,
            job.id,
            result=result if isinstance(result, dict) else {"result": result},
            claim=job,
        )
    logger.info("Job %s succeeded: status recorded", job.id)


def schedule_maintenance() -> None:
    now = time.time()
    with SessionLocal() as db:
        if has_active_job(db, PRUNE_TASK):
            return
        last = db.scalar(
            select(Job)
            .where(Job.task == PRUNE_TASK)
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        if last is not None:
            reference = last.finished_at or last.created_at
            if reference is not None and now - reference.timestamp() < (
                MAINTENANCE_INTERVAL_HOURS * 3600
            ):
                return
        enqueue(db, PRUNE_TASK)
        logger.info("Scheduled %s", PRUNE_TASK)

        if (
            db.scalar(
                select(func.count(Job.id)).where(
                    Job.task == PRUNE_FINISHED_TASK,
                    Job.status.in_([JobStatus.QUEUED.value, JobStatus.RUNNING.value]),
                )
            )
            == 0
        ):
            enqueue(db, PRUNE_FINISHED_TASK)

        if not has_active_job(db, EVIDENCE_PRUNE_TASK):
            enqueue(db, EVIDENCE_PRUNE_TASK)


def dispatch_scheduled_reviews() -> None:
    with SessionLocal() as db:
        count = dispatch_due_reviews(db)
    if count:
        logger.info("Dispatched %s scheduled inventory review(s)", count)


def _keep_heartbeat(worker_id: str) -> None:
    while True:
        try:
            _heartbeat()
            _record_worker_heartbeat(worker_id)
        except Exception:
            logger.exception("Worker heartbeat could not be updated")
        time.sleep(15)


def _run_queue(queue: str, peer=None) -> None:
    global HEARTBEAT_FILE
    HEARTBEAT_FILE = _queue_heartbeat_file(queue)
    previous_handler = signal.signal(signal.SIGTERM, _interrupt_on_termination)
    lane_peer = None
    lane_queue = (
        DOCUMENT_LOCAL_QUEUE
        if queue == "default"
        else DOCUMENT_AI_QUEUE
        if queue == "ai"
        else None
    )
    try:
        if lane_queue is not None:
            lane_peer = multiprocessing.get_context("spawn").Process(
                target=_run_queue,
                args=(lane_queue,),
            )
            lane_peer.start()
        _serve_queue(queue, peer=peer, lane_peer=lane_peer, lane_queue=lane_queue)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if lane_peer is not None:
            _stop_process(lane_peer)
        signal.signal(signal.SIGTERM, previous_handler)


def _serve_queue(queue: str, *, peer, lane_peer, lane_queue: str | None) -> None:
    settings = get_settings()
    logger.info(
        "Housetory worker starting (environment=%s, heartbeat=%s, queue=%s)",
        settings.environment,
        HEARTBEAT_FILE,
        queue,
    )
    worker_id = f"{socket.gethostname()}:{queue}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
    with SessionLocal() as db:
        route_legacy_ai_jobs(db)
        requeued = requeue_stale_jobs(db)
        if requeued:
            logger.warning("Requeued %s stale job(s)", requeued)
    if queue == "default":
        schedule_maintenance()
        dispatch_scheduled_reviews()
    _heartbeat()
    _record_worker_heartbeat(worker_id)
    threading.Thread(target=_keep_heartbeat, args=(worker_id,), daemon=True).start()

    last_maintenance_check = time.monotonic()
    last_legacy_routing_check = time.monotonic()
    last_db_heartbeat = time.monotonic()
    while True:
        if peer is not None and not peer.is_alive():
            raise RuntimeError("The AI worker exited; restart both execution lanes.")
        if lane_peer is not None and not lane_peer.is_alive():
            raise RuntimeError(f"The reserved {lane_queue} worker exited.")
        try:
            job = None
            with SessionLocal() as db:
                job = claim_job(db, worker_id=worker_id, queue=queue)
            if job is not None:
                if (
                    queue in {DOCUMENT_LOCAL_QUEUE, DOCUMENT_AI_QUEUE}
                    or job.task == ASSISTANT_TASK
                    or (job.task == ASSISTANT_REVIEW_TASK and queue == "ai")
                    or (
                        job.task == OCR_TASK
                        and (job.payload or {}).get("mode") == "background"
                    )
                    or (
                        job.task == ENRICHMENT_TASK
                        and (job.payload or {}).get("kind") == "document"
                    )
                ):
                    process_interactive_job(job)
                else:
                    process_job(job)
            else:
                time.sleep(POLL_SECONDS)
            if queue == "default" and time.monotonic() - last_maintenance_check > 60:
                schedule_maintenance()
                dispatch_scheduled_reviews()
                last_maintenance_check = time.monotonic()
            if queue == "default" and time.monotonic() - last_legacy_routing_check > 60:
                with SessionLocal() as db:
                    route_legacy_ai_jobs(db)
                    requeue_stale_jobs(db)
                last_legacy_routing_check = time.monotonic()
            if time.monotonic() - last_db_heartbeat > 15:
                _record_worker_heartbeat(worker_id)
                last_db_heartbeat = time.monotonic()
            _heartbeat()
        except KeyboardInterrupt:
            logger.info("Worker interrupted, shutting down")
            break
        except Exception:
            logger.exception("Worker loop error")
            time.sleep(min(POLL_SECONDS * 2, 30))


def _run_ai_child() -> None:
    _run_queue("ai")


def run() -> None:
    previous_handler = signal.signal(signal.SIGTERM, _interrupt_on_termination)
    child = None
    try:
        queue = get_settings().worker_queue
        if queue != "all":
            _run_queue(queue)
            return
        child = multiprocessing.get_context("spawn").Process(target=_run_ai_child)
        child.start()
        _run_queue("default", peer=child)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if child is not None:
            _stop_process(child)
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    run()
