"""Durable manual review batches, reusing the existing analysis and suggestion writes."""

import uuid

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...models import Household, InventoryReviewRun, InventoryReviewSuggestion, Item
from ...schemas.inventory_review import ReviewRunRequest
from ..serializers import item_load_options
from . import _request_fingerprint, _run_out, run_review
from .scope import MAX_AI_ITEMS, _normalized, _Scope, _scope_conditions


def start(db: Session, household_id: uuid.UUID, payload: ReviewRunRequest, actor_id: uuid.UUID):
    db.execute(select(Household.id).where(Household.id == household_id).with_for_update())
    existing = db.scalar(
        select(InventoryReviewRun).where(
            InventoryReviewRun.household_id == household_id,
            InventoryReviewRun.request_id == payload.request_id,
        )
    )
    if existing:
        if existing.request_fingerprint != _request_fingerprint(payload):
            raise ApiError(409, "review_request_reused", "This request was used for another scope.")
        return _run_out(existing)
    conditions, label, scope_id = _scope_conditions(db, household_id, payload)
    ids = list(
        db.scalars(select(Item.id).where(*conditions).order_by(Item.updated_at.desc(), Item.id))
    )
    from ..inventory_review_schedule import _assistant_route

    route = _assistant_route(db, household_id)[1] if payload.include_ai else None
    run = InventoryReviewRun(
        household_id=household_id,
        request_id=payload.request_id,
        request_fingerprint=_request_fingerprint(payload),
        scope_type=payload.scope_type,
        scope_id=scope_id,
        scope_label=label,
        include_ai=payload.include_ai,
        status="partial" if ids else "completed",
        total_item_count=len(ids),
        created_by_user_id=actor_id,
        progress_json={
            "remaining": [str(value) for value in ids],
            "retry_ids": [],
            "state": "paused" if ids else "completed",
            "version": 0,
            "completed_batches": 0,
            "unavailable": 0,
            "payload": payload.model_dump(mode="json"),
            "ai_route": route,
        },
    )
    db.add(run)
    db.flush()
    return _run_out(run)


def _locked(db: Session, household_id: uuid.UUID, run_id: uuid.UUID):
    run = db.scalar(
        select(InventoryReviewRun)
        .where(
            InventoryReviewRun.id == run_id,
            InventoryReviewRun.household_id == household_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None or "remaining" not in (run.progress_json or {}):
        raise ApiError(404, "review_run_not_found", "Resumable review not found.")
    return run


def advance(
    db: Session,
    household_id: uuid.UUID,
    run_id: uuid.UUID,
    version: int,
    *,
    actor_id: uuid.UUID,
    actor_name: str,
    allow_ai: bool,
    cancel: bool = False,
    resume: bool = False,
):
    # One transaction per bounded batch serializes duplicate requests and cancellation.
    # If interrupted, the batch rolls back; already committed batches remain resumable.
    run = _locked(db, household_id, run_id)
    progress = dict(run.progress_json)
    if cancel:
        if progress["state"] != "completed":
            progress["state"] = "cancelled"
            progress["version"] += 1
            run.progress_json = progress
        return _run_out(run)
    if version != progress["version"] or progress["state"] == "completed":
        return _run_out(run)
    if progress["state"] == "cancelled" and not resume:
        return _run_out(run)
    if run.include_ai and not allow_ai:
        raise ApiError(403, "owner_required", "Only the owner can resume AI review.")
    payload = ReviewRunRequest.model_validate(progress["payload"])
    if run.include_ai:
        from ..inventory_review_schedule import _assistant_route

        if progress["ai_route"] != _assistant_route(db, household_id)[1]:
            raise ApiError(
                409,
                "review_provider_changed",
                "AI configuration or consent changed. Start a new review to confirm the new route.",
            )
    conditions, _, _ = _scope_conditions(db, household_id, payload)
    retry = bool(progress["retry_ids"])
    queue = list(progress["retry_ids"] if retry else progress["remaining"])
    ids = queue[:MAX_AI_ITEMS]
    items = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(*conditions, Item.id.in_([uuid.UUID(value) for value in ids]))
            .order_by(Item.updated_at.desc(), Item.id)
        )
    )
    scope = _Scope(
        run.scope_type,
        f"{run.scope_label}: {len(items)}-item batch",
        run.scope_id,
        len(items),
        items,
    )
    # Compare matching names/serials across the selected scope, including batch boundaries.
    comparisons = scope
    if items and not retry:
        names = {_normalized(item.name) for item in items}
        serials = {_normalized(item.serial_number) for item in items if item.serial_number}
        matches = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    *conditions,
                    or_(
                        func.lower(func.regexp_replace(func.trim(Item.name), r"\s+", " ", "g")).in_(
                            names
                        ),
                        func.lower(
                            func.regexp_replace(func.trim(Item.serial_number), r"\s+", " ", "g")
                        ).in_(serials),
                    ),
                )
                .order_by(Item.updated_at.desc(), Item.id)
            )
        )
        comparisons = _Scope(run.scope_type, run.scope_label, run.scope_id, len(matches), matches)
    batch_request = payload.model_copy(
        update={
            "request_id": uuid.uuid5(run.id, str(progress["version"])),
        }
    )
    result = run_review(
        db,
        household_id,
        batch_request,
        actor_user_id=actor_id,
        actor_name=actor_name,
        allow_ai=allow_ai,
        scope_override=scope,
        comparison_scope=comparisons,
        local_checks=not retry,
    )
    db.expire_all()
    if run.include_ai and progress["ai_route"] != _assistant_route(db, household_id)[1]:
        raise ApiError(
            409,
            "review_provider_changed",
            "AI configuration or consent changed during review. This batch was not published.",
        )
    child = db.get(InventoryReviewRun, result.id)
    db.execute(
        update(InventoryReviewSuggestion)
        .where(
            InventoryReviewSuggestion.run_id == child.id,
        )
        .values(run_id=run.id)
    )
    failed_ids = (child.progress_json or {}).get("ai_eligible_ids", [])
    pending = set((child.progress_json or {}).get("pending_fingerprints", []))
    seen = set(progress.get("pending_fingerprints", []))
    repeated = len(pending & seen)
    progress["pending_fingerprints"] = sorted(seen | pending)
    child.progress_json = {"parent_id": str(run.id)}
    for field in (
        "created_suggestion_count",
        "existing_suggestion_count",
        "stale_suggestion_count",
        "suppressed_suggestion_count",
        "ai_item_count",
        "ai_reviewed_count",
    ):
        setattr(run, field, getattr(run, field) + getattr(result, field))
    run.existing_suggestion_count -= repeated
    progress["unavailable"] += len(ids) - len(items)
    if not retry:
        run.item_count_scanned += len(items)
        run.ai_eligible_count += result.ai_eligible_count
        progress["remaining"] = queue[MAX_AI_ITEMS:]
    else:
        progress["retry_ids"] = queue[MAX_AI_ITEMS:]
    if result.ai_error:
        progress["retry_ids"] = list(
            dict.fromkeys(
                [
                    *progress["retry_ids"],
                    *failed_ids,
                ]
            )
        )
    else:
        progress["completed_batches"] += 1
    run.ai_used = run.ai_used or result.ai_used
    run.ai_provider_label = result.ai_provider_label or run.ai_provider_label
    run.ai_model = result.ai_model or run.ai_model
    run.ai_error = result.ai_error
    remaining = len(progress["remaining"]) + len(progress["retry_ids"])
    progress["state"] = "paused" if remaining else "completed"
    progress["version"] += 1
    run.progress_json = progress
    run.status = "partial" if remaining or progress["unavailable"] else "completed"
    run.partial_reason = (
        f"{remaining} items unfinished. Resume to continue without repeating completed batches."
        if remaining
        else f"{progress['unavailable']} items became unavailable or left the selected scope."
        if progress["unavailable"]
        else None
    )
    run.completed_at = result.completed_at if not remaining else None
    db.flush()
    return _run_out(run)
