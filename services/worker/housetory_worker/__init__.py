"""Housetory background worker.

Runs durable maintenance jobs from PostgreSQL. The worker has no HTTP port and
is intentionally able to run on CPU-only hosts.
"""

import json
import logging
import os
import socket
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, func, select

from housetory_api import __version__
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.domain import JobStatus
from housetory_api.jobs import (
    claim_job,
    enqueue,
    has_active_job,
    mark_failed,
    mark_succeeded,
    requeue_stale_jobs,
)
from housetory_api.models import AuthSession, Job, WorkerHeartbeat
from housetory_api.services.document_ocr import OCR_TASK
from housetory_api.services.document_ocr import run_job as run_document_ocr
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
    INTERPRET_TASK as VOICE_INTERPRET_TASK,
)
from housetory_api.services.voice import (
    TRANSCRIBE_TASK as VOICE_TRANSCRIBE_TASK,
)
from housetory_api.services.voice import (
    process_interpretation as run_voice_interpretation,
)
from housetory_api.services.voice import (
    process_transcription as run_voice_transcription,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("housetory.worker")

PRUNE_TASK = "maintenance.prune_expired_sessions"
PRUNE_FINISHED_TASK = "maintenance.prune_finished_jobs"
PRUNE_ITEM_IMAGES_TASK = "maintenance.prune_item_images"
HEARTBEAT_FILE = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat"))
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


def prune_expired_sessions(payload: dict) -> dict:
    del payload
    with SessionLocal() as db:
        result = db.execute(delete(AuthSession).where(AuthSession.expires_at < func.now()))
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
                Job.finished_at < func.now() - func.make_interval(0, 0, 0, interval_days),
            )
        )
        db.commit()
        return {"deleted": int(result.rowcount or 0)}


def ping(payload: dict) -> dict:
    return {"pong": True, "echo": payload}


HANDLERS = {
    PRUNE_TASK: prune_expired_sessions,
    PRUNE_FINISHED_TASK: prune_finished_jobs,
    EVIDENCE_PRUNE_TASK: lambda payload: {"expired": prune_expired_exports()},
    EVIDENCE_EXPORT_TASK: run_evidence_export,
    "maintenance.ping": ping,
    OCR_TASK: run_document_ocr,
    IMPORT_TASK: run_import_job,
    RECOGNITION_TASK: run_recognition_job,
    VOICE_TRANSCRIBE_TASK: lambda payload: run_voice_transcription(payload.get("voice_note_id")),
    VOICE_INTERPRET_TASK: lambda payload: run_voice_interpretation(payload.get("voice_note_id")),
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
            mark_failed(db, job.id, f"No handler registered for task {job.task!r}.")
        logger.error("No handler for job %s (%s)", job.id, job.task)
        return

    logger.info("Running job %s (%s), attempt %s", job.id, job.task, job.attempts)
    try:
        result = handler(job.payload or {})
    except Exception as exc:
        logger.exception("Job %s failed", job.id)
        with SessionLocal() as db:
            mark_failed(db, job.id, f"{type(exc).__name__}: {exc}")
        return

    with SessionLocal() as db:
        mark_succeeded(
            db,
            job.id,
            result=result if isinstance(result, dict) else {"result": result},
        )
    logger.info("Job %s succeeded: status recorded", job.id)


def schedule_maintenance() -> None:
    now = time.time()
    with SessionLocal() as db:
        if has_active_job(db, PRUNE_TASK):
            return
        last = db.scalar(
            select(Job).where(Job.task == PRUNE_TASK).order_by(Job.created_at.desc()).limit(1)
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


def run() -> None:
    settings = get_settings()
    logger.info(
        "Housetory worker starting (environment=%s, heartbeat=%s)",
        settings.environment,
        HEARTBEAT_FILE,
    )
    worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
    with SessionLocal() as db:
        requeued = requeue_stale_jobs(db)
        if requeued:
            logger.warning("Requeued %s stale job(s)", requeued)
    schedule_maintenance()
    dispatch_scheduled_reviews()
    _heartbeat()
    _record_worker_heartbeat(worker_id)

    last_maintenance_check = time.monotonic()
    last_db_heartbeat = time.monotonic()
    while True:
        try:
            job = None
            with SessionLocal() as db:
                job = claim_job(db, worker_id=worker_id)
            if job is not None:
                process_job(job)
            else:
                time.sleep(POLL_SECONDS)
            if time.monotonic() - last_maintenance_check > 60:
                schedule_maintenance()
                dispatch_scheduled_reviews()
                last_maintenance_check = time.monotonic()
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


if __name__ == "__main__":
    run()
