import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import LocationPhoto, Room, RoomPhoto, StorageLocation
from ...schemas.items import PhotoList, PhotoOrderRequest
from ...services import storage
from ...services.serializers import entity_photo_out
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["photos"])

PHOTO_LIMIT = 20


def _room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    return room


def _location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
        )
    )
    if location is None:
        raise ApiError(404, "location_not_found", "Storage location not found.")
    return location


def _upload(
    db: Session,
    files: list[UploadFile],
    model,
    owner_column,
    owner_id: uuid.UUID,
    bucket: str,
) -> PhotoList:
    if not files:
        raise ApiError(422, "no_files", "Choose at least one photo to upload.")
    current = int(db.scalar(select(func.count(model.id)).where(owner_column == owner_id)) or 0)
    if current + len(files) > PHOTO_LIMIT:
        raise ApiError(
            422,
            "photo_limit",
            f"A place can have at most {PHOTO_LIMIT} photos. Remove one before uploading more.",
        )
    highest = db.scalar(
        select(func.coalesce(func.max(model.sort_order), -1)).where(owner_column == owner_id)
    )
    next_sort = int(highest if highest is not None else -1) + 1
    created = []
    stored = []
    try:
        for upload in files:
            stored_photo = storage.store_entity_photo(bucket, owner_id, upload)
            stored.append(stored_photo)
            photo = model(
                storage_key=stored_photo.storage_key,
                thumbnail_key=stored_photo.thumbnail_key,
                original_filename=stored_photo.original_filename,
                content_type=stored_photo.content_type,
                byte_size=stored_photo.byte_size,
                width=stored_photo.width,
                height=stored_photo.height,
                sort_order=next_sort,
            )
            setattr(photo, f"{bucket[:-1]}_id", owner_id)
            db.add(photo)
            created.append(photo)
            next_sort += 1
        db.commit()
    except Exception:
        db.rollback()
        for stored_photo in stored:
            storage.delete_key(stored_photo.storage_key)
            storage.delete_key(stored_photo.thumbnail_key)
        raise
    return PhotoList(
        items=[
            entity_photo_out(photo, "room" if bucket == "rooms" else "location")
            for photo in created
        ]
    )


@router.get("/rooms/{room_id}/photos", response_model=PhotoList)
def list_room_photos(
    room_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    room = _room(db, auth.household.id, room_id)
    photos = sorted(room.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    return PhotoList(items=[entity_photo_out(photo, "room") for photo in photos])


@router.post("/rooms/{room_id}/photos", response_model=PhotoList, status_code=201)
def upload_room_photos(
    room_id: uuid.UUID,
    files: Annotated[list[UploadFile], File(description="One or more images")],
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    _room(db, auth.household.id, room_id)
    return _upload(db, files, RoomPhoto, RoomPhoto.room_id, room_id, "rooms")


@router.post("/rooms/{room_id}/photos/{photo_id}/primary", response_model=PhotoList)
def primary_room_photo(
    room_id: uuid.UUID,
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    room = _room(db, auth.household.id, room_id)
    return _set_primary(db, room.photos, photo_id, "room")


@router.put("/rooms/{room_id}/photos/order", response_model=PhotoList)
def reorder_room_photos(
    room_id: uuid.UUID,
    payload: PhotoOrderRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    room = _room(db, auth.household.id, room_id)
    ordered = _ordered_photos(room.photos, payload.photo_ids)
    for index, photo in enumerate(ordered):
        photo.sort_order = index
    db.commit()
    return PhotoList(items=[entity_photo_out(photo, "room") for photo in ordered])


@router.get("/locations/{location_id}/photos", response_model=PhotoList)
def list_location_photos(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    location = _location(db, auth.household.id, location_id)
    photos = sorted(location.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    return PhotoList(items=[entity_photo_out(photo, "location") for photo in photos])


@router.post("/locations/{location_id}/photos", response_model=PhotoList, status_code=201)
def upload_location_photos(
    location_id: uuid.UUID,
    files: Annotated[list[UploadFile], File(description="One or more images")],
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    _location(db, auth.household.id, location_id)
    return _upload(db, files, LocationPhoto, LocationPhoto.location_id, location_id, "locations")


@router.post("/locations/{location_id}/photos/{photo_id}/primary", response_model=PhotoList)
def primary_location_photo(
    location_id: uuid.UUID,
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    location = _location(db, auth.household.id, location_id)
    return _set_primary(db, location.photos, photo_id, "location")


def _ordered_photos(photos, photo_ids: list[uuid.UUID]) -> list:
    active = sorted(photos, key=lambda photo: (photo.sort_order, photo.created_at))
    if set(photo_ids) != {photo.id for photo in active} or len(photo_ids) != len(active):
        raise ApiError(
            422,
            "invalid_photo_order",
            "Reorder every photograph on this place exactly once.",
        )
    by_id = {photo.id: photo for photo in active}
    return [by_id[photo_id] for photo_id in photo_ids]


def _set_primary(db: Session, photos, photo_id: uuid.UUID, kind: str) -> PhotoList:
    active = sorted(photos, key=lambda photo: (photo.sort_order, photo.created_at))
    selected = next((photo for photo in active if photo.id == photo_id), None)
    if selected is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    reordered = [selected, *(photo for photo in active if photo.id != photo_id)]
    for index, photo in enumerate(reordered):
        photo.sort_order = index
    db.commit()
    return PhotoList(items=[entity_photo_out(photo, kind) for photo in reordered])


def _authorized_room_photo(db: Session, household_id: uuid.UUID, photo_id: uuid.UUID) -> RoomPhoto:
    photo = db.scalar(
        select(RoomPhoto)
        .join(Room)
        .where(RoomPhoto.id == photo_id, Room.household_id == household_id)
    )
    if photo is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    return photo


def _authorized_location_photo(
    db: Session, household_id: uuid.UUID, photo_id: uuid.UUID
) -> LocationPhoto:
    photo = db.scalar(
        select(LocationPhoto)
        .join(StorageLocation)
        .where(
            LocationPhoto.id == photo_id,
            StorageLocation.household_id == household_id,
        )
    )
    if photo is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    return photo


def _file_response(path, media_type: str) -> FileResponse:
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@router.get("/room-photos/{photo_id}/file")
def room_photo_file(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_room_photo(db, auth.household.id, photo_id)
    return _file_response(storage.resolve_key(photo.storage_key), photo.content_type)


@router.get("/room-photos/{photo_id}/thumbnail")
def room_photo_thumbnail(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_room_photo(db, auth.household.id, photo_id)
    key = photo.thumbnail_key or photo.storage_key
    return _file_response(
        storage.resolve_key(key),
        "image/webp" if photo.thumbnail_key else photo.content_type,
    )


@router.delete("/room-photos/{photo_id}", status_code=204)
def delete_room_photo(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> None:
    photo = _authorized_room_photo(db, auth.household.id, photo_id)
    keys = [photo.storage_key, photo.thumbnail_key]
    db.delete(photo)
    db.commit()
    for key in keys:
        storage.delete_key(key)


@router.get("/location-photos/{photo_id}/file")
def location_photo_file(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_location_photo(db, auth.household.id, photo_id)
    return _file_response(storage.resolve_key(photo.storage_key), photo.content_type)


@router.get("/location-photos/{photo_id}/thumbnail")
def location_photo_thumbnail(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_location_photo(db, auth.household.id, photo_id)
    key = photo.thumbnail_key or photo.storage_key
    return _file_response(
        storage.resolve_key(key),
        "image/webp" if photo.thumbnail_key else photo.content_type,
    )


@router.delete("/location-photos/{photo_id}", status_code=204)
def delete_location_photo(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> None:
    photo = _authorized_location_photo(db, auth.household.id, photo_id)
    keys = [photo.storage_key, photo.thumbnail_key]
    db.delete(photo)
    db.commit()
    for key in keys:
        storage.delete_key(key)
