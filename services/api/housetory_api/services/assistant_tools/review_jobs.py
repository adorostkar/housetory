"""Queued batches over the same review, coverage, decision and approval implementation."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from ...db import SessionLocal
from ...jobs import enqueue
from ...models import AssistantRun, InventoryReviewRun, Job
from ...schemas.inventory_review import ReviewRunRequest
from ..inventory_review import _run_out, batches

TASK = "assistant.review"


def _queue(db, auth, run, *, resume=False, continuing=False):
    """Queue the next batch. `continuing` hands over from the job that just finished a
    batch, keeping the review marked active so observers never see a false pause."""
    run = batches._locked(db, auth.household.id, run.id)
    progress = dict(run.progress_json)
    finished = (progress["state"] == "cancelled" and not resume) or (
        not progress["remaining"] and not progress.get("retry_ids")
    )
    if finished:
        if continuing and progress.get("background_active"):
            run.progress_json = {**progress, "background_active": False}
            db.commit()
        return _run_out(run)
    previous = (
        db.get(Job, uuid.UUID(progress["background_job_id"]))
        if progress.get("background_job_id")
        else None
    )
    if (
        not continuing
        and progress.get("background_active")
        and previous
        and previous.status in {"queued", "running"}
    ):
        return _run_out(run)
    job = enqueue(
        db,
        TASK,
        {
            "run_id": str(run.id),
            "actor_id": str(auth.user.id),
            "session_id": str(auth.session.id),
            "household_id": str(auth.household.id),
            "version": progress["version"],
            "resume": resume,
            "mode": "interactive",
            "deadline_at": (datetime.now(UTC) + timedelta(seconds=90)).isoformat(),
        },
        queue="ai" if run.include_ai else "default",
        max_attempts=1,
        priority=5,
        commit=False,
    )
    job.payload = {**job.payload, "job_id": str(job.id)}
    run.progress_json = {**progress, "background_job_id": str(job.id), "background_active": True}
    db.commit()
    return _run_out(run)


def start_review(db, auth, payload: ReviewRunRequest):
    from ...api.errors import ApiError

    assistant = None
    if payload.assistant_run_id is not None:
        assistant = db.get(AssistantRun, payload.assistant_run_id)
        if assistant is None or (
            assistant.actor_user_id != auth.user.id or assistant.household_id != auth.household.id
        ):
            raise ApiError(404, "assistant_run_not_found", "Assistant request not found.")
        if not any(
            (step["result"].get("review") or {}).get("id") == str(payload.assistant_review_id)
            for step in assistant.data.get("steps", [])
        ):
            prior = db.scalar(
                select(InventoryReviewRun).where(
                    InventoryReviewRun.household_id == auth.household.id,
                    InventoryReviewRun.request_id == payload.request_id,
                )
            )
            if prior is None or (
                (prior.progress_json or {}).get("payload", {}).get("assistant_run_id")
                != str(assistant.id)
            ):
                raise ApiError(
                    409,
                    "assistant_review_changed",
                    "Reload this review before starting another run.",
                )
    result = batches.start(db, auth.household.id, payload, auth.user.id)
    db.commit()
    run = batches._locked(db, auth.household.id, result.id)
    result = _queue(db, auth, run)
    if assistant is not None:
        db.refresh(assistant, with_for_update=True)
        steps = []
        for step in assistant.data.get("steps", []):
            output = dict(step["result"])
            if (output.get("review") or {}).get("id") == str(payload.assistant_review_id):
                output["review"] = result.model_dump(mode="json")
            steps.append({**step, "result": output})
        assistant.data = {**assistant.data, "steps": steps}
        db.commit()
    return result


def resume_review(db, auth, run_id, version):
    run = batches._locked(db, auth.household.id, run_id)
    if run.include_ai and auth.role != "owner":
        from ...api.errors import ApiError

        raise ApiError(403, "owner_required", "Only the owner can resume AI review.")
    if run.progress_json["version"] != version:
        return _run_out(run)
    return _queue(db, auth, run, resume=True)


def recover(db, run):
    progress = dict(run.progress_json)
    if progress.get("background_active") and progress.get("background_job_id"):
        job = db.get(Job, uuid.UUID(progress["background_job_id"]))
        expired = job and datetime.now(UTC) > datetime.fromisoformat(job.payload["deadline_at"])
        if job is None or job.status in {"failed", "cancelled", "succeeded"} or expired:
            run.progress_json = {
                **progress,
                "background_active": False,
                "version": progress["version"] + 1,
                "state": "cancelled" if progress["state"] == "cancelled" else "paused",
            }
            run.progress_json = {
                key: value for key, value in run.progress_json.items() if key != "inference_lease"
            }
            if job and job.status in {"queued", "running"}:
                job.status = "cancelled"
                job.finished_at = datetime.now(UTC)
            run.partial_reason = (
                "Background review was interrupted. Resume to continue completed work."
            )
            db.commit()


def run_job(payload: dict):
    from . import authorize

    with SessionLocal() as db:
        auth = authorize(
            db,
            uuid.UUID(payload["actor_id"]),
            uuid.UUID(payload["household_id"]),
            None,
            uuid.UUID(payload["session_id"]),
        )
        run = batches._locked(db, auth.household.id, uuid.UUID(payload["run_id"]))
        if auth.role not in {"owner", "member"} or (run.include_ai and auth.role != "owner"):
            from ...api.errors import ApiError

            raise ApiError(
                403,
                "review_permission_changed",
                "Review permissions changed; no batch was published.",
            )
        if run.progress_json.get("background_job_id") != payload["job_id"]:
            return {"state": "superseded"}
        result = batches.advance_detached(
            db,
            auth.household.id,
            run.id,
            payload["version"],
            actor_id=auth.user.id,
            actor_name=auth.user.name,
            allow_ai=auth.role == "owner",
            resume=payload.get("resume", False),
        )
        run = batches._locked(db, auth.household.id, result.id)
        if run.progress_json.get("background_job_id") != payload["job_id"]:
            return {"state": "superseded"}
        if (
            result.remaining_item_count
            and result.batch_state != "cancelled"
            and not result.ai_error
        ):
            result = _queue(db, auth, run, continuing=True)
        else:
            run.progress_json = {**run.progress_json, "background_active": False}
            db.commit()
        return result.model_dump(mode="json")
