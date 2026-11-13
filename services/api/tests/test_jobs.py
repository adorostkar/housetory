"""Queue mechanics tests."""

import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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


def test_document_lanes_are_reserved_and_round_robin_by_actor():
    with SessionLocal() as db:
        background = enqueue(db, "ai.enrich", queue="ai")
        first = enqueue(
            db,
            "documents.ocr",
            {"household_id": "house-a", "actor_user_id": "user-a"},
            queue="documents",
            priority=5,
        )
        second = enqueue(
            db,
            "documents.ocr",
            {"household_id": "house-a", "actor_user_id": "user-a"},
            queue="documents",
            priority=5,
        )
        other_user = enqueue(
            db,
            "documents.ocr",
            {"household_id": "house-b", "actor_user_id": "user-b"},
            queue="documents",
            priority=5,
        )
        document_ai = enqueue(db, "ai.enrich", {"kind": "document"}, queue="ai-documents")

        assert claim_job(db, worker_id="background", queue="ai").id == background.id
        assert claim_job(db, worker_id="local", queue="documents").id == first.id
        assert claim_job(db, worker_id="local", queue="documents").id == other_user.id
        assert claim_job(db, worker_id="local", queue="documents").id == second.id
        assert claim_job(db, worker_id="document-ai", queue="ai-documents").id == document_ai.id


def test_reserved_document_ai_lane_dispatches_during_stalled_background_handler():
    legacy_waits = []
    reserved_waits = []
    stall_seconds = 0.08

    for sample in range(5):
        release = threading.Event()
        started = threading.Event()
        with SessionLocal() as db:
            background = enqueue(db, "ai.enrich", queue="ai")
            assert claim_job(db, worker_id=f"background-{sample}", queue="ai").id == background.id
        with ThreadPoolExecutor(max_workers=1) as executor:
            handler = executor.submit(
                lambda started_event=started, release_event=release: (
                    started_event.set(),
                    release_event.wait(timeout=2),
                )
            )
            assert started.wait(timeout=1)
            with SessionLocal() as db:
                interactive = enqueue(
                    db,
                    "ai.enrich",
                    {"kind": "document", "household_id": "household", "actor_user_id": "user"},
                    queue="ai",
                    priority=10,
                )
            time.sleep(stall_seconds)
            release.set()
            handler.result(timeout=1)
            with SessionLocal() as db:
                claimed = claim_job(db, worker_id=f"legacy-{sample}", queue="ai")
                legacy_waits.append(
                    max(0, (claimed.locked_at - interactive.created_at).total_seconds() * 1000)
                )

        release = threading.Event()
        started = threading.Event()
        with SessionLocal() as db:
            background = enqueue(db, "ai.enrich", queue="ai")
            assert (
                claim_job(db, worker_id=f"background-reserved-{sample}", queue="ai").id
                == background.id
            )
        with ThreadPoolExecutor(max_workers=1) as executor:
            handler = executor.submit(
                lambda started_event=started, release_event=release: (
                    started_event.set(),
                    release_event.wait(timeout=2),
                )
            )
            assert started.wait(timeout=1)
            with SessionLocal() as db:
                interactive = enqueue(
                    db,
                    "ai.enrich",
                    {"kind": "document", "household_id": "household", "actor_user_id": "user"},
                    queue="ai-documents",
                    priority=10,
                )
                claimed = claim_job(
                    db,
                    worker_id=f"reserved-{sample}",
                    queue="ai-documents",
                )
                reserved_waits.append(
                    max(0, (claimed.locked_at - interactive.created_at).total_seconds() * 1000)
                )
            release.set()
            handler.result(timeout=1)

    print(
        "stage-a-synthetic-dispatch "
        f"samples={len(legacy_waits)} stall_ms={stall_seconds * 1000:.0f} "
        f"shared_p50_ms={statistics.median(legacy_waits):.1f} "
        f"reserved_p50_ms={statistics.median(reserved_waits):.1f} "
        f"shared_samples_ms={[round(value, 1) for value in legacy_waits]} "
        f"reserved_samples_ms={[round(value, 1) for value in reserved_waits]}"
    )
    assert statistics.median(legacy_waits) >= stall_seconds * 1000
    assert statistics.median(reserved_waits) < statistics.median(legacy_waits)
