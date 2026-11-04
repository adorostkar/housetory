import uuid
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import (
    Category,
    Item,
    ItemPhoto,
    Purchase,
    Room,
    StorageLocation,
    Tag,
    Warranty,
)
from ...schemas.items import (
    ItemCreate,
    ItemDetailResponse,
    ItemList,
    ItemUpdate,
    PhotoList,
    PurchaseIn,
    WarrantyIn,
)
from ...services import storage
from ...services.hierarchy import descendant_ids
from ...services.purchases import get_purchase, prune_orphan_purchases, validate_receipt
from ...services.serializers import (
    item_detail,
    item_load_options,
    item_summary,
    photo_out,
)
from ...services.warranties import resolve_end_date
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["items"])


def _get_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    item = db.scalar(
        select(Item)
        .options(*item_load_options())
        .where(Item.id == item_id, Item.household_id == household_id)
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    return item


def _room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(422, "room_not_found", "The selected room does not exist.")
    return room


def _location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    location = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
        )
    )
    if location is None:
        raise ApiError(422, "location_not_found", "The selected storage location does not exist.")
    return location


def _category(db: Session, household_id: uuid.UUID, category_id: uuid.UUID) -> Category:
    category = db.scalar(
        select(Category).where(Category.id == category_id, Category.household_id == household_id)
    )
    if category is None:
        raise ApiError(422, "category_not_found", "The selected category does not exist.")
    return category


def _tags(db: Session, household_id: uuid.UUID, tag_ids: list[uuid.UUID]) -> list[Tag]:
    unique_ids = list(dict.fromkeys(tag_ids))
    if not unique_ids:
        return []
    tags = db.scalars(
        select(Tag).where(Tag.household_id == household_id, Tag.id.in_(unique_ids))
    ).all()
    if len(tags) != len(unique_ids):
        raise ApiError(422, "tag_not_found", "One or more selected tags do not exist.")
    return list(tags)


def _resolve_location(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
) -> tuple[uuid.UUID | None, StorageLocation | None]:
    location = _location(db, household_id, location_id) if location_id else None
    if room_id is not None:
        _room(db, household_id, room_id)
    if location is not None:
        if room_id is None:
            room_id = location.room_id
        elif location.room_id != room_id:
            raise ApiError(
                422,
                "location_room_mismatch",
                "That storage location belongs to a different room.",
            )
    return room_id, location


def _apply_purchase(db: Session, item: Item, payload: PurchaseIn, *, replace: bool) -> None:
    if replace or item.purchase is None:
        item.purchase = Purchase(household_id=item.household_id, currency="USD")
    purchase = cast(Purchase, item.purchase)
    fields = payload.model_fields_set
    if "merchant" in fields or "vendor" in fields:
        purchase.vendor = payload.merchant_name
    if "purchase_date" in fields:
        purchase.purchase_date = payload.purchase_date
    if "price_cents" in fields:
        purchase.price_cents = payload.price_cents
    if "currency" in fields:
        purchase.currency = payload.currency
    if "order_number" in fields:
        purchase.order_number = payload.order_number
    if "notes" in fields:
        purchase.notes = payload.notes
    if "receipt_document_id" in fields:
        validate_receipt(db, item.household_id, payload.receipt_document_id)
        purchase.receipt_document_id = payload.receipt_document_id


def _apply_warranty(db: Session, item: Item, payload: WarrantyIn, *, replace: bool) -> None:
    if replace or item.warranty is None:
        item.warranty = Warranty()
    warranty = cast(Warranty, item.warranty)
    fields = payload.model_fields_set
    if "provider" in fields:
        warranty.provider = payload.provider
    if "start_date" in fields:
        warranty.start_date = payload.start_date
    if "duration_months" in fields:
        warranty.duration_months = payload.duration_months
    if "reminder_days" in fields:
        warranty.reminder_days = payload.reminder_days
    if "notes" in fields:
        warranty.notes = payload.notes
    if "document_id" in fields:
        document = validate_receipt(db, item.household_id, payload.document_id)
        warranty.document_id = document.id if document is not None else None
    if "end_date" in fields:
        warranty.end_date = payload.end_date
    warranty.end_date = resolve_end_date(
        start_date=warranty.start_date,
        duration_months=warranty.duration_months,
        end_date=warranty.end_date,
    )
    if (
        warranty.start_date is not None
        and warranty.end_date is not None
        and warranty.end_date < warranty.start_date
    ):
        raise ApiError(
            422, "invalid_warranty_dates", "Warranty end date must not precede its start date."
        )
    if warranty.duration_months is not None and warranty.start_date is None:
        raise ApiError(
            422,
            "warranty_start_required",
            "A warranty duration requires a start date.",
        )


@router.get("/items", response_model=ItemList)
def list_items(
    q: Annotated[str | None, Query(max_length=200)] = None,
    room_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    tag_id: uuid.UUID | None = None,
    include_descendants: bool = False,
    include_archived: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    sort: Literal["created_desc", "created_asc", "name_asc", "name_desc", "updated_desc"] = (
        "created_desc"
    ),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemList:
    conditions = [Item.household_id == auth.household.id]
    if not include_archived:
        conditions.append(Item.is_archived.is_(False))
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
                StorageLocation.name.ilike(search),
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
    }[sort]
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*conditions)
        .order_by(*ordering)
        .limit(limit)
        .offset(offset)
    ).all()
    return ItemList(
        items=[item_summary(item) for item in items],
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
    room_id, location = _resolve_location(
        db, auth.household.id, payload.room_id, payload.storage_location_id
    )
    category = (
        _category(db, auth.household.id, payload.category_id) if payload.category_id else None
    )
    tags = _tags(db, auth.household.id, payload.tag_ids)

    item = Item(
        household_id=auth.household.id,
        name=payload.name,
        description=payload.description,
        brand=payload.brand,
        model=payload.model,
        serial_number=payload.serial_number,
        quantity=payload.quantity,
        condition=payload.condition.value,
        room_id=room_id,
        storage_location_id=location.id if location else None,
        category_id=category.id if category else None,
        current_value_cents=payload.current_value_cents,
        current_value_currency=payload.current_value_currency,
    )
    item.tags = tags
    if payload.purchase_id is not None:
        item.purchase_id = get_purchase(db, auth.household.id, payload.purchase_id).id
    elif payload.purchase is not None:
        _apply_purchase(db, item, payload.purchase, replace=True)
    if payload.warranty is not None:
        _apply_warranty(db, item, payload.warranty, replace=True)
    db.add(item)
    db.commit()
    item = _get_item(db, auth.household.id, item.id)
    return ItemDetailResponse(item=item_detail(item))


@router.get("/items/{item_id}", response_model=ItemDetailResponse)
def get_item(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    return ItemDetailResponse(item=item_detail(item))


@router.patch("/items/{item_id}", response_model=ItemDetailResponse)
def update_item(
    item_id: uuid.UUID,
    payload: ItemUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemDetailResponse:
    item = _get_item(db, auth.household.id, item_id)
    fields = payload.model_fields_set

    if "room_id" in fields or "storage_location_id" in fields:
        new_room_id = payload.room_id if "room_id" in fields else item.room_id
        new_location_id = (
            payload.storage_location_id
            if "storage_location_id" in fields
            else item.storage_location_id
        )
        if new_room_id is None and "storage_location_id" not in fields:
            new_location_id = None
        if "room_id" in fields and "storage_location_id" not in fields and new_location_id:
            current_location = db.get(StorageLocation, new_location_id)
            if current_location is not None and current_location.room_id != new_room_id:
                new_location_id = None
        resolved_room_id, location = _resolve_location(
            db, auth.household.id, new_room_id, new_location_id
        )
        item.room_id = resolved_room_id
        item.storage_location_id = location.id if location else None

    if "category_id" in fields:
        if payload.category_id is None:
            item.category_id = None
        else:
            item.category_id = _category(db, auth.household.id, payload.category_id).id

    if "tag_ids" in fields and payload.tag_ids is not None:
        item.tags = _tags(db, auth.household.id, payload.tag_ids)

    if payload.name is not None:
        item.name = payload.name
    if "description" in fields:
        item.description = payload.description
    if "brand" in fields:
        item.brand = payload.brand
    if "model" in fields:
        item.model = payload.model
    if "serial_number" in fields:
        item.serial_number = payload.serial_number
    if payload.quantity is not None:
        item.quantity = payload.quantity
    if payload.condition is not None:
        item.condition = payload.condition.value
    if payload.is_archived is not None:
        item.is_archived = payload.is_archived

    if "current_value_cents" in fields:
        item.current_value_cents = payload.current_value_cents
    if "current_value_currency" in fields and payload.current_value_currency is not None:
        item.current_value_currency = payload.current_value_currency

    if "purchase_id" in fields:
        previous_purchase_id = item.purchase_id
        if payload.purchase_id is None:
            item.purchase_id = None
        else:
            item.purchase_id = get_purchase(db, auth.household.id, payload.purchase_id).id
        if previous_purchase_id is not None:
            db.flush()
            prune_orphan_purchases(db, auth.household.id)
    elif "purchase" in fields:
        previous_purchase_id = item.purchase_id
        if payload.purchase is None:
            item.purchase_id = None
        else:
            _apply_purchase(db, item, payload.purchase, replace=item.purchase is None)
        if previous_purchase_id is not None and item.purchase_id != previous_purchase_id:
            db.flush()
            prune_orphan_purchases(db, auth.household.id)
    if "warranty" in fields:
        if payload.warranty is None:
            item.warranty = None
        else:
            _apply_warranty(db, item, payload.warranty, replace=item.warranty is None)

    db.commit()
    # Relationships may already be loaded on the identity-mapped object; force a
    # fresh read so a moved item's room/location/category are reflected in the
    # response.
    db.expire_all()
    item = _get_item(db, auth.household.id, item.id)
    return ItemDetailResponse(item=item_detail(item))


@router.delete("/items/{item_id}", status_code=204)
def delete_item(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    item = _get_item(db, auth.household.id, item_id)
    keys = [photo.storage_key for photo in item.photos]
    keys += [photo.thumbnail_key for photo in item.photos if photo.thumbnail_key]

    # Documents linked only to this item would otherwise become unreachable
    # orphans. Shared documents remain in the household library.
    exclusive_documents = [document for document in item.documents if len(document.items) <= 1]
    for document in exclusive_documents:
        keys.append(document.storage_key)
        keys.append(document.original_storage_key)
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
