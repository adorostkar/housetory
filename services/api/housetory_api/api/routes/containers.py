import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ...config import get_settings
from ...db import get_db
from ...models import Item, Room, StorageLocation
from ...schemas.containers import (
    ContainerBulkCreate,
    ContainerBulkResult,
    ContainerConvert,
    ContainerCreate,
    ContainerDetail,
    ContainerList,
    ContainerMove,
    ContainerOut,
    ContainerOwnershipCreate,
    ContainerQrConfig,
    ContainerUpdate,
)
from ...services import properties as property_service
from ...services import storage_items
from ...services.container_serializers import (
    serialize_container,
    serialize_container_detail,
)
from ...services.containers import (
    assign_identifier,
    convert_location,
    create_containers,
    delete_location_safely,
    get_location,
    location_rows,
    move_container,
)
from ...services.hierarchy import descendant_ids
from ...services.labels import qr_image_bytes, qr_payload
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/containers", tags=["containers"])


def _get(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    return get_location(db, household_id, location_id)


def _get_recoverable_deleted(
    db: Session, household_id: uuid.UUID, location_id: uuid.UUID
) -> StorageLocation | None:
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
        )
    )
    return location if location is not None and location.deleted_at is not None else None


def _deleted_error(location: StorageLocation) -> ApiError:
    return ApiError(
        410,
        "container_deleted",
        (
            f"Container {location.identifier or location.name} was deleted. "
            "Its item move history may offer a restore-assisted undo."
        ),
    )


@router.get("/qr-config", response_model=ContainerQrConfig)
def qr_config(auth: AuthContext = Depends(require_auth)) -> ContainerQrConfig:
    settings = get_settings()
    return ContainerQrConfig(
        base_url=settings.qr_effective_base_url,
        warning=settings.qr_base_url_warning,
        local_only=settings.qr_base_url_warning is not None
        and "localhost" in settings.qr_base_url_warning.lower(),
    )


@router.get("", response_model=ContainerList)
def list_containers(
    q: Annotated[str | None, Query(max_length=120)] = None,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    container_type: str | None = None,
    empty: bool | None = None,
    include_fixed: bool = False,
    include_owned: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerList:
    conditions = [
        StorageLocation.household_id == auth.household.id,
        StorageLocation.active(),
    ]
    if not include_fixed:
        conditions.append(StorageLocation.is_container.is_(True))
    if not include_owned:
        conditions.append(StorageLocation.owner_item_id.is_(None))
    if property_id is not None:
        property_service.get_property(db, auth.household.id, property_id)
        conditions.append(StorageLocation.room.has(Room.property_id == property_id))
    if room_id is not None:
        conditions.append(StorageLocation.room_id == room_id)
    if container_type:
        conditions.append(StorageLocation.container_type == container_type)
    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        conditions.append(
            (StorageLocation.identifier.ilike(search)) | (StorageLocation.name.ilike(search))
        )
    locations = list(
        db.scalars(
            select(StorageLocation)
            .options(joinedload(StorageLocation.room).joinedload(Room.property))
            .where(*conditions)
            .order_by(
                StorageLocation.identifier.asc().nullslast(),
                func.lower(StorageLocation.name),
            )
        ).all()
    )
    if empty is not None:
        rows = location_rows(db, auth.household.id)
        counts: dict[uuid.UUID, int] = {}
        for item_location_id in db.scalars(
            select(Item.storage_location_id).where(
                Item.household_id == auth.household.id,
                Item.storage_location_id.is_not(None),
                Item.is_archived.is_(False),
            )
        ):
            if item_location_id is not None:
                counts[item_location_id] = counts.get(item_location_id, 0) + 1
        filtered = []
        for location in locations:
            subtree = descendant_ids(rows, location.id)
            has_items = any(counts.get(candidate, 0) > 0 for candidate in subtree)
            if has_items != empty:
                filtered.append(location)
        locations = filtered
    total = len(locations)
    page = locations[offset : offset + limit]
    settings = get_settings()
    return ContainerList(
        items=[serialize_container(db, auth.household.id, location) for location in page],
        total=total,
        qr_base_url=settings.qr_effective_base_url,
        qr_warning=settings.qr_base_url_warning,
    )


@router.post("", response_model=ContainerOut, status_code=201)
def create_container(
    payload: ContainerCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerOut:
    try:
        location = create_containers(
            db,
            auth.household.id,
            room_id=payload.room_id,
            container_type=payload.container_type.value,
            quantity=1,
            parent_id=payload.parent_id,
            name=payload.name,
            description=payload.description,
            sort_order=payload.sort_order,
        )[0]
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location.id)
    return serialize_container(db, auth.household.id, location)


@router.post("/bulk", response_model=ContainerBulkResult, status_code=201)
def bulk_create_containers(
    payload: ContainerBulkCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerBulkResult:
    try:
        locations = create_containers(
            db,
            auth.household.id,
            room_id=payload.room_id,
            container_type=payload.container_type.value,
            quantity=payload.quantity,
            parent_id=payload.parent_id,
            name=payload.name,
            description=payload.description,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    locations = [_get(db, auth.household.id, location.id) for location in locations]
    return ContainerBulkResult(
        items=[serialize_container(db, auth.household.id, location) for location in locations],
        identifiers=[location.identifier or "" for location in locations],
    )


@router.post("/convert", response_model=ContainerOut)
def convert_existing_location(
    payload: ContainerConvert,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerOut:
    try:
        location = convert_location(
            db,
            auth.household.id,
            payload.location_id,
            container_type=payload.container_type.value,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location.id)
    return serialize_container(db, auth.household.id, location)


@router.get("/lookup/{identifier}", response_model=ContainerOut)
def lookup_identifier(
    identifier: str,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerOut:
    normalized = identifier.strip().upper()
    if not re.fullmatch(r"[A-Z]{2,12}-[0-9]{3,6}", normalized):
        raise ApiError(422, "invalid_identifier", "Use an identifier such as BOX-001.")
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.household_id == auth.household.id,
            StorageLocation.active(),
            func.upper(StorageLocation.identifier) == normalized,
        )
    )
    if location is None:
        deleted = db.scalar(
            select(StorageLocation).where(
                StorageLocation.household_id == auth.household.id,
                StorageLocation.deleted_at.is_not(None),
                func.upper(StorageLocation.identifier) == normalized,
            )
        )
        if deleted is not None:
            raise _deleted_error(deleted)
        raise ApiError(404, "container_not_found", "No container has that identifier.")
    return serialize_container(db, auth.household.id, location)


@router.get("/{location_id}", response_model=ContainerDetail)
def read_container(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerDetail:
    deleted = _get_recoverable_deleted(db, auth.household.id, location_id)
    if deleted is not None:
        raise _deleted_error(deleted)
    location = _get(db, auth.household.id, location_id)
    return serialize_container_detail(db, auth.household.id, location)


@router.patch("/{location_id}", response_model=ContainerOut)
def update_container(
    location_id: uuid.UUID,
    payload: ContainerUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerOut:
    location = _get(db, auth.household.id, location_id)
    fields = payload.model_fields_set
    if payload.container_type is not None and not location.is_container:
        raise ApiError(
            422,
            "not_a_container",
            "Convert this fixed place to a container before changing its type.",
        )
    if payload.name is not None:
        location.name = payload.name
        if location.owner_item_id is not None:
            owner = db.get(Item, location.owner_item_id)
            if owner is not None:
                owner.name = payload.name
    if "description" in fields:
        location.description = payload.description
    if payload.container_type is not None:
        location.container_type = payload.container_type.value
        location.kind = payload.container_type.value
    if "sort_order" in fields and payload.sort_order is not None:
        location.sort_order = payload.sort_order
    db.commit()
    location = _get(db, auth.household.id, location.id)
    return serialize_container(db, auth.household.id, location)


@router.post("/{location_id}/move", response_model=ContainerDetail)
def move_existing_container(
    location_id: uuid.UUID,
    payload: ContainerMove,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerDetail:
    try:
        move_container(
            db,
            auth.household.id,
            location_id,
            destination_room_id=payload.room_id,
            destination_parent_id=payload.parent_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location_id)
    return serialize_container_detail(db, auth.household.id, location)


@router.delete("/{location_id}", status_code=204)
def delete_empty_container(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    try:
        location = _get(db, auth.household.id, location_id)
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


@router.post("/{location_id}/ownership", response_model=ContainerDetail)
def create_container_ownership(
    location_id: uuid.UUID,
    payload: ContainerOwnershipCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerDetail:
    try:
        if payload.item_id is not None:
            storage_items.link_existing_item_to_location(
                db,
                auth.household.id,
                location_id,
                payload.item_id,
                actor_user_id=auth.user.id,
                actor_name=auth.user.name,
            )
        else:
            storage_items.create_item_for_location(
                db,
                auth.household.id,
                location_id,
                name=payload.name,
                actor_user_id=auth.user.id,
                actor_name=auth.user.name,
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location_id)
    return serialize_container_detail(db, auth.household.id, location)


@router.delete("/{location_id}/ownership", response_model=ContainerDetail)
def delete_container_ownership(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerDetail:
    try:
        storage_items.unlink_location_owner(
            db,
            auth.household.id,
            location_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location_id)
    return serialize_container_detail(db, auth.household.id, location)


@router.post("/{location_id}/identifier", response_model=ContainerOut)
def create_identifier(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ContainerOut:
    location = _get(db, auth.household.id, location_id)
    try:
        assign_identifier(db, auth.household.id, location)
        db.commit()
    except Exception:
        db.rollback()
        raise
    location = _get(db, auth.household.id, location.id)
    return serialize_container(db, auth.household.id, location)


def _retired_summary() -> None:
    raise ApiError(
        410,
        "feature_retired",
        "Saved container summaries and AI headlines were retired. Container "
        "contents are shown live from current inventory.",
    )


@router.post("/{location_id}/summary")
def regenerate_summary(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
) -> None:
    del location_id, auth
    _retired_summary()


@router.patch("/{location_id}/summary")
def edit_summary(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
) -> None:
    del location_id, auth
    _retired_summary()


@router.post("/{location_id}/summary/ai")
def ai_summary(
    location_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
) -> None:
    del location_id, auth
    _retired_summary()


@router.get("/{location_id}/qr.svg")
def container_qr(
    location_id: uuid.UUID,
    download: bool = False,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    deleted = _get_recoverable_deleted(db, auth.household.id, location_id)
    if deleted is not None:
        raise _deleted_error(deleted)
    location = _get(db, auth.household.id, location_id)
    payload = qr_payload(location.id)
    identifier = re.sub(r"[^A-Za-z0-9._-]+", "_", location.identifier or "container")
    disposition = "attachment" if download else "inline"
    return Response(
        content=qr_image_bytes(payload),
        media_type="image/svg+xml",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'{disposition}; filename="{identifier}-qr.svg"',
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
