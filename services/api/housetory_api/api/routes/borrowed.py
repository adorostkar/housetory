import uuid
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.borrowed import (
    BorrowedCancelRequest,
    BorrowedCorrect,
    BorrowedCreate,
    BorrowedDetailOut,
    BorrowedFilterStatus,
    BorrowedListOut,
    BorrowedReturnCreate,
)
from ...schemas.lending import ActivityEventOut
from ...services import borrowed as borrowed_service
from ...services import storage
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["borrowed"])


def _validate_place(
    db: Session,
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None,
    room_id: uuid.UUID | None,
    storage_location_id: uuid.UUID | None,
) -> None:
    borrowed_service.validate_place(
        db,
        household_id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
    )


@router.get("/borrowed", response_model=BorrowedListOut)
def list_borrowed_records(
    status: BorrowedFilterStatus = "open",
    q: Annotated[str | None, Query(max_length=200)] = None,
    overdue: bool = False,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    storage_location_id: uuid.UUID | None = None,
    on_date: date | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedListOut:
    _validate_place(
        db,
        auth.household.id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
    )
    return borrowed_service.list_records(
        db,
        auth.household.id,
        status=status,
        q=q,
        overdue=overdue,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
        on_date=on_date,
        limit=limit,
        offset=offset,
    )


@router.post("/borrowed", response_model=BorrowedDetailOut, status_code=201)
def create_borrowed_record(
    payload: BorrowedCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    try:
        result = borrowed_service.create_record(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.get("/borrowed/{record_id}", response_model=BorrowedDetailOut)
def read_borrowed_record(
    record_id: uuid.UUID,
    on_date: date | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    return borrowed_service.record_detail(db, auth.household.id, record_id, on_date=on_date)


@router.patch("/borrowed/{record_id}", response_model=BorrowedDetailOut)
def correct_borrowed_record(
    record_id: uuid.UUID,
    payload: BorrowedCorrect,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    try:
        result = borrowed_service.correct_record(
            db,
            auth.household.id,
            record_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/borrowed/{record_id}/returns", response_model=BorrowedDetailOut)
def create_borrowed_return(
    record_id: uuid.UUID,
    payload: BorrowedReturnCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    try:
        result = borrowed_service.create_return(
            db,
            auth.household.id,
            record_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/borrowed/{record_id}/cancel", response_model=BorrowedDetailOut)
def cancel_borrowed_record(
    record_id: uuid.UUID,
    payload: BorrowedCancelRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    try:
        result = borrowed_service.cancel_record(
            db,
            auth.household.id,
            record_id,
            reason=payload.reason,
            request_id=payload.request_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.get("/borrowed/{record_id}/history", response_model=list[ActivityEventOut])
def read_borrowed_history(
    record_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> list[ActivityEventOut]:
    return borrowed_service.history_for_record(
        db, auth.household.id, record_id, limit=limit, offset=offset
    )


@router.post("/borrowed/{record_id}/photo", response_model=BorrowedDetailOut, status_code=201)
def upload_borrowed_photo(
    record_id: uuid.UUID,
    file: Annotated[UploadFile, File(description="Actual photo of the borrowed item")],
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    mutation = None
    try:
        mutation = borrowed_service.set_photo(
            db,
            auth.household.id,
            record_id,
            file,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        if mutation is not None:
            for key in mutation.new_keys:
                storage.delete_key(key)
        raise
    for key in mutation.old_keys:
        storage.delete_key(key)
    return mutation.detail


@router.delete("/borrowed/{record_id}/photo", response_model=BorrowedDetailOut)
def delete_borrowed_photo(
    record_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BorrowedDetailOut:
    try:
        mutation = borrowed_service.remove_photo(
            db,
            auth.household.id,
            record_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    for key in mutation.old_keys:
        storage.delete_key(key)
    return mutation.detail


def _photo_file(storage_key: str, media_type: str) -> FileResponse:
    path: Path = storage.resolve_key(storage_key)
    if not path.is_file():
        raise ApiError(404, "borrowed_photo_not_found", "Borrowed-item photo not found.")
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/borrowed/{record_id}/photo/file")
def read_borrowed_photo(
    record_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = borrowed_service.get_photo(db, auth.household.id, record_id)
    return _photo_file(photo.storage_key, photo.content_type)


@router.get("/borrowed/{record_id}/photo/thumbnail")
def read_borrowed_photo_thumbnail(
    record_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = borrowed_service.get_photo(db, auth.household.id, record_id)
    key = photo.thumbnail_key or photo.storage_key
    return _photo_file(key, "image/webp" if photo.thumbnail_key else photo.content_type)
