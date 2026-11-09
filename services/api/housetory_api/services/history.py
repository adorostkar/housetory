"""Household-scoped activity history and compensating undo."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import ActivityAction, LoanStatus
from ..models import (
    ActivityEvent,
    Item,
    Loan,
    LoanReturn,
    Room,
    StorageLocation,
)
from ..schemas.lending import (
    ActivityEventOut,
    ActivityHistoryOut,
    RestoreAssistedContainerOut,
    RestoreAssistedItemOut,
    RestoreAssistedUndoOut,
)

UNDOABLE_ACTIONS = {
    ActivityAction.ITEM_MOVED.value,
    ActivityAction.CONTAINER_MOVED.value,
    ActivityAction.LOAN_CREATED.value,
    ActivityAction.LOAN_RETURNED.value,
}

ACTION_LABELS = {
    ActivityAction.ITEM_MOVED.value: "Item moved",
    ActivityAction.ITEM_VALUE_UPDATED.value: "Current value updated",
    ActivityAction.ITEM_DISPOSITION_CHANGED.value: "Item disposition changed",
    ActivityAction.ITEM_STORAGE_ENABLED.value: "Item storage enabled",
    ActivityAction.ITEM_STORAGE_DISABLED.value: "Item storage removed",
    ActivityAction.CONTAINER_OWNERSHIP_UNLINKED.value: "Container ownership unlinked",
    ActivityAction.ITEMS_BULK_MOVED.value: "Bulk move",
    ActivityAction.ITEMS_BULK_TAGGED.value: "Bulk tag update",
    ActivityAction.ITEMS_BULK_CATEGORISED.value: "Bulk category update",
    ActivityAction.CONTAINER_MOVED.value: "Container moved",
    ActivityAction.CONTAINER_DELETED.value: "Container deleted (recoverable)",
    ActivityAction.CONTAINER_RESTORED.value: "Container restored",
    ActivityAction.LOAN_CREATED.value: "Loan created",
    ActivityAction.LOAN_RETURNED.value: "Items returned",
    ActivityAction.LOAN_CORRECTED.value: "Loan corrected",
    ActivityAction.LOAN_CANCELLED.value: "Loan cancelled",
    ActivityAction.BORROWED_CREATED.value: "Borrowed item recorded",
    ActivityAction.BORROWED_RETURNED.value: "Borrowed item returned",
    ActivityAction.BORROWED_CORRECTED.value: "Borrowed item corrected",
    ActivityAction.BORROWED_CANCELLED.value: "Borrowed item cancelled",
    ActivityAction.BORROWED_PHOTO_UPDATED.value: "Borrowed photo updated",
    ActivityAction.BORROWED_PHOTO_REMOVED.value: "Borrowed photo removed",
    ActivityAction.ITEM_MOVE_UNDONE.value: "Item move undone",
    ActivityAction.CONTAINER_MOVE_UNDONE.value: "Container move undone",
    ActivityAction.LOAN_CREATION_UNDONE.value: "Loan creation undone",
    ActivityAction.LOAN_RETURN_UNDONE.value: "Return undone",
    ActivityAction.ROOM_MOVED.value: "Room moved",
    ActivityAction.PLACE_CONTENTS_MOVED.value: "Place contents moved",
    ActivityAction.PLACE_CONTENTS_MOVED_AND_DELETED.value: "Place emptied and deleted",
    ActivityAction.ROOM_CONTENTS_MOVED.value: "Room contents moved",
    ActivityAction.ROOM_CONTENTS_MOVED_AND_DELETED.value: "Room emptied and deleted",
    ActivityAction.INVENTORY_REVIEW_COMPLETED.value: "Inventory review completed",
    ActivityAction.INVENTORY_REVIEW_CATEGORY_APPLIED.value: "Review category applied",
    ActivityAction.INVENTORY_REVIEW_NAME_APPLIED.value: "Review name applied",
    ActivityAction.INVENTORY_REVIEW_ORGANISATION_APPLIED.value: "Review organisation applied",
    ActivityAction.INVENTORY_REVIEW_DISMISSED.value: "Review suggestion dismissed",
    ActivityAction.INVENTORY_REVIEW_CATEGORY_REVERTED.value: "Review category reverted",
    ActivityAction.INVENTORY_REVIEW_NAME_REVERTED.value: "Review name reverted",
    ActivityAction.INVENTORY_REVIEW_ORGANISATION_REVERTED.value: "Review organisation reverted",
}


def _safe_text(value: str | None, limit: int = 500) -> str:
    return (value or "").strip()[:limit]


def location_snapshot(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
) -> dict[str, Any]:
    room = db.get(Room, room_id) if room_id else None
    if room is not None and room.household_id != household_id:
        room = None
    location = db.get(StorageLocation, location_id) if location_id else None
    if location is not None and location.household_id != household_id:
        location = None
    if location is not None and room is None:
        room = db.get(Room, location.room_id)
        if room is not None and room.household_id != household_id:
            room = None
    path: list[dict[str, Any]] = []
    cursor = location
    seen: set[uuid.UUID] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        path.append(
            {
                "id": str(cursor.id),
                "name": cursor.name,
                "identifier": cursor.identifier,
            }
        )
        cursor = db.get(StorageLocation, cursor.parent_id) if cursor.parent_id else None
    path.reverse()
    property_record = room.property if room is not None else None
    return {
        "property_id": str(property_record.id) if property_record is not None else None,
        "property_name": property_record.name if property_record is not None else None,
        "room_id": str(room.id) if room else None,
        "room_name": room.name if room else None,
        "location_id": str(location.id) if location else None,
        "location_name": location.name if location else None,
        "location_identifier": location.identifier if location else None,
        "path": path,
    }


def record_event(
    db: Session,
    household_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    summary: str,
    details: dict[str, Any] | None = None,
    item_id: uuid.UUID | None = None,
    container_id: uuid.UUID | None = None,
    loan_id: uuid.UUID | None = None,
    borrowed_item_id: uuid.UUID | None = None,
    request_id: uuid.UUID | None = None,
    undoes_event_id: uuid.UUID | None = None,
) -> ActivityEvent:
    if request_id is not None:
        existing = db.scalar(
            select(ActivityEvent).where(
                ActivityEvent.household_id == household_id,
                ActivityEvent.request_id == request_id,
            )
        )
        if existing is not None:
            return existing
    event = ActivityEvent(
        household_id=household_id,
        actor_user_id=actor_user_id,
        actor_name_snapshot=_safe_text(actor_name or "Housetory", 120),
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        item_id=item_id,
        container_id=container_id,
        loan_id=loan_id,
        borrowed_item_id=borrowed_item_id,
        summary=_safe_text(summary, 500),
        details=details or {},
        request_id=request_id,
        undoes_event_id=undoes_event_id,
    )
    db.add(event)
    db.flush()
    return event


def find_request_event(
    db: Session, household_id: uuid.UUID, request_id: uuid.UUID | None
) -> ActivityEvent | None:
    if request_id is None:
        return None
    return db.scalar(
        select(ActivityEvent).where(
            ActivityEvent.household_id == household_id,
            ActivityEvent.request_id == request_id,
        )
    )


def get_event(
    db: Session, household_id: uuid.UUID, event_id: uuid.UUID, *, for_update: bool = False
) -> ActivityEvent:
    query = select(ActivityEvent).where(
        ActivityEvent.id == event_id,
        ActivityEvent.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update().execution_options(populate_existing=True)
    event = db.scalar(query)
    if event is None:
        raise ApiError(404, "activity_not_found", "History event not found.")
    return event


def _later_event_exists(db: Session, event: ActivityEvent, actions: set[str]) -> bool:
    return bool(
        db.scalar(
            select(func.count(ActivityEvent.id)).where(
                ActivityEvent.household_id == event.household_id,
                ActivityEvent.id != event.id,
                ActivityEvent.created_at > event.created_at,
                ActivityEvent.action.in_(actions),
                *([ActivityEvent.item_id == event.item_id] if event.item_id is not None else []),
                *(
                    [ActivityEvent.container_id == event.container_id]
                    if event.container_id is not None
                    else []
                ),
                *([ActivityEvent.loan_id == event.loan_id] if event.loan_id is not None else []),
            )
        )
        or 0
    )


def _detail_uuid(details: dict[str, Any], key: str) -> uuid.UUID | None:
    value = details.get(key)
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def _restore_location_label(location: StorageLocation | None) -> str | None:
    if location is None:
        return None
    if location.identifier and location.identifier != location.name:
        return f"{location.identifier} · {location.name}"
    return location.identifier or location.name


def _restore_item_preview(
    db: Session,
    household_id: uuid.UUID,
    item: Item | None,
    *,
    target_room_id: uuid.UUID | None,
    target_location: StorageLocation | None,
) -> RestoreAssistedItemOut | None:
    if item is None:
        return None
    current_room = db.get(Room, item.room_id) if item.room_id else None
    if current_room is not None and current_room.household_id != household_id:
        current_room = None
    current_location = (
        db.get(StorageLocation, item.storage_location_id) if item.storage_location_id else None
    )
    if current_location is not None and current_location.household_id != household_id:
        current_location = None
    target_room = db.get(Room, target_room_id) if target_room_id else None
    if target_room is not None and target_room.household_id != household_id:
        target_room = None
    return RestoreAssistedItemOut(
        id=item.id,
        name=item.name,
        quantity=item.quantity,
        current_room_id=current_room.id if current_room else None,
        current_room_name=current_room.name if current_room else None,
        current_location_id=current_location.id if current_location else None,
        current_location_name=current_location.name if current_location else None,
        current_location_identifier=(current_location.identifier if current_location else None),
        target_room_id=target_room.id if target_room else None,
        target_room_name=target_room.name if target_room else None,
        target_location_id=target_location.id if target_location else None,
        target_location_name=target_location.name if target_location else None,
        target_location_identifier=(target_location.identifier if target_location else None),
    )


def _restore_container_preview(
    db: Session,
    container: StorageLocation,
) -> RestoreAssistedContainerOut:
    snapshot = container.deletion_snapshot or {}
    snapshot_path = snapshot.get("path") if isinstance(snapshot.get("path"), list) else []
    snapshot_parent = (
        snapshot_path[-2] if len(snapshot_path) > 1 and isinstance(snapshot_path[-2], dict) else {}
    )
    room = db.get(Room, container.room_id) if container.room_id else None
    property_record = room.property if room is not None else None
    parent = db.get(StorageLocation, container.parent_id) if container.parent_id else None
    return RestoreAssistedContainerOut(
        id=container.id,
        name=container.name,
        identifier=container.identifier,
        legacy_identifier=container.legacy_identifier,
        kind=container.kind,
        container_type=container.container_type,
        is_container=container.is_container,
        room_id=(room.id if room is not None else _detail_uuid(snapshot, "room_id")),
        room_name=(room.name if room is not None else str(snapshot.get("room_name") or "") or None),
        property_id=(
            property_record.id
            if property_record is not None
            else _detail_uuid(snapshot, "property_id")
        ),
        property_name=(
            property_record.name
            if property_record is not None
            else str(snapshot.get("property_name") or "") or None
        ),
        parent_id=(parent.id if parent is not None else _detail_uuid(snapshot_parent, "id")),
        parent_name=(
            parent.name if parent is not None else str(snapshot_parent.get("name") or "") or None
        ),
        deleted_at=container.deleted_at,
        deleted_by_name=container.deleted_by_name,
    )


def _legacy_restore_preview(
    db: Session,
    household_id: uuid.UUID,
    event: ActivityEvent,
    *,
    from_location_id: uuid.UUID,
) -> RestoreAssistedUndoOut:
    details = event.details or {}
    from_detail = details.get("from") if isinstance(details.get("from"), dict) else {}
    from_detail = from_detail or {}
    from_room_id = _detail_uuid(details, "from_room_id")
    room = db.get(Room, from_room_id) if from_room_id else None
    if room is not None and room.household_id != household_id:
        room = None
    property_record = room.property if room is not None else None
    item = (
        db.scalar(
            select(Item).where(
                Item.id == event.item_id,
                Item.household_id == household_id,
            )
        )
        if event.item_id is not None
        else None
    )
    path = from_detail.get("path") if isinstance(from_detail.get("path"), list) else []
    parent_name = None
    if len(path) > 1 and isinstance(path[-2], dict):
        parent_name = str(path[-2].get("name") or "") or None
    container = RestoreAssistedContainerOut(
        id=from_location_id,
        name=str(from_detail.get("location_name") or "") or None,
        identifier=str(from_detail.get("location_identifier") or "") or None,
        room_id=from_room_id,
        room_name=(str(from_detail.get("room_name") or "") or None if room is None else room.name),
        property_id=(
            _detail_uuid(details, "from_property_id") or _detail_uuid(from_detail, "property_id")
            if property_record is None
            else property_record.id
        ),
        property_name=(
            str(from_detail.get("property_name") or "") or None
            if property_record is None
            else property_record.name
        ),
        parent_name=parent_name,
    )
    return RestoreAssistedUndoOut(
        available=False,
        reason=(
            "The original storage place was permanently deleted before recoverable "
            "tombstones existed. Its identity cannot be restored or invented safely."
        ),
        legacy_unrecoverable=True,
        will_restore_container=False,
        will_move_item=False,
        container=container,
        item=_restore_item_preview(
            db,
            household_id,
            item,
            target_room_id=from_room_id,
            target_location=None,
        ),
    )


def _restore_assisted_preview(
    db: Session,
    household_id: uuid.UUID,
    event: ActivityEvent,
    *,
    for_update: bool = False,
) -> RestoreAssistedUndoOut | None:
    """Return restore-assisted undo state for a deleted original place."""
    if event.action != ActivityAction.ITEM_MOVED.value:
        return None
    details = event.details or {}
    from_location_id = _detail_uuid(details, "from_location_id")
    if from_location_id is None:
        return None
    if event.undoes_event_id is not None:
        return None
    if db.scalar(select(ActivityEvent.id).where(ActivityEvent.undoes_event_id == event.id)):
        return None

    container_query = select(StorageLocation).where(
        StorageLocation.id == from_location_id,
        StorageLocation.household_id == household_id,
    )
    if for_update:
        container_query = container_query.with_for_update()
    container = db.scalar(container_query)
    if container is not None and container.deleted_at is None:
        return None
    if container is None:
        return _legacy_restore_preview(db, household_id, event, from_location_id=from_location_id)

    item_query = (
        select(Item).where(Item.id == event.item_id, Item.household_id == household_id)
        if event.item_id is not None
        else None
    )
    if item_query is not None and for_update:
        item_query = item_query.with_for_update()
    item = db.scalar(item_query) if item_query is not None else None
    from_room_id = _detail_uuid(details, "from_room_id")
    to_room_id = _detail_uuid(details, "to_room_id")
    to_location_id = _detail_uuid(details, "to_location_id")
    from_detail = details.get("from") if isinstance(details.get("from"), dict) else {}
    from_detail = from_detail or {}

    reason: str | None = None
    if item is None:
        reason = "The item no longer exists."
    elif item.is_archived:
        reason = "Restore the item before restoring this move."
    elif item.room_id != to_room_id or item.storage_location_id != to_location_id:
        reason = "The item has moved since this action, so undo is unsafe."
    elif (
        db.scalar(
            select(StorageLocation.id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.owner_item_id == item.id,
                StorageLocation.deleted_at.is_(None),
            )
        )
        is not None
    ):
        reason = (
            "This item provides storage. Move it from the item page so its contents "
            "move with it; automatic restore is unavailable."
        )
    elif _later_event_exists(
        db,
        event,
        {ActivityAction.ITEM_MOVED.value, ActivityAction.ITEM_MOVE_UNDONE.value},
    ):
        reason = "A later item move exists. Undo that move first."

    room = db.get(Room, from_room_id) if from_room_id else None
    if room is not None and room.household_id != household_id:
        room = None
    if reason is None:
        if from_room_id is None:
            reason = "The original room is missing from movement history."
        elif room is None:
            reason = "The original room no longer exists."
        elif container.room_id != from_room_id:
            reason = "Recovery metadata points to a different room."
        else:
            from_property_id = _detail_uuid(details, "from_property_id") or _detail_uuid(
                from_detail, "property_id"
            )
            if from_property_id is not None and room.property_id != from_property_id:
                reason = "Recovery metadata points to a different property."

    parent = None
    if reason is None and container.parent_id is not None:
        parent = db.get(StorageLocation, container.parent_id)
        if parent is None or parent.household_id != household_id:
            reason = "The original parent place no longer exists."
        elif parent.deleted_at is not None:
            reason = "The original parent place is also deleted. Restore it first."
        elif parent.room_id != container.room_id:
            reason = "The original parent place is now in a different room."

    if reason is None and container.identifier:
        conflict = db.scalar(
            select(StorageLocation.id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.identifier == container.identifier,
                StorageLocation.id != container.id,
            )
        )
        if conflict is not None:
            reason = "The original identifier is already used by another place."

    if reason is None and container.legacy_identifier:
        conflict = db.scalar(
            select(StorageLocation.id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
                func.upper(StorageLocation.legacy_identifier)
                == container.legacy_identifier.upper(),
                StorageLocation.id != container.id,
            )
        )
        if conflict is not None:
            reason = "The original legacy identifier is already used by another active place."

    if reason is None:
        name_conflict = db.scalar(
            select(StorageLocation.id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
                StorageLocation.room_id == container.room_id,
                StorageLocation.id != container.id,
                func.lower(StorageLocation.name) == container.name.casefold(),
                (
                    StorageLocation.parent_id.is_(None)
                    if container.parent_id is None
                    else StorageLocation.parent_id == container.parent_id
                ),
            )
        )
        if name_conflict is not None:
            reason = "Another active place now uses this name in the same room and parent."

    target_room = room
    return RestoreAssistedUndoOut(
        available=reason is None,
        reason=reason,
        legacy_unrecoverable=False,
        will_restore_container=True,
        will_move_item=item is not None,
        container=_restore_container_preview(db, container),
        item=_restore_item_preview(
            db,
            household_id,
            item,
            target_room_id=target_room.id if target_room is not None else from_room_id,
            target_location=container,
        ),
    )


def restore_assisted_preview(
    db: Session,
    household_id: uuid.UUID,
    event_id: uuid.UUID,
) -> RestoreAssistedUndoOut:
    event = get_event(db, household_id, event_id)
    preview = _restore_assisted_preview(db, household_id, event)
    if preview is None:
        raise ApiError(
            409,
            "restore_not_applicable",
            "This history action does not need a deleted container restored.",
        )
    return preview


def _undo_blocked_reason(
    db: Session, event: ActivityEvent
) -> tuple[bool, str | None, ActivityEvent | None]:
    undo_event = db.scalar(
        select(ActivityEvent).where(
            ActivityEvent.household_id == event.household_id,
            ActivityEvent.undoes_event_id == event.id,
        )
    )
    if undo_event is not None:
        return False, "This action has already been undone.", undo_event
    if event.undoes_event_id is not None:
        return False, "A compensating event cannot itself be undone.", None
    if event.action not in UNDOABLE_ACTIONS:
        return False, "This type of action does not support undo.", None

    if event.action == ActivityAction.ITEM_MOVED.value:
        if event.item_id is None:
            return False, "The item no longer exists.", None
        item = db.scalar(
            select(Item).where(Item.id == event.item_id, Item.household_id == event.household_id)
        )
        if item is None:
            return False, "The item no longer exists.", None
        if item.is_archived:
            return False, "Restore the item before undoing its move.", None
        to_room = _detail_uuid(event.details, "to_room_id")
        to_location = _detail_uuid(event.details, "to_location_id")
        if item.room_id != to_room or item.storage_location_id != to_location:
            return False, "The item has moved since this action, so undo is unsafe.", None
        owned = db.scalar(
            select(StorageLocation).where(
                StorageLocation.household_id == event.household_id,
                StorageLocation.owner_item_id == item.id,
                StorageLocation.deleted_at.is_(None),
            )
        )
        if owned is not None and (owned.room_id != to_room or owned.parent_id != to_location):
            return (
                False,
                "The item's storage place no longer matches this move. Open the item "
                "and move it again before undoing.",
                None,
            )
        if _later_event_exists(
            db,
            event,
            {ActivityAction.ITEM_MOVED.value, ActivityAction.ITEM_MOVE_UNDONE.value},
        ):
            return False, "A later item move exists. Undo that move first.", None
        from_room = _detail_uuid(event.details, "from_room_id")
        from_location = _detail_uuid(event.details, "from_location_id")
        if (
            from_room is not None
            and db.scalar(
                select(func.count(Room.id)).where(
                    Room.id == from_room, Room.household_id == event.household_id
                )
            )
            == 0
        ):
            return False, "The original room no longer exists.", None
        if (
            from_location is not None
            and db.scalar(
                select(func.count(StorageLocation.id)).where(
                    StorageLocation.id == from_location,
                    StorageLocation.household_id == event.household_id,
                    StorageLocation.active(),
                )
            )
            == 0
        ):
            return False, "The original storage place no longer exists.", None
        return True, None, None

    if event.action == ActivityAction.CONTAINER_MOVED.value:
        if event.container_id is None:
            return False, "The container no longer exists.", None
        container = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == event.container_id,
                StorageLocation.household_id == event.household_id,
                StorageLocation.active(),
            )
        )
        if container is None:
            return False, "The container no longer exists.", None
        if container.owner_item_id is not None:
            return (
                False,
                "This container belongs to an owned item. Move the item instead so its "
                "contents and storage identity stay together.",
                None,
            )
        to_room = _detail_uuid(event.details, "to_room_id")
        to_parent = _detail_uuid(event.details, "to_parent_id")
        if container.room_id != to_room or container.parent_id != to_parent:
            return False, "The container has moved since this action, so undo is unsafe.", None
        if _later_event_exists(
            db,
            event,
            {
                ActivityAction.CONTAINER_MOVED.value,
                ActivityAction.CONTAINER_MOVE_UNDONE.value,
            },
        ):
            return False, "A later container move exists. Undo that move first.", None
        from_room = _detail_uuid(event.details, "from_room_id")
        from_parent = _detail_uuid(event.details, "from_parent_id")
        if (
            from_room is not None
            and db.scalar(
                select(func.count(Room.id)).where(
                    Room.id == from_room, Room.household_id == event.household_id
                )
            )
            == 0
        ):
            return False, "The original room no longer exists.", None
        if (
            from_parent is not None
            and db.scalar(
                select(func.count(StorageLocation.id)).where(
                    StorageLocation.id == from_parent,
                    StorageLocation.household_id == event.household_id,
                    StorageLocation.active(),
                )
            )
            == 0
        ):
            return False, "The original parent place no longer exists.", None
        return True, None, None

    if event.loan_id is None:
        return False, "The loan no longer exists.", None
    loan = db.scalar(
        select(Loan).where(Loan.id == event.loan_id, Loan.household_id == event.household_id)
    )
    if loan is None:
        return False, "The loan no longer exists.", None

    if event.action == ActivityAction.LOAN_CREATED.value:
        if loan.status == LoanStatus.CANCELLED.value:
            return False, "This loan was already cancelled.", None
        if loan.status == LoanStatus.RETURNED.value:
            return False, "The loan was returned; undo the return instead.", None
        if loan.returned_quantity > 0:
            return False, "The loan has returns. Undo the latest return instead.", None
        if loan.item_id is None:
            return False, "The item no longer exists.", None
        if db.scalar(select(func.count(LoanReturn.id)).where(LoanReturn.loan_id == loan.id)):
            return False, "The loan has return history, so undo is unsafe.", None
        if loan.parent_loan_id is not None:
            return (
                False,
                "This loan is part of a contents-included loan. Manage the parent loan "
                "and its child loans explicitly instead of undoing its creation.",
                None,
            )
        if db.scalar(select(Loan.id).where(Loan.parent_loan_id == loan.id)) is not None:
            return (
                False,
                "This loan includes child content loans. Record returns or cancel them "
                "separately; the parent creation cannot be undone as one action.",
                None,
            )
        if _later_event_exists(
            db,
            event,
            {
                ActivityAction.LOAN_CORRECTED.value,
                ActivityAction.LOAN_CANCELLED.value,
                ActivityAction.LOAN_RETURNED.value,
                ActivityAction.LOAN_RETURN_UNDONE.value,
            },
        ):
            return False, "The loan changed after it was created.", None
        return True, None, None

    if event.action == ActivityAction.LOAN_RETURNED.value:
        return_id = _detail_uuid(event.details, "return_id")
        if return_id is None:
            return False, "The return record no longer exists.", None
        loan_return = db.scalar(
            select(LoanReturn).where(
                LoanReturn.id == return_id,
                LoanReturn.household_id == event.household_id,
                LoanReturn.loan_id == loan.id,
            )
        )
        if loan_return is None:
            return False, "The return record no longer exists.", None
        if loan_return.reversed_at is not None:
            return False, "This return was already undone.", None
        if loan.status == LoanStatus.CANCELLED.value:
            return False, "The loan was cancelled.", None
        later_return = db.scalar(
            select(LoanReturn.id).where(
                LoanReturn.loan_id == loan.id,
                LoanReturn.reversed_at.is_(None),
                LoanReturn.created_at > loan_return.created_at,
            )
        )
        if later_return is not None:
            return False, "A later return exists. Undo that return first.", None
        if _later_event_exists(
            db,
            event,
            {
                ActivityAction.LOAN_CORRECTED.value,
                ActivityAction.LOAN_CANCELLED.value,
                ActivityAction.LOAN_RETURN_UNDONE.value,
            },
        ):
            return False, "The loan changed after this return.", None
        if loan.item_id is not None:
            item = db.scalar(
                select(Item).where(Item.id == loan.item_id, Item.household_id == loan.household_id)
            )
            if item is None:
                return False, "The item no longer exists.", None
            new_outstanding = loan.quantity - loan.returned_quantity + loan_return.quantity
            if new_outstanding > item.quantity:
                return (
                    False,
                    "The item quantity is now too low for this return to be undone. "
                    "Increase the recorded quantity first.",
                    None,
                )
        return True, None, None

    return False, "This type of action does not support undo.", None


def event_can_undo(db: Session, event: ActivityEvent) -> tuple[bool, str | None]:
    can_undo, reason, _existing = _undo_blocked_reason(db, event)
    return can_undo, reason


def serialize_event(db: Session, event: ActivityEvent) -> ActivityEventOut:
    can_undo, reason, undo_event = _undo_blocked_reason(db, event)
    return ActivityEventOut(
        id=event.id,
        action=event.action,
        entity_type=event.entity_type,
        entity_id=event.entity_id,
        item_id=event.item_id,
        container_id=event.container_id,
        loan_id=event.loan_id,
        borrowed_item_id=event.borrowed_item_id,
        actor_user_id=event.actor_user_id,
        actor_name=event.actor_name_snapshot,
        summary=event.summary,
        details=event.details or {},
        created_at=event.created_at,
        undoes_event_id=event.undoes_event_id,
        undo_event_id=undo_event.id if undo_event else None,
        can_undo=can_undo,
        undo_blocked_reason=reason,
        restore_assisted=_restore_assisted_preview(db, event.household_id, event),
    )


def history_for_item(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    limit: int = 30,
    offset: int = 0,
) -> ActivityHistoryOut:
    conditions = [
        ActivityEvent.household_id == household_id,
        ActivityEvent.item_id == item_id,
    ]
    total = int(db.scalar(select(func.count(ActivityEvent.id)).where(*conditions)) or 0)
    events = list(
        db.scalars(
            select(ActivityEvent)
            .where(*conditions)
            .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
    )
    return ActivityHistoryOut(
        items=[serialize_event(db, event) for event in events],
        total=total,
        limit=limit,
        offset=offset,
    )


def history_for_container(
    db: Session,
    household_id: uuid.UUID,
    container_id: uuid.UUID,
    *,
    limit: int = 30,
    offset: int = 0,
) -> ActivityHistoryOut:
    conditions = [
        ActivityEvent.household_id == household_id,
        ActivityEvent.container_id == container_id,
    ]
    total = int(db.scalar(select(func.count(ActivityEvent.id)).where(*conditions)) or 0)
    events = list(
        db.scalars(
            select(ActivityEvent)
            .where(*conditions)
            .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
    )
    return ActivityHistoryOut(
        items=[serialize_event(db, event) for event in events],
        total=total,
        limit=limit,
        offset=offset,
    )


def history_for_loan(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    *,
    limit: int = 50,
) -> list[ActivityEventOut]:
    events = list(
        db.scalars(
            select(ActivityEvent)
            .where(
                ActivityEvent.household_id == household_id,
                ActivityEvent.loan_id == loan_id,
            )
            .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
            .limit(limit)
        ).all()
    )
    return [serialize_event(db, event) for event in events]


def history_for_borrowed(
    db: Session,
    household_id: uuid.UUID,
    borrowed_item_id: uuid.UUID,
    *,
    limit: int = 50,
) -> list[ActivityEventOut]:
    events = list(
        db.scalars(
            select(ActivityEvent)
            .where(
                ActivityEvent.household_id == household_id,
                ActivityEvent.borrowed_item_id == borrowed_item_id,
            )
            .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
            .limit(limit)
        ).all()
    )
    return [serialize_event(db, event) for event in events]


def _undo_summary(event: ActivityEvent) -> str:
    label = ACTION_LABELS.get(event.action, event.action)
    return f"Undid: {label}"


def undo_event(
    db: Session,
    household_id: uuid.UUID,
    event_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    request_id: uuid.UUID | None = None,
) -> ActivityEvent:
    event = get_event(db, household_id, event_id, for_update=True)
    if request_id is not None:
        existing_request = find_request_event(db, household_id, request_id)
        if existing_request is not None:
            if existing_request.undoes_event_id != event.id:
                raise ApiError(
                    409,
                    "request_id_reused",
                    "That request id was used for another history action.",
                )
            return existing_request
    can_undo, reason, existing_undo = _undo_blocked_reason(db, event)
    if existing_undo is not None:
        raise ApiError(409, "already_undone", reason or "This action was already undone.")
    if not can_undo:
        raise ApiError(409, "undo_not_safe", reason or "This action cannot be undone safely.")

    details = event.details or {}
    undo_action = ""
    entity_type = event.entity_type
    entity_id = event.entity_id
    item_id = event.item_id
    container_id = event.container_id
    loan_id = event.loan_id
    reverse_details: dict[str, Any] = {
        "undone_event_id": str(event.id),
        "undone_action": event.action,
    }

    if event.action == ActivityAction.ITEM_MOVED.value:
        item = db.scalar(
            select(Item)
            .where(Item.id == event.item_id, Item.household_id == household_id)
            .with_for_update()
        )
        if item is None:
            raise ApiError(409, "undo_not_safe", "The item no longer exists.")
        to_room = _detail_uuid(details, "to_room_id")
        to_location = _detail_uuid(details, "to_location_id")
        if item.room_id != to_room or item.storage_location_id != to_location:
            raise ApiError(409, "undo_not_safe", "The item moved after this action.")
        from_room = _detail_uuid(details, "from_room_id")
        from_location = _detail_uuid(details, "from_location_id")
        _validate_destination(db, household_id, from_room, from_location)
        owned = db.scalar(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.owner_item_id == item.id,
                StorageLocation.deleted_at.is_(None),
            )
        )
        if owned is not None:
            from . import storage_items

            if from_room is None:
                raise ApiError(
                    409,
                    "undo_not_safe",
                    "The original room is missing; the item's storage cannot follow.",
                )
            storage_items.move_owned_storage(
                db,
                household_id,
                item,
                destination_room_id=from_room,
                destination_location_id=from_location,
                actor_user_id=actor_user_id,
                actor_name=actor_name,
            )
        item.room_id = from_room
        item.storage_location_id = from_location
        db.flush()
        undo_action = ActivityAction.ITEM_MOVE_UNDONE.value
        reverse_details["from"] = details.get("to", {})
        reverse_details["to"] = details.get("from", {})
        item_id = item.id
        entity_id = item.id
    elif event.action == ActivityAction.CONTAINER_MOVED.value:
        from . import containers

        containers.household_hierarchy_lock(db, household_id)
        moving = db.scalar(
            select(StorageLocation)
            .where(
                StorageLocation.id == event.container_id,
                StorageLocation.household_id == household_id,
            )
            .with_for_update()
        )
        if moving is None:
            raise ApiError(409, "undo_not_safe", "The container no longer exists.")
        to_room = _detail_uuid(details, "to_room_id")
        to_parent = _detail_uuid(details, "to_parent_id")
        if moving.room_id != to_room or moving.parent_id != to_parent:
            raise ApiError(409, "undo_not_safe", "The container moved after this action.")
        from_room = _detail_uuid(details, "from_room_id")
        from_parent = _detail_uuid(details, "from_parent_id")
        if from_room is None:
            raise ApiError(409, "undo_not_safe", "The original room is missing.")
        _validate_destination(db, household_id, from_room, from_parent)
        containers.move_container(
            db,
            household_id,
            moving.id,
            destination_room_id=from_room,
            destination_parent_id=from_parent,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            record_history=False,
        )
        undo_action = ActivityAction.CONTAINER_MOVE_UNDONE.value
        reverse_details["from"] = details.get("to", {})
        reverse_details["to"] = details.get("from", {})
        container_id = moving.id
        entity_id = moving.id
    elif event.action == ActivityAction.LOAN_CREATED.value:
        loan = db.scalar(
            select(Loan)
            .where(Loan.id == event.loan_id, Loan.household_id == household_id)
            .with_for_update()
        )
        if loan is None:
            raise ApiError(409, "undo_not_safe", "The loan no longer exists.")
        if loan.returned_quantity > 0 or db.scalar(
            select(func.count(LoanReturn.id)).where(LoanReturn.loan_id == loan.id)
        ):
            raise ApiError(409, "undo_not_safe", "The loan has return history.")
        if _later_event_exists(
            db,
            event,
            {
                ActivityAction.LOAN_CORRECTED.value,
                ActivityAction.LOAN_CANCELLED.value,
                ActivityAction.LOAN_RETURNED.value,
                ActivityAction.LOAN_RETURN_UNDONE.value,
            },
        ):
            raise ApiError(409, "undo_not_safe", "The loan changed after it was created.")
        loan.status = LoanStatus.CANCELLED.value
        loan.cancelled_at = datetime.now(UTC)
        db.flush()
        undo_action = ActivityAction.LOAN_CREATION_UNDONE.value
        reverse_details.update(
            {
                "borrower_name": loan.borrower_name,
                "quantity": loan.quantity,
                "item_name": loan.item_name_snapshot,
            }
        )
        loan_id = loan.id
        item_id = loan.item_id
        entity_type = "loan"
        entity_id = loan.id
    elif event.action == ActivityAction.LOAN_RETURNED.value:
        return_id = _detail_uuid(details, "return_id")
        if return_id is None:
            raise ApiError(409, "undo_not_safe", "The return record no longer exists.")
        loan = db.scalar(
            select(Loan)
            .where(Loan.id == event.loan_id, Loan.household_id == household_id)
            .with_for_update()
        )
        if loan is None:
            raise ApiError(409, "undo_not_safe", "The loan no longer exists.")
        if loan.item_id is not None:
            item = db.scalar(
                select(Item)
                .where(Item.id == loan.item_id, Item.household_id == household_id)
                .with_for_update()
            )
            if item is None:
                raise ApiError(409, "undo_not_safe", "The item no longer exists.")
        loan_return = db.scalar(
            select(LoanReturn)
            .where(
                LoanReturn.id == return_id,
                LoanReturn.household_id == household_id,
                LoanReturn.loan_id == loan.id,
            )
            .with_for_update()
        )
        if loan_return is None or loan_return.reversed_at is not None:
            raise ApiError(409, "undo_not_safe", "The return is no longer active.")
        later_return = db.scalar(
            select(LoanReturn.id).where(
                LoanReturn.loan_id == loan.id,
                LoanReturn.reversed_at.is_(None),
                LoanReturn.created_at > loan_return.created_at,
            )
        )
        if later_return is not None:
            raise ApiError(409, "undo_not_safe", "Undo the later return first.")
        if _later_event_exists(
            db,
            event,
            {
                ActivityAction.LOAN_CORRECTED.value,
                ActivityAction.LOAN_CANCELLED.value,
                ActivityAction.LOAN_RETURN_UNDONE.value,
            },
        ):
            raise ApiError(409, "undo_not_safe", "The loan changed after this return.")
        new_outstanding = loan.quantity - loan.returned_quantity + loan_return.quantity
        if loan.item_id is not None:
            item = db.get(Item, loan.item_id)
            if item is None or new_outstanding > item.quantity:
                raise ApiError(
                    409,
                    "undo_not_safe",
                    "The item quantity is too low for this return to be undone.",
                )
        loan_return.reversed_at = datetime.now(UTC)
        loan.returned_quantity = max(0, loan.returned_quantity - loan_return.quantity)
        if loan.returned_quantity == 0:
            loan.status = LoanStatus.OUTSTANDING.value
        else:
            loan.status = LoanStatus.PARTIALLY_RETURNED.value
        db.flush()
        undo_action = ActivityAction.LOAN_RETURN_UNDONE.value
        reverse_details.update(
            {
                "return_id": str(loan_return.id),
                "quantity": loan_return.quantity,
                "returned_on": loan_return.returned_on.isoformat(),
                "borrower_name": loan.borrower_name,
                "item_name": loan.item_name_snapshot,
            }
        )
        loan_id = loan.id
        item_id = loan.item_id
        entity_type = "loan"
        entity_id = loan.id
    else:  # pragma: no cover - guarded above
        raise ApiError(409, "undo_not_safe", "This action cannot be undone.")

    summary = _undo_summary(event)
    if len(summary) > 480:
        summary = summary[:480]
    undo_event = record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=undo_action,
        entity_type=entity_type,
        entity_id=entity_id,
        item_id=item_id,
        container_id=container_id,
        loan_id=loan_id,
        summary=summary,
        details=reverse_details,
        request_id=request_id,
        undoes_event_id=event.id,
    )
    if undo_action == ActivityAction.LOAN_RETURN_UNDONE.value:
        return_record = db.get(LoanReturn, _detail_uuid(reverse_details, "return_id"))
        if return_record is not None:
            return_record.reversed_by_event_id = undo_event.id
            db.flush()
    return undo_event


def restore_assisted_undo_event(
    db: Session,
    household_id: uuid.UUID,
    event_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    request_id: uuid.UUID | None = None,
) -> ActivityEvent:
    """Restore one tombstoned place and undo one item move atomically."""
    event = get_event(db, household_id, event_id, for_update=True)
    if request_id is not None:
        existing_request = find_request_event(db, household_id, request_id)
        if existing_request is not None:
            if existing_request.undoes_event_id != event.id:
                raise ApiError(
                    409,
                    "request_id_reused",
                    "That request id was used for another history action.",
                )
            return existing_request

    existing_undo = db.scalar(
        select(ActivityEvent).where(ActivityEvent.undoes_event_id == event.id)
    )
    if existing_undo is not None:
        raise ApiError(409, "already_undone", "This action has already been undone.")

    preview = _restore_assisted_preview(db, household_id, event, for_update=True)
    if preview is None:
        raise ApiError(
            409,
            "restore_not_applicable",
            "This history action does not need a deleted container restored.",
        )
    if not preview.available or preview.container is None:
        raise ApiError(
            409,
            "restore_not_safe",
            preview.reason or "This move cannot be restored safely.",
        )

    container = db.scalar(
        select(StorageLocation)
        .where(
            StorageLocation.id == preview.container.id,
            StorageLocation.household_id == household_id,
            StorageLocation.deleted_at.is_not(None),
        )
        .with_for_update()
    )
    if container is None:
        raise ApiError(
            409,
            "restore_not_safe",
            "The recoverable place changed before it could be restored.",
        )
    item = db.scalar(
        select(Item)
        .where(Item.id == event.item_id, Item.household_id == household_id)
        .with_for_update()
    )
    if item is None:
        raise ApiError(409, "restore_not_safe", "The item no longer exists.")
    details = event.details or {}
    from_room_id = _detail_uuid(details, "from_room_id")
    if from_room_id is None:
        raise ApiError(409, "restore_not_safe", "The original room is missing.")
    now = datetime.now(UTC)
    container.deleted_at = None
    container.deleted_by_user_id = None
    container.deleted_by_name = None
    container.restored_at = now
    container.restored_by_user_id = actor_user_id
    container.updated_at = now
    item.room_id = from_room_id
    item.storage_location_id = container.id
    item.updated_at = now
    db.flush()

    record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.CONTAINER_RESTORED.value,
        entity_type="container",
        entity_id=container.id,
        container_id=container.id,
        summary=(
            f"Restored container {container.identifier or container.name} for an item move undo"
        ),
        details={
            "restored_container_id": str(container.id),
            "restored_for_item_id": str(item.id),
            "restored_for_move_event_id": str(event.id),
            "room_id": str(from_room_id),
            "identifier": container.identifier,
            "name": container.name,
        },
    )
    summary = _undo_summary(event)
    summary = f"Restored container and {summary[:430]}"
    undo_event = record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.ITEM_MOVE_UNDONE.value,
        entity_type="item",
        entity_id=item.id,
        item_id=item.id,
        container_id=container.id,
        summary=summary,
        details={
            "undone_event_id": str(event.id),
            "undone_action": event.action,
            "restore_assisted": True,
            "restored_container_id": str(container.id),
            "restored_container_name": container.name,
            "restored_container_identifier": container.identifier,
            "from": details.get("to", {}),
            "to": details.get("from", {}),
        },
        request_id=request_id,
        undoes_event_id=event.id,
    )
    db.flush()
    return undo_event


def _validate_destination(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
) -> None:
    if room_id is None and location_id is not None:
        raise ApiError(409, "undo_not_safe", "The original location is incomplete.")
    if room_id is not None:
        room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(409, "undo_not_safe", "The original room no longer exists.")
    if location_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            raise ApiError(409, "undo_not_safe", "The original storage place no longer exists.")
        if room_id is not None and location.room_id != room_id:
            raise ApiError(409, "undo_not_safe", "The original location is inconsistent.")
