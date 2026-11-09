"""Persistent, rule-first inventory review suggestions.

Analysis never changes inventory. Only explicit accept actions mutate compatible
category/name/organisation suggestions; duplicate and missing-detail findings stay advisory.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...domain import ActivityAction, AiTask
from ...models import (
    InventoryReviewRun,
    InventoryReviewSuggestion,
    Item,
)
from ...schemas.inventory_review import (
    ReviewRunOut,
    ReviewRunRequest,
    ReviewScopeItemsOut,
    ReviewSuggestionListOut,
    ReviewSummaryOut,
)
from .. import ai, history, lending
from ..serializers import item_load_options, item_summary
from .candidates import (
    _advisory_candidates,
    _ai_organisation_candidates,
    _Candidate,
    _candidate_fingerprint,
    _category_candidates,
    _create_suggestion,
    _duplicate_candidates,
    _name_candidates,
)
from .decisions import accept_suggestion as accept_suggestion
from .decisions import bulk_accept as bulk_accept
from .decisions import dismiss_suggestion as dismiss_suggestion
from .decisions import undo_suggestion as undo_suggestion
from .scope import MAX_SCAN_ITEMS, _hash, _load_scope
from .scope import _scope_conditions as _scope_conditions
from .suggestion_out import serialize_suggestion


def _request_fingerprint(payload: ReviewRunRequest) -> str:
    return _hash(
        {
            "scope_type": payload.scope_type,
            "scope_id": str(payload.scope_id) if payload.scope_id else None,
            "item_ids": sorted(str(value) for value in (payload.item_ids or [])),
            "include_ai": payload.include_ai,
        }
    )


def _run_out(run: InventoryReviewRun) -> ReviewRunOut:
    return ReviewRunOut.model_validate(run, from_attributes=True)


def run_review(
    db: Session,
    household_id: uuid.UUID,
    payload: ReviewRunRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    allow_ai: bool,
    max_items: int = MAX_SCAN_ITEMS,
    prioritize_since: datetime | None = None,
    scan_offset: int = 0,
    trigger_type: str = "manual",
    schedule_id: uuid.UUID | None = None,
    ai_skip_note: str | None = None,
) -> ReviewRunOut:
    request_fingerprint = _request_fingerprint(payload)
    existing = db.scalar(
        select(InventoryReviewRun).where(
            InventoryReviewRun.household_id == household_id,
            InventoryReviewRun.request_id == payload.request_id,
        )
    )
    if existing is not None:
        if existing.request_fingerprint != request_fingerprint:
            raise ApiError(
                409,
                "review_request_reused",
                "That review request id was used for a different scope.",
            )
        return _run_out(existing)
    scope = _load_scope(
        db,
        household_id,
        payload,
        max_items=max_items,
        prioritize_since=prioritize_since,
        scan_offset=scan_offset,
    )
    run = InventoryReviewRun(
        household_id=household_id,
        request_id=payload.request_id,
        request_fingerprint=request_fingerprint,
        trigger_type=trigger_type,
        schedule_id=schedule_id,
        scope_type=payload.scope_type,
        scope_id=scope.scope_id,
        scope_label=scope.label,
        include_ai=payload.include_ai,
        total_item_count=scope.total_count,
        item_count_scanned=len(scope.items),
        created_by_user_id=actor_user_id,
    )
    db.add(run)
    db.flush()
    candidates = [
        *_category_candidates(scope),
        *_name_candidates(scope),
        *_duplicate_candidates(scope),
        *_advisory_candidates(scope, db, household_id),
    ]
    ai_meta: dict[str, Any] = {}
    ai_error = None
    ai_partial = None
    ai_used = False
    if payload.include_ai:
        if not allow_ai:
            ai_error = "Only the household owner can run the optional AI review pass."
        elif ai_skip_note:
            ai_error = ai_skip_note
            status = ai.status_for(db, household_id, AiTask.ASSISTANT.value, probe=False)
            ai_meta = {
                "provider": status.provider_label or status.provider,
                "model": status.model,
                "item_count": 0,
            }
        else:
            already_targeted = {
                candidate.item_id
                for candidate in candidates
                if candidate.type == "category" and candidate.item_id
            }
            ai_candidates, ai_meta, ai_partial, ai_error = _ai_organisation_candidates(
                db, household_id, scope, already_targeted
            )
            ai_used = bool(ai_meta.get("attempted"))
            candidates.extend(ai_candidates)
    elif ai_skip_note:
        ai_error = ai_skip_note
    partial_reason = ai_partial
    if len(scope.items) < scope.total_count:
        reason = f"Reviewed {len(scope.items)} of {scope.total_count} items in this bounded scan."
        partial_reason = f"{partial_reason} {reason}".strip() if partial_reason else reason
    run.partial_reason = partial_reason
    run.ai_error = ai_error
    run.ai_used = ai_used
    run.ai_item_count = int(ai_meta.get("item_count", 0))
    run.ai_provider_label = ai_meta.get("provider")
    run.ai_model = ai_meta.get("model")

    fingerprints: dict[str, _Candidate] = {}
    for candidate in candidates:
        fingerprints[_candidate_fingerprint(candidate)] = candidate
    existing_rows = list(
        db.scalars(
            select(InventoryReviewSuggestion).where(
                InventoryReviewSuggestion.household_id == household_id,
                InventoryReviewSuggestion.fingerprint.in_(fingerprints),
            )
        ).all()
    )
    existing_by_fingerprint = {row.fingerprint: row for row in existing_rows}
    created = 0
    existing_count = 0
    suppressed = 0
    for fingerprint, candidate in fingerprints.items():
        prior = existing_by_fingerprint.get(fingerprint)
        if prior is not None:
            if prior.status == "pending":
                existing_count += 1
            else:
                suppressed += 1
            continue
        _create_suggestion(db, household_id, run, candidate, fingerprint)
        created += 1

    scanned_ids = [item.id for item in scope.items]
    pending_rows = list(
        db.scalars(
            select(InventoryReviewSuggestion).where(
                InventoryReviewSuggestion.household_id == household_id,
                InventoryReviewSuggestion.status == "pending",
                InventoryReviewSuggestion.item_id.in_(scanned_ids),
            )
        ).all()
    )
    stale = 0
    for row in pending_rows:
        if row.fingerprint in fingerprints:
            continue
        row.status = "stale"
        row.status_changed_at = datetime.now(UTC)
        stale += 1
    run.created_suggestion_count = created
    run.existing_suggestion_count = existing_count
    run.stale_suggestion_count = stale
    run.suppressed_suggestion_count = suppressed
    run.status = "partial" if run.partial_reason or run.ai_error else "completed"
    run.completed_at = datetime.now(UTC)
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.INVENTORY_REVIEW_COMPLETED.value,
        entity_type="batch",
        entity_id=run.id,
        summary=(
            f"Inventory review {run.status} for {scope.label}: "
            f"{created} new suggestion(s), {existing_count} existing, "
            f"{stale} stale, {suppressed} previously resolved"
        ),
        details={
            "run_id": str(run.id),
            "scope_type": run.scope_type,
            "scope_id": str(run.scope_id) if run.scope_id else None,
            "scope_label": run.scope_label,
            "total_item_count": run.total_item_count,
            "item_count_scanned": run.item_count_scanned,
            "created_suggestion_count": created,
            "existing_suggestion_count": existing_count,
            "stale_suggestion_count": stale,
            "suppressed_suggestion_count": suppressed,
            "ai_used": run.ai_used,
            "ai_item_count": run.ai_item_count,
            "ai_error": run.ai_error,
            "partial_reason": run.partial_reason,
        },
    )
    db.flush()
    return _run_out(run)


def list_suggestions(
    db: Session,
    household_id: uuid.UUID,
    *,
    status: str | None,
    suggestion_type: str | None,
    scope_type: str | None,
    scope_id: uuid.UUID | None,
    q: str | None,
    limit: int,
    offset: int,
) -> ReviewSuggestionListOut:
    conditions = [InventoryReviewSuggestion.household_id == household_id]
    if status:
        conditions.append(InventoryReviewSuggestion.status == status)
    if suggestion_type:
        conditions.append(InventoryReviewSuggestion.type == suggestion_type)
    if scope_type:
        conditions.append(InventoryReviewSuggestion.scope_type == scope_type)
    if scope_id:
        conditions.append(InventoryReviewSuggestion.scope_id == scope_id)
    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        conditions.append(
            or_(
                InventoryReviewSuggestion.title.ilike(search),
                InventoryReviewSuggestion.explanation.ilike(search),
            )
        )
    total = int(db.scalar(select(func.count(InventoryReviewSuggestion.id)).where(*conditions)) or 0)
    rows = list(
        db.scalars(
            select(InventoryReviewSuggestion)
            .where(*conditions)
            .order_by(
                case((InventoryReviewSuggestion.status == "pending", 0), else_=1),
                InventoryReviewSuggestion.priority.desc(),
                InventoryReviewSuggestion.created_at.desc(),
            )
            .limit(limit)
            .offset(offset)
        ).all()
    )
    status_counts = {
        str(status_value): int(count)
        for status_value, count in db.execute(
            select(InventoryReviewSuggestion.status, func.count())
            .where(InventoryReviewSuggestion.household_id == household_id)
            .group_by(InventoryReviewSuggestion.status)
        ).all()
    }
    type_counts = {
        str(type_value): int(count)
        for type_value, count in db.execute(
            select(InventoryReviewSuggestion.type, func.count())
            .where(InventoryReviewSuggestion.household_id == household_id)
            .group_by(InventoryReviewSuggestion.type)
        ).all()
    }
    return ReviewSuggestionListOut(
        items=[serialize_suggestion(db, row) for row in rows],
        total=total,
        pending_count=status_counts.get("pending", 0),
        status_counts=status_counts,
        type_counts=type_counts,
    )


def review_summary(db: Session, household_id: uuid.UUID) -> ReviewSummaryOut:
    status_counts = {
        str(status): int(count)
        for status, count in db.execute(
            select(InventoryReviewSuggestion.status, func.count())
            .where(InventoryReviewSuggestion.household_id == household_id)
            .group_by(InventoryReviewSuggestion.status)
        ).all()
    }
    type_counts = {
        str(type_value): int(count)
        for type_value, count in db.execute(
            select(InventoryReviewSuggestion.type, func.count())
            .where(InventoryReviewSuggestion.household_id == household_id)
            .group_by(InventoryReviewSuggestion.type)
        ).all()
    }
    last_run = db.scalar(
        select(InventoryReviewRun)
        .where(InventoryReviewRun.household_id == household_id)
        .order_by(InventoryReviewRun.created_at.desc())
        .limit(1)
    )
    from ..inventory_review_schedule import schedule_summary

    return ReviewSummaryOut(
        pending_count=status_counts.get("pending", 0),
        status_counts=status_counts,
        type_counts=type_counts,
        last_run=_run_out(last_run) if last_run else None,
        schedule=schedule_summary(db, household_id),
    )


def scope_items(
    db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]
) -> ReviewScopeItemsOut:
    if len(item_ids) > 100:
        raise ApiError(422, "review_scope_too_large", "Select at most 100 items.")
    items = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(Item.household_id == household_id, Item.id.in_(item_ids))
            .order_by(func.lower(Item.name))
        ).all()
    )
    if len(items) != len(set(item_ids)):
        raise ApiError(
            404, "review_items_unavailable", "One or more selected items are unavailable."
        )
    loans = lending.loan_quantities_for_items(db, household_id, [item.id for item in items])
    return ReviewScopeItemsOut(
        items=[
            item_summary(item, on_loan_quantity=loans.get(item.id, 0)).model_dump(mode="json")
            for item in items
        ]
    )


__all__ = [
    "accept_suggestion",
    "bulk_accept",
    "dismiss_suggestion",
    "list_suggestions",
    "review_summary",
    "run_review",
    "scope_items",
    "serialize_suggestion",
    "undo_suggestion",
]
