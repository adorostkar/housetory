"""Durable manual review batches, reusing the existing analysis and suggestion writes."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...models import (
    Household,
    HouseholdMember,
    InventoryReviewCoverage,
    InventoryReviewRun,
    InventoryReviewSuggestion,
    Item,
)
from ...schemas.inventory_review import ReviewRunRequest
from ..serializers import item_load_options
from . import _request_fingerprint, _run_out, coverage, run_review
from .candidates import unanswered_note
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
    statement = select(Item.id).where(*conditions)
    if payload.include_ai and not payload.review_again:
        # Queue unfinished/edited items first; exact inputs are checked within each batch.
        statement = statement.outerjoin(
            InventoryReviewCoverage,
            and_(
                InventoryReviewCoverage.item_id == Item.id,
                InventoryReviewCoverage.household_id == household_id,
                InventoryReviewCoverage.capability == coverage.CAPABILITY,
            ),
        ).order_by(
            or_(
                InventoryReviewCoverage.item_id.is_(None),
                Item.updated_at > InventoryReviewCoverage.reviewed_at,
            ).desc()
        )
    ids = list(db.scalars(statement.order_by(Item.updated_at.desc(), Item.id)))
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
            "snapshot_ids": [str(value) for value in ids],
            "retry_ids": [],
            "state": "paused" if ids else "completed",
            "version": 0,
            "completed_batches": 0,
            "unavailable": 0,
            "payload": payload.model_dump(mode="json"),
            "ai_route": route,
            "capability_version": coverage.CAPABILITY_VERSION,
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
    ai_inference=None,
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

        if (
            progress.get("capability_version", coverage.CAPABILITY_VERSION)
            != coverage.CAPABILITY_VERSION
        ):
            raise ApiError(
                409,
                "review_capability_changed",
                "Review capabilities changed. Start a new review; "
                "completed work and decisions are preserved.",
            )
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
        comparison_conditions = (
            [Item.household_id == household_id, Item.is_archived.is_(False)]
            if payload.scope_type == "items"
            else conditions
        )
        matches = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    *comparison_conditions,
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
        ai_inference=ai_inference,
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
    progress["ai_outcomes"] = {
        **progress.get("ai_outcomes", {}),
        **(child.progress_json or {}).get("ai_outcomes", {}),
    }
    answered_now = (child.progress_json or {}).get("ai_successful_inputs", {})
    # Unanswered items are not requeued here (a model that keeps omitting them would never
    # finish); they stay uncovered for a later review and are reported on this run.
    still_unanswered = [
        value for value in progress.get("ai_unanswered_ids", []) if value not in answered_now
    ]
    progress["ai_unanswered_ids"] = list(
        dict.fromkeys(
            [*still_unanswered, *(child.progress_json or {}).get("ai_unanswered_ids", [])]
        )
    )
    progress["ai_diagnostics"] = [
        *progress.get("ai_diagnostics", []),
        *(child.progress_json or {}).get("ai_diagnostics", []),
    ][-MAX_AI_ITEMS:]
    child.progress_json = {**child.progress_json, "parent_id": str(run.id)}
    for field in (
        "created_suggestion_count",
        "existing_suggestion_count",
        "stale_suggestion_count",
        "suppressed_suggestion_count",
        "ai_item_count",
        "ai_reviewed_count",
        "ai_reused_count",
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
    unanswered = len(progress["ai_unanswered_ids"])
    diagnostics = progress["ai_diagnostics"]
    run.status = (
        "partial"
        if remaining or progress["unavailable"] or unanswered or diagnostics
        else "completed"
    )
    reasons = [
        f"{remaining} items unfinished. Resume to continue without repeating completed batches."
        if remaining
        else f"{progress['unavailable']} items became unavailable or left the selected scope."
        if progress["unavailable"]
        else None,
        unanswered_note(unanswered, diagnostics) or None,
    ]
    run.partial_reason = " ".join(reason for reason in reasons if reason) or None
    run.completed_at = result.completed_at if not remaining else None
    db.flush()
    return _run_out(run)


class _InferenceRequest(Exception):
    def __init__(self, system, prompt, config):
        self.system, self.prompt, self.config = system, prompt, config


def advance_detached(
    db: Session,
    household_id: uuid.UUID,
    run_id: uuid.UUID,
    version: int,
    *,
    actor_id: uuid.UUID,
    actor_name: str,
    allow_ai: bool,
    resume: bool = False,
):
    """Replay the same batch around inference, with no transaction held during the call."""
    from .. import ai

    run = _locked(db, household_id, run_id)
    if not run.include_ai:
        return advance(
            db,
            household_id,
            run_id,
            version,
            actor_id=actor_id,
            actor_name=actor_name,
            allow_ai=allow_ai,
            resume=resume,
        )
    if not allow_ai:
        raise ApiError(403, "owner_required", "Only the owner can resume AI review.")
    progress = dict(run.progress_json)
    if (
        version != progress["version"]
        or progress["state"] == "completed"
        or (progress["state"] == "cancelled" and not resume)
    ):
        return _run_out(run)
    now = datetime.now(UTC)
    lease = progress.get("inference_lease")
    if lease and datetime.fromisoformat(lease["until"]) > now:
        raise ApiError(
            409,
            "review_batch_running",
            "This batch is already being reviewed. Wait for progress or cancel it.",
        )
    token = str(uuid.uuid4())
    run.progress_json = {
        **progress,
        "state": "running",
        "inference_lease": {"token": token, "until": (now + timedelta(seconds=120)).isoformat()},
    }
    db.commit()
    options = dict(actor_id=actor_id, actor_name=actor_name, allow_ai=allow_ai, resume=resume)

    def capture(system, prompt, *, config):
        raise _InferenceRequest(system, prompt, config)

    try:
        request = None
        try:
            result = advance(db, household_id, run_id, version, ai_inference=capture, **options)
        except _InferenceRequest as pending:
            request = pending
            db.rollback()
        if request is not None:
            failure = None
            try:
                with ai.bounded_request_deadline(90):
                    raw = ai.complete_json(request.system, request.prompt, config=request.config)
            except ai.AiError as exc:
                failure = exc

            if (
                db.scalar(
                    select(HouseholdMember.role).where(
                        HouseholdMember.household_id == household_id,
                        HouseholdMember.user_id == actor_id,
                    )
                )
                != "owner"
            ):
                raise ApiError(
                    403,
                    "review_permission_changed",
                    "Review permissions changed during inference; this batch was not published.",
                )

            def replay(system, prompt, *, config):
                if (system, prompt, config) != (request.system, request.prompt, request.config):
                    raise ApiError(
                        409,
                        "review_inputs_changed",
                        "Review inputs changed during inference. Resume with current information.",
                    )
                if failure is not None:
                    raise failure
                return raw

            result = advance(db, household_id, run_id, version, ai_inference=replay, **options)
        return result
    except Exception:
        db.rollback()
        raise
    finally:
        current = _locked(db, household_id, run_id)
        progress = dict(current.progress_json)
        if (progress.get("inference_lease") or {}).get("token") == token:
            progress.pop("inference_lease", None)
            if progress["state"] == "running":
                progress["state"] = "paused"
            current.progress_json = progress
        db.commit()
