"""Bounded, atomic bulk move/tag/category operations for inventory items."""

import hashlib
import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..api.errors import ApiError
from ..domain import ActivityAction
from ..models import Category, Item, Room, StorageLocation, Tag
from ..schemas.bulk import (
    BulkCategoryRequest,
    BulkCategoryResult,
    BulkMoveRequest,
    BulkMoveResult,
    BulkTagRequest,
    BulkTagResult,
)
from ..schemas.items import ItemUpdate
from . import history, lending
from .containers import household_hierarchy_lock
from .items import update_item_record


def _fingerprint(action: str, payload: Any) -> str:
    data = payload.model_dump(mode="json", exclude={"request_id"})
    if "item_ids" in data:
        data["item_ids"] = sorted(str(value) for value in data["item_ids"])
    if "tag_ids" in data:
        data["tag_ids"] = sorted(str(value) for value in data["tag_ids"])
    serialized = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return f"{action}:{hashlib.sha256(serialized.encode()).hexdigest()}"


def _replay(
    db: Session,
    household_id: uuid.UUID,
    request_id: uuid.UUID,
    action: str,
    fingerprint: str,
) -> dict[str, Any] | None:
    event = history.find_request_event(db, household_id, request_id)
    if event is None:
        return None
    if event.action != action or (event.details or {}).get("request_fingerprint") != fingerprint:
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was used for a different bulk action or payload.",
        )
    result = (event.details or {}).get("result")
    if not isinstance(result, dict):
        raise ApiError(409, "request_id_reused", "The prior bulk result is unavailable.")
    return result


def _lock_items(
    db: Session,
    household_id: uuid.UUID,
    item_ids: list[uuid.UUID],
    *,
    load_tags: bool = False,
) -> list[Item]:
    query = select(Item).where(Item.household_id == household_id, Item.id.in_(item_ids))
    if load_tags:
        query = query.options(selectinload(Item.tags))
    items = list(db.scalars(query.order_by(Item.id).with_for_update()).all())
    if len(items) != len(item_ids):
        raise ApiError(
            404,
            "bulk_items_unavailable",
            "One or more selected items are unavailable. Refresh the list and try again.",
        )
    if any(item.is_archived for item in items):
        raise ApiError(
            409,
            "bulk_items_archived",
            "Archived items cannot be changed in bulk. Restore them or clear the selection.",
        )
    return items


def _destination(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID,
    location_id: uuid.UUID | None,
) -> tuple[Room, StorageLocation | None, dict[str, Any]]:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "bulk_destination_unavailable", "Destination room not found.")
    location = None
    if location_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            raise ApiError(
                404,
                "bulk_destination_unavailable",
                "Destination storage place not found.",
            )
        if location.room_id != room.id:
            raise ApiError(
                422,
                "bulk_destination_mismatch",
                "The destination storage place belongs to a different room.",
            )
    snapshot = history.location_snapshot(db, household_id, room.id, location_id)
    return room, location, snapshot


def _save_result(event, result: dict[str, Any]) -> None:
    event.details = {
        **(event.details or {}),
        "result": result,
    }


def bulk_move(
    db: Session,
    household_id: uuid.UUID,
    payload: BulkMoveRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> BulkMoveResult:
    action = ActivityAction.ITEMS_BULK_MOVED.value
    fingerprint = _fingerprint(action, payload)
    household_hierarchy_lock(db, household_id)
    replayed = _replay(db, household_id, payload.request_id, action, fingerprint)
    if replayed is not None:
        return BulkMoveResult.model_validate(replayed)

    items = _lock_items(db, household_id, payload.item_ids)
    room, location, destination = _destination(
        db, household_id, payload.room_id, payload.storage_location_id
    )
    moved = [
        item
        for item in items
        if item.room_id != room.id
        or item.storage_location_id != (location.id if location is not None else None)
    ]
    if not moved:
        raise ApiError(
            409,
            "bulk_noop",
            "Every selected item is already in that room and storage place.",
        )
    on_loan = lending.loan_quantities_for_items(db, household_id, [item.id for item in items])
    selected_units = sum(item.quantity for item in items)
    moved_units = sum(item.quantity for item in moved)
    batch_id = uuid.uuid4()
    history_context = {
        "batch_id": str(batch_id),
        "batch_action": action,
        "batch_item_count": len(items),
        "batch_unit_count": selected_units,
    }
    for item in moved:
        update_item_record(
            db,
            household_id,
            item,
            ItemUpdate(
                room_id=room.id,
                storage_location_id=location.id if location is not None else None,
            ),
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            history_context=history_context,
        )
    target_label = room.name
    if location is not None:
        target_label = f"{location.identifier or location.name} · {room.name}"
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="batch",
        entity_id=batch_id,
        summary=(
            f"Bulk moved {len(moved)} item(s) ({moved_units} unit(s)) to {target_label}"
            f"{f' · {sum(on_loan.values())} unit(s) on loan' if sum(on_loan.values()) else ''}"
        ),
        details={
            "request_fingerprint": fingerprint,
            "batch_id": str(batch_id),
            "item_ids": [str(item.id) for item in items],
            "moved_item_ids": [str(item.id) for item in moved],
            "selected_count": len(items),
            "moved_count": len(moved),
            "unchanged_count": len(items) - len(moved),
            "selected_unit_count": selected_units,
            "moved_unit_count": moved_units,
            "on_loan_quantity": sum(on_loan.values()),
            "destination": destination,
        },
        request_id=payload.request_id,
    )
    result = BulkMoveResult(
        request_id=payload.request_id,
        batch_id=batch_id,
        history_event_id=event.id,
        selected_count=len(items),
        moved_count=len(moved),
        unchanged_count=len(items) - len(moved),
        selected_unit_count=selected_units,
        moved_unit_count=moved_units,
        on_loan_quantity=sum(on_loan.values()),
        moved_item_ids=[item.id for item in moved],
        destination={
            "room_id": room.id,
            "room_name": room.name,
            "storage_location_id": location.id if location is not None else None,
            "storage_location_name": location.name if location is not None else None,
            "storage_location_identifier": location.identifier if location is not None else None,
            "path": destination.get("path") or [],
        },
    )
    _save_result(event, result.model_dump(mode="json"))
    db.flush()
    return result


def bulk_tags(
    db: Session,
    household_id: uuid.UUID,
    payload: BulkTagRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> BulkTagResult:
    action = ActivityAction.ITEMS_BULK_TAGGED.value
    fingerprint = _fingerprint(action, payload)
    household_hierarchy_lock(db, household_id)
    replayed = _replay(db, household_id, payload.request_id, action, fingerprint)
    if replayed is not None:
        return BulkTagResult.model_validate(replayed)

    items = _lock_items(db, household_id, payload.item_ids, load_tags=True)
    tags = list(
        db.scalars(
            select(Tag).where(
                Tag.household_id == household_id,
                Tag.id.in_(payload.tag_ids),
            )
        ).all()
    )
    if len(tags) != len(payload.tag_ids):
        raise ApiError(
            404,
            "bulk_tags_unavailable",
            "One or more selected tags are unavailable. Refresh and try again.",
        )
    selected = {tag.id: tag for tag in tags}
    updated: list[Item] = []
    for item in items:
        current = {tag.id: tag for tag in item.tags}
        if payload.mode == "add":
            desired = {**current, **selected}
        else:
            desired = {tag_id: tag for tag_id, tag in current.items() if tag_id not in selected}
        if set(desired) == set(current):
            continue
        item.tags = list(desired.values())
        updated.append(item)
    if not updated:
        raise ApiError(
            409,
            "bulk_noop",
            "No selected item needed that tag change.",
        )
    tag_names = [tag.name for tag in tags]
    batch_id = uuid.uuid4()
    verb = "Added" if payload.mode == "add" else "Removed"
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="batch",
        entity_id=batch_id,
        summary=(
            f"{verb} {len(tag_names)} tag(s) on {len(updated)} item(s): "
            f"{', '.join(tag_names)[:350]}"
        ),
        details={
            "request_fingerprint": fingerprint,
            "batch_id": str(batch_id),
            "mode": payload.mode,
            "item_ids": [str(item.id) for item in items],
            "updated_item_ids": [str(item.id) for item in updated],
            "tag_ids": [str(tag.id) for tag in tags],
            "tag_names": tag_names,
            "selected_count": len(items),
            "updated_count": len(updated),
            "unchanged_count": len(items) - len(updated),
        },
        request_id=payload.request_id,
    )
    result = BulkTagResult(
        request_id=payload.request_id,
        batch_id=batch_id,
        history_event_id=event.id,
        mode=payload.mode,
        selected_count=len(items),
        updated_count=len(updated),
        unchanged_count=len(items) - len(updated),
        tag_ids=[tag.id for tag in tags],
        tag_names=tag_names,
        updated_item_ids=[item.id for item in updated],
    )
    _save_result(event, result.model_dump(mode="json"))
    db.flush()
    return result


def bulk_category(
    db: Session,
    household_id: uuid.UUID,
    payload: BulkCategoryRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> BulkCategoryResult:
    action = ActivityAction.ITEMS_BULK_CATEGORISED.value
    fingerprint = _fingerprint(action, payload)
    household_hierarchy_lock(db, household_id)
    replayed = _replay(db, household_id, payload.request_id, action, fingerprint)
    if replayed is not None:
        return BulkCategoryResult.model_validate(replayed)

    items = _lock_items(db, household_id, payload.item_ids)
    category = None
    if payload.mode == "set":
        category = db.scalar(
            select(Category).where(
                Category.id == payload.category_id,
                Category.household_id == household_id,
            )
        )
        if category is None:
            raise ApiError(
                404,
                "bulk_category_unavailable",
                "The selected category is unavailable. Refresh and try again.",
            )
    target_id = category.id if category is not None else None
    updated = [item for item in items if item.category_id != target_id]
    if not updated:
        raise ApiError(
            409,
            "bulk_noop",
            "No selected item needed that category change.",
        )
    for item in updated:
        item.category_id = target_id
    batch_id = uuid.uuid4()
    category_name = category.name if category is not None else None
    summary = (
        f"Set category {category_name} on {len(updated)} item(s)"
        if category is not None
        else f"Cleared the category on {len(updated)} item(s)"
    )
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="batch",
        entity_id=batch_id,
        summary=summary,
        details={
            "request_fingerprint": fingerprint,
            "batch_id": str(batch_id),
            "mode": payload.mode,
            "item_ids": [str(item.id) for item in items],
            "updated_item_ids": [str(item.id) for item in updated],
            "category_id": str(category.id) if category is not None else None,
            "category_name": category_name,
            "selected_count": len(items),
            "updated_count": len(updated),
            "unchanged_count": len(items) - len(updated),
        },
        request_id=payload.request_id,
    )
    result = BulkCategoryResult(
        request_id=payload.request_id,
        batch_id=batch_id,
        history_event_id=event.id,
        mode=payload.mode,
        selected_count=len(items),
        updated_count=len(updated),
        unchanged_count=len(items) - len(updated),
        category_id=category.id if category is not None else None,
        category_name=category_name,
        updated_item_ids=[item.id for item in updated],
    )
    _save_result(event, result.model_dump(mode="json"))
    db.flush()
    return result
