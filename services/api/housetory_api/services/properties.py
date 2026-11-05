"""Property management and explicit cross-property room subtree moves."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import ActivityAction
from ..models import Item, Property, Room, StorageLocation
from ..schemas.properties import (
    PropertyBrief,
    PropertyCreate,
    PropertyList,
    PropertyOut,
    PropertyUpdate,
    RoomPropertyMovePreview,
    RoomPropertyMoveRequest,
    RoomPropertyMoveResult,
)
from . import history, lending
from .hierarchy import descendant_ids

ROOM_MOVED_ACTION = ActivityAction.ROOM_MOVED.value


def household_hierarchy_lock(db: Session, household_id: uuid.UUID) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"housetory-hierarchy-{household_id}"},
    )


def get_property(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Property:
    query = select(Property).where(
        Property.id == property_id,
        Property.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update()
    record = db.scalar(query)
    if record is None:
        raise ApiError(404, "property_not_found", "Property not found.")
    return record


def property_brief(record: Property) -> PropertyBrief:
    return PropertyBrief(id=record.id, name=record.name, is_archived=record.is_archived)


def active_properties(db: Session, household_id: uuid.UUID) -> list[Property]:
    return list(
        db.scalars(
            select(Property)
            .where(
                Property.household_id == household_id,
                Property.is_archived.is_(False),
            )
            .order_by(Property.sort_order, func.lower(Property.name), Property.created_at)
        ).all()
    )


def resolve_room_property(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID | None,
) -> Property:
    """Resolve an explicit property or the only active property."""
    if property_id is not None:
        record = get_property(db, household_id, property_id)
        if record.is_archived:
            raise ApiError(
                422,
                "property_archived",
                "This property is archived. Restore it before adding rooms.",
            )
        return record
    properties = active_properties(db, household_id)
    if len(properties) == 1:
        return properties[0]
    if not properties:
        raise ApiError(
            422,
            "property_required",
            "Create a property before adding rooms.",
        )
    raise ApiError(
        422,
        "property_required",
        "Choose a property for this room.",
    )


def _stats(
    db: Session, household_id: uuid.UUID
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int], dict[uuid.UUID, tuple[int, int]]]:
    room_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(Room.property_id, func.count(Room.id))
            .where(Room.household_id == household_id)
            .group_by(Room.property_id)
        ).all()
    }
    location_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(Room.property_id, func.count(StorageLocation.id))
            .join(StorageLocation, StorageLocation.room_id == Room.id)
            .where(Room.household_id == household_id)
            .group_by(Room.property_id)
        ).all()
    }
    item_counts = {
        row[0]: (int(row[1]), int(row[2] or 0))
        for row in db.execute(
            select(
                Room.property_id,
                func.count(Item.id),
                func.coalesce(func.sum(Item.quantity), 0),
            )
            .join(Item, Item.room_id == Room.id)
            .where(
                Room.household_id == household_id,
                Item.household_id == household_id,
                Item.is_archived.is_(False),
            )
            .group_by(Room.property_id)
        ).all()
    }
    return room_counts, location_counts, item_counts


def _property_out(
    record: Property,
    *,
    room_counts: dict[uuid.UUID, int],
    location_counts: dict[uuid.UUID, int],
    item_counts: dict[uuid.UUID, tuple[int, int]],
) -> PropertyOut:
    item_count, quantity = item_counts.get(record.id, (0, 0))
    return PropertyOut(
        id=record.id,
        name=record.name,
        description=record.description,
        sort_order=record.sort_order,
        is_archived=record.is_archived,
        room_count=room_counts.get(record.id, 0),
        container_count=location_counts.get(record.id, 0),
        location_count=location_counts.get(record.id, 0),
        item_count=item_count,
        total_quantity=quantity,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def list_properties(
    db: Session,
    household_id: uuid.UUID,
    *,
    include_archived: bool = False,
) -> PropertyList:
    conditions = [Property.household_id == household_id]
    if not include_archived:
        conditions.append(Property.is_archived.is_(False))
    properties = list(
        db.scalars(
            select(Property)
            .where(*conditions)
            .order_by(Property.sort_order, func.lower(Property.name), Property.created_at)
        ).all()
    )
    room_counts, location_counts, item_counts = _stats(db, household_id)
    return PropertyList(
        items=[
            _property_out(
                record,
                room_counts=room_counts,
                location_counts=location_counts,
                item_counts=item_counts,
            )
            for record in properties
        ]
    )


def read_property(db: Session, household_id: uuid.UUID, property_id: uuid.UUID) -> PropertyOut:
    record = get_property(db, household_id, property_id)
    room_counts, location_counts, item_counts = _stats(db, household_id)
    return _property_out(
        record,
        room_counts=room_counts,
        location_counts=location_counts,
        item_counts=item_counts,
    )


def _ensure_unique_name(
    db: Session,
    household_id: uuid.UUID,
    name: str,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    query = select(Property.id).where(
        Property.household_id == household_id,
        func.lower(Property.name) == name.lower(),
    )
    if exclude_id is not None:
        query = query.where(Property.id != exclude_id)
    if db.scalar(query) is not None:
        raise ApiError(
            409,
            "property_name_exists",
            "A property with that name already exists.",
        )


def create_property(
    db: Session,
    household_id: uuid.UUID,
    payload: PropertyCreate,
) -> PropertyOut:
    _ensure_unique_name(db, household_id, payload.name)
    record = Property(
        household_id=household_id,
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return read_property(db, household_id, record.id)


def _property_content_counts(
    db: Session, household_id: uuid.UUID, property_id: uuid.UUID
) -> tuple[int, int]:
    room_count = int(
        db.scalar(
            select(func.count(Room.id)).where(
                Room.household_id == household_id,
                Room.property_id == property_id,
            )
        )
        or 0
    )
    item_count = int(
        db.scalar(
            select(func.count(Item.id))
            .join(Room, Room.id == Item.room_id)
            .where(
                Room.household_id == household_id,
                Room.property_id == property_id,
                Item.household_id == household_id,
            )
        )
        or 0
    )
    return room_count, item_count


def _ensure_empty_property(db: Session, household_id: uuid.UUID, record: Property) -> None:
    room_count, item_count = _property_content_counts(db, household_id, record.id)
    if room_count or item_count:
        raise ApiError(
            409,
            "property_not_empty",
            "Move the rooms and items to another property first. A populated "
            "property cannot be archived or deleted.",
        )


def update_property(
    db: Session,
    household_id: uuid.UUID,
    record: Property,
    payload: PropertyUpdate,
) -> PropertyOut:
    household_hierarchy_lock(db, household_id)
    fields = payload.model_fields_set
    if payload.name is not None:
        _ensure_unique_name(db, household_id, payload.name, exclude_id=record.id)
        record.name = payload.name
    if "description" in fields:
        record.description = payload.description
    if payload.sort_order is not None:
        record.sort_order = payload.sort_order
    if payload.is_archived is not None:
        if payload.is_archived:
            _ensure_empty_property(db, household_id, record)
        record.is_archived = payload.is_archived
    db.commit()
    db.refresh(record)
    return read_property(db, household_id, record.id)


def delete_property(db: Session, household_id: uuid.UUID, record: Property) -> None:
    _ensure_empty_property(db, household_id, record)
    db.delete(record)
    db.commit()


def _subtree_rows(
    db: Session, household_id: uuid.UUID, room_id: uuid.UUID
) -> tuple[Room, set[uuid.UUID], list[StorageLocation]]:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    rooms = list(db.scalars(select(Room).where(Room.household_id == household_id)).all())
    room_subtree = descendant_ids([(entry.id, entry.parent_id) for entry in rooms], room.id)
    locations = list(
        db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.room_id.in_(room_subtree),
            )
        ).all()
    )
    return room, room_subtree, locations


def _move_fingerprint(
    room: Room,
    destination: Property,
    room_subtree: set[uuid.UUID],
    locations: list[StorageLocation],
    item_rows: list[tuple[uuid.UUID, datetime, int, uuid.UUID | None, uuid.UUID | None]],
) -> str:
    payload = {
        "room_id": str(room.id),
        "room_updated_at": room.updated_at.isoformat(),
        "source_property_id": str(room.property_id),
        "destination_property_id": str(destination.id),
        "destination_updated_at": destination.updated_at.isoformat(),
        "rooms": sorted(str(value) for value in room_subtree),
        "locations": sorted(str(location.id) for location in locations),
        "items": [
            {
                "id": str(row[0]),
                "updated_at": row[1].isoformat(),
                "quantity": row[2],
                "room_id": str(row[3]) if row[3] else None,
                "location_id": str(row[4]) if row[4] else None,
            }
            for row in sorted(item_rows, key=lambda row: str(row[0]))
        ],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def room_property_move_preview(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID,
    destination_property_id: uuid.UUID,
) -> RoomPropertyMovePreview:
    room, room_subtree, locations = _subtree_rows(db, household_id, room_id)
    destination = get_property(db, household_id, destination_property_id)
    source = db.get(Property, room.property_id)
    if source is None:
        raise ApiError(409, "property_missing", "The room's current property is unavailable.")
    location_ids = [location.id for location in locations]
    conditions = [Item.room_id.in_(room_subtree)]
    if location_ids:
        conditions.append(Item.storage_location_id.in_(location_ids))
    item_rows = list(
        db.execute(
            select(
                Item.id,
                Item.updated_at,
                Item.quantity,
                Item.room_id,
                Item.storage_location_id,
            ).where(
                Item.household_id == household_id,
                or_(*conditions),
            )
        ).all()
    )
    on_loan = lending.loan_quantities_for_items(db, household_id, [row[0] for row in item_rows])
    fingerprint = _move_fingerprint(
        room,
        destination,
        room_subtree,
        locations,
        [(row[0], row[1], row[2], row[3], row[4]) for row in item_rows],
    )
    warning = None
    can_move = True
    if room.parent_id is not None:
        can_move = False
        warning = (
            "Only a top-level room can move to another property. Move its parent "
            "subtree, or detach this room explicitly first."
        )
    elif room.property_id == destination.id:
        can_move = False
        warning = "This room is already in that property."
    elif destination.is_archived:
        can_move = False
        warning = "Restore the destination property before moving rooms into it."
    elif (
        room.parent_id is None
        and db.scalar(
            select(Room.id).where(
                Room.household_id == household_id,
                Room.property_id == destination.id,
                Room.parent_id.is_(None),
                Room.id != room.id,
                func.lower(Room.name) == room.name.lower(),
            )
        )
        is not None
    ):
        can_move = False
        warning = (
            "A top-level room with this name already exists in the destination "
            "property. Rename one of them first."
        )
    return RoomPropertyMovePreview(
        room_id=room.id,
        room_name=room.name,
        current_property=property_brief(source),
        destination_property=property_brief(destination),
        descendant_room_count=len(room_subtree),
        descendant_container_count=len(locations),
        item_count=len(item_rows),
        total_quantity=sum(row[2] for row in item_rows),
        on_loan_quantity=sum(on_loan.values()),
        fingerprint=fingerprint,
        can_move=can_move,
        warning=warning,
    )


def _replay_room_move(
    db: Session,
    household_id: uuid.UUID,
    payload: RoomPropertyMoveRequest,
) -> RoomPropertyMoveResult | None:
    event = history.find_request_event(db, household_id, payload.request_id)
    if event is None:
        return None
    details = event.details or {}
    if (
        event.action != ROOM_MOVED_ACTION
        or details.get("request_fingerprint") != payload.preview_fingerprint
    ):
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was used for a different property move.",
        )
    result = details.get("result")
    if not isinstance(result, dict):
        raise ApiError(409, "request_id_reused", "The prior property move result is unavailable.")
    return RoomPropertyMoveResult.model_validate(result)


def move_room_to_property(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID,
    payload: RoomPropertyMoveRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> RoomPropertyMoveResult:
    household_hierarchy_lock(db, household_id)
    replayed = _replay_room_move(db, household_id, payload)
    if replayed is not None:
        return replayed
    room, room_subtree, locations = _subtree_rows(db, household_id, room_id)
    destination = get_property(db, household_id, payload.property_id, for_update=True)
    preview = room_property_move_preview(db, household_id, room_id, destination.id)
    if preview.fingerprint != payload.preview_fingerprint:
        raise ApiError(
            409,
            "property_move_stale",
            "Rooms, items or the destination changed after the move preview. "
            "Review the affected scope again.",
        )
    if not preview.can_move:
        raise ApiError(
            409,
            "property_move_not_allowed",
            preview.warning or "This room cannot move to that property.",
        )
    room_rows = list(
        db.scalars(
            select(Room)
            .where(
                Room.household_id == household_id,
                Room.id.in_(room_subtree),
            )
            .order_by(Room.id)
            .with_for_update()
        ).all()
    )
    if len(room_rows) != len(room_subtree):
        raise ApiError(409, "property_move_stale", "The room subtree changed. Try again.")
    location_ids = [location.id for location in locations]
    conditions = [Item.room_id.in_(room_subtree)]
    if location_ids:
        conditions.append(Item.storage_location_id.in_(location_ids))
    item_rows = list(
        db.execute(
            select(Item.id, Item.quantity).where(
                Item.household_id == household_id,
                or_(*conditions),
            )
        ).all()
    )
    now = datetime.now(UTC)
    db.execute(
        update(Room)
        .where(Room.household_id == household_id, Room.id.in_(room_subtree))
        .values(property_id=destination.id, updated_at=now)
    )
    if item_rows:
        db.execute(
            update(Item)
            .where(
                Item.household_id == household_id,
                Item.id.in_([row[0] for row in item_rows]),
            )
            .values(updated_at=now)
        )
    db.flush()
    result = RoomPropertyMoveResult(
        room_id=preview.room_id,
        room_name=preview.room_name,
        current_property=preview.current_property,
        destination_property=preview.destination_property,
        descendant_room_count=preview.descendant_room_count,
        descendant_container_count=preview.descendant_container_count,
        item_count=preview.item_count,
        total_quantity=preview.total_quantity,
        on_loan_quantity=preview.on_loan_quantity,
        fingerprint=preview.fingerprint,
        can_move=True,
        warning=None,
        history_event_id=uuid.uuid4(),
        affected_item_ids=[row[0] for row in item_rows],
    )
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ROOM_MOVED_ACTION,
        entity_type="room",
        entity_id=room.id,
        summary=(
            f"Moved room {room.name} from {preview.current_property.name} to "
            f"{destination.name} · {preview.descendant_room_count} room(s), "
            f"{preview.item_count} item(s)"
        ),
        details={
            "request_fingerprint": preview.fingerprint,
            "result": result.model_dump(mode="json"),
            "from_property_id": str(preview.current_property.id),
            "from_property_name": preview.current_property.name,
            "to_property_id": str(destination.id),
            "to_property_name": destination.name,
            "room_ids": sorted(str(value) for value in room_subtree),
            "item_ids": [str(row[0]) for row in item_rows],
            "descendant_room_count": preview.descendant_room_count,
            "descendant_container_count": preview.descendant_container_count,
            "item_count": preview.item_count,
            "total_quantity": preview.total_quantity,
            "on_loan_quantity": preview.on_loan_quantity,
        },
        request_id=payload.request_id,
    )
    result.history_event_id = event.id
    event.details = {
        **(event.details or {}),
        "result": result.model_dump(mode="json"),
    }
    db.commit()
    return result
