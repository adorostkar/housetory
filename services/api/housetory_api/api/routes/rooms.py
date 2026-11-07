import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ...db import get_db
from ...domain import LoanStatus
from ...models import BorrowedRecord, Item, Room, StorageLocation
from ...schemas.properties import (
    RoomPropertyMovePreview,
    RoomPropertyMoveRequest,
    RoomPropertyMoveResponse,
)
from ...schemas.rooms import RoomCreate, RoomList, RoomOut, RoomUpdate
from ...services import properties as property_service
from ...services.containers import detach_tombstones_for_room
from ...services.hierarchy import descendant_totals
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/rooms", tags=["rooms"])


def _get_room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(
        select(Room)
        .options(joinedload(Room.property))
        .where(Room.id == room_id, Room.household_id == household_id)
    )
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    return room


def _ensure_unique_name(
    db: Session,
    household_id: uuid.UUID,
    name: str,
    property_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    query = select(Room.id).where(
        Room.household_id == household_id,
        Room.property_id == property_id,
        func.lower(Room.name) == name.lower(),
    )
    if parent_id is None:
        query = query.where(Room.parent_id.is_(None))
    else:
        query = query.where(Room.parent_id == parent_id)
    if exclude_id is not None:
        query = query.where(Room.id != exclude_id)
    if db.scalar(query) is not None:
        raise ApiError(409, "room_name_taken", "A room with this name already exists here.")


def _validate_parent(
    db: Session,
    household_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    *,
    property_id: uuid.UUID,
    room_id: uuid.UUID | None = None,
) -> Room | None:
    if parent_id is None:
        return None
    if room_id is not None and parent_id == room_id:
        raise ApiError(422, "room_cycle", "A room cannot be its own parent.")
    cursor: Room | None = _get_room(db, household_id, parent_id)
    if cursor.property_id != property_id:
        raise ApiError(
            422,
            "room_property_mismatch",
            "A sub-room must stay in the same property as its parent.",
        )
    while cursor is not None:
        if room_id is not None and cursor.id == room_id:
            raise ApiError(422, "room_cycle", "That would create a loop in the room hierarchy.")
        cursor = db.get(Room, cursor.parent_id) if cursor.parent_id else None
    return _get_room(db, household_id, parent_id)


def _counts(db: Session, household_id: uuid.UUID) -> tuple[dict, dict, dict]:
    item_counts = dict(
        db.execute(
            select(Item.room_id, func.count(Item.id))
            .where(
                Item.household_id == household_id,
                Item.room_id.is_not(None),
                Item.is_archived.is_(False),
            )
            .group_by(Item.room_id)
        ).all()
    )
    location_counts = dict(
        db.execute(
            select(StorageLocation.room_id, func.count(StorageLocation.id))
            .where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
            .group_by(StorageLocation.room_id)
        ).all()
    )
    recoverable_deleted_counts = dict(
        db.execute(
            select(StorageLocation.room_id, func.count(StorageLocation.id))
            .where(
                StorageLocation.household_id == household_id,
                StorageLocation.deleted_at.is_not(None),
            )
            .group_by(StorageLocation.room_id)
        ).all()
    )
    return item_counts, location_counts, recoverable_deleted_counts


def _aggregate_counts(
    rooms: list[Room], item_counts: dict, location_counts: dict, deleted_counts: dict
) -> tuple[dict, dict, dict]:
    rows = [(room.id, room.parent_id) for room in rooms]
    return (
        descendant_totals(rows, item_counts),
        descendant_totals(rows, location_counts),
        descendant_totals(rows, deleted_counts),
    )


def _to_out(
    room: Room,
    item_counts: dict,
    location_counts: dict,
    total_items: dict,
    total_locations: dict,
    total_recoverable_deleted: dict,
) -> RoomOut:
    return RoomOut(
        id=room.id,
        name=room.name,
        description=room.description,
        property_id=room.property_id,
        property=property_service.property_brief(room.property),
        parent_id=room.parent_id,
        sort_order=room.sort_order,
        item_count=item_counts.get(room.id, 0),
        location_count=location_counts.get(room.id, 0),
        total_item_count=total_items.get(room.id, 0),
        total_location_count=total_locations.get(room.id, 0),
        recoverable_deleted_location_count=total_recoverable_deleted.get(room.id, 0),
        created_at=room.created_at,
        updated_at=room.updated_at,
    )


@router.get("", response_model=RoomList)
def list_rooms(
    property_id: uuid.UUID | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomList:
    conditions = [Room.household_id == auth.household.id]
    if property_id is not None:
        property_service.get_property(db, auth.household.id, property_id)
        conditions.append(Room.property_id == property_id)
    rooms = db.scalars(
        select(Room)
        .options(joinedload(Room.property))
        .where(*conditions)
        .order_by(Room.sort_order, func.lower(Room.name))
    ).all()
    item_counts, location_counts, deleted_counts = _counts(db, auth.household.id)
    total_items, total_locations, total_recoverable_deleted = _aggregate_counts(
        list(rooms), item_counts, location_counts, deleted_counts
    )
    return RoomList(
        items=[
            _to_out(
                room,
                item_counts,
                location_counts,
                total_items,
                total_locations,
                total_recoverable_deleted,
            )
            for room in rooms
        ]
    )


@router.post("", response_model=RoomOut, status_code=201)
def create_room(
    payload: RoomCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    property_service.household_hierarchy_lock(db, auth.household.id)
    parent = None
    if payload.parent_id is not None:
        parent = _get_room(db, auth.household.id, payload.parent_id)
        if payload.property_id is not None and payload.property_id != parent.property_id:
            raise ApiError(
                422,
                "room_property_mismatch",
                "A sub-room must stay in the same property as its parent.",
            )
        property_record = parent.property
    else:
        property_record = property_service.resolve_room_property(
            db, auth.household.id, payload.property_id
        )
    _validate_parent(
        db,
        auth.household.id,
        payload.parent_id,
        property_id=property_record.id,
    )
    _ensure_unique_name(
        db,
        auth.household.id,
        payload.name,
        property_record.id,
        payload.parent_id,
    )
    room = Room(
        household_id=auth.household.id,
        property_id=property_record.id,
        parent_id=payload.parent_id,
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    db.add(room)
    db.commit()
    room = _get_room(db, auth.household.id, room.id)
    return _to_out(room, {}, {}, {}, {}, {})


@router.get("/{room_id}", response_model=RoomOut)
def get_room(
    room_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    room = _get_room(db, auth.household.id, room_id)
    rooms = db.scalars(select(Room).where(Room.household_id == auth.household.id)).all()
    item_counts, location_counts, deleted_counts = _counts(db, auth.household.id)
    total_items, total_locations, total_recoverable_deleted = _aggregate_counts(
        list(rooms), item_counts, location_counts, deleted_counts
    )
    return _to_out(
        room,
        item_counts,
        location_counts,
        total_items,
        total_locations,
        total_recoverable_deleted,
    )


@router.patch("/{room_id}", response_model=RoomOut)
def update_room(
    room_id: uuid.UUID,
    payload: RoomUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    property_service.household_hierarchy_lock(db, auth.household.id)
    room = _get_room(db, auth.household.id, room_id)
    fields = payload.model_fields_set
    new_parent_id = payload.parent_id if "parent_id" in fields else room.parent_id

    if "parent_id" in fields:
        _validate_parent(
            db,
            auth.household.id,
            new_parent_id,
            property_id=room.property_id,
            room_id=room_id,
        )

    if payload.name is not None and payload.name != room.name:
        _ensure_unique_name(
            db,
            auth.household.id,
            payload.name,
            room.property_id,
            new_parent_id,
            exclude_id=room.id,
        )
    elif "parent_id" in fields and room.parent_id != new_parent_id:
        _ensure_unique_name(
            db,
            auth.household.id,
            room.name,
            room.property_id,
            new_parent_id,
            exclude_id=room.id,
        )

    if payload.name is not None:
        room.name = payload.name
    if "description" in fields:
        room.description = payload.description
    if "sort_order" in fields and payload.sort_order is not None:
        room.sort_order = payload.sort_order
    if "parent_id" in fields:
        room.parent_id = new_parent_id

    db.commit()
    room = _get_room(db, auth.household.id, room.id)
    rooms = db.scalars(
        select(Room)
        .options(joinedload(Room.property))
        .where(Room.household_id == auth.household.id)
    ).all()
    item_counts, location_counts, deleted_counts = _counts(db, auth.household.id)
    total_items, total_locations, total_recoverable_deleted = _aggregate_counts(
        list(rooms), item_counts, location_counts, deleted_counts
    )
    return _to_out(
        room,
        item_counts,
        location_counts,
        total_items,
        total_locations,
        total_recoverable_deleted,
    )


@router.get(
    "/{room_id}/property-move/preview",
    response_model=RoomPropertyMovePreview,
)
def preview_room_property_move(
    room_id: uuid.UUID,
    property_id: uuid.UUID = Query(...),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomPropertyMovePreview:
    return property_service.room_property_move_preview(db, auth.household.id, room_id, property_id)


@router.post(
    "/{room_id}/property-move",
    response_model=RoomPropertyMoveResponse,
)
def move_room_property(
    room_id: uuid.UUID,
    payload: RoomPropertyMoveRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomPropertyMoveResponse:
    result = property_service.move_room_to_property(
        db,
        auth.household.id,
        room_id,
        payload,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )
    preview = property_service.room_property_move_preview(
        db, auth.household.id, room_id, payload.property_id
    )
    return RoomPropertyMoveResponse(preview=preview, result=result)


@router.delete("/{room_id}", status_code=204)
def delete_room(
    room_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    property_service.household_hierarchy_lock(db, auth.household.id)
    room = _get_room(db, auth.household.id, room_id)
    has_children = db.scalar(select(Room.id).where(Room.parent_id == room.id).limit(1)) is not None
    has_locations = (
        db.scalar(
            select(StorageLocation.id)
            .where(
                StorageLocation.room_id == room.id,
                StorageLocation.active(),
            )
            .limit(1)
        )
        is not None
    )
    has_items = db.scalar(select(Item.id).where(Item.room_id == room.id).limit(1)) is not None
    has_borrowed = (
        db.scalar(
            select(BorrowedRecord.id)
            .where(
                BorrowedRecord.household_id == auth.household.id,
                BorrowedRecord.status.in_(
                    [LoanStatus.OUTSTANDING.value, LoanStatus.PARTIALLY_RETURNED.value]
                ),
                BorrowedRecord.room_id == room.id,
                BorrowedRecord.storage_location_id.is_(None),
            )
            .limit(1)
        )
        is not None
    )
    if has_children or has_locations or has_items or has_borrowed:
        raise ApiError(
            409,
            "room_not_empty",
            "This room still has sub-rooms, active places, items or active borrowed "
            "placements. Nothing was deleted.",
        )
    detach_tombstones_for_room(
        db,
        auth.household.id,
        room.id,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )
    db.delete(room)
    db.commit()
    return Response(status_code=204)
