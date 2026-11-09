"""Inventory review suggestion serialisation."""

from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import (
    Category,
    InventoryReviewSuggestion,
    Item,
    Tag,
)
from ...schemas.inventory_review import (
    ReviewSuggestionOut,
)
from .. import lending
from ..serializers import item_load_options, item_summary


def _serialize_item(db: Session, item_id: uuid.UUID | None) -> dict[str, Any] | None:
    if item_id is None:
        return None
    item = db.scalar(select(Item).options(*item_load_options()).where(Item.id == item_id))
    if item is None:
        return None
    loans = lending.loan_quantities_for_items(db, item.household_id, [item.id])
    return item_summary(item, on_loan_quantity=loans.get(item.id, 0)).model_dump(mode="json")


def _uuid_list(value: Any) -> list[uuid.UUID] | None:
    if not isinstance(value, list):
        return None
    try:
        return list(dict.fromkeys(uuid.UUID(str(entry)) for entry in value))
    except (TypeError, ValueError):
        return None


def _clean_taxonomy_name(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    if not cleaned or len(cleaned) > limit:
        return None
    return cleaned


def _owned_tags(db: Session, household_id: uuid.UUID, tag_ids: list[uuid.UUID]) -> list[Tag] | None:
    if not tag_ids:
        return []
    records = list(
        db.scalars(select(Tag).where(Tag.household_id == household_id, Tag.id.in_(tag_ids))).all()
    )
    if len(records) != len(tag_ids):
        return None
    return records


def _organisation_undo_blocker(
    db: Session,
    household_id: uuid.UUID,
    suggestion: InventoryReviewSuggestion,
    item: Item,
) -> str | None:
    before = suggestion.before_json or {}
    after = suggestion.after_json or {}
    before_tag_ids = _uuid_list(before.get("tag_ids"))
    after_tag_ids = _uuid_list(after.get("tag_ids"))
    expected_category = after.get("applied_category_id")
    current_category = str(item.category_id) if item.category_id else None
    if current_category != expected_category:
        return "The item category changed after apply."
    if after_tag_ids is None or {tag.id for tag in item.tags} != set(after_tag_ids):
        return "The item tags changed after apply."
    before_category = before.get("category_id")
    if before_category:
        original_category = db.scalar(
            select(Category.id).where(
                Category.id == uuid.UUID(str(before_category)),
                Category.household_id == household_id,
            )
        )
        if original_category is None:
            return "The original category no longer exists."
    if before_tag_ids is None:
        return "The original tags are unavailable."
    if _owned_tags(db, household_id, before_tag_ids) is None:
        return "One or more original tags no longer exist."
    return None


def serialize_suggestion(db: Session, suggestion: InventoryReviewSuggestion) -> ReviewSuggestionOut:
    can_undo = False
    undo_blocked_reason = None
    if suggestion.status == "accepted":
        if suggestion.item_id is None:
            undo_blocked_reason = "The source item no longer exists."
        elif suggestion.applied_item_updated_at is None:
            undo_blocked_reason = "The applied item version is unavailable."
        else:
            item = db.get(Item, suggestion.item_id)
            if item is None:
                undo_blocked_reason = "The source item no longer exists."
            elif item.updated_at != suggestion.applied_item_updated_at:
                undo_blocked_reason = "The item changed after this suggestion was applied."
            elif suggestion.type == "category":
                before_category = (suggestion.before_json or {}).get("category_id")
                current_category = str(item.category_id) if item.category_id else None
                if current_category != (suggestion.after_json or {}).get("category_id"):
                    undo_blocked_reason = "The item category changed after apply."
                elif before_category and db.get(Category, uuid.UUID(str(before_category))) is None:
                    undo_blocked_reason = "The original category no longer exists."
                else:
                    can_undo = True
            elif suggestion.type == "organisation":
                undo_blocked_reason = _organisation_undo_blocker(
                    db, suggestion.household_id, suggestion, item
                )
                can_undo = undo_blocked_reason is None
            elif suggestion.type == "name":
                if item.name != (suggestion.after_json or {}).get("name"):
                    undo_blocked_reason = "The item name changed after apply."
                else:
                    can_undo = True
    return ReviewSuggestionOut(
        id=suggestion.id,
        run_id=suggestion.run_id,
        type=suggestion.type,  # type: ignore[arg-type]
        action_kind=suggestion.action_kind,  # type: ignore[arg-type]
        status=suggestion.status,  # type: ignore[arg-type]
        source=suggestion.source,
        priority=suggestion.priority,
        title=suggestion.title,
        explanation=suggestion.explanation,
        scope_type=suggestion.scope_type,  # type: ignore[arg-type]
        scope_id=suggestion.scope_id,
        item_id=suggestion.item_id,
        secondary_item_id=suggestion.secondary_item_id,
        category_id=suggestion.category_id,
        before=suggestion.before_json or {},
        after=suggestion.after_json or {},
        evidence=suggestion.evidence_json or {},
        fingerprint=suggestion.fingerprint,
        created_at=suggestion.created_at,
        updated_at=suggestion.updated_at,
        accepted_at=suggestion.accepted_at,
        applied_at=suggestion.applied_at,
        dismissed_at=suggestion.dismissed_at,
        reverted_at=suggestion.reverted_at,
        can_undo=can_undo,
        undo_blocked_reason=undo_blocked_reason,
        item=_serialize_item(db, suggestion.item_id),
        secondary_item=_serialize_item(db, suggestion.secondary_item_id),
    )
