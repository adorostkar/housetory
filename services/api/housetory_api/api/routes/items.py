import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload

from ...db import get_db
from ...domain import PurchaseInfoFilter
from ...models import (
    Category,
    ImportEntry,
    Item,
    ItemPhoto,
    Purchase,
    Room,
    StorageLocation,
    Tag,
)
from ...schemas.imports import ImportSourceBrief
from ...schemas.items import (
    ItemCreate,
    ItemDetailResponse,
    ItemList,
    ItemStorageEnableRequest,
    ItemSummaryList,
    ItemUpdate,
    PhotoList,
    PhotoOrderRequest,
)
from ...schemas.valuation import (
    ItemValuationApplyIn,
    ItemValuationEstimateIn,
    ItemValuationPreviewOut,
)
from ...services import items as item_service
from ...services import lending, storage, storage_items
from ...services import properties as property_service
from ...services import valuation as valuation_service
from ...services.container_serializers import location_path_map
from ...services.containers import location_breadcrumb
from ...services.hierarchy import descendant_ids
from ...services.purchase_info import purchase_info_filter_clause
from ...services.serializers import (
    item_detail,
    item_list_entry,
    item_load_options,
    item_summary,
    item_summary_load_options,
    photo_out,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["items"])


def _get_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    return item_service.get_item(db, household_id, item_id)


def _import_source(db: Session, item_id: uuid.UUID) -> ImportSourceBrief | None:
    entry = db.scalar(
        select(ImportEntry)
        .options(joinedload(ImportEntry.batch))
        .where(ImportEntry.imported_item_id == item_id)
    )
    if entry is None or entry.batch is None:
        return None
    return ImportSourceBrief(
        batch_id=entry.batch.id,
        title=entry.batch.title,
        source_path=entry.source_path,
        note_title=entry.note_title,
        source_excerpt=entry.source_excerpt,
        created_at=entry.created_at,
        url=f"/imports/{entry.batch.id}",
    )


def _room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    return item_service.room(db, household_id, room_id)


def _location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    return item_service.location(db, household_id, location_id)


def _category(db: Session, household_id: uuid.UUID, category_id: uuid.UUID) -> Category:
    return item_service.category(db, household_id, category_id)


def _detail_response(db: Session, household_id: uuid.UUID, item: Item) -> ItemDetailResponse:
    path = (
        location_breadcrumb(db, household_id, item.storage_location_id)
        if item.storage_location_id
        else []
    )
    loan_quantities = lending.loan_quantities_for_items(db, household_id, [item.id])
    return ItemDetailResponse(
        item=item_detail(
            item,
            import_source=_import_source(db, item.id),
            location_path=path,
            storage=storage_items.storage_out(db, household_id, item.id),
            on_loan_quantity=loan_quantities.get(item.id, 0),
        )
    )


@router.get("/items", response_model=ItemList | ItemSummaryList)
def list_items(
    q: Annotated[str | None, Query(max_length=200)] = None,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    tag_id: uuid.UUID | None = None,
    purchase_info: PurchaseInfoFilter | None = None,
    include_descendants: bool = False,
    include_archived: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    representation: Literal["full", "summary"] = "full",
    sort: Literal["created_desc", "created_asc", "name_asc", "name_desc", "updated_desc"] = (
        "created_desc"
    ),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemList | ItemSummaryList:
    conditions = [Item.household_id == auth.household.id]
    if not include_archived:
        conditions.append(Item.is_archived.is_(False))
    if property_id is not None:
        property_service.get_property(db, auth.household.id, property_id)
        conditions.append(
            or_(
                Item.room.has(Room.property_id == property_id),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == property_id)
                ),
            )
        )
    if room_id is not None:
        _room(db, auth.household.id, room_id)
        if include_descendants:
            rows = db.execute(
                select(Room.id, Room.parent_id).where(Room.household_id == auth.household.id)
            ).all()
            conditions.append(Item.room_id.in_(descendant_ids(rows, room_id)))
        else:
            conditions.append(Item.room_id == room_id)
    if location_id is not None:
        _location(db, auth.household.id, location_id)
        if include_descendants:
            rows = db.execute(
                select(StorageLocation.id, StorageLocation.parent_id).where(
                    StorageLocation.household_id == auth.household.id
                )
            ).all()
            conditions.append(Item.storage_location_id.in_(descendant_ids(rows, location_id)))
        else:
            conditions.append(Item.storage_location_id == location_id)
    if category_id is not None:
        _category(db, auth.household.id, category_id)
        conditions.append(Item.category_id == category_id)
    if tag_id is not None:
        conditions.append(Item.tags.any(Tag.id == tag_id))
    if purchase_info is not None:
        conditions.append(purchase_info_filter_clause(purchase_info))
    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        room_rows = db.execute(
            select(Room.id, Room.parent_id).where(Room.household_id == auth.household.id)
        ).all()
        matched_room_ids: set[uuid.UUID] = set()
        for matched_id in db.scalars(
            select(Room.id).where(
                Room.household_id == auth.household.id,
                Room.name.ilike(search),
            )
        ):
            matched_room_ids.update(descendant_ids(room_rows, matched_id))

        location_rows = db.execute(
            select(StorageLocation.id, StorageLocation.parent_id).where(
                StorageLocation.household_id == auth.household.id
            )
        ).all()
        matched_location_ids: set[uuid.UUID] = set()
        for matched_id in db.scalars(
            select(StorageLocation.id).where(
                StorageLocation.household_id == auth.household.id,
                (StorageLocation.name.ilike(search)) | (StorageLocation.identifier.ilike(search)),
            )
        ):
            matched_location_ids.update(descendant_ids(location_rows, matched_id))

        search_conditions = [
            Item.name.ilike(search),
            Item.description.ilike(search),
            Item.brand.ilike(search),
            Item.model.ilike(search),
            Item.serial_number.ilike(search),
            Item.category.has(Category.name.ilike(search)),
            Item.tags.any(Tag.name.ilike(search)),
        ]
        if matched_room_ids:
            search_conditions.append(Item.room_id.in_(matched_room_ids))
        if matched_location_ids:
            search_conditions.append(Item.storage_location_id.in_(matched_location_ids))
        conditions.append(or_(*search_conditions))

    total = int(db.scalar(select(func.count(Item.id)).where(*conditions)) or 0)
    ordering = {
        "created_desc": [Item.created_at.desc()],
        "created_asc": [Item.created_at.asc()],
        "name_asc": [func.lower(Item.name).asc()],
        "name_desc": [func.lower(Item.name).desc()],
        "updated_desc": [Item.updated_at.desc()],
    }[sort] + [Item.id.asc()]
    items = db.scalars(
        select(Item)
        .options(
            *(
                item_summary_load_options(compact_purchase=True)
                if representation == "summary"
                else item_load_options()
            )
        )
        .where(*conditions)
        .order_by(*ordering)
        .limit(limit)
        .offset(offset)
    ).all()
    location_ids = {item.storage_location_id for item in items if item.storage_location_id}
    path_map = (
        location_path_map(db, auth.household.id, requested_ids=location_ids) if location_ids else {}
    )
    loan_quantities = lending.loan_quantities_for_items(
        db, auth.household.id, [item.id for item in items]
    )
    if representation == "summary":
        purchase_ids = {item.purchase_id for item in items if item.purchase_id}
        purchase_counts = (
            dict(
                db.execute(
                    select(Item.purchase_id, func.count(Item.id))
                    .where(
                        Item.household_id == auth.household.id, Item.purchase_id.in_(purchase_ids)
                    )
                    .group_by(Item.purchase_id)
                ).all()
            )
            if purchase_ids
            else {}
        )
        entries = [
            item_list_entry(
                item,
                purchase_item_count=purchase_counts.get(item.purchase_id, 0),
                on_loan_quantity=loan_quantities.get(item.id, 0),
            ).model_copy(update={"location_path": path_map.get(item.storage_location_id, [])})
            for item in items
        ]
        return ItemSummaryList(items=entries, total=total, limit=limit, offset=offset)
    summaries = []
    for item in items:
        summary = item_summary(item, on_loan_quantity=loan_quantities.get(item.id, 0))
        if item.storage_location_id:
            summary = summary.model_copy(
                update={"location_path": path_map.get(item.storage_location_id, [])}
            )
        summaries.append(summary)
    return ItemList(
        items=summaries,
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/items", response_model=ItemDetailResponse, status_code=201)
def create_item(
    payload: ItemCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = item_service.create_item_record(db, auth.household.id, payload)
    db.commit()
    item = _get_item(db, auth.household.id, item.id)
    path = (
        location_breadcrumb(db, auth.household.id, item.storage_location_id)
        if item.storage_location_id
        else []
    )
    return ItemDetailResponse(
        item=item_detail(
            item,
            location_path=path,
            storage=storage_items.storage_out(db, auth.household.id, item.id),
        )
    )


@router.get("/items/{item_id}", response_model=ItemDetailResponse)
def get_item(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    path = (
        location_breadcrumb(db, auth.household.id, item.storage_location_id)
        if item.storage_location_id
        else []
    )
    loan_quantities = lending.loan_quantities_for_items(db, auth.household.id, [item.id])
    return ItemDetailResponse(
        item=item_detail(
            item,
            import_source=_import_source(db, item.id),
            location_path=path,
            storage=storage_items.storage_out(db, auth.household.id, item.id),
            on_loan_quantity=loan_quantities.get(item.id, 0),
        )
    )


@router.patch("/items/{item_id}", response_model=ItemDetailResponse)
def update_item(
    item_id: uuid.UUID,
    payload: ItemUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    item_service.update_item_record(
        db,
        auth.household.id,
        item,
        payload,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )
    db.commit()
    # Relationships may already be loaded on the identity-mapped object; force a
    # fresh read so a moved item's room/location/category are reflected.
    db.expire_all()
    item = _get_item(db, auth.household.id, item.id)
    path = (
        location_breadcrumb(db, auth.household.id, item.storage_location_id)
        if item.storage_location_id
        else []
    )
    loan_quantities = lending.loan_quantities_for_items(db, auth.household.id, [item.id])
    return ItemDetailResponse(
        item=item_detail(
            item,
            location_path=path,
            storage=storage_items.storage_out(db, auth.household.id, item.id),
            on_loan_quantity=loan_quantities.get(item.id, 0),
        )
    )


@router.post(
    "/items/{item_id}/valuation/estimate",
    response_model=ItemValuationPreviewOut,
)
def estimate_item_value(
    item_id: uuid.UUID,
    payload: ItemValuationEstimateIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemValuationPreviewOut:
    try:
        result = valuation_service.create_preview(
            db,
            auth.household.id,
            item_id,
            payload,
            actor_user_id=auth.user.id,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/items/{item_id}/valuation/apply", response_model=ItemDetailResponse)
def apply_item_valuation(
    item_id: uuid.UUID,
    payload: ItemValuationApplyIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    try:
        item = valuation_service.apply_valuation(
            db,
            auth.household.id,
            item_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.expire_all()
    item = _get_item(db, auth.household.id, item.id)
    return _detail_response(db, auth.household.id, item)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    item = lending.lock_item(db, auth.household.id, item_id)
    lending.ensure_item_deletable(db, auth.household.id, item)
    storage_items.assert_item_delete_allowed(db, auth.household.id, item_id)
    item = _get_item(db, auth.household.id, item_id)
    keys = [photo.storage_key for photo in item.photos]
    keys += [photo.thumbnail_key for photo in item.photos if photo.thumbnail_key]
    keys += [image.storage_key for image in item.images if image.storage_key]
    keys += [image.thumbnail_key for image in item.images if image.thumbnail_key]

    # Documents linked only to this item would otherwise become unreachable
    # orphans. Shared documents remain in the household library.
    exclusive_documents = [document for document in item.documents if len(document.items) <= 1]
    for document in exclusive_documents:
        keys.append(document.storage_key)
        keys.append(document.original_storage_key)
        if document.scan is not None:
            keys.extend(
                key
                for page in document.scan.pages
                for key in (page.original_storage_key, page.cleaned_storage_key)
            )
            db.delete(document.scan)
        db.delete(document)

    if item.purchase_id is not None:
        other_links = int(
            db.scalar(
                select(func.count(Item.id)).where(
                    Item.purchase_id == item.purchase_id,
                    Item.id != item.id,
                )
            )
            or 0
        )
        if other_links == 0:
            purchase = db.get(Purchase, item.purchase_id)
            if purchase is not None:
                db.delete(purchase)

    db.delete(item)
    db.commit()
    for key in keys:
        storage.delete_key(key)
    return Response(status_code=204)


@router.post("/items/{item_id}/storage", response_model=ItemDetailResponse)
def enable_item_storage(
    item_id: uuid.UUID,
    payload: ItemStorageEnableRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    try:
        storage_items.enable_item_storage(
            db,
            auth.household.id,
            item.id,
            existing_location_id=payload.existing_location_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.expire_all()
    item = _get_item(db, auth.household.id, item.id)
    return _detail_response(db, auth.household.id, item)


@router.delete("/items/{item_id}/storage", response_model=ItemDetailResponse)
def remove_item_storage(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    try:
        storage_items.remove_item_storage(
            db,
            auth.household.id,
            item.id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.expire_all()
    item = _get_item(db, auth.household.id, item.id)
    return _detail_response(db, auth.household.id, item)


@router.get("/items/{item_id}/photos", response_model=PhotoList)
def list_photos(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    item = _get_item(db, auth.household.id, item_id)
    return PhotoList(items=[photo_out(photo) for photo in item.photos])


@router.post("/items/{item_id}/photos", response_model=PhotoList, status_code=201)
def upload_photos(
    item_id: uuid.UUID,
    files: Annotated[list[UploadFile], File(description="One or more images")],
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    item = _get_item(db, auth.household.id, item_id)
    if not files:
        raise ApiError(422, "no_files", "Choose at least one photo to upload.")
    current_count = int(
        db.scalar(select(func.count(ItemPhoto.id)).where(ItemPhoto.item_id == item.id)) or 0
    )
    if current_count + len(files) > 20:
        raise ApiError(
            422,
            "photo_limit",
            "An item can have at most 20 photos. Remove a photo before uploading more.",
        )

    highest_sort = db.scalar(
        select(func.coalesce(func.max(ItemPhoto.sort_order), -1)).where(
            ItemPhoto.item_id == item.id
        )
    )
    stored = []
    created: list[ItemPhoto] = []
    next_sort = int(highest_sort if highest_sort is not None else -1) + 1
    try:
        for upload in files:
            photo_file = storage.store_photo(item.id, upload)
            stored.append(photo_file)
            photo = ItemPhoto(
                item_id=item.id,
                storage_key=photo_file.storage_key,
                thumbnail_key=photo_file.thumbnail_key,
                original_filename=photo_file.original_filename,
                content_type=photo_file.content_type,
                byte_size=photo_file.byte_size,
                width=photo_file.width,
                height=photo_file.height,
                sort_order=next_sort,
            )
            next_sort += 1
            db.add(photo)
            created.append(photo)
        db.commit()
    except Exception:
        db.rollback()
        for photo_file in stored:
            storage.delete_key(photo_file.storage_key)
            storage.delete_key(photo_file.thumbnail_key)
        raise

    return PhotoList(items=[photo_out(photo) for photo in created])


@router.post("/items/{item_id}/photos/{photo_id}/primary", response_model=PhotoList)
def set_primary_photo(
    item_id: uuid.UUID,
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    item = _get_item(db, auth.household.id, item_id)
    active_photos = sorted(item.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    selected = next((photo for photo in active_photos if photo.id == photo_id), None)
    if selected is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    reordered = [selected, *(photo for photo in active_photos if photo.id != photo_id)]
    for index, photo in enumerate(reordered):
        photo.sort_order = index
    db.commit()
    return PhotoList(items=[photo_out(photo) for photo in reordered])


@router.put("/items/{item_id}/photos/order", response_model=PhotoList)
def reorder_photos(
    item_id: uuid.UUID,
    payload: PhotoOrderRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PhotoList:
    item = _get_item(db, auth.household.id, item_id)
    active_photos = sorted(item.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    if set(payload.photo_ids) != {photo.id for photo in active_photos} or len(
        payload.photo_ids
    ) != len(active_photos):
        raise ApiError(
            422,
            "invalid_photo_order",
            "Reorder every photograph on this item exactly once.",
        )
    by_id = {photo.id: photo for photo in active_photos}
    ordered = [by_id[photo_id] for photo_id in payload.photo_ids]
    for index, photo in enumerate(ordered):
        photo.sort_order = index
    db.commit()
    return PhotoList(items=[photo_out(photo) for photo in ordered])


@router.delete("/photos/{photo_id}", status_code=204)
def delete_photo(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    photo = db.scalar(
        select(ItemPhoto)
        .join(Item)
        .where(ItemPhoto.id == photo_id, Item.household_id == auth.household.id)
    )
    if photo is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    keys = [photo.storage_key, photo.thumbnail_key]
    db.delete(photo)
    db.commit()
    for key in keys:
        storage.delete_key(key)
    return Response(status_code=204)


def _authorized_photo(db: Session, household_id: uuid.UUID, photo_id: uuid.UUID) -> ItemPhoto:
    photo = db.scalar(
        select(ItemPhoto)
        .join(Item)
        .where(ItemPhoto.id == photo_id, Item.household_id == household_id)
    )
    if photo is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    return photo


@router.get("/photos/{photo_id}/file")
def get_photo_file(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_photo(db, auth.household.id, photo_id)
    path = storage.resolve_key(photo.storage_key)
    return FileResponse(
        path,
        media_type=photo.content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@router.get("/photos/{photo_id}/thumbnail")
def get_photo_thumbnail(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    photo = _authorized_photo(db, auth.household.id, photo_id)
    key = photo.thumbnail_key or photo.storage_key
    path = storage.resolve_key(key)
    media_type = "image/webp" if photo.thumbnail_key else photo.content_type
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
