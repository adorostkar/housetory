"""Accepting, dismissing and undoing inventory review suggestions."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...domain import ActivityAction
from ...models import (
    Category,
    InventoryReviewSuggestion,
    Item,
    Tag,
)
from ...schemas.inventory_review import (
    ReviewAcceptRequest,
    ReviewBulkAcceptOut,
    ReviewDecisionOut,
)
from .. import history, storage_items
from .scope import _normalized
from .suggestion_out import (
    _clean_taxonomy_name,
    _organisation_undo_blocker,
    _owned_tags,
    _uuid_list,
    serialize_suggestion,
)


def _load_suggestion(
    db: Session, household_id: uuid.UUID, suggestion_id: uuid.UUID
) -> InventoryReviewSuggestion:
    suggestion = db.scalar(
        select(InventoryReviewSuggestion)
        .where(
            InventoryReviewSuggestion.id == suggestion_id,
            InventoryReviewSuggestion.household_id == household_id,
        )
        .with_for_update()
    )
    if suggestion is None:
        raise ApiError(404, "review_suggestion_not_found", "Review suggestion not found.")
    return suggestion


def _decision(
    db: Session,
    suggestion: InventoryReviewSuggestion,
    status: Literal["applied", "stale", "skipped", "unsupported"],
    message: str,
) -> ReviewDecisionOut:
    db.flush()
    return ReviewDecisionOut(
        suggestion_id=suggestion.id,
        status=status,
        message=message,
        suggestion=serialize_suggestion(db, suggestion),
    )


def accept_suggestion(
    db: Session,
    household_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    payload: ReviewAcceptRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> ReviewDecisionOut:
    suggestion = _load_suggestion(db, household_id, suggestion_id)
    if suggestion.status == "accepted":
        return _decision(db, suggestion, "skipped", "This suggestion is already accepted.")
    if suggestion.status != "pending":
        return _decision(
            db,
            suggestion,
            "skipped",
            f"This suggestion is {suggestion.status}; nothing was changed.",
        )
    if suggestion.action_kind == "advisory":
        return _decision(
            db,
            suggestion,
            "unsupported",
            "This finding is advisory. Open the item or compare the records; "
            "it has no automatic inventory action.",
        )
    item = db.scalar(
        select(Item)
        .where(Item.id == suggestion.item_id, Item.household_id == household_id)
        .with_for_update()
    )
    if item is None:
        suggestion.status = "stale"
        suggestion.status_changed_at = datetime.now(UTC)
        return _decision(
            db, suggestion, "stale", "The source item no longer exists; suggestion marked stale."
        )
    before_updated = (suggestion.before_json or {}).get("item_updated_at")
    current_updated = item.updated_at.isoformat() if item.updated_at else None
    if before_updated != current_updated:
        suggestion.status = "stale"
        suggestion.status_changed_at = datetime.now(UTC)
        return _decision(
            db,
            suggestion,
            "stale",
            "The item changed after analysis. Suggestion marked stale; run review again.",
        )
    if suggestion.type == "category":
        category_id = payload.category_id or suggestion.category_id
        if category_id is None:
            return _decision(db, suggestion, "unsupported", "No category was proposed.")
        category = db.scalar(
            select(Category).where(
                Category.id == category_id, Category.household_id == household_id
            )
        )
        if category is None:
            return _decision(db, suggestion, "unsupported", "The chosen category is unavailable.")
        before_category = (suggestion.before_json or {}).get("category_id")
        current_category = str(item.category_id) if item.category_id else None
        if current_category != before_category:
            suggestion.status = "stale"
            suggestion.status_changed_at = datetime.now(UTC)
            return _decision(
                db,
                suggestion,
                "stale",
                "The item category changed after analysis; suggestion marked stale.",
            )
        item.category_id = category.id
        after = {"category_id": str(category.id), "category_name": category.name}
        action = ActivityAction.INVENTORY_REVIEW_CATEGORY_APPLIED.value
        summary = f"Applied review category “{category.name}” to {item.name}"
    elif suggestion.type == "organisation":
        before = suggestion.before_json or {}
        proposed = suggestion.after_json or {}
        before_tag_ids = _uuid_list(before.get("tag_ids"))
        before_category = before.get("category_id")
        current_category = str(item.category_id) if item.category_id else None
        current_tag_ids = {tag.id for tag in item.tags}
        if current_category != before_category or before_tag_ids is None:
            suggestion.status = "stale"
            suggestion.status_changed_at = datetime.now(UTC)
            return _decision(
                db,
                suggestion,
                "stale",
                "The item organisation changed after analysis; suggestion marked stale.",
            )
        if current_tag_ids != set(before_tag_ids):
            suggestion.status = "stale"
            suggestion.status_changed_at = datetime.now(UTC)
            return _decision(
                db,
                suggestion,
                "stale",
                "The item tags changed after analysis; suggestion marked stale.",
            )

        raw_category_name = proposed.get("category_name")
        category_name = _clean_taxonomy_name(raw_category_name, 80)
        if raw_category_name is not None and category_name is None:
            return _decision(
                db, suggestion, "unsupported", "The proposed category name is invalid."
            )
        category = None
        create_category = False
        if category_name is not None:
            raw_category_id = proposed.get("category_id")
            if raw_category_id:
                try:
                    proposed_category_id = uuid.UUID(str(raw_category_id))
                except ValueError:
                    return _decision(
                        db, suggestion, "unsupported", "The proposed category is unavailable."
                    )
                category = db.scalar(
                    select(Category).where(
                        Category.id == proposed_category_id,
                        Category.household_id == household_id,
                    )
                )
                if category is None:
                    return _decision(
                        db, suggestion, "unsupported", "The proposed category is unavailable."
                    )
            else:
                category = db.scalar(
                    select(Category)
                    .where(
                        Category.household_id == household_id,
                        Category.parent_id.is_(None),
                        func.lower(Category.name) == category_name.lower(),
                    )
                    .order_by(Category.id)
                    .limit(1)
                )
                create_category = category is None
            if category is not None and category.id == item.category_id:
                category = None
                category_name = None
                create_category = False

        raw_tags = proposed.get("tags", [])
        if not isinstance(raw_tags, list) or len(raw_tags) > 3:
            return _decision(db, suggestion, "unsupported", "The proposed tags are invalid.")
        tag_options: list[dict[str, Any]] = []
        seen_tags = {_normalized(tag.name) for tag in item.tags}
        for raw_tag in raw_tags:
            if not isinstance(raw_tag, dict):
                return _decision(db, suggestion, "unsupported", "The proposed tags are invalid.")
            raw_tag_id = raw_tag.get("id")
            tag = None
            if raw_tag_id:
                try:
                    proposed_tag_id = uuid.UUID(str(raw_tag_id))
                except ValueError:
                    return _decision(
                        db, suggestion, "unsupported", "A proposed tag is unavailable."
                    )
                tag = db.scalar(
                    select(Tag).where(Tag.id == proposed_tag_id, Tag.household_id == household_id)
                )
                if tag is None:
                    return _decision(
                        db, suggestion, "unsupported", "A proposed tag is unavailable."
                    )
                tag_name = tag.name
            else:
                tag_name = _clean_taxonomy_name(raw_tag.get("name"), 60)
                if tag_name is None:
                    return _decision(
                        db, suggestion, "unsupported", "A proposed tag name is invalid."
                    )
                tag = db.scalar(
                    select(Tag)
                    .where(
                        Tag.household_id == household_id,
                        func.lower(Tag.name) == tag_name.lower(),
                    )
                    .order_by(Tag.id)
                    .limit(1)
                )
            normalized_tag = _normalized(tag.name if tag else tag_name)
            if normalized_tag in seen_tags:
                continue
            seen_tags.add(normalized_tag)
            tag_options.append({"record": tag, "name": tag.name if tag else tag_name})
        if category is None and category_name is None and not tag_options:
            return _decision(
                db, suggestion, "unsupported", "The organisation suggestion is already applied."
            )

        category_created = False
        if create_category and category_name is not None:
            category = Category(household_id=household_id, name=category_name, parent_id=None)
            db.add(category)
            category_created = True
        resolved_tags: list[tuple[Tag, bool]] = []
        for option in tag_options:
            tag = option["record"]
            created = False
            if tag is None:
                tag = Tag(household_id=household_id, name=option["name"])
                db.add(tag)
                created = True
            resolved_tags.append((tag, created))
        db.flush()
        if category is not None:
            item.category_id = category.id
        desired_tags = {tag.id: tag for tag in item.tags}
        for tag, _created in resolved_tags:
            desired_tags[tag.id] = tag
        if resolved_tags:
            item.tags = list(desired_tags.values())
        item.updated_at = datetime.now(UTC)
        after = dict(proposed)
        after.update(
            {
                "category_id": str(category.id) if category else before_category,
                "category_name": category.name if category else None,
                "category_is_new": category_created,
                "tags": [
                    {"id": str(tag.id), "name": tag.name, "is_new": created}
                    for tag, created in resolved_tags
                ],
                "tag_ids": sorted(str(tag_id) for tag_id in desired_tags),
                "tag_names": sorted(tag.name for tag in desired_tags.values()),
                "applied_category_id": str(item.category_id) if item.category_id else None,
            }
        )
        action = ActivityAction.INVENTORY_REVIEW_ORGANISATION_APPLIED.value
        summary = f"Applied review organisation to {item.name}"
        if category_created:
            summary += f"; created category “{category.name}”" if category else ""
    elif suggestion.type == "name":
        proposed_name = (payload.name or (suggestion.after_json or {}).get("name") or "").strip()
        if not proposed_name:
            return _decision(db, suggestion, "unsupported", "No name was proposed.")
        if len(proposed_name) > 200:
            return _decision(db, suggestion, "unsupported", "The proposed name is too long.")
        owned = storage_items.active_owned_location(db, household_id, item.id)
        if owned is not None and len(proposed_name) > 120:
            return _decision(
                db,
                suggestion,
                "unsupported",
                "This item provides storage; its place name supports up to 120 characters.",
            )
        before_name = (suggestion.before_json or {}).get("name")
        if item.name != before_name:
            suggestion.status = "stale"
            suggestion.status_changed_at = datetime.now(UTC)
            return _decision(
                db,
                suggestion,
                "stale",
                "The item name changed after analysis; suggestion marked stale.",
            )
        item.name = proposed_name
        if owned is not None:
            owned.name = proposed_name
        after = {"name": proposed_name}
        action = ActivityAction.INVENTORY_REVIEW_NAME_APPLIED.value
        summary = f"Applied review name “{proposed_name}” (was “{before_name}”)"
    else:
        return _decision(
            db, suggestion, "unsupported", "This suggestion type has no safe apply action."
        )
    db.flush()
    db.refresh(item)
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="item",
        entity_id=item.id,
        item_id=item.id,
        summary=summary,
        details={
            "suggestion_id": str(suggestion.id),
            "suggestion_type": suggestion.type,
            "before": suggestion.before_json or {},
            "after": after,
        },
    )
    now = datetime.now(UTC)
    suggestion.after_json = after
    suggestion.status = "accepted"
    suggestion.status_changed_at = now
    suggestion.accepted_at = now
    suggestion.applied_at = now
    suggestion.applied_item_updated_at = item.updated_at
    suggestion.applied_history_event_id = event.id
    suggestion.applied_by_user_id = actor_user_id
    return _decision(db, suggestion, "applied", "Suggestion applied to the item.")


def dismiss_suggestion(
    db: Session,
    household_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    reason: str | None,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> ReviewDecisionOut:
    suggestion = _load_suggestion(db, household_id, suggestion_id)
    if suggestion.status == "dismissed":
        return _decision(db, suggestion, "skipped", "This suggestion is already dismissed.")
    if suggestion.status not in {"pending", "stale"}:
        return _decision(
            db,
            suggestion,
            "skipped",
            f"This suggestion is {suggestion.status}; it was not dismissed.",
        )
    suggestion.status = "dismissed"
    suggestion.status_changed_at = datetime.now(UTC)
    suggestion.dismissed_at = datetime.now(UTC)
    suggestion.dismissed_by_user_id = actor_user_id
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.INVENTORY_REVIEW_DISMISSED.value,
        entity_type="item" if suggestion.item_id else "batch",
        entity_id=suggestion.item_id or suggestion.id,
        item_id=suggestion.item_id,
        summary=f"Dismissed review suggestion: {suggestion.title}",
        details={
            "suggestion_id": str(suggestion.id),
            "suggestion_type": suggestion.type,
            "reason": (reason or "")[:300] or None,
        },
    )
    return _decision(db, suggestion, "skipped", "Suggestion dismissed.")


def undo_suggestion(
    db: Session,
    household_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> ReviewDecisionOut:
    suggestion = _load_suggestion(db, household_id, suggestion_id)
    if suggestion.status != "accepted":
        return _decision(
            db,
            suggestion,
            "skipped",
            f"This suggestion is {suggestion.status}; there is no applied change to undo.",
        )
    item = db.scalar(
        select(Item)
        .where(Item.id == suggestion.item_id, Item.household_id == household_id)
        .with_for_update()
    )
    if item is None:
        return _decision(db, suggestion, "stale", "The item no longer exists; undo is unavailable.")
    if (
        suggestion.applied_item_updated_at is None
        or item.updated_at != suggestion.applied_item_updated_at
    ):
        blocked = "The item changed after this suggestion was applied; undo is unsafe."
        suggestion_result = serialize_suggestion(db, suggestion)
        suggestion_result.undo_blocked_reason = blocked
        return ReviewDecisionOut(
            suggestion_id=suggestion.id,
            status="skipped",
            message=blocked,
            suggestion=suggestion_result,
        )
    if suggestion.type == "category":
        current = str(item.category_id) if item.category_id else None
        if current != (suggestion.after_json or {}).get("category_id"):
            return _decision(db, suggestion, "skipped", "The category changed; undo is unsafe.")
        before_category_id = (suggestion.before_json or {}).get("category_id")
        if before_category_id:
            category = db.scalar(
                select(Category).where(
                    Category.id == uuid.UUID(str(before_category_id)),
                    Category.household_id == household_id,
                )
            )
            if category is None:
                return _decision(
                    db, suggestion, "skipped", "The original category no longer exists."
                )
            item.category_id = category.id
        else:
            item.category_id = None
        action = ActivityAction.INVENTORY_REVIEW_CATEGORY_REVERTED.value
        summary = f"Reverted review category on {item.name}"
    elif suggestion.type == "organisation":
        blocked = _organisation_undo_blocker(db, household_id, suggestion, item)
        if blocked:
            return _decision(db, suggestion, "skipped", f"{blocked} Undo is unsafe.")
        before = suggestion.before_json or {}
        before_category_id = before.get("category_id")
        if before_category_id:
            original_category = db.scalar(
                select(Category).where(
                    Category.id == uuid.UUID(str(before_category_id)),
                    Category.household_id == household_id,
                )
            )
            if original_category is None:
                return _decision(
                    db, suggestion, "skipped", "The original category no longer exists."
                )
            item.category_id = original_category.id
        else:
            item.category_id = None
        before_tag_ids = _uuid_list(before.get("tag_ids"))
        original_tags = _owned_tags(db, household_id, before_tag_ids or [])
        if before_tag_ids is None or original_tags is None:
            return _decision(
                db, suggestion, "skipped", "One or more original tags no longer exist."
            )
        item.tags = original_tags
        item.updated_at = datetime.now(UTC)
        action = ActivityAction.INVENTORY_REVIEW_ORGANISATION_REVERTED.value
        summary = f"Reverted review organisation on {item.name}"
    elif suggestion.type == "name":
        if item.name != (suggestion.after_json or {}).get("name"):
            return _decision(db, suggestion, "skipped", "The name changed; undo is unsafe.")
        before_name = (suggestion.before_json or {}).get("name")
        if not before_name:
            return _decision(db, suggestion, "skipped", "The original name is unavailable.")
        owned = storage_items.active_owned_location(db, household_id, item.id)
        if owned is not None and len(before_name) > 120:
            return _decision(
                db,
                suggestion,
                "skipped",
                "The original name is too long for the item's storage place.",
            )
        item.name = before_name
        if owned is not None:
            owned.name = before_name
        action = ActivityAction.INVENTORY_REVIEW_NAME_REVERTED.value
        summary = f"Reverted review name to “{before_name}”"
    else:
        return _decision(db, suggestion, "unsupported", "This suggestion cannot be undone.")
    db.flush()
    db.refresh(item)
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="item",
        entity_id=item.id,
        item_id=item.id,
        summary=summary,
        details={
            "suggestion_id": str(suggestion.id),
            "suggestion_type": suggestion.type,
            "before": suggestion.after_json or {},
            "after": suggestion.before_json or {},
        },
    )
    suggestion.status = "reverted"
    suggestion.status_changed_at = datetime.now(UTC)
    suggestion.reverted_at = datetime.now(UTC)
    suggestion.revert_history_event_id = event.id
    return _decision(db, suggestion, "applied", "Applied review change reverted.")


def bulk_accept(
    db: Session,
    household_id: uuid.UUID,
    suggestion_ids: list[uuid.UUID],
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> ReviewBulkAcceptOut:
    results: list[ReviewDecisionOut] = []
    for suggestion_id in suggestion_ids:
        suggestion = db.scalar(
            select(InventoryReviewSuggestion).where(
                InventoryReviewSuggestion.id == suggestion_id,
                InventoryReviewSuggestion.household_id == household_id,
            )
        )
        if suggestion is None:
            results.append(
                ReviewDecisionOut(
                    suggestion_id=suggestion_id,
                    status="skipped",
                    message="Suggestion not found in this household.",
                )
            )
            continue
        if suggestion.status != "pending":
            results.append(
                ReviewDecisionOut(
                    suggestion_id=suggestion.id,
                    status="skipped",
                    message=f"Suggestion is {suggestion.status}.",
                    suggestion=serialize_suggestion(db, suggestion),
                )
            )
            continue
        if suggestion.action_kind == "advisory":
            results.append(
                ReviewDecisionOut(
                    suggestion_id=suggestion.id,
                    status="unsupported",
                    message="Advisory findings have no automatic inventory action.",
                    suggestion=serialize_suggestion(db, suggestion),
                )
            )
            continue
        result = accept_suggestion(
            db,
            household_id,
            suggestion.id,
            ReviewAcceptRequest(),
            actor_user_id=actor_user_id,
            actor_name=actor_name,
        )
        results.append(result)
    return ReviewBulkAcceptOut(
        applied_count=sum(1 for result in results if result.status == "applied"),
        skipped_count=sum(1 for result in results if result.status == "skipped"),
        stale_count=sum(1 for result in results if result.status == "stale"),
        unsupported_count=sum(1 for result in results if result.status == "unsupported"),
        results=results,
    )
