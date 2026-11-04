import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Item, Room, StorageLocation
from ...schemas.rooms import RoomCreate, RoomList, RoomOut, RoomUpdate
from ...services.hierarchy import descendant_totals
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/rooms", tags=["rooms"])


def _get_room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    return room


def _ensure_unique_name(
    db: Session,
    household_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    query = select(Room.id).where(
        Room.household_id == household_id,
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
    room_id: uuid.UUID | None = None,
) -> None:
    if parent_id is None:
        return
    if room_id is not None and parent_id == room_id:
        raise ApiError(422, "room_cycle", "A room cannot be its own parent.")
    cursor: Room | None = _get_room(db, household_id, parent_id)
    while cursor is not None:
        if room_id is not None and cursor.id == room_id:
            raise ApiError(422, "room_cycle", "That would create a loop in the room hierarchy.")
        cursor = db.get(Room, cursor.parent_id) if cursor.parent_id else None


def _counts(db: Session, household_id: uuid.UUID) -> tuple[dict, dict]:
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
            .where(StorageLocation.household_id == household_id)
            .group_by(StorageLocation.room_id)
        ).all()
    )
    return item_counts, location_counts


def _aggregate_counts(
    rooms: list[Room], item_counts: dict, location_counts: dict
) -> tuple[dict, dict]:
    rows = [(room.id, room.parent_id) for room in rooms]
    return (
        descendant_totals(rows, item_counts),
        descendant_totals(rows, location_counts),
    )


def _to_out(
    room: Room,
    item_counts: dict,
    location_counts: dict,
    total_items: dict,
    total_locations: dict,
) -> RoomOut:
    return RoomOut(
        id=room.id,
        name=room.name,
        description=room.description,
        parent_id=room.parent_id,
        sort_order=room.sort_order,
        item_count=item_counts.get(room.id, 0),
        location_count=location_counts.get(room.id, 0),
        total_item_count=total_items.get(room.id, 0),
        total_location_count=total_locations.get(room.id, 0),
        created_at=room.created_at,
        updated_at=room.updated_at,
    )


@router.get("", response_model=RoomList)
def list_rooms(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomList:
    rooms = db.scalars(
        select(Room)
        .where(Room.household_id == auth.household.id)
        .order_by(Room.sort_order, func.lower(Room.name))
    ).all()
    item_counts, location_counts = _counts(db, auth.household.id)
    total_items, total_locations = _aggregate_counts(list(rooms), item_counts, location_counts)
    return RoomList(
        items=[
            _to_out(room, item_counts, location_counts, total_items, total_locations)
            for room in rooms
        ]
    )


@router.post("", response_model=RoomOut, status_code=201)
def create_room(
    payload: RoomCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    _validate_parent(db, auth.household.id, payload.parent_id)
    _ensure_unique_name(db, auth.household.id, payload.name, payload.parent_id)
    room = Room(
        household_id=auth.household.id,
        parent_id=payload.parent_id,
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    db.add(room)
    db.commit()
    return _to_out(room, {}, {}, {}, {})


@router.get("/{room_id}", response_model=RoomOut)
def get_room(
    room_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    room = _get_room(db, auth.household.id, room_id)
    rooms = db.scalars(select(Room).where(Room.household_id == auth.household.id)).all()
    item_counts, location_counts = _counts(db, auth.household.id)
    total_items, total_locations = _aggregate_counts(list(rooms), item_counts, location_counts)
    return _to_out(room, item_counts, location_counts, total_items, total_locations)


@router.patch("/{room_id}", response_model=RoomOut)
def update_room(
    room_id: uuid.UUID,
    payload: RoomUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RoomOut:
    room = _get_room(db, auth.household.id, room_id)
    fields = payload.model_fields_set
    new_parent_id = payload.parent_id if "parent_id" in fields else room.parent_id

    if "parent_id" in fields:
        _validate_parent(db, auth.household.id, new_parent_id, room_id=room_id)

    if payload.name is not None and payload.name != room.name:
        _ensure_unique_name(
            db,
            auth.household.id,
            payload.name,
            new_parent_id,
            exclude_id=room.id,
        )
    elif "parent_id" in fields and room.parent_id != new_parent_id:
        _ensure_unique_name(
            db,
            auth.household.id,
            room.name,
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
    rooms = db.scalars(select(Room).where(Room.household_id == auth.household.id)).all()
    item_counts, location_counts = _counts(db, auth.household.id)
    total_items, total_locations = _aggregate_counts(list(rooms), item_counts, location_counts)
    return _to_out(room, item_counts, location_counts, total_items, total_locations)


@router.delete("/{room_id}", status_code=204)
def delete_room(
    room_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    room = _get_room(db, auth.household.id, room_id)
    has_children = db.scalar(select(Room.id).where(Room.parent_id == room.id).limit(1)) is not None
    has_locations = (
        db.scalar(select(StorageLocation.id).where(StorageLocation.room_id == room.id).limit(1))
        is not None
    )
    has_items = db.scalar(select(Item.id).where(Item.room_id == room.id).limit(1)) is not None
    if has_children or has_locations or has_items:
        raise ApiError(
            409,
            "room_not_empty",
            "This room still has sub-rooms, storage locations, or items.",
        )
    db.delete(room)
    db.commit()
    return Response(status_code=204)
