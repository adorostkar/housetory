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
from ...services.containers import delete_location_safely, household_hierarchy_lock
from ...services.hierarchy import descendant_totals
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/storage-locations", tags=["storage"])


def _get_location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
        )
    )
    if location is None:
        deleted = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.deleted_at.is_not(None),
            )
        )
        if deleted is not None:
            raise ApiError(
                410,
                "location_deleted",
                (
                    f"Storage place {deleted.identifier or deleted.name} was deleted. "
                    "Its item move history may offer a restore-assisted undo."
                ),
            )
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
        StorageLocation.active(),
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


def _counts(db: Session, household_id: uuid.UUID) -> tuple[dict, dict]:
    direct = dict(
        db.execute(
            select(Item.storage_location_id, func.count(Item.id))
            .where(
                Item.household_id == household_id,
                Item.storage_location_id.is_not(None),
                Item.is_archived.is_(False),
            )
            .group_by(Item.storage_location_id)
        ).all()
    )
    rows = db.execute(
        select(StorageLocation.id, StorageLocation.parent_id).where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
        )
    ).all()
    return direct, descendant_totals(rows, direct)


def _to_out(
    location: StorageLocation, direct_counts: dict, total_counts: dict
) -> StorageLocationOut:
    return StorageLocationOut(
        id=location.id,
        room_id=location.room_id,
        parent_id=location.parent_id,
        name=location.name,
        description=location.description,
        kind=location.kind,
        is_container=location.is_container,
        container_type=location.container_type,
        identifier=location.identifier,
        summary_headline=location.summary_headline,
        summary_short=location.summary_short,
        label_generated_at=location.label_generated_at,
        sort_order=location.sort_order,
        item_count=direct_counts.get(location.id, 0),
        total_item_count=total_counts.get(location.id, 0),
        created_at=location.created_at,
        updated_at=location.updated_at,
    )


@router.get("", response_model=StorageLocationList)
def list_locations(
    room_id: uuid.UUID | None = Query(default=None),
    q: str | None = Query(default=None, max_length=120),
    is_container: bool | None = Query(default=None),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationList:
    query = select(StorageLocation).where(
        StorageLocation.household_id == auth.household.id,
        StorageLocation.active(),
    )
    if room_id is not None:
        _get_room(db, auth.household.id, room_id)
        query = query.where(StorageLocation.room_id == room_id)
    if is_container is not None:
        query = query.where(StorageLocation.is_container.is_(is_container))
    if q and q.strip():
        search = f"%{q.strip()}%"
        query = query.where(
            (StorageLocation.identifier.ilike(search)) | (StorageLocation.name.ilike(search))
        )
    locations = db.scalars(
        query.order_by(
            StorageLocation.room_id,
            StorageLocation.sort_order,
            func.lower(StorageLocation.name),
        )
    ).all()
    direct, totals = _counts(db, auth.household.id)
    return StorageLocationList(items=[_to_out(location, direct, totals) for location in locations])


@router.post("", response_model=StorageLocationOut, status_code=201)
def create_location(
    payload: StorageLocationCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    household_hierarchy_lock(db, auth.household.id)
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
    return _to_out(location, {}, {})


@router.get("/{location_id}", response_model=StorageLocationOut)
def get_location(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    location = _get_location(db, auth.household.id, location_id)
    direct, totals = _counts(db, auth.household.id)
    return _to_out(location, direct, totals)


@router.patch("/{location_id}", response_model=StorageLocationOut)
def update_location(
    location_id: uuid.UUID,
    payload: StorageLocationUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StorageLocationOut:
    household_hierarchy_lock(db, auth.household.id)
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
    direct, totals = _counts(db, auth.household.id)
    return _to_out(location, direct, totals)


@router.delete("/{location_id}", status_code=204)
def delete_location(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    try:
        location = _get_location(db, auth.household.id, location_id)
        delete_location_safely(
            db,
            auth.household.id,
            location,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return Response(status_code=204)
