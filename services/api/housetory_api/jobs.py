"""PostgreSQL-backed job queue primitives.

The API and worker share these functions so queue semantics live in one place.
Workers claim rows with ``FOR UPDATE SKIP LOCKED``; multiple worker processes
can therefore share a single PostgreSQL instance safely.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import String, case, cast, func, or_, select, update
from sqlalchemy.orm import Session

from .domain import JobStatus
from .models import Document, ImportBatch, Job, WorkerHeartbeat

AI_TASKS = frozenset(
    {
        "ai.enrich",
        "ai.recognize",
        "voice.transcribe",
        "voice.interpret",
        "inventory.review.scheduled",
        "insurance.estimate",
        "insurance.list",
        "item_images.new_item",
        "item_images.batch",
    }
)
DOCUMENT_LOCAL_QUEUE = "documents"
DOCUMENT_AI_QUEUE = "ai-documents"


def enqueue(
    db: Session,
    task: str,
    payload: dict[str, Any] | None = None,
    *,
    run_at: datetime | None = None,
    priority: int = 0,
    max_attempts: int = 5,
    queue: str | None = None,
    commit: bool = True,
) -> Job:
    job = Job(
        queue=queue or ("ai" if task in AI_TASKS else "default"),
        task=task,
        payload=payload or {},
        status=JobStatus.QUEUED.value,
        priority=priority,
        run_at=run_at or datetime.now(UTC),
        max_attempts=max_attempts,
    )
    db.add(job)
    if commit:
        db.commit()
    else:
        db.flush()
    return job


def route_legacy_ai_jobs(db: Session) -> None:
    db.execute(
        update(Job)
        .where(
            Job.queue == "default",
            or_(
                (
                    Job.task.in_(AI_TASKS)
                    & Job.payload["ai_enabled"].astext.is_distinct_from("false")
                ),
                (
                    (Job.task == "imports.process")
                    & Job.payload["batch_id"].astext.in_(
                        select(cast(ImportBatch.id, String)).where(
                            ImportBatch.metadata_json["product_url"].astext.is_not(None),
                        )
                    )
                ),
            ),
            Job.status == JobStatus.QUEUED.value,
        )
        .values(
            queue=case(
                (
                    (Job.task == "ai.enrich")
                    & (Job.payload["kind"].astext == "document")
                    & Job.payload["mode"].astext.is_distinct_from("background"),
                    DOCUMENT_AI_QUEUE,
                ),
                else_="ai",
            )
        )
    )
    from .services.document_processing import initialize_processing

    legacy_documents = db.scalars(
        select(Job)
        .where(
            Job.queue == "default",
            Job.task == "documents.ocr",
            Job.status == JobStatus.QUEUED.value,
        )
        .with_for_update(skip_locked=True)
    ).all()
    for job in legacy_documents:
        payload = dict(job.payload or {})
        try:
            document_id = uuid.UUID(str(payload["document_id"]))
        except (KeyError, ValueError):
            continue
        document = db.get(Document, document_id)
        if document is None:
            job.queue = DOCUMENT_LOCAL_QUEUE
            continue
        state = (document.extracted_metadata or {}).get("processing") or {}
        if not state or not state.get("correlation_id"):
            state = initialize_processing(document, page_count=1)
        job.queue = state.get("local_queue", DOCUMENT_LOCAL_QUEUE)
        job.payload = {
            **payload,
            "job_id": str(job.id),
            "household_id": str(document.household_id),
            "actor_user_id": payload.get("actor_user_id"),
            "correlation_id": state["correlation_id"],
            "deadline_at": state.get("deadline_at"),
            "mode": state.get("mode", "interactive"),
        }
        if state.get("mode") != "background":
            job.max_attempts = 1

    queued_ai_documents = db.scalars(
        select(Job)
        .where(
            Job.queue.in_(["ai", DOCUMENT_AI_QUEUE]),
            Job.task == "ai.enrich",
            Job.payload["kind"].astext == "document",
            Job.status == JobStatus.QUEUED.value,
        )
        .with_for_update(skip_locked=True)
    ).all()
    for job in queued_ai_documents:
        payload = dict(job.payload or {})
        if payload.get("correlation_id") and payload.get("mode") in {"interactive", "background"}:
            job.queue = "ai" if payload.get("mode") == "background" else DOCUMENT_AI_QUEUE
            continue
        try:
            document_id = uuid.UUID(str(payload["source_id"]))
        except (KeyError, ValueError):
            continue
        document = db.get(Document, document_id)
        if document is None:
            continue
        state = (document.extracted_metadata or {}).get("processing") or {}
        if not state or not state.get("correlation_id"):
            state = initialize_processing(document, page_count=1)
        if state.get("stage") in {"waiting", "reading"} and (
            not payload.get("correlation_id")
            or payload["correlation_id"] == state["correlation_id"]
        ):
            state.update(
                stage="interpreting",
                updated_at=datetime.now(UTC).isoformat(),
            )
            metadata = dict(document.extracted_metadata or {})
            metadata["processing"] = state
            document.extracted_metadata = metadata
        job.payload = {
            **payload,
            "household_id": str(document.household_id),
            "actor_user_id": payload.get("actor_user_id"),
            "correlation_id": payload.get("correlation_id") or state["correlation_id"],
            "deadline_at": payload.get("deadline_at") or state.get("deadline_at"),
            "mode": payload.get("mode") or state.get("mode", "interactive"),
            "source_generation": payload.get("source_generation", document.source_generation),
        }
        job.queue = "ai" if job.payload["mode"] == "background" else DOCUMENT_AI_QUEUE
        if job.payload["mode"] != "background":
            job.max_attempts = 1
    db.commit()


def claim_job(db: Session, *, worker_id: str, queue: str = "default") -> Job | None:
    """Claim the highest-priority runnable job, skipping rows locked by peers."""
    now = datetime.now(UTC)
    fair_queue = queue in {DOCUMENT_LOCAL_QUEUE, DOCUMENT_AI_QUEUE, "ai"}
    job = db.scalar(
        select(Job)
        .where(
            Job.queue == queue,
            Job.status == JobStatus.QUEUED.value,
            Job.run_at <= now,
        )
        .order_by(
            Job.priority.desc(),
            *([Job.payload["last_served_at"].astext.asc().nulls_first()] if fair_queue else []),
            Job.run_at.asc(),
            Job.created_at.asc(),
        )
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if job is None:
        db.rollback()
        return None
    job.status = JobStatus.RUNNING.value
    job.attempts += 1
    job.locked_by = worker_id
    job.locked_at = now
    if fair_queue:
        actor_key = (
            (job.payload or {}).get("actor_user_id")
            or (job.payload or {}).get("household_id")
            or "__unattributed__"
        )
        queued_jobs = db.scalars(
            select(Job).where(
                Job.queue == queue,
                Job.status == JobStatus.QUEUED.value,
                func.coalesce(
                    Job.payload["actor_user_id"].astext,
                    Job.payload["household_id"].astext,
                    "__unattributed__",
                )
                == actor_key,
            )
        ).all()
        served_at = now.isoformat()
        job.payload = {**(job.payload or {}), "last_served_at": served_at}
        for queued in queued_jobs:
            queued.payload = {**(queued.payload or {}), "last_served_at": served_at}
    db.commit()
    return job


def mark_succeeded(
    db: Session,
    job_id: uuid.UUID,
    *,
    result: dict[str, Any] | None = None,
) -> None:
    job = db.get(Job, job_id)
    if job is None or job.status == JobStatus.CANCELLED.value:
        return
    now = datetime.now(UTC)
    if result is not None:
        job.result = result
    job.status = JobStatus.SUCCEEDED.value
    job.finished_at = now
    job.locked_by = None
    job.locked_at = None
    job.last_error = None
    db.commit()


def mark_failed(db: Session, job_id: uuid.UUID, error: str) -> None:
    job = db.get(Job, job_id)
    if job is None or job.status == JobStatus.CANCELLED.value:
        return
    now = datetime.now(UTC)
    job.last_error = error[:4000]
    job.locked_by = None
    job.locked_at = None
    interactive_document = (
        job.queue in {DOCUMENT_LOCAL_QUEUE, DOCUMENT_AI_QUEUE}
        and (job.payload or {}).get("mode") != "background"
    )
    if job.attempts < job.max_attempts and not interactive_document:
        job.status = JobStatus.QUEUED.value
        job.finished_at = None
        delay_seconds = min(2**job.attempts, 300)
        job.run_at = now + timedelta(seconds=delay_seconds)
    else:
        job.status = JobStatus.FAILED.value
        job.finished_at = now
    db.commit()


def requeue_stale_jobs(db: Session, *, older_than_minutes: int = 15) -> int:
    """Recover jobs left running after a worker crash."""
    cutoff = datetime.now(UTC) - timedelta(minutes=older_than_minutes)
    jobs = db.scalars(
        select(Job).where(
            Job.status == JobStatus.RUNNING.value,
            Job.locked_at.is_not(None),
            Job.locked_at < cutoff,
            ~select(WorkerHeartbeat.worker_id)
            .where(
                WorkerHeartbeat.worker_id == Job.locked_by,
                WorkerHeartbeat.updated_at > datetime.now(UTC) - timedelta(minutes=2),
            )
            .exists(),
        )
    ).all()
    for job in jobs:
        job.locked_by = None
        job.locked_at = None
        interactive_document = (
            job.queue in {DOCUMENT_LOCAL_QUEUE, DOCUMENT_AI_QUEUE}
            and (job.payload or {}).get("mode") != "background"
        )
        if job.attempts < job.max_attempts and not interactive_document:
            job.status = JobStatus.QUEUED.value
            job.last_error = "Worker did not finish this job; it was requeued."
        else:
            job.status = JobStatus.FAILED.value
            job.finished_at = datetime.now(UTC)
            job.last_error = "Worker did not finish this job and attempts were exhausted."
            if interactive_document:
                from .services.document_processing import fail_processing_for_job

                fail_processing_for_job(
                    db,
                    job,
                    reason="worker_interrupted",
                )
    db.commit()
    return len(jobs)


def update_result(db: Session, job_id: uuid.UUID, result: dict[str, Any]) -> None:
    job = db.get(Job, job_id)
    if job is None:
        return
    job.result = {**(job.result or {}), **result}
    db.commit()


def is_cancelled(db: Session, job_id: uuid.UUID) -> bool:
    status = db.scalar(select(Job.status).where(Job.id == job_id))
    return status == JobStatus.CANCELLED.value


def has_active_job(db: Session, task: str) -> bool:
    return (
        db.scalar(
            select(Job.id)
            .where(
                Job.task == task,
                Job.status.in_([JobStatus.QUEUED.value, JobStatus.RUNNING.value]),
            )
            .limit(1)
        )
        is not None
    )
