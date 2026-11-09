"""Evidence snapshot building from recorded household facts."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ...api.errors import ApiError
from ...config import get_settings
from ...domain import DocumentType, PurchaseInfoStatus
from ...models import (
    Document,
    DocumentScan,
    Household,
    Item,
    Property,
    Room,
    StorageLocation,
)
from ...schemas.evidence_exports import (
    EvidenceCurrencyTotal,
    EvidenceDocumentPreview,
    EvidenceItemPreview,
    EvidenceOptionsIn,
    EvidencePreviewOut,
    EvidencePurchaseReference,
    EvidenceScopeIn,
)
from .. import current_value as current_value_service
from .. import lending
from ..purchase_info import effective_purchase_info_status, missing_purchase_info_fields
from ..serializers import item_load_options, last_verified_out
from ..warranties import effective_reminder_days, warranty_status

FORMAT_VERSION = "inventory-evidence-v2"
CONDITION_LABELS = {
    "new": "New",
    "excellent": "Excellent",
    "good": "Good",
    "fair": "Fair",
    "poor": "Poor",
    "unknown": "Unknown",
}
DOCUMENT_KIND_ORDER = {"receipt": 0, "warranty": 1, "manual": 2, "other": 3}


def _clean_text(value: Any, limit: int = 4000) -> str:
    if value is None:
        return ""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(value))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _slug(value: str, fallback: str = "entry", limit: int = 42) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", _clean_text(value, 200)).strip("-._")
    return (cleaned[:limit] or fallback).lower()


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


def _iso(value: date | datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _local_clock() -> tuple[datetime, str]:
    local = datetime.now(UTC).astimezone()
    name = local.tzname() or "UTC"
    offset = local.strftime("%z")
    label = f"{name} (UTC{offset[:3]}:{offset[3:]})" if offset and offset != "+0000" else name
    return local, label


def _fingerprint(snapshot: dict[str, Any]) -> str:
    state = {
        key: value
        for key, value in snapshot.items()
        if key not in {"generated_at", "timezone", "fingerprint"}
    }
    encoded = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _snapshot_current_value(item: dict[str, Any]) -> dict[str, Any]:
    """Read current-value fields without reinterpreting an older snapshot.

    v1 stored one ``current_value_cents`` amount per item record. It is treated
    as a legacy record total here; it is never converted into a per-unit value or
    multiplied by quantity. v2 stores the explicit unit/quantity/total basis.
    """
    if "current_value_total_cents" in item:
        return {
            "unit_cents": item.get("current_value_unit_cents"),
            "quantity": item.get("current_value_quantity", item.get("quantity", 0)),
            "total_cents": item.get("current_value_total_cents"),
            "currency": item.get("current_value_currency"),
            "basis": item.get("current_value_basis"),
            "estimated_at": item.get("current_value_estimated_at"),
        }
    legacy_total = item.get("current_value_cents")
    return {
        "unit_cents": None,
        "quantity": item.get("quantity", 0),
        "total_cents": legacy_total,
        "currency": item.get("current_value_currency"),
        "basis": current_value_service.LEGACY_RECORD_TOTAL if legacy_total is not None else None,
        "estimated_at": None,
    }


def _snapshot_currency_total(entry: dict[str, Any]) -> dict[str, Any]:
    if "current_value_total_cents" in entry:
        return entry
    legacy = dict(entry)
    legacy["current_value_total_cents"] = legacy.pop("current_value_cents", 0)
    return legacy


def _room_paths(rooms: list[Room]) -> dict[uuid.UUID, str]:
    by_id = {room.id: room for room in rooms}
    result: dict[uuid.UUID, str] = {}

    def resolve(room_id: uuid.UUID, seen: set[uuid.UUID] | None = None) -> str:
        if room_id in result:
            return result[room_id]
        seen = seen or set()
        if room_id in seen:
            return by_id[room_id].name
        seen.add(room_id)
        room = by_id[room_id]
        prefix = resolve(room.parent_id, seen) if room.parent_id in by_id else ""
        value = f"{prefix} / {room.name}" if prefix else room.name
        result[room_id] = value
        return value

    for room in rooms:
        resolve(room.id)
    return result


def _location_path(
    location: StorageLocation | None, by_id: dict[uuid.UUID, StorageLocation]
) -> str:
    if location is None:
        return ""
    parts: list[str] = []
    seen: set[uuid.UUID] = set()
    cursor: StorageLocation | None = location
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        parts.append(
            f"{cursor.identifier} · {cursor.name}"
            if cursor.identifier and cursor.identifier != cursor.name
            else cursor.name
        )
        cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
    return " / ".join(reversed(parts))


def _scope_roots(
    db: Session, household_id: uuid.UUID, scope: EvidenceScopeIn
) -> tuple[set[uuid.UUID], set[uuid.UUID], str]:
    room_rows = db.execute(
        select(
            Room.id,
            Room.parent_id,
            Room.name,
            Property.name,
        )
        .join(Property, Property.id == Room.property_id)
        .where(Room.household_id == household_id)
    ).all()
    location_rows = db.execute(
        select(
            StorageLocation.id,
            StorageLocation.parent_id,
            StorageLocation.name,
            StorageLocation.identifier,
            Property.name,
        )
        .join(Room, Room.id == StorageLocation.room_id)
        .join(Property, Property.id == Room.property_id)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
        )
    ).all()
    room_by_id = {row[0]: row for row in room_rows}
    location_by_id = {row[0]: row for row in location_rows}
    room_root_ids = set(scope.room_ids)
    container_root_ids = set(scope.container_ids)
    if not room_root_ids.issubset(room_by_id):
        raise ApiError(422, "scope_not_found", "One or more selected rooms do not exist.")
    if not container_root_ids.issubset(location_by_id):
        raise ApiError(422, "scope_not_found", "One or more selected containers do not exist.")
    room_ids: set[uuid.UUID] = set()
    if room_root_ids:
        children: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
        for room_id, parent_id, _name, _property_name in room_rows:
            children[parent_id].append(room_id)
        stack = list(room_root_ids)
        while stack:
            current = stack.pop()
            if current in room_ids:
                continue
            room_ids.add(current)
            stack.extend(children.get(current, []))
    location_ids: set[uuid.UUID] = set()
    if container_root_ids:
        children = defaultdict(list)
        for location_id, parent_id, _name, _identifier, _property_name in location_rows:
            children[parent_id].append(location_id)
        stack = list(container_root_ids)
        while stack:
            current = stack.pop()
            if current in location_ids:
                continue
            location_ids.add(current)
            stack.extend(children.get(current, []))
    labels: list[str] = []
    for room_id in sorted(room_root_ids, key=lambda value: room_by_id[value][2].lower()):
        room_id_value, _parent, name, property_name = room_by_id[room_id]
        labels.append(f"Room: {property_name} / {name}")
    for location_id in sorted(
        container_root_ids,
        key=lambda value: (
            (location_by_id[value][3] or "").lower(),
            location_by_id[value][2].lower(),
        ),
    ):
        _id, _parent, name, identifier, property_name = location_by_id[location_id]
        labels.append(f"Container: {property_name} / {identifier or name}")
    if scope.item_ids:
        count = len(scope.item_ids)
        labels.append(f"{count} selected item" + ("s" if count != 1 else ""))
    if scope.include_home:
        property_count = int(
            db.scalar(
                select(func.count(Property.id)).where(
                    Property.household_id == household_id,
                    Property.is_archived.is_(False),
                )
            )
            or 0
        )
        labels.insert(0, "All properties" if property_count > 1 else "Current home")
    if not labels:
        labels.append("Selected inventory")
    if len(labels) > 4:
        label = f"{', '.join(labels[:3])} and {len(labels) - 3} more scope(s)"
    else:
        label = ", ".join(labels)
    return room_ids, location_ids, label


def _selected_item_rows(
    db: Session,
    household_id: uuid.UUID,
    scope: EvidenceScopeIn,
) -> tuple[list[tuple[uuid.UUID, bool]], str]:
    room_ids, container_ids, scope_label = _scope_roots(db, household_id, scope)
    extra_item_ids = set(scope.item_ids)
    if extra_item_ids:
        existing = set(
            db.scalars(
                select(Item.id).where(
                    Item.household_id == household_id, Item.id.in_(extra_item_ids)
                )
            ).all()
        )
        if existing != extra_item_ids:
            raise ApiError(422, "scope_not_found", "One or more selected items do not exist.")
    conditions = [Item.household_id == household_id]
    if not scope.include_home:
        selectors = []
        if extra_item_ids:
            selectors.append(Item.id.in_(extra_item_ids))
        if room_ids:
            selectors.append(Item.room_id.in_(room_ids))
        if container_ids:
            selectors.append(Item.storage_location_id.in_(container_ids))
            selectors.append(
                Item.id.in_(
                    select(StorageLocation.owner_item_id).where(
                        StorageLocation.household_id == household_id,
                        StorageLocation.id.in_(container_ids),
                        StorageLocation.owner_item_id.is_not(None),
                    )
                )
            )
        if not selectors:
            return [], scope_label
        conditions.append(or_(*selectors))
    rows = list(db.execute(select(Item.id, Item.is_archived).where(*conditions)).all())
    return rows, scope_label


def _document_kind(
    document: Document,
    *,
    receipt_ids: set[uuid.UUID],
    warranty_ids: set[uuid.UUID],
) -> str:
    if document.id in receipt_ids or document.document_type in {
        DocumentType.RECEIPT.value,
        DocumentType.INVOICE.value,
    }:
        return "receipt"
    if (
        document.id in warranty_ids
        or document.document_type == DocumentType.WARRANTY_CERTIFICATE.value
    ):
        return "warranty"
    if document.document_type in {
        DocumentType.MANUAL.value,
        DocumentType.SPECIFICATION.value,
    }:
        return "manual"
    return "other"


def _category_included(kind: str, options: EvidenceOptionsIn) -> bool:
    return {
        "receipt": options.include_receipts,
        "warranty": options.include_warranty_documents,
        "manual": options.include_manuals,
        "other": options.include_other_documents,
    }[kind]


def build_snapshot(
    db: Session,
    household: Household,
    scope: EvidenceScopeIn,
    include_archived: bool,
    options: EvidenceOptionsIn,
) -> dict[str, Any]:
    settings = get_settings()
    rows, scope_label = _selected_item_rows(db, household.id, scope)
    archived_excluded = 0 if include_archived else sum(1 for _item_id, archived in rows if archived)
    selected_rows = [item_id for item_id, archived in rows if include_archived or not archived]
    if len(selected_rows) > settings.evidence_export_max_items:
        raise ApiError(
            422,
            "export_too_many_items",
            f"This selection has {len(selected_rows)} items; the limit is "
            f"{settings.evidence_export_max_items}. Narrow the scope before exporting.",
        )
    if not selected_rows:
        local, timezone_label = _local_clock()
        snapshot = {
            "format_version": FORMAT_VERSION,
            "household": {"id": str(household.id), "name": household.name},
            "generated_at": local.isoformat(),
            "timezone": timezone_label,
            "scope": scope.as_json(),
            "scope_label": scope_label,
            "include_archived": include_archived,
            "options": options.model_dump(mode="json"),
            "item_count": 0,
            "unit_count": 0,
            "at_home_unit_count": 0,
            "on_loan_unit_count": 0,
            "archived_excluded_count": archived_excluded,
            "missing_purchase_count": 0,
            "items": [],
            "documents": [],
            "photos": [],
            "currency_totals": [],
            "purchase_references": [],
            "photo_count": 0,
            "included_photo_count": 0,
            "photo_bytes": 0,
            "document_count": 0,
            "included_document_count": 0,
            "document_bytes": 0,
            "evidence_reference_count": 0,
            "bundle_estimated_bytes": 0,
            "max_bundle_bytes": settings.evidence_export_max_bundle_mb * 1024 * 1024,
            "warnings": ["No inventory items are in this selection."],
        }
        snapshot["fingerprint"] = _fingerprint(snapshot)
        return snapshot

    items = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(Item.household_id == household.id, Item.id.in_(selected_rows))
            .execution_options(populate_existing=True)
        ).all()
    )
    rooms = list(db.scalars(select(Room).where(Room.household_id == household.id)).all())
    locations = list(
        db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household.id,
                StorageLocation.active(),
            )
        ).all()
    )
    room_path_map = _room_paths(rooms)
    location_by_id = {location.id: location for location in locations}
    selected_ids = {item.id for item in items}
    loan_quantities = lending.loan_quantities_for_items(db, household.id, list(selected_ids))
    receipt_ids: set[uuid.UUID] = set()
    warranty_ids: set[uuid.UUID] = set()
    purchase_selected_items: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for item in items:
        if item.purchase and item.purchase.receipt_document_id:
            receipt_ids.add(item.purchase.receipt_document_id)
            purchase_selected_items[item.purchase_id].add(item.id)
        if item.warranty and item.warranty.document_id:
            warranty_ids.add(item.warranty.document_id)

    document_ids: set[uuid.UUID] = set()
    for item in items:
        document_ids.update(document.id for document in item.documents)
    document_ids.update(receipt_ids)
    document_ids.update(warranty_ids)
    if len(document_ids) > settings.evidence_export_max_documents:
        raise ApiError(
            422,
            "export_too_many_documents",
            f"This selection references {len(document_ids)} documents; the limit is "
            f"{settings.evidence_export_max_documents}. Exclude manuals or narrow the scope.",
        )
    documents_by_id: dict[uuid.UUID, Document] = {}
    if document_ids:
        documents = db.scalars(
            select(Document)
            .options(
                selectinload(Document.items),
                selectinload(Document.scan).selectinload(DocumentScan.pages),
            )
            .where(
                Document.household_id == household.id,
                Document.id.in_(document_ids),
            )
            .execution_options(populate_existing=True)
        ).all()
        documents_by_id = {document.id: document for document in documents}

    documents_snapshot: list[dict[str, Any]] = []
    doc_refs: dict[uuid.UUID, str] = {}
    included_docs: list[tuple[Document, str]] = []
    for document in documents_by_id.values():
        kind = _document_kind(document, receipt_ids=receipt_ids, warranty_ids=warranty_ids)
        linked_item_ids = {item.id for item in document.items if item.id in selected_ids}
        if document.id in receipt_ids:
            for purchase_id, item_ids in purchase_selected_items.items():
                purchase = next(
                    (
                        item.purchase
                        for item in items
                        if item.purchase_id == purchase_id and item.purchase is not None
                    ),
                    None,
                )
                if purchase is not None and purchase.receipt_document_id == document.id:
                    linked_item_ids.update(item_ids)
        if document.id in warranty_ids:
            for item in items:
                if item.warranty and item.warranty.document_id == document.id:
                    linked_item_ids.add(item.id)
        other_item_ids = {item.id for item in document.items if item.id not in selected_ids}
        for item in items:
            if (
                document.id in receipt_ids
                and item.purchase
                and item.purchase.receipt_document_id == document.id
                and item.purchase_id in purchase_selected_items
            ):
                other_item_ids.update(
                    other.id for other in item.purchase.items if other.id not in selected_ids
                )
        category_included = _category_included(kind, options)
        excluded_by_user = document.id in set(options.excluded_document_ids)
        included = category_included and not excluded_by_user
        scan_pages = (
            sorted(document.scan.pages, key=lambda page: page.page_index) if document.scan else []
        )
        record = {
            "id": str(document.id),
            "title": document.title,
            "document_type": document.document_type,
            "evidence_kind": kind,
            "merchant": document.merchant,
            "document_date": _iso(document.document_date),
            "created_at": _iso(document.created_at),
            "byte_size": document.byte_size,
            "original_byte_size": document.original_byte_size,
            "content_type": document.content_type,
            "original_content_type": document.original_content_type,
            "original_filename": document.original_filename,
            "storage_key": document.storage_key,
            "original_storage_key": document.original_storage_key,
            "scan_page_count": len(scan_pages),
            "scan_pages": [
                {
                    "index": page.page_index + 1,
                    "original_storage_key": page.original_storage_key,
                    "cleaned_storage_key": page.cleaned_storage_key,
                    "original_filename": page.original_filename,
                    "original_content_type": page.original_content_type,
                    "original_byte_size": page.original_byte_size,
                    "cleaned_content_type": page.cleaned_content_type,
                    "cleaned_byte_size": page.cleaned_byte_size,
                }
                for page in scan_pages
            ],
            "shared_with_unselected": bool(other_item_ids),
            "other_item_count": len(other_item_ids),
            "category_included": category_included,
            "excluded_by_user": excluded_by_user,
            "included": included,
            "selected_item_ids": [str(value) for value in sorted(linked_item_ids)],
        }
        documents_snapshot.append(record)
        if included:
            included_docs.append((document, str(document.id)))
    included_docs.sort(
        key=lambda entry: (
            DOCUMENT_KIND_ORDER.get(
                _document_kind(entry[0], receipt_ids=receipt_ids, warranty_ids=warranty_ids),
                9,
            ),
            entry[0].title.lower(),
            str(entry[0].id),
        )
    )
    for index, (document, _id) in enumerate(included_docs, start=1):
        ref = f"E-{index:03d}"
        doc_refs[document.id] = ref
        for record in documents_snapshot:
            if record["id"] == str(document.id):
                record["reference"] = ref
                break

    item_snapshot: list[dict[str, Any]] = []
    for item in items:
        room_path = (
            room_path_map.get(item.room_id, item.room.name if item.room else "")
            if item.room_id
            else ""
        )
        location_path = _location_path(item.storage_location, location_by_id)
        property_record = (
            item.room.property
            if item.room is not None
            else (
                item.storage_location.room.property
                if item.storage_location is not None and item.storage_location.room is not None
                else None
            )
        )
        property_name = property_record.name if property_record is not None else ""
        full_path = " / ".join(part for part in (property_name, room_path, location_path) if part)
        if not full_path:
            full_path = "No location recorded"
        on_loan = min(item.quantity, max(0, loan_quantities.get(item.id, 0)))
        at_home = max(0, item.quantity - on_loan)
        purchase = item.purchase
        allocation_rows = (
            [
                allocation
                for allocation in purchase.allocations
                if allocation.item_id == item.id and allocation.allocated_cents is not None
            ]
            if purchase is not None
            else []
        )
        allocation_cents = (
            sum(allocation.allocated_cents or 0 for allocation in allocation_rows)
            if allocation_rows
            else None
        )
        allocation_currency = allocation_rows[0].currency if allocation_rows else None
        purchase_allocated_total = (
            sum(
                allocation.allocated_cents or 0
                for allocation in purchase.allocations
                if allocation.allocated_cents is not None
            )
            if purchase is not None
            else 0
        )
        purchase_selected_count = (
            sum(1 for entry in purchase.items if entry.id in selected_ids)
            if purchase is not None
            else 0
        )
        purchase_item_count = len(purchase.items) if purchase is not None else 0
        purchase_unallocated = (
            purchase.price_cents - purchase_allocated_total
            if purchase is not None and purchase.price_cents is not None
            else None
        )
        warranty = item.warranty
        warranty_label = None
        warranty_days = None
        if warranty is not None:
            reminder = effective_reminder_days(
                warranty.reminder_days, household.warranty_reminder_days
            )
            status_value, warranty_days = warranty_status(warranty.end_date, reminder_days=reminder)
            warranty_label = status_value.value
        document_refs = [
            doc_refs[document.id] for document in item.documents if document.id in doc_refs
        ]
        if warranty and warranty.document_id in doc_refs:
            document_refs.append(doc_refs[warranty.document_id])
        if purchase and purchase.receipt_document_id in doc_refs:
            document_refs.append(doc_refs[purchase.receipt_document_id])
        document_refs = sorted(set(document_refs))
        item_record = {
            "id": str(item.id),
            "name": item.name,
            "description": item.description,
            "brand": item.brand,
            "model": item.model,
            "serial_number": item.serial_number,
            "quantity": item.quantity,
            "on_loan_quantity": on_loan,
            "at_home_quantity": at_home,
            "condition": CONDITION_LABELS.get(item.condition, item.condition),
            "category": item.category.name if item.category else None,
            "tags": sorted(tag.name for tag in item.tags),
            "room_path": room_path,
            "property_id": str(property_record.id) if property_record is not None else None,
            "property_name": property_name or None,
            "location_path": location_path,
            "full_location_path": full_path,
            "is_archived": item.is_archived,
            "purchase_info_status": effective_purchase_info_status(item).value,
            "purchase_missing_fields": missing_purchase_info_fields(item),
            "purchase": (
                {
                    "id": str(purchase.id),
                    "merchant": purchase.vendor,
                    "purchase_date": _iso(purchase.purchase_date),
                    "total_cents": purchase.price_cents,
                    "currency": purchase.currency,
                    "item_count": purchase_item_count,
                    "selected_item_count": purchase_selected_count,
                    "has_unselected_items": purchase_selected_count < purchase_item_count,
                    "has_allocations": bool(purchase.allocations),
                    "allocated_total_cents": purchase_allocated_total,
                    "unallocated_cents": purchase_unallocated,
                    "item_allocation_cents": allocation_cents,
                    "item_allocation_currency": allocation_currency,
                    "receipt_document_id": (
                        str(purchase.receipt_document_id) if purchase.receipt_document_id else None
                    ),
                    "receipt_document_ref": doc_refs.get(purchase.receipt_document_id),
                }
                if purchase is not None
                else None
            ),
            "current_value_unit_cents": current_value_service.unit_value_cents(item),
            "current_value_quantity": current_value_service.owned_quantity(item),
            "current_value_total_cents": current_value_service.total_value_cents(item),
            "current_value_currency": item.current_value_currency,
            "current_value_basis": current_value_service.effective_basis(item),
            "current_value_estimated_at": (
                item.current_value_estimated_at.isoformat()
                if item.current_value_estimated_at is not None
                else None
            ),
            "current_value_estimate": item.current_value_estimate_metadata,
            "warranty": (
                {
                    "provider": warranty.provider,
                    "start_date": _iso(warranty.start_date),
                    "end_date": _iso(warranty.end_date),
                    "status": warranty_label,
                    "days_remaining": warranty_days,
                    "document_ref": doc_refs.get(warranty.document_id),
                }
                if warranty is not None
                else None
            ),
            "last_checked": (
                {
                    "at": checked.at.isoformat(),
                    "session_id": str(checked.session_id) if checked.session_id else None,
                    "status": checked.status,
                    "quantity": checked.quantity,
                    "owned_quantity": checked.owned_quantity,
                    "on_loan_quantity": checked.on_loan_quantity,
                    "location_path": checked.location_path,
                    "stale": checked.stale,
                    "stale_reason": checked.stale_reason,
                }
                if (checked := last_verified_out(item, on_loan)) is not None
                else None
            ),
            "photo_ids": [str(photo.id) for photo in item.photos],
            "document_refs": document_refs,
            "document_count": len(document_refs),
            "photo_count": len(item.photos),
        }
        item_snapshot.append(item_record)

    item_snapshot.sort(
        key=lambda entry: (
            entry["full_location_path"].lower(),
            entry["name"].lower(),
            entry["id"],
        )
    )
    photos_snapshot: list[dict[str, Any]] = []
    for item in items:
        for photo in sorted(item.photos, key=lambda entry: (entry.sort_order, entry.created_at)):
            photos_snapshot.append(
                {
                    "id": str(photo.id),
                    "item_id": str(item.id),
                    "item_name": item.name,
                    "storage_key": photo.storage_key,
                    "thumbnail_key": photo.thumbnail_key,
                    "original_filename": photo.original_filename,
                    "content_type": photo.content_type,
                    "byte_size": photo.byte_size,
                    "width": photo.width,
                    "height": photo.height,
                }
            )
    if options.include_photos and len(photos_snapshot) > settings.evidence_export_max_photos:
        raise ApiError(
            422,
            "export_too_many_photos",
            f"This selection has {len(photos_snapshot)} photos; the limit is "
            f"{settings.evidence_export_max_photos}. Uncheck photos or narrow the scope.",
        )

    documents_snapshot.sort(
        key=lambda entry: (
            DOCUMENT_KIND_ORDER.get(entry["evidence_kind"], 9),
            entry["title"].lower(),
            entry["id"],
        )
    )
    included_documents = [doc for doc in documents_snapshot if doc["included"]]
    document_bytes = 0
    if options.include_attachments:
        for document in included_documents:
            if options.include_document_originals:
                document_bytes += document["original_byte_size"] + document["byte_size"]
                document_bytes += sum(page["original_byte_size"] for page in document["scan_pages"])
            else:
                document_bytes += document["byte_size"]
    included_photos = photos_snapshot if options.include_photos else []
    photo_bytes = (
        sum(photo["byte_size"] for photo in included_photos) if options.include_photos else 0
    )
    bundle_estimated = document_bytes + photo_bytes if options.include_attachments else 0
    max_bundle = settings.evidence_export_max_bundle_mb * 1024 * 1024
    bundle_within_limit = bundle_estimated <= max_bundle

    purchase_refs: dict[uuid.UUID, dict[str, Any]] = {}
    for item in items:
        purchase = item.purchase
        if purchase is None:
            continue
        entry = purchase_refs.setdefault(
            purchase.id,
            {
                "purchase_id": str(purchase.id),
                "merchant": purchase.vendor,
                "purchase_date": _iso(purchase.purchase_date),
                "total_cents": purchase.price_cents,
                "currency": purchase.currency,
                "item_count_in_household": len(purchase.items),
                "selected_item_ids": set(),
                "allocated_total_cents": sum(
                    allocation.allocated_cents or 0
                    for allocation in purchase.allocations
                    if allocation.allocated_cents is not None
                ),
                "selected_allocated_cents": 0,
                "receipt_document_id": (
                    str(purchase.receipt_document_id) if purchase.receipt_document_id else None
                ),
            },
        )
        entry["selected_item_ids"].add(item.id)
        entry["selected_allocated_cents"] += sum(
            allocation.allocated_cents or 0
            for allocation in purchase.allocations
            if allocation.item_id == item.id and allocation.allocated_cents is not None
        )
    purchase_references = []
    for entry in purchase_refs.values():
        total = entry["total_cents"]
        allocated_total = entry["allocated_total_cents"]
        purchase_references.append(
            {
                **{key: value for key, value in entry.items() if key != "selected_item_ids"},
                "selected_item_count": len(entry["selected_item_ids"]),
                "has_unselected_items": len(entry["selected_item_ids"])
                < entry["item_count_in_household"],
                "has_allocations": bool(allocated_total),
                "unallocated_cents": total - allocated_total if total is not None else None,
            }
        )
    purchase_references.sort(
        key=lambda entry: (
            entry["currency"],
            entry["purchase_date"] or "",
            (entry["merchant"] or "").lower(),
        )
    )

    allocation_totals: dict[str, int] = defaultdict(int)
    allocation_items: dict[str, set[uuid.UUID]] = defaultdict(set)
    current_totals: dict[str, int] = defaultdict(int)
    current_items: dict[str, set[uuid.UUID]] = defaultdict(set)
    for item in items:
        if item.purchase is not None:
            for allocation in item.purchase.allocations:
                if allocation.item_id == item.id and allocation.allocated_cents is not None:
                    allocation_totals[allocation.currency] += allocation.allocated_cents
                    allocation_items[allocation.currency].add(item.id)
        current_total = current_value_service.total_value_cents(item)
        if current_total is not None:
            current_totals[item.current_value_currency] += current_total
            current_items[item.current_value_currency].add(item.id)
    currency_totals = [
        {
            "currency": currency,
            "selected_allocated_purchase_cents": allocation_totals.get(currency, 0),
            "current_value_total_cents": current_totals.get(currency, 0),
            "allocated_item_count": len(allocation_items.get(currency, set())),
            "current_value_item_count": len(current_items.get(currency, set())),
        }
        for currency in sorted(set(allocation_totals) | set(current_totals))
    ]

    warnings: list[str] = []
    if archived_excluded:
        warnings.append(
            f"{_plural(archived_excluded, 'archived item')} "
            f"{'is' if archived_excluded == 1 else 'are'} outside this selection. "
            "Enable archived inclusion if they should be documented."
        )
    if include_archived and any(entry["is_archived"] for entry in item_snapshot):
        warnings.append("This package includes archived items.")
    shared_docs = sum(1 for document in included_documents if document["shared_with_unselected"])
    if shared_docs:
        warnings.append(
            f"{_plural(shared_docs, 'included document')} "
            f"{'is' if shared_docs == 1 else 'are'} also linked to items outside this "
            "selection and may contain other products or personal information."
        )
    manual_candidates = sum(
        1
        for document in documents_snapshot
        if document["evidence_kind"] == "manual" and not document["category_included"]
    )
    if manual_candidates:
        warnings.append(
            f"{_plural(manual_candidates, 'manual/specification document')} "
            f"{'is' if manual_candidates == 1 else 'are'} excluded by default. "
            "Include manuals only if the larger package is wanted."
        )
    excluded_docs = sum(1 for document in documents_snapshot if document["excluded_by_user"])
    if excluded_docs:
        warnings.append(f"{_plural(excluded_docs, 'document')} explicitly excluded.")
    missing_purchase = sum(
        1
        for item in items
        if effective_purchase_info_status(item)
        in {PurchaseInfoStatus.UNRECORDED, PurchaseInfoStatus.UNKNOWN}
    )
    if missing_purchase:
        warnings.append(
            f"{_plural(missing_purchase, 'selected item')} "
            f"{'has' if missing_purchase == 1 else 'have'} missing or unknown purchase "
            "information; no price was invented."
        )
    shared_purchases = sum(1 for entry in purchase_references if entry["has_unselected_items"])
    if shared_purchases:
        warnings.append(
            f"{_plural(shared_purchases, 'purchase record')} "
            f"{'is' if shared_purchases == 1 else 'are'} shared with items outside this "
            "selection. The shared total is not assigned to every selected item."
        )
    legacy_purchases = sum(
        1
        for entry in purchase_references
        if not entry["has_allocations"] and entry["selected_item_count"] > 0
    )
    if legacy_purchases:
        warnings.append(
            f"{_plural(legacy_purchases, 'purchase record')} "
            f"{'has' if legacy_purchases == 1 else 'have'} no reviewed per-item allocation; "
            "no historical split was invented."
        )
    legacy_values = sum(
        1
        for item in item_snapshot
        if item["current_value_basis"] == current_value_service.LEGACY_RECORD_TOTAL
    )
    if legacy_values:
        warnings.append(
            f"{_plural(legacy_values, 'item')} "
            f"{'has' if legacy_values == 1 else 'have'} a legacy current-value record total. "
            "The recorded total is reported once and is not multiplied by quantity; "
            "per-unit values were not recorded."
        )
    if options.include_attachments and not options.include_document_originals:
        warnings.append("The bundle includes normalized/download copies, not exact original bytes.")
    if not options.include_attachments:
        warnings.append(
            "No attachment ZIP is included. The PDF lists evidence references without "
            "external URLs."
        )
    if options.include_photos and len(photos_snapshot) > settings.evidence_export_max_pdf_photos:
        warnings.append(
            f"The PDF will show up to {settings.evidence_export_max_pdf_photos} selected "
            "photos; the attachment bundle can contain all selected photos."
        )
    if not bundle_within_limit:
        warnings.append(
            f"Estimated attachment bytes exceed the {settings.evidence_export_max_bundle_mb} "
            "MB package limit. Exclude manuals, originals or photos."
        )
    if options.include_photos and not photos_snapshot:
        warnings.append("No item photos are recorded for this selection.")

    local, timezone_label = _local_clock()
    snapshot = {
        "format_version": FORMAT_VERSION,
        "household": {"id": str(household.id), "name": household.name},
        "generated_at": local.isoformat(),
        "timezone": timezone_label,
        "scope": scope.as_json(),
        "scope_label": scope_label,
        "include_archived": include_archived,
        "options": options.model_dump(mode="json"),
        "item_count": len(item_snapshot),
        "unit_count": sum(item["quantity"] for item in item_snapshot),
        "at_home_unit_count": sum(item["at_home_quantity"] for item in item_snapshot),
        "on_loan_unit_count": sum(item["on_loan_quantity"] for item in item_snapshot),
        "archived_excluded_count": archived_excluded,
        "missing_purchase_count": missing_purchase,
        "items": item_snapshot,
        "documents": documents_snapshot,
        "photos": photos_snapshot,
        "currency_totals": currency_totals,
        "purchase_references": purchase_references,
        "photo_count": len(photos_snapshot),
        "included_photo_count": len(included_photos),
        "photo_bytes": photo_bytes,
        "document_count": len(documents_snapshot),
        "included_document_count": len(included_documents),
        "document_bytes": document_bytes,
        "evidence_reference_count": len(included_documents),
        "bundle_estimated_bytes": bundle_estimated,
        "max_bundle_bytes": max_bundle,
        "warnings": warnings,
    }
    snapshot["fingerprint"] = _fingerprint(snapshot)
    return snapshot


def _preview_from_snapshot(snapshot: dict[str, Any]) -> EvidencePreviewOut:
    options = EvidenceOptionsIn.model_validate(snapshot["options"])
    items = []
    for item in snapshot["items"]:
        current = _snapshot_current_value(item)
        items.append(
            EvidenceItemPreview(
                id=uuid.UUID(item["id"]),
                name=item["name"],
                brand=item["brand"],
                model=item["model"],
                serial_number=item["serial_number"],
                quantity=item["quantity"],
                on_loan_quantity=item["on_loan_quantity"],
                at_home_quantity=item["at_home_quantity"],
                condition=item["condition"],
                is_archived=item["is_archived"],
                category=item["category"],
                property_id=(uuid.UUID(item["property_id"]) if item.get("property_id") else None),
                property_name=item.get("property_name"),
                full_location_path=item["full_location_path"],
                purchase_info_status=item["purchase_info_status"],
                purchase_currency=(item.get("purchase") or {}).get("currency"),
                item_allocation_cents=(item.get("purchase") or {}).get("item_allocation_cents"),
                current_value_unit_cents=current["unit_cents"],
                current_value_quantity=current["quantity"],
                current_value_total_cents=current["total_cents"],
                current_value_currency=current["currency"],
                current_value_basis=current["basis"],
                current_value_estimated_at=(
                    datetime.fromisoformat(current["estimated_at"])
                    if current.get("estimated_at")
                    else None
                ),
                photo_count=item["photo_count"],
                document_count=item["document_count"],
            )
        )
    documents = [
        EvidenceDocumentPreview(
            id=uuid.UUID(document["id"]),
            title=document["title"],
            document_type=document["document_type"],
            evidence_kind=document["evidence_kind"],
            merchant=document["merchant"],
            document_date=(
                date.fromisoformat(document["document_date"]) if document["document_date"] else None
            ),
            byte_size=document["byte_size"],
            original_byte_size=document["original_byte_size"],
            scan_page_count=document["scan_page_count"],
            shared_with_unselected=document["shared_with_unselected"],
            category_included=document["category_included"],
            excluded_by_user=document["excluded_by_user"],
            included=document["included"],
            selected_item_ids=[uuid.UUID(value) for value in document["selected_item_ids"]],
        )
        for document in snapshot["documents"]
    ]
    return EvidencePreviewOut(
        fingerprint=snapshot["fingerprint"],
        format_version=snapshot["format_version"],
        household_name=snapshot["household"]["name"],
        generated_at=datetime.fromisoformat(snapshot["generated_at"]),
        timezone=snapshot["timezone"],
        scope_label=snapshot["scope_label"],
        scope=snapshot["scope"],
        include_archived=snapshot["include_archived"],
        options=options,
        item_count=snapshot["item_count"],
        unit_count=snapshot["unit_count"],
        at_home_unit_count=snapshot["at_home_unit_count"],
        on_loan_unit_count=snapshot["on_loan_unit_count"],
        archived_excluded_count=snapshot["archived_excluded_count"],
        missing_purchase_count=snapshot["missing_purchase_count"],
        photo_count=snapshot["photo_count"],
        included_photo_count=snapshot["included_photo_count"],
        photo_bytes=snapshot["photo_bytes"],
        document_count=snapshot["document_count"],
        included_document_count=snapshot["included_document_count"],
        document_bytes=snapshot["document_bytes"],
        evidence_reference_count=snapshot["evidence_reference_count"],
        bundle_estimated_bytes=snapshot["bundle_estimated_bytes"],
        max_bundle_bytes=snapshot["max_bundle_bytes"],
        bundle_within_limit=snapshot["bundle_estimated_bytes"] <= snapshot["max_bundle_bytes"],
        can_generate=snapshot["item_count"] > 0
        and snapshot["bundle_estimated_bytes"] <= snapshot["max_bundle_bytes"],
        items=items,
        documents=documents,
        currency_totals=[
            EvidenceCurrencyTotal(**_snapshot_currency_total(entry))
            for entry in snapshot["currency_totals"]
        ],
        purchase_references=[
            EvidencePurchaseReference(**entry) for entry in snapshot["purchase_references"]
        ],
        warnings=snapshot["warnings"],
    )
