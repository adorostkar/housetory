from sqlalchemy.orm import joinedload, selectinload

from ..config import get_settings
from ..models import Document, Item, ItemPhoto
from ..schemas.items import (
    CategoryBrief,
    DocumentOut,
    ItemDetail,
    ItemSummary,
    LocationBrief,
    PhotoOut,
    PurchaseOut,
    RoomBrief,
    TagBrief,
    WarrantyOut,
)

_settings = get_settings()


def item_load_options() -> list:
    return [
        joinedload(Item.room),
        joinedload(Item.storage_location),
        joinedload(Item.category),
        joinedload(Item.purchase),
        joinedload(Item.warranty),
        selectinload(Item.tags),
        selectinload(Item.photos),
        selectinload(Item.documents),
    ]


def photo_url(photo_id, *, thumbnail: bool = False) -> str:  # noqa: ANN001
    suffix = "/thumbnail" if thumbnail else "/file"
    return f"{_settings.api_prefix}/photos/{photo_id}{suffix}"


def photo_out(photo: ItemPhoto) -> PhotoOut:
    return PhotoOut(
        id=photo.id,
        original_filename=photo.original_filename,
        content_type=photo.content_type,
        byte_size=photo.byte_size,
        width=photo.width,
        height=photo.height,
        sort_order=photo.sort_order,
        created_at=photo.created_at,
        url=photo_url(photo.id),
        thumbnail_url=photo_url(photo.id, thumbnail=True),
    )


def document_out(document: Document) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        original_filename=document.original_filename,
        content_type=document.content_type,
        byte_size=document.byte_size,
        title=document.title,
        created_at=document.created_at,
        url=f"{_settings.api_prefix}/documents/{document.id}/file",
    )


def _primary_photo(item: Item) -> PhotoOut | None:
    photos = sorted(item.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    return photo_out(photos[0]) if photos else None


def item_summary(item: Item) -> ItemSummary:
    purchase = item.purchase
    warranty = item.warranty
    return ItemSummary(
        id=item.id,
        name=item.name,
        description=item.description,
        brand=item.brand,
        model=item.model,
        quantity=item.quantity,
        condition=item.condition,
        is_archived=item.is_archived,
        room=RoomBrief(id=item.room.id, name=item.room.name) if item.room else None,
        location=(
            LocationBrief(
                id=item.storage_location.id,
                name=item.storage_location.name,
                kind=item.storage_location.kind,
            )
            if item.storage_location
            else None
        ),
        category=(
            CategoryBrief(id=item.category.id, name=item.category.name, color=item.category.color)
            if item.category
            else None
        ),
        tags=[
            TagBrief(id=tag.id, name=tag.name)
            for tag in sorted(item.tags, key=lambda t: t.name.lower())
        ],
        primary_photo=_primary_photo(item),
        purchase=(
            PurchaseOut(
                vendor=purchase.vendor,
                purchase_date=purchase.purchase_date,
                price_cents=purchase.price_cents,
                currency=purchase.currency,
                order_number=purchase.order_number,
                notes=purchase.notes,
            )
            if purchase
            else None
        ),
        warranty=(
            WarrantyOut(
                provider=warranty.provider,
                start_date=warranty.start_date,
                end_date=warranty.end_date,
                notes=warranty.notes,
            )
            if warranty
            else None
        ),
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def item_detail(item: Item) -> ItemDetail:
    summary = item_summary(item)
    return ItemDetail(
        **summary.model_dump(),
        serial_number=item.serial_number,
        photos=[
            photo_out(photo)
            for photo in sorted(item.photos, key=lambda p: (p.sort_order, p.created_at))
        ],
        documents=[
            document_out(document)
            for document in sorted(item.documents, key=lambda d: d.created_at, reverse=True)
        ],
    )
