import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.place_management import (
    PlaceTransferPreviewOut,
    PlaceTransferRequest,
    PlaceTransferResult,
)
from ...services import place_management
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/place-management", tags=["place-management"])


@router.get(
    "/locations/{location_id}/preview",
    response_model=PlaceTransferPreviewOut,
)
def preview_location_transfer(
    location_id: uuid.UUID,
    destination_room_id: uuid.UUID | None = None,
    destination_location_id: uuid.UUID | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PlaceTransferPreviewOut:
    return place_management.preview_place_transfer(
        db,
        auth.household.id,
        "location",
        location_id,
        destination_room_id=destination_room_id,
        destination_location_id=destination_location_id,
    )


@router.post(
    "/locations/{location_id}/transfer",
    response_model=PlaceTransferResult,
)
def transfer_location_contents(
    location_id: uuid.UUID,
    payload: PlaceTransferRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PlaceTransferResult:
    try:
        result = place_management.transfer_place_contents(
            db,
            auth.household.id,
            "location",
            location_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.get("/rooms/{room_id}/preview", response_model=PlaceTransferPreviewOut)
def preview_room_transfer(
    room_id: uuid.UUID,
    destination_room_id: uuid.UUID | None = None,
    destination_location_id: uuid.UUID | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PlaceTransferPreviewOut:
    return place_management.preview_place_transfer(
        db,
        auth.household.id,
        "room",
        room_id,
        destination_room_id=destination_room_id,
        destination_location_id=destination_location_id,
    )


@router.post("/rooms/{room_id}/transfer", response_model=PlaceTransferResult)
def transfer_room_contents(
    room_id: uuid.UUID,
    payload: PlaceTransferRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PlaceTransferResult:
    try:
        result = place_management.transfer_place_contents(
            db,
            auth.household.id,
            "room",
            room_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


__all__ = ["router"]
