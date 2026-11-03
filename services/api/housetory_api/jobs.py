"""PostgreSQL-backed job queue primitives.

The API and worker share these functions so queue semantics live in one place.
Workers claim rows with ``FOR UPDATE SKIP LOCKED``; multiple worker processes
can therefore share a single PostgreSQL instance safely.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .domain import JobStatus
from .models import Job


def enqueue(
    db: Session,
    task: str,
    payload: dict[str, Any] | None = None,
    *,
    run_at: datetime | None = None,
    priority: int = 0,
    max_attempts: int = 5,
    queue: str = "default",
    commit: bool = True,
) -> Job:
    job = Job(
        queue=queue,
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


def claim_job(db: Session, *, worker_id: str, queue: str = "default") -> Job | None:
    """Claim the highest-priority runnable job, skipping rows locked by peers."""
    now = datetime.now(UTC)
    job = db.scalar(
        select(Job)
        .where(
            Job.queue == queue,
            Job.status == JobStatus.QUEUED.value,
            Job.run_at <= now,
        )
        .order_by(Job.priority.desc(), Job.run_at.asc(), Job.created_at.asc())
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
    db.commit()
    return job


def mark_succeeded(db: Session, job_id: uuid.UUID) -> None:
    job = db.get(Job, job_id)
    if job is None:
        return
    now = datetime.now(UTC)
    job.status = JobStatus.SUCCEEDED.value
    job.finished_at = now
    job.locked_by = None
    job.locked_at = None
    job.last_error = None
    db.commit()


def mark_failed(db: Session, job_id: uuid.UUID, error: str) -> None:
    job = db.get(Job, job_id)
    if job is None:
        return
    now = datetime.now(UTC)
    job.last_error = error[:4000]
    job.locked_by = None
    job.locked_at = None
    if job.attempts < job.max_attempts:
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
        )
    ).all()
    for job in jobs:
        job.locked_by = None
        job.locked_at = None
        if job.attempts < job.max_attempts:
            job.status = JobStatus.QUEUED.value
            job.last_error = "Worker did not finish this job; it was requeued."
        else:
            job.status = JobStatus.FAILED.value
            job.finished_at = datetime.now(UTC)
            job.last_error = "Worker did not finish this job and attempts were exhausted."
    db.commit()
    return len(jobs)


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
