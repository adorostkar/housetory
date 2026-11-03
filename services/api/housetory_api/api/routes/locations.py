import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Item, Room, StorageLocation
from ...schemas.locations import (
    StorageLocationCreate,
    StorageLocationList,
    StorageLocationOut,
    StorageLocationUpdate,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/storage-locations", tags=["storage"])


def _get_location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
        )
    )
    if location is None:
        raise ApiError(404, "location_not_found", "Storage location not found.")
    return location


def _get_room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    return room


def _validate_parent(
    db: Session,
    household_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    room_id: uuid.UUID,
    *,
    location_id: uuid.UUID | None = None,
) -> None:
    if parent_id is None:
        return
    if location_id is not None and parent_id == location_id:
        raise ApiError(422, "location_cycle", "A location cannot be its own parent.")
    cursor: StorageLocation | None = _get_location(db, household_id, parent_id)
    if cursor.room_id != room_id:
        raise ApiError(
            422,
            "location_room_mismatch",
            "A nested location must belong to the same room as its parent.",
        )
    while cursor is not None:
        if location_id is not None and cursor.id == location_id:
            raise ApiError(
                422,
                "location_cycle",
                "That would create a loop in the location hierarchy.",
            )
        cursor = db.get(StorageLocation, cursor.parent_id) if cursor.parent_id else None


def _ensure_unique_name(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    query = select(StorageLocation.id).where(
        StorageLocation.household_id == household_id,
        StorageLocation.room_id == room_id,
        func.lower(StorageLocation.name) == name.lower(),
    )
    if parent_id is None:
        query = query.where(StorageLocation.parent_id.is_(None))
    else:
        query = query.where(StorageLocation.parent_id == parent_id)
    if exclude_id is not None:
        query = query.where(StorageLocation.id != exclude_id)
    if db.scalar(query) is not None:
        raise ApiError(409, "location_name_taken", "A location with this name already exists here.")


def _counts(db: Session, household_id: uuid.UUID) -> dict:
    return dict(
        db.execute(
            select(Item.storage_location_id, func.count(Item.id))
            .where(
                Item.household_id == household_id,
                Item.storage_location_id.is_not(None),
            )
            .group_by(Item.storage_location_id)
        ).all()
    )


def _to_out(location: StorageLocation, counts: dict) -> StorageLocationOut:
    return StorageLocationOut(
        id=location.id,
        room_id=location.room_id,
        parent_id=location.parent_id,
        name=location.name,
        description=location.description,
        kind=location.kind,
        sort_order=location.sort_order,
        item_count=counts.get(location.id, 0),
        created_at=location.created_at,
        updated_at=location.updated_at,
    )


@router.get("", response_model=StorageLocationList)
def list_locations(
    room_id: uuid.UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationList:
    query = select(StorageLocation).where(StorageLocation.household_id == auth.household.id)
    if room_id is not None:
        _get_room(db, auth.household.id, room_id)
        query = query.where(StorageLocation.room_id == room_id)
    locations = db.scalars(
        query.order_by(
            StorageLocation.room_id,
            StorageLocation.sort_order,
            func.lower(StorageLocation.name),
        )
    ).all()
    counts = _counts(db, auth.household.id)
    return StorageLocationList(items=[_to_out(location, counts) for location in locations])


@router.post("", response_model=StorageLocationOut, status_code=201)
def create_location(
    payload: StorageLocationCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    _get_room(db, auth.household.id, payload.room_id)
    _validate_parent(
        db,
        auth.household.id,
        payload.parent_id,
        payload.room_id,
    )
    _ensure_unique_name(
        db,
        auth.household.id,
        payload.room_id,
        payload.name,
        payload.parent_id,
    )
    location = StorageLocation(
        household_id=auth.household.id,
        room_id=payload.room_id,
        parent_id=payload.parent_id,
        name=payload.name,
        description=payload.description,
        kind=payload.kind.value,
        sort_order=payload.sort_order,
    )
    db.add(location)
    db.commit()
    return _to_out(location, {})


@router.get("/{location_id}", response_model=StorageLocationOut)
def get_location(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    location = _get_location(db, auth.household.id, location_id)
    return _to_out(location, _counts(db, auth.household.id))


@router.patch("/{location_id}", response_model=StorageLocationOut)
def update_location(
    location_id: uuid.UUID,
    payload: StorageLocationUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    location = _get_location(db, auth.household.id, location_id)
    fields = payload.model_fields_set
    new_parent_id = payload.parent_id if "parent_id" in fields else location.parent_id

    if "parent_id" in fields:
        _validate_parent(
            db,
            auth.household.id,
            new_parent_id,
            location.room_id,
            location_id=location.id,
        )

    if (payload.name is not None and payload.name != location.name) or (
        "parent_id" in fields and new_parent_id != location.parent_id
    ):
        _ensure_unique_name(
            db,
            auth.household.id,
            location.room_id,
            payload.name if payload.name is not None else location.name,
            new_parent_id,
            exclude_id=location.id,
        )

    if payload.name is not None:
        location.name = payload.name
    if "description" in fields:
        location.description = payload.description
    if payload.kind is not None:
        location.kind = payload.kind.value
    if payload.sort_order is not None:
        location.sort_order = payload.sort_order
    if "parent_id" in fields:
        location.parent_id = new_parent_id

    db.commit()
    return _to_out(location, _counts(db, auth.household.id))


@router.delete("/{location_id}", status_code=204)
def delete_location(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    location = _get_location(db, auth.household.id, location_id)
    has_children = (
        db.scalar(
            select(StorageLocation.id).where(StorageLocation.parent_id == location.id).limit(1)
        )
        is not None
    )
    has_items = (
        db.scalar(select(Item.id).where(Item.storage_location_id == location.id).limit(1))
        is not None
    )
    if has_children or has_items:
        raise ApiError(
            409,
            "location_not_empty",
            "This location still has nested locations or items.",
        )
    db.delete(location)
    db.commit()
    return Response(status_code=204)
