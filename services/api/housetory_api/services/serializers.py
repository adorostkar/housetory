from datetime import date
from typing import Literal

from sqlalchemy.orm import joinedload, selectinload

from ..config import get_settings
from ..domain import WarrantyStatus
from ..models import Document, Item, ItemPhoto, Purchase, Warranty
from ..schemas.common import ItemReference
from ..schemas.documents import DocumentBrief, DocumentOut
from ..schemas.imports import ImportSourceBrief
from ..schemas.items import (
    CategoryBrief,
    ItemDetail,
    ItemSummary,
    LocationBrief,
    PhotoOut,
    RoomBrief,
    TagBrief,
)
from ..schemas.purchases import PurchaseOut
from ..schemas.warranties import WarrantyOut
from .warranties import effective_reminder_days, warranty_status

_settings = get_settings()


def item_load_options() -> list:
    return [
        joinedload(Item.household),
        joinedload(Item.room),
        joinedload(Item.storage_location),
        joinedload(Item.category),
        joinedload(Item.purchase).joinedload(Purchase.receipt_document),
        joinedload(Item.purchase).selectinload(Purchase.items),
        joinedload(Item.warranty).joinedload(Warranty.document),
        selectinload(Item.tags),
        selectinload(Item.photos),
        selectinload(Item.documents).selectinload(Document.items),
    ]


def photo_url(photo_id, *, thumbnail: bool = False) -> str:  # noqa: ANN001
    suffix = "/thumbnail" if thumbnail else "/file"
    return f"{_settings.api_prefix}/photos/{photo_id}{suffix}"


def document_url(document_id, *, original: bool = False) -> str:  # noqa: ANN001
    suffix = "/original" if original else "/file"
    return f"{_settings.api_prefix}/documents/{document_id}{suffix}"


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


def entity_photo_out(photo, kind: Literal["room", "location"]) -> PhotoOut:
    path = f"{kind}-photos/{photo.id}"
    return PhotoOut(
        id=photo.id,
        original_filename=photo.original_filename,
        content_type=photo.content_type,
        byte_size=photo.byte_size,
        width=photo.width,
        height=photo.height,
        sort_order=photo.sort_order,
        created_at=photo.created_at,
        url=f"{_settings.api_prefix}/{path}/file",
        thumbnail_url=f"{_settings.api_prefix}/{path}/thumbnail",
    )


def document_brief(document: Document) -> DocumentBrief:
    return DocumentBrief(
        id=document.id,
        title=document.title,
        document_type=document.document_type,
        content_type=document.content_type,
        url=document_url(document.id),
    )


def document_out(document: Document) -> DocumentOut:
    items = sorted(document.items, key=lambda item: item.name.lower())
    return DocumentOut(
        id=document.id,
        title=document.title,
        document_type=document.document_type,
        original_filename=document.original_filename,
        content_type=document.content_type,
        original_content_type=document.original_content_type,
        byte_size=document.byte_size,
        original_byte_size=document.original_byte_size,
        document_date=document.document_date,
        merchant=document.merchant,
        notes=document.notes,
        extracted_text=document.extracted_text,
        extracted_metadata=document.extracted_metadata or {},
        ocr_status=document.ocr_status,
        ocr_error=document.ocr_error,
        ocr_confidence=document.ocr_confidence,
        ocr_processed_at=document.ocr_processed_at,
        created_at=document.created_at,
        updated_at=document.updated_at,
        items=[ItemReference(id=item.id, name=item.name) for item in items],
        item_count=len(items),
        url=document_url(document.id),
        original_url=document_url(document.id, original=True),
    )


def purchase_out(purchase: Purchase) -> PurchaseOut:
    items = sorted(purchase.items, key=lambda item: item.name.lower())
    return PurchaseOut(
        id=purchase.id,
        merchant=purchase.vendor,
        vendor=purchase.vendor,
        purchase_date=purchase.purchase_date,
        price_cents=purchase.price_cents,
        currency=purchase.currency,
        order_number=purchase.order_number,
        notes=purchase.notes,
        receipt_document_id=purchase.receipt_document_id,
        receipt=(
            document_brief(purchase.receipt_document)
            if purchase.receipt_document is not None
            else None
        ),
        items=[ItemReference(id=item.id, name=item.name) for item in items],
        item_count=len(items),
        is_shared=len(items) > 1,
        created_at=purchase.created_at,
        updated_at=purchase.updated_at,
    )


def warranty_out(
    warranty: Warranty,
    household_reminder_days: int,
    *,
    include_item: bool = False,
    today: date | None = None,
) -> WarrantyOut:
    reminder = effective_reminder_days(warranty.reminder_days, household_reminder_days)
    status, days_remaining = warranty_status(warranty.end_date, reminder_days=reminder, today=today)
    return WarrantyOut(
        id=warranty.id,
        provider=warranty.provider,
        start_date=warranty.start_date,
        duration_months=warranty.duration_months,
        end_date=warranty.end_date,
        reminder_days=warranty.reminder_days,
        effective_reminder_days=reminder,
        notes=warranty.notes,
        coverage_notes=warranty.notes,
        status=status.value if isinstance(status, WarrantyStatus) else status,
        days_remaining=days_remaining,
        document_id=warranty.document_id,
        document=(document_brief(warranty.document) if warranty.document is not None else None),
        item=(
            ItemReference(id=warranty.item.id, name=warranty.item.name)
            if include_item and warranty.item is not None
            else None
        ),
        created_at=warranty.created_at,
        updated_at=warranty.updated_at,
    )


def _primary_photo(item: Item) -> PhotoOut | None:
    photos = sorted(item.photos, key=lambda photo: (photo.sort_order, photo.created_at))
    return photo_out(photos[0]) if photos else None


def item_summary(
    item: Item,
    *,
    household_reminder_days: int | None = None,
    on_loan_quantity: int = 0,
) -> ItemSummary:
    purchase = item.purchase
    warranty = item.warranty
    reminder_days = (
        household_reminder_days
        if household_reminder_days is not None
        else item.household.warranty_reminder_days
    )
    return ItemSummary(
        id=item.id,
        name=item.name,
        description=item.description,
        brand=item.brand,
        model=item.model,
        quantity=item.quantity,
        on_loan_quantity=on_loan_quantity,
        condition=item.condition,
        is_archived=item.is_archived,
        room=RoomBrief(id=item.room.id, name=item.room.name) if item.room else None,
        location=(
            LocationBrief(
                id=item.storage_location.id,
                name=item.storage_location.name,
                kind=item.storage_location.kind,
                parent_id=item.storage_location.parent_id,
                identifier=item.storage_location.identifier,
                container_type=item.storage_location.container_type,
                is_container=item.storage_location.is_container,
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
        purchase=purchase_out(purchase) if purchase else None,
        warranty=(warranty_out(warranty, reminder_days) if warranty else None),
        current_value_cents=item.current_value_cents,
        current_value_currency=item.current_value_currency,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def item_detail(
    item: Item,
    *,
    household_reminder_days: int | None = None,
    import_source: ImportSourceBrief | None = None,
    location_path: list[LocationBrief] | None = None,
) -> ItemDetail:
    summary = item_summary(item, household_reminder_days=household_reminder_days)
    return ItemDetail(
        **summary.model_dump(exclude={"location_path"}),
        location_path=location_path or [],
        serial_number=item.serial_number,
        import_source=import_source,
        photos=[
            photo_out(photo)
            for photo in sorted(item.photos, key=lambda p: (p.sort_order, p.created_at))
        ],
        documents=[
            document_out(document)
            for document in sorted(item.documents, key=lambda d: d.created_at, reverse=True)
        ],
    )


__all__ = [
    "document_brief",
    "document_out",
    "document_url",
    "item_detail",
    "item_load_options",
    "item_summary",
    "photo_out",
    "photo_url",
    "purchase_out",
    "warranty_out",
]
