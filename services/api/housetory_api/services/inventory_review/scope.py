"""Inventory review scope loading and limits."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload

from ...api.errors import ApiError
from ...models import (
    Item,
    Property,
    Room,
    StorageLocation,
)
from ...schemas.inventory_review import (
    ReviewRunRequest,
)
from ..hierarchy import descendant_ids
from ..serializers import item_load_options

MAX_SCAN_ITEMS = 500
MAX_AI_ITEMS = 40
MAX_PAIR_SUGGESTIONS = 20
MAX_ADVISORY_SUGGESTIONS = 30
MAX_EVIDENCE_ITEMS = 12
ACTIVE_ITEM_FILTER = Item.is_archived.is_(False)


@dataclass
class _Scope:
    kind: str
    label: str
    scope_id: uuid.UUID | None
    total_count: int
    items: list[Item]


def _normalized(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def _hash(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _scope_conditions(
    db: Session,
    household_id: uuid.UUID,
    payload: ReviewRunRequest,
) -> tuple[list[Any], str, uuid.UUID | None]:
    conditions: list[Any] = [Item.household_id == household_id, ACTIVE_ITEM_FILTER]
    scope_id = payload.scope_id
    if payload.scope_type == "household":
        return conditions, "Whole household", None
    if payload.scope_type == "items":
        ids = list(payload.item_ids or [])
        found = set(
            db.scalars(
                select(Item.id).where(Item.household_id == household_id, Item.id.in_(ids))
            ).all()
        )
        if len(found) != len(ids):
            raise ApiError(
                404,
                "review_items_unavailable",
                "One or more selected items are unavailable in this household.",
            )
        conditions.append(Item.id.in_(ids))
        return conditions, f"Selected items ({len(ids)})", None
    if payload.scope_type == "property":
        property_record = db.scalar(
            select(Property).where(Property.id == scope_id, Property.household_id == household_id)
        )
        if property_record is None:
            raise ApiError(404, "property_not_found", "Property not found.")
        conditions.append(
            or_(
                Item.room.has(Room.property_id == property_record.id),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == property_record.id)
                ),
            )
        )
        return conditions, property_record.name, property_record.id
    if payload.scope_type == "room":
        room = db.scalar(select(Room).where(Room.id == scope_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(404, "room_not_found", "Room not found.")
        rows = db.execute(
            select(Room.id, Room.parent_id).where(Room.household_id == household_id)
        ).all()
        conditions.append(Item.room_id.in_(descendant_ids(rows, room.id)))
        return conditions, f"Room: {room.name}", room.id
    if payload.scope_type == "container":
        location = db.scalar(
            select(StorageLocation)
            .options(joinedload(StorageLocation.room))
            .where(
                StorageLocation.id == scope_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            raise ApiError(404, "location_not_found", "Container or place not found.")
        rows = db.execute(
            select(StorageLocation.id, StorageLocation.parent_id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        ).all()
        conditions.append(Item.storage_location_id.in_(descendant_ids(rows, location.id)))
        label = f"{location.identifier or location.name} · {location.room.name}"
        return conditions, label, location.id
    raise ApiError(422, "invalid_review_scope", "Choose a valid review scope.")


def _load_scope(
    db: Session,
    household_id: uuid.UUID,
    payload: ReviewRunRequest,
    *,
    max_items: int = MAX_SCAN_ITEMS,
    prioritize_since: datetime | None = None,
    scan_offset: int = 0,
) -> _Scope:
    conditions, label, scope_id = _scope_conditions(db, household_id, payload)
    total = int(db.scalar(select(func.count(Item.id)).where(*conditions)) or 0)
    limit = max(1, min(max_items, MAX_SCAN_ITEMS))

    if prioritize_since is None and scan_offset == 0:
        # Preserve the on-demand review ordering exactly: newest first, bounded.
        items = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(*conditions)
                .order_by(Item.updated_at.desc(), Item.id)
                .limit(limit + (1 if limit == MAX_SCAN_ITEMS else 0))
            ).all()
        )
        if len(items) > limit:
            items = items[:limit]
        return _Scope(
            kind=payload.scope_type,
            label=label,
            scope_id=scope_id,
            total_count=total,
            items=items,
        )

    items: list[Item] = []
    if prioritize_since is not None:
        items = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(*conditions, Item.updated_at > prioritize_since)
                .order_by(Item.updated_at.desc(), Item.id)
                .limit(limit)
            ).all()
        )

    remaining = limit - len(items)
    if remaining > 0:
        selected_ids = {item.id for item in items}
        remaining_conditions = list(conditions)
        if selected_ids:
            remaining_conditions.append(Item.id.not_in(selected_ids))
        remaining_total = int(
            db.scalar(select(func.count(Item.id)).where(*remaining_conditions)) or 0
        )
        if remaining_total:
            offset = scan_offset % remaining_total
            window = list(
                db.scalars(
                    select(Item)
                    .options(*item_load_options())
                    .where(*remaining_conditions)
                    .order_by(Item.updated_at.asc(), Item.id)
                    .offset(offset)
                    .limit(remaining)
                ).all()
            )
            if len(window) < remaining and offset > 0:
                window.extend(
                    db.scalars(
                        select(Item)
                        .options(*item_load_options())
                        .where(*remaining_conditions)
                        .order_by(Item.updated_at.asc(), Item.id)
                        .limit(remaining - len(window))
                    ).all()
                )
            items.extend(window)

    return _Scope(
        kind=payload.scope_type,
        label=label,
        scope_id=scope_id,
        total_count=total,
        items=items,
    )


def _item_evidence(item: Item) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "name": item.name,
        "quantity": item.quantity,
        "brand": item.brand,
        "model": item.model,
        "serial_number": item.serial_number,
        "is_archived": item.is_archived,
        "room": item.room.name if item.room else None,
        "location": item.storage_location_id
        and (item.storage_location.name if item.storage_location else None),
        "category": item.category.name if item.category else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }
