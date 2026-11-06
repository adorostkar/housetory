from datetime import date
from typing import Literal

from sqlalchemy.orm import joinedload, selectinload

from ..config import get_settings
from ..domain import WarrantyStatus
from ..models import (
    Document,
    DocumentScan,
    DocumentScanPage,
    Item,
    ItemImage,
    ItemPhoto,
    Purchase,
    PurchaseAllocation,
    Room,
    StorageLocation,
    Warranty,
)
from ..schemas.common import ItemReference
from ..schemas.documents import DocumentBrief, DocumentOut, DocumentPageOut, ScanAdjustments
from ..schemas.households import HouseholdBrief
from ..schemas.imports import ImportSourceBrief
from ..schemas.items import (
    CategoryBrief,
    ItemDetail,
    ItemSummary,
    LastVerifiedOut,
    LocationBrief,
    PhotoOut,
    RoomBrief,
    TagBrief,
)
from ..schemas.properties import PropertyBrief
from ..schemas.purchases import PurchaseOut
from ..schemas.warranties import WarrantyOut
from .item_images import representative_image_out
from .purchase_info import effective_purchase_info_status, missing_purchase_info_fields
from .warranties import effective_reminder_days, warranty_status

_settings = get_settings()


def item_load_options() -> list:
    return [
        joinedload(Item.household),
        joinedload(Item.room).joinedload(Room.property),
        joinedload(Item.storage_location)
        .joinedload(StorageLocation.room)
        .joinedload(Room.property),
        joinedload(Item.category),
        joinedload(Item.purchase).joinedload(Purchase.receipt_document),
        joinedload(Item.purchase).selectinload(Purchase.items),
        joinedload(Item.purchase)
        .selectinload(Purchase.allocations)
        .joinedload(PurchaseAllocation.item),
        joinedload(Item.warranty).joinedload(Warranty.document),
        joinedload(Item.last_verification),
        selectinload(Item.tags),
        selectinload(Item.photos),
        selectinload(Item.images).joinedload(ItemImage.provider),
        selectinload(Item.documents).selectinload(Document.items),
        selectinload(Item.documents).selectinload(Document.scan).selectinload(DocumentScan.pages),
    ]


def photo_url(photo_id, *, thumbnail: bool = False) -> str:  # noqa: ANN001
    suffix = "/thumbnail" if thumbnail else "/file"
    return f"{_settings.api_prefix}/photos/{photo_id}{suffix}"


def document_url(document_id, *, original: bool = False) -> str:  # noqa: ANN001
    suffix = "/original" if original else "/file"
    return f"{_settings.api_prefix}/documents/{document_id}{suffix}"


def document_page_out(page: DocumentScanPage) -> DocumentPageOut:
    prefix = f"{_settings.api_prefix}/documents/scans/{page.scan_id}/pages/{page.id}"
    try:
        adjustments = ScanAdjustments.model_validate(page.adjustments or {})
    except ValueError:
        adjustments = ScanAdjustments()
    return DocumentPageOut(
        id=page.id,
        page_number=page.page_index + 1,
        width=page.width,
        height=page.height,
        original_filename=page.original_filename,
        original_content_type=page.original_content_type,
        original_byte_size=page.original_byte_size,
        cleaned_content_type=page.cleaned_content_type,
        cleaned_byte_size=page.cleaned_byte_size,
        original_url=f"{prefix}/original",
        cleaned_url=f"{prefix}/file",
        adjustments=adjustments,
        updated_at=page.updated_at,
    )


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
    pages = (
        [
            document_page_out(page)
            for page in sorted(document.scan.pages, key=lambda page: page.page_index)
        ]
        if document.scan is not None
        else []
    )
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
        pages=pages,
        page_count=len(pages),
        url=document_url(document.id),
        original_url=document_url(document.id, original=True),
    )


def purchase_out(purchase: Purchase) -> PurchaseOut:
    items = sorted(purchase.items, key=lambda item: item.name.lower())
    allocations = sorted(
        purchase.allocations,
        key=lambda allocation: (
            allocation.item.name.lower() if allocation.item else "",
            allocation.created_at,
        ),
    )
    allocated_total = sum(
        allocation.allocated_cents
        for allocation in allocations
        if allocation.allocated_cents is not None
    )
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
        allocations=[
            {
                "id": allocation.id,
                "item_id": allocation.item_id,
                "item": ItemReference(
                    id=allocation.item.id,
                    name=allocation.item.name,
                )
                if allocation.item is not None
                else ItemReference(id=allocation.item_id, name="Deleted item"),
                "document_id": allocation.document_id,
                "extraction_version": allocation.extraction_version,
                "source_line_id": allocation.source_line_id,
                "description": allocation.description,
                "quantity": allocation.quantity,
                "unit_price_cents": allocation.unit_price_cents,
                "line_total_cents": allocation.line_total_cents,
                "allocated_cents": allocation.allocated_cents,
                "currency": allocation.currency,
                "source_evidence": allocation.source_evidence,
                "created_at": allocation.created_at,
            }
            for allocation in allocations
        ],
        allocated_total_cents=allocated_total,
        unallocated_cents=(
            purchase.price_cents - allocated_total if purchase.price_cents is not None else None
        ),
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


def last_verified_out(item: Item, on_loan_quantity: int = 0) -> LastVerifiedOut | None:
    state = item.last_verification
    if state is None:
        return None
    reasons: list[str] = []
    if item.updated_at != state.item_updated_at:
        reasons.append("Item changed since this check.")
    if item.quantity != state.owned_quantity:
        reasons.append("Recorded quantity changed since this check.")
    if on_loan_quantity != state.on_loan_quantity:
        reasons.append("Loan quantities changed since this check.")
    if item.room_id != state.room_id or item.storage_location_id != state.location_id:
        reasons.append("Location changed since this check.")
    return LastVerifiedOut(
        at=state.verified_at,
        session_id=state.session_id,
        status=state.status,
        quantity=state.counted_quantity,
        owned_quantity=state.owned_quantity,
        on_loan_quantity=state.on_loan_quantity,
        location_path=state.location_path,
        room_id=state.room_id,
        location_id=state.location_id,
        stale=bool(reasons),
        stale_reason=" ".join(reasons) or None,
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
    property_record = (
        item.room.property
        if item.room is not None
        else (
            item.storage_location.room.property
            if item.storage_location is not None and item.storage_location.room is not None
            else None
        )
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
        household=(
            HouseholdBrief(id=item.household.id, name=item.household.name)
            if item.household is not None
            else None
        ),
        property=(
            PropertyBrief(
                id=property_record.id,
                name=property_record.name,
                is_archived=property_record.is_archived,
            )
            if property_record is not None
            else None
        ),
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
        representative_image=representative_image_out(item),
        purchase=purchase_out(purchase) if purchase else None,
        purchase_info_status=effective_purchase_info_status(item).value,
        purchase_info_missing_fields=missing_purchase_info_fields(item),
        warranty=(warranty_out(warranty, reminder_days) if warranty else None),
        current_value_cents=item.current_value_cents,
        current_value_currency=item.current_value_currency,
        created_at=item.created_at,
        updated_at=item.updated_at,
        last_verified=last_verified_out(item, on_loan_quantity),
    )


def item_detail(
    item: Item,
    *,
    household_reminder_days: int | None = None,
    import_source: ImportSourceBrief | None = None,
    location_path: list[LocationBrief] | None = None,
    on_loan_quantity: int = 0,
) -> ItemDetail:
    summary = item_summary(
        item,
        household_reminder_days=household_reminder_days,
        on_loan_quantity=on_loan_quantity,
    )
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
    "document_page_out",
    "document_url",
    "item_detail",
    "item_load_options",
    "item_summary",
    "last_verified_out",
    "photo_out",
    "photo_url",
    "purchase_out",
    "warranty_out",
]
