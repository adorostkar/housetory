"""Queue mechanics tests."""

from datetime import UTC, datetime, timedelta

from housetory_api.db import SessionLocal
from housetory_api.domain import JobStatus
from housetory_api.jobs import (
    claim_job,
    enqueue,
    has_active_job,
    mark_failed,
    mark_succeeded,
    requeue_stale_jobs,
    route_legacy_ai_jobs,
)
from housetory_api.models import Job, WorkerHeartbeat


def test_enqueue_claim_and_succeed():
    with SessionLocal() as db:
        job = enqueue(db, "maintenance.ping", {"hello": "world"})
        assert job.status == JobStatus.QUEUED.value
        assert has_active_job(db, "maintenance.ping")

    with SessionLocal() as db:
        claimed = claim_job(db, worker_id="worker-a")
        assert claimed is not None
        assert claimed.id == job.id
        assert claimed.status == JobStatus.RUNNING.value
        assert claimed.attempts == 1
        assert claimed.locked_by == "worker-a"

    with SessionLocal() as db:
        assert claim_job(db, worker_id="worker-b") is None
        mark_succeeded(db, job.id)

    with SessionLocal() as db:
        saved = db.get(Job, job.id)
        assert saved.status == JobStatus.SUCCEEDED.value
        assert saved.finished_at is not None
        assert saved.locked_by is None
        assert not has_active_job(db, "maintenance.ping")


def test_failed_job_is_retried_then_marked_failed():
    with SessionLocal() as db:
        job = enqueue(db, "maintenance.ping", max_attempts=2)
        claimed = claim_job(db, worker_id="worker-a")
        assert claimed is not None
        mark_failed(db, claimed.id, "first failure")

    with SessionLocal() as db:
        retried = db.get(Job, job.id)
        assert retried.status == JobStatus.QUEUED.value
        assert retried.attempts == 1
        assert retried.last_error == "first failure"
        assert retried.run_at > datetime.now(UTC)
        # A backoff in the future means the job is not claimable yet.
        assert claim_job(db, worker_id="worker-a") is None
        retried.run_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()

    with SessionLocal() as db:
        claimed = claim_job(db, worker_id="worker-b")
        assert claimed is not None
        mark_failed(db, claimed.id, "second failure")

    with SessionLocal() as db:
        failed = db.get(Job, job.id)
        assert failed.status == JobStatus.FAILED.value
        assert failed.attempts == 2
        assert failed.finished_at is not None


def test_stale_running_jobs_are_requeued():
    with SessionLocal() as db:
        job = enqueue(db, "maintenance.ping")
        job.status = JobStatus.RUNNING.value
        job.locked_by = "dead-worker"
        job.locked_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()

    with SessionLocal() as db:
        assert requeue_stale_jobs(db, older_than_minutes=15) == 1

    with SessionLocal() as db:
        requeued = db.get(Job, job.id)
        assert requeued.status == JobStatus.QUEUED.value
        assert requeued.locked_by is None
        assert "requeued" in requeued.last_error


def test_ai_lane_and_legacy_jobs_do_not_block_local_queue():
    with SessionLocal() as db:
        legacy = enqueue(db, "ai.enrich", queue="default")
        rules = enqueue(db, "inventory.review.scheduled", {"ai_enabled": False}, queue="default")
        route_legacy_ai_jobs(db)
        local = enqueue(db, "maintenance.ping", priority=100)
        assert claim_job(db, worker_id="ai", queue="ai").id == legacy.id
        assert claim_job(db, worker_id="local", queue="default").id == local.id
        assert claim_job(db, worker_id="local", queue="default").id == rules.id


def test_live_worker_long_inference_is_not_recovered_as_a_crash():
    with SessionLocal() as db:
        job = enqueue(db, "ai.enrich")
        claimed = claim_job(db, worker_id="live-ai", queue="ai")
        claimed.locked_at = datetime.now(UTC) - timedelta(hours=1)
        db.add(
            WorkerHeartbeat(
                worker_id="live-ai",
                version="test",
                updated_at=datetime.now(UTC),
            )
        )
        db.commit()
        assert requeue_stale_jobs(db) == 0
        assert db.get(Job, job.id).status == "running"
