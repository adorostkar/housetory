"""Optional scheduled inventory review.

Schedules are off by default, owner-managed and dispatched through the same
durable job queue as other worker tasks. A scheduled run creates the same
persistent suggestions as an on-demand review; it never applies inventory
changes. Remote AI is a separate, explicitly recorded consent that is bound to
the current household Assistant route.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import AiTask, JobStatus
from ..jobs import enqueue
from ..models import (
    HouseholdMember,
    InventoryReviewRun,
    InventoryReviewSchedule,
    Job,
)
from ..schemas.inventory_review import (
    ReviewRunRequest,
    ReviewScheduleOut,
    ReviewScheduleSummaryOut,
    ReviewScheduleUpdate,
)
from . import ai, inventory_review

SCHEDULED_REVIEW_TASK = "inventory.review.scheduled"
MAX_SCHEDULE_ITEMS = 500
MAX_SCHEDULE_RUNS_PER_DAY = 4
PROVIDER_REQUEST_CAP = 1
SCAN_CURSOR_MODULUS = 10_000
ACTIVE_JOB_STATUSES = (JobStatus.QUEUED.value, JobStatus.RUNNING.value)


def _hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ApiError(
            422,
            "invalid_timezone",
            "Choose a valid IANA timezone, for example Europe/London.",
        ) from None


def next_occurrence(
    *,
    frequency: str,
    timezone: str,
    weekday: int,
    monthly_day: int,
    local_hour: int,
    after: datetime,
) -> datetime:
    """Return the next scheduled instant strictly after ``after`` in UTC.

    Weekly schedules target ``weekday`` (0=Monday). Monthly schedules target
    ``monthly_day`` (1..28) to avoid month-end ambiguity. Times use the
    schedule's IANA timezone, so UTC offsets follow daylight-saving changes.
    A nonexistent local time during spring-forward is resolved by the timezone
    database to the nearest valid instant; callers never miss a run.
    """
    zone = _zone(timezone)
    local_after = after.astimezone(zone)
    if frequency == "weekly":
        candidate_date = local_after.date() + timedelta(days=(weekday - local_after.weekday()) % 7)
        candidate = datetime.combine(candidate_date, time(hour=local_hour), tzinfo=zone)
        if candidate <= local_after:
            candidate += timedelta(days=7)
        return candidate.astimezone(UTC)

    year, month = local_after.year, local_after.month
    candidate = datetime.combine(date(year, month, monthly_day), time(hour=local_hour), tzinfo=zone)
    if candidate <= local_after:
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1
        candidate = datetime.combine(
            date(year, month, monthly_day), time(hour=local_hour), tzinfo=zone
        )
    return candidate.astimezone(UTC)


def _local_day_start(schedule: InventoryReviewSchedule, now: datetime) -> datetime:
    local = now.astimezone(_zone(schedule.timezone))
    return datetime.combine(local.date(), time.min, tzinfo=local.tzinfo).astimezone(UTC)


def _assistant_route(db: Session, household_id: uuid.UUID):
    status = ai.status_for(db, household_id, AiTask.ASSISTANT.value, probe=False)
    config = ai.config_for(db, household_id, AiTask.ASSISTANT.value)
    fingerprint = _hash(
        {
            "provider_id": str(config.provider_id) if config.provider_id else None,
            "provider": config.provider,
            "base_url": (config.base_url or "").rstrip("/"),
            "model": config.model,
            "mode": config.mode,
            "source": config.source,
            "endpoint": config.endpoint_scope,
            "endpoint_host": config.endpoint_host,
            "cloud_consent": config.cloud_consent,
        }
    )
    return status, fingerprint


def _consent_reason(
    schedule: InventoryReviewSchedule,
    status,
    fingerprint: str,
) -> str | None:
    if not schedule.include_ai:
        return None
    if not schedule.ai_consent or not schedule.ai_consent_fingerprint:
        return "Scheduled AI consent has not been recorded."
    if schedule.ai_consent_fingerprint != fingerprint:
        return (
            "The Assistant provider, endpoint or model changed after consent. "
            "Reconfirm scheduled AI consent."
        )
    if not status.configured:
        return status.error or "The household Assistant task is not configured."
    return None


def _consent_matches(schedule: InventoryReviewSchedule, fingerprint: str) -> bool:
    return bool(
        schedule.include_ai
        and schedule.ai_consent
        and schedule.ai_consent_fingerprint
        and schedule.ai_consent_fingerprint == fingerprint
    )


def _state(
    schedule: InventoryReviewSchedule | None,
    status,
    fingerprint: str,
    consent_matches: bool,
) -> tuple[str, str]:
    if schedule is None:
        return (
            "not_configured",
            "No scheduled review has been configured. Automatic review is off.",
        )
    if not schedule.enabled:
        return "disabled", "Automatic review is off."
    if schedule.include_ai:
        if not status.configured:
            return (
                "ai_not_configured",
                "Scheduled AI is paused because the household Assistant task is not "
                "configured. Runs continue offline and never switch provider.",
            )
        if not consent_matches:
            return (
                "consent_needed",
                _consent_reason(schedule, status, fingerprint)
                or "Scheduled AI consent must be reconfirmed.",
            )
    if schedule.last_run_status == "failed":
        return (
            "attention",
            schedule.last_run_detail or "The last scheduled run failed.",
        )
    if schedule.next_due_at is None:
        return "attention", "The schedule is enabled but has no next due time."
    return "scheduled", "Scheduled review is active."


def schedule_summary(db: Session, household_id: uuid.UUID) -> ReviewScheduleSummaryOut:
    schedule = db.scalar(
        select(InventoryReviewSchedule).where(InventoryReviewSchedule.household_id == household_id)
    )
    if schedule is None:
        return ReviewScheduleSummaryOut(
            state_detail=("No scheduled review has been configured. Automatic review is off.")
        )
    status, fingerprint = _assistant_route(db, household_id)
    matches = _consent_matches(schedule, fingerprint)
    state, detail = _state(schedule, status, fingerprint, matches)
    return ReviewScheduleSummaryOut(
        configured=True,
        enabled=schedule.enabled,
        state=state,  # type: ignore[arg-type]
        state_detail=detail,
        scope_type=schedule.scope_type,  # type: ignore[arg-type]
        scope_label=schedule.scope_label,
        frequency=schedule.frequency,  # type: ignore[arg-type]
        timezone=schedule.timezone,
        weekday=schedule.weekday,
        monthly_day=schedule.monthly_day,
        local_hour=schedule.local_hour,
        max_items=schedule.max_items,
        max_runs_per_day=schedule.max_runs_per_day,
        provider_request_cap=PROVIDER_REQUEST_CAP,
        include_ai=schedule.include_ai,
        ai_consent_valid=matches,
        assistant_configured=status.configured,
        assistant_provider_label=status.provider_label or status.provider,
        assistant_model=status.model,
        last_run_at=schedule.last_run_at,
        last_run_status=schedule.last_run_status,  # type: ignore[arg-type]
        last_run_detail=schedule.last_run_detail,
        next_due_at=schedule.next_due_at,
    )


def schedule_out(db: Session, household_id: uuid.UUID) -> ReviewScheduleOut | None:
    schedule = db.scalar(
        select(InventoryReviewSchedule).where(InventoryReviewSchedule.household_id == household_id)
    )
    if schedule is None:
        return None
    status, fingerprint = _assistant_route(db, household_id)
    matches = _consent_matches(schedule, fingerprint)
    state, detail = _state(schedule, status, fingerprint, matches)
    out = ReviewScheduleOut.model_validate(schedule, from_attributes=True)
    return out.model_copy(
        update={
            "configured": True,
            "state": state,
            "state_detail": detail,
            "ai_consent_valid": matches,
            "ai_consent_reason": (
                None if matches else _consent_reason(schedule, status, fingerprint)
            ),
            "assistant_task": AiTask.ASSISTANT.value,
            "assistant_configured": status.configured,
            "assistant_provider_label": status.provider_label or status.provider,
            "assistant_model": status.model,
            "assistant_mode": status.mode,
            "assistant_error": status.error,
            "provider_request_cap": PROVIDER_REQUEST_CAP,
        }
    )


def save_schedule(
    db: Session,
    household_id: uuid.UUID,
    payload: ReviewScheduleUpdate,
    *,
    actor_user_id: uuid.UUID,
) -> ReviewScheduleOut:
    now = datetime.now(UTC)
    status, fingerprint = _assistant_route(db, household_id)
    schedule = db.scalar(
        select(InventoryReviewSchedule)
        .where(InventoryReviewSchedule.household_id == household_id)
        .with_for_update()
    )
    scope_request = ReviewRunRequest(
        scope_type=payload.scope_type,
        scope_id=payload.scope_id,
        include_ai=False,
        request_id=uuid.uuid4(),
    )
    _conditions, scope_label, _scope_id = inventory_review._scope_conditions(
        db, household_id, scope_request
    )

    consent = False
    if payload.include_ai:
        if not status.configured:
            raise ApiError(
                422,
                "assistant_not_configured",
                "Configure the household Assistant task before enabling scheduled AI. "
                "Offline-only scheduling is still available.",
            )
        already_consented = bool(
            schedule
            and schedule.include_ai
            and schedule.ai_consent
            and schedule.ai_consent_fingerprint == fingerprint
        )
        if payload.ai_consent is True or (payload.ai_consent is None and already_consented):
            consent = True
        else:
            raise ApiError(
                422,
                "ai_consent_required",
                "Scheduled AI needs separate explicit consent. Confirm the exact data "
                "sent to the current Assistant provider and the possibility of provider "
                "usage or cost. Offline-only scheduling is available without it.",
            )

    if schedule is None:
        schedule = InventoryReviewSchedule(
            household_id=household_id,
            created_by_user_id=actor_user_id,
        )
        db.add(schedule)

    schedule.enabled = payload.enabled
    schedule.scope_type = payload.scope_type
    schedule.scope_id = payload.scope_id if payload.scope_type != "household" else None
    schedule.scope_label = scope_label
    schedule.frequency = payload.frequency
    schedule.timezone = payload.timezone
    schedule.weekday = payload.weekday
    schedule.monthly_day = payload.monthly_day
    schedule.local_hour = payload.local_hour
    schedule.max_items = payload.max_items
    schedule.max_runs_per_day = payload.max_runs_per_day
    schedule.include_ai = payload.include_ai
    schedule.updated_by_user_id = actor_user_id
    schedule.last_run_status = schedule.last_run_status or "never"

    if payload.include_ai and consent:
        if payload.ai_consent is True or not schedule.ai_consent:
            schedule.ai_consent = True
            schedule.ai_consent_at = now
            schedule.ai_consent_fingerprint = fingerprint
            schedule.ai_consent_provider_id = status.provider_id
            schedule.ai_consent_provider_label = status.provider_label or status.provider
            schedule.ai_consent_model = status.model
    else:
        schedule.ai_consent = False
        schedule.ai_consent_at = None
        schedule.ai_consent_fingerprint = None
        schedule.ai_consent_provider_id = None
        schedule.ai_consent_provider_label = None
        schedule.ai_consent_model = None

    if payload.enabled:
        schedule.next_due_at = next_occurrence(
            frequency=payload.frequency,
            timezone=payload.timezone,
            weekday=payload.weekday,
            monthly_day=payload.monthly_day,
            local_hour=payload.local_hour,
            after=now,
        )
    else:
        schedule.next_due_at = None

    db.flush()
    if not payload.enabled:
        db.execute(
            update(Job)
            .where(
                Job.task == SCHEDULED_REVIEW_TASK,
                Job.status == JobStatus.QUEUED.value,
                Job.payload["schedule_id"].astext == str(schedule.id),
            )
            .values(
                status=JobStatus.CANCELLED.value,
                finished_at=now,
                last_error="Schedule disabled before this run started.",
            )
        )
    db.commit()
    db.refresh(schedule)
    result = schedule_out(db, household_id)
    if result is None:  # pragma: no cover - the row was just committed
        raise ApiError(500, "schedule_unavailable", "The schedule could not be loaded.")
    return result


def _active_schedule_job(db: Session, schedule_id: uuid.UUID) -> Job | None:
    return db.scalar(
        select(Job)
        .where(
            Job.task == SCHEDULED_REVIEW_TASK,
            Job.status.in_(ACTIVE_JOB_STATUSES),
            Job.payload["schedule_id"].astext == str(schedule_id),
        )
        .order_by(Job.created_at.desc())
        .limit(1)
    )


def _scheduled_runs_today(db: Session, schedule: InventoryReviewSchedule, now: datetime) -> int:
    return int(
        db.scalar(
            select(func.count(InventoryReviewRun.id)).where(
                InventoryReviewRun.schedule_id == schedule.id,
                InventoryReviewRun.trigger_type == "scheduled",
                InventoryReviewRun.created_at >= _local_day_start(schedule, now),
            )
        )
        or 0
    )


def dispatch_due_reviews(db: Session, *, now: datetime | None = None, limit: int = 20) -> int:
    """Claim and enqueue at most one due run per schedule.

    Row locks with ``SKIP LOCKED`` make this safe with multiple workers. Only
    one bounded catch-up run is dispatched when a schedule is overdue; the next
    due time is always computed from the current time, so restarts cannot cause
    a burst of historical runs.
    """
    now = now or datetime.now(UTC)
    schedules = list(
        db.scalars(
            select(InventoryReviewSchedule)
            .where(
                InventoryReviewSchedule.enabled.is_(True),
                InventoryReviewSchedule.next_due_at.is_not(None),
                InventoryReviewSchedule.next_due_at <= now,
            )
            .order_by(InventoryReviewSchedule.next_due_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).all()
    )
    dispatched = 0
    for schedule in schedules:
        if _active_schedule_job(db, schedule.id) is not None:
            # A queued or running job owns this schedule. Leave the due time in
            # place; the next worker tick will dispatch after it completes.
            continue
        runs_today = _scheduled_runs_today(db, schedule, now)
        if runs_today >= schedule.max_runs_per_day:
            schedule.last_run_status = "skipped"
            schedule.last_run_detail = (
                f"Daily scheduled-run cap reached ({runs_today} of "
                f"{schedule.max_runs_per_day}). No extra run was dispatched."
            )
            schedule.next_due_at = next_occurrence(
                frequency=schedule.frequency,
                timezone=schedule.timezone,
                weekday=schedule.weekday,
                monthly_day=schedule.monthly_day,
                local_hour=schedule.local_hour,
                after=now,
            )
            continue

        due = schedule.next_due_at
        request_id = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"housetory-review-schedule:{schedule.id}:{due.isoformat()}",
        )
        existing = db.scalar(
            select(InventoryReviewRun.id).where(
                InventoryReviewRun.household_id == schedule.household_id,
                InventoryReviewRun.request_id == request_id,
            )
        )
        if existing is not None:
            schedule.next_due_at = next_occurrence(
                frequency=schedule.frequency,
                timezone=schedule.timezone,
                weekday=schedule.weekday,
                monthly_day=schedule.monthly_day,
                local_hour=schedule.local_hour,
                after=now,
            )
            continue

        job = enqueue(
            db,
            SCHEDULED_REVIEW_TASK,
            {
                "household_id": str(schedule.household_id),
                "schedule_id": str(schedule.id),
                "request_id": str(request_id),
            },
            max_attempts=3,
            priority=5,
            commit=False,
        )
        db.flush()
        job.payload = {**(job.payload or {}), "job_id": str(job.id)}
        schedule.last_dispatch_at = now
        schedule.last_run_status = "queued"
        schedule.last_run_detail = "Scheduled run queued."
        schedule.last_run_job_id = job.id
        schedule.next_due_at = next_occurrence(
            frequency=schedule.frequency,
            timezone=schedule.timezone,
            weekday=schedule.weekday,
            monthly_day=schedule.monthly_day,
            local_hour=schedule.local_hour,
            after=now,
        )
        dispatched += 1
    db.commit()
    return dispatched


def _run_detail(
    run,
    *,
    ai_skip_note: str | None,
    disabled_during_run: bool,
) -> str:
    detail = (
        f"Scanned {run.item_count_scanned} of {run.total_item_count}; "
        f"{run.created_suggestion_count} new, "
        f"{run.existing_suggestion_count} already queued, "
        f"{run.stale_suggestion_count} stale, "
        f"{run.suppressed_suggestion_count} previously resolved."
    )
    if run.ai_used:
        detail += f" AI used {run.ai_provider_label or 'Assistant'}."
    if ai_skip_note:
        detail += f" {ai_skip_note}"
    if run.partial_reason:
        detail += f" Partial: {run.partial_reason}"
    if disabled_during_run:
        detail += (
            " The schedule was disabled while this run was in flight; no future run "
            "will be dispatched."
        )
    return detail


def execute_scheduled_review(db: Session, payload: dict) -> dict:
    schedule_id = uuid.UUID(str(payload["schedule_id"]))
    household_id = uuid.UUID(str(payload["household_id"]))
    request_id = uuid.UUID(str(payload["request_id"]))
    now = datetime.now(UTC)
    schedule = db.scalar(
        select(InventoryReviewSchedule)
        .where(
            InventoryReviewSchedule.id == schedule_id,
            InventoryReviewSchedule.household_id == household_id,
        )
        .with_for_update()
    )
    if schedule is None:
        return {"skipped": True, "reason": "The schedule no longer exists."}
    if not schedule.enabled:
        schedule.last_run_at = now
        schedule.last_run_status = "skipped"
        schedule.last_run_detail = (
            "The schedule was disabled before this queued run started. No review was performed."
        )
        db.commit()
        return {"skipped": True, "reason": "Schedule disabled."}

    approving_owner_id = schedule.updated_by_user_id or schedule.created_by_user_id
    approving_owner = (
        db.scalar(
            select(HouseholdMember).where(
                HouseholdMember.household_id == schedule.household_id,
                HouseholdMember.user_id == approving_owner_id,
                HouseholdMember.role == "owner",
            )
        )
        if approving_owner_id is not None
        else None
    )
    if approving_owner is None:
        schedule.last_run_at = now
        schedule.last_run_status = "failed"
        schedule.last_run_detail = (
            "Scheduled review paused: the owner who last approved this schedule is "
            "no longer an owner of this household. An owner must review and save the "
            "schedule again."
        )
        if schedule.enabled:
            schedule.next_due_at = next_occurrence(
                frequency=schedule.frequency,
                timezone=schedule.timezone,
                weekday=schedule.weekday,
                monthly_day=schedule.monthly_day,
                local_hour=schedule.local_hour,
                after=now,
            )
        db.commit()
        return {"skipped": True, "reason": "approving owner is no longer an owner"}

    schedule.last_run_status = "running"
    schedule.last_run_detail = "Scheduled review is running."
    schedule.last_run_at = now
    db.commit()

    status, fingerprint = _assistant_route(db, household_id)
    matches = _consent_matches(schedule, fingerprint)
    ai_skip_note = None
    effective_ai = schedule.include_ai
    if effective_ai and not status.configured:
        effective_ai = False
        ai_skip_note = (
            "Scheduled AI was skipped because the Assistant task is not configured; "
            "offline rules still ran."
        )
    elif effective_ai and not matches:
        effective_ai = False
        ai_skip_note = (
            "Scheduled AI was skipped because consent no longer matches the current "
            "Assistant route; offline rules still ran."
        )

    run_request = ReviewRunRequest(
        scope_type=schedule.scope_type,
        scope_id=schedule.scope_id,
        include_ai=schedule.include_ai,
        request_id=request_id,
    )
    try:
        run = inventory_review.run_review(
            db,
            household_id,
            run_request,
            actor_user_id=None,
            actor_name="Scheduled inventory review",
            allow_ai=True,
            max_items=schedule.max_items,
            prioritize_since=schedule.last_success_at,
            scan_offset=schedule.scan_cursor,
            trigger_type="scheduled",
            schedule_id=schedule.id,
            ai_skip_note=ai_skip_note,
        )
    except Exception as exc:
        db.rollback()
        failed = db.scalar(
            select(InventoryReviewSchedule)
            .where(InventoryReviewSchedule.id == schedule_id)
            .with_for_update()
        )
        if failed is not None:
            failed.last_run_at = now
            failed.last_run_status = "failed"
            failed.last_run_detail = f"Scheduled review failed: {type(exc).__name__}: {exc}"[:2000]
            db.commit()
        raise

    db.refresh(schedule)
    disabled_during_run = not schedule.enabled
    schedule.last_run_at = now
    schedule.last_run_status = run.status
    schedule.last_run_detail = _run_detail(
        run,
        ai_skip_note=ai_skip_note,
        disabled_during_run=disabled_during_run,
    )
    schedule.last_run_id = run.id
    if payload.get("job_id"):
        schedule.last_run_job_id = uuid.UUID(str(payload["job_id"]))
    if run.status in {"completed", "partial"}:
        schedule.last_success_at = now
    schedule.scan_cursor = (
        schedule.scan_cursor + max(1, run.item_count_scanned)
    ) % SCAN_CURSOR_MODULUS
    if schedule.enabled:
        schedule.next_due_at = next_occurrence(
            frequency=schedule.frequency,
            timezone=schedule.timezone,
            weekday=schedule.weekday,
            monthly_day=schedule.monthly_day,
            local_hour=schedule.local_hour,
            after=now,
        )
    db.commit()
    return {
        "run_id": str(run.id),
        "status": run.status,
        "scanned": run.item_count_scanned,
        "total": run.total_item_count,
        "created": run.created_suggestion_count,
        "existing": run.existing_suggestion_count,
        "ai_used": run.ai_used,
        "ai_skipped_reason": ai_skip_note,
    }


def run_scheduled_review_job(payload: dict) -> dict:
    from ..db import SessionLocal

    with SessionLocal() as db:
        return execute_scheduled_review(db, payload)


__all__ = [
    "MAX_SCHEDULE_ITEMS",
    "MAX_SCHEDULE_RUNS_PER_DAY",
    "PROVIDER_REQUEST_CAP",
    "SCHEDULED_REVIEW_TASK",
    "dispatch_due_reviews",
    "execute_scheduled_review",
    "next_occurrence",
    "run_scheduled_review_job",
    "save_schedule",
    "schedule_out",
    "schedule_summary",
]
