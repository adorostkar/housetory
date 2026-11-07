"""Inventory evidence package generation.

This module intentionally reuses the recorded documents, photos, purchases,
allocations, warranties and lending facts already in the household. It does not
invent valuations, stocktake verification, insurance acceptance or per-item
purchase splits. The PDF is a standalone, offline-readable report; the optional
CSV and ZIP carry the same reviewed snapshot and exact-or-normalized evidence
bytes with a manifest.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
import uuid
import zipfile
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from PIL import Image as PilImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    Image as ReportlabImage,
)
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import DocumentType, PurchaseInfoStatus
from ..jobs import enqueue
from ..models import (
    Document,
    DocumentScan,
    Household,
    InventoryEvidenceExport,
    Item,
    Property,
    Room,
    StorageLocation,
)
from ..schemas.evidence_exports import (
    EvidenceCreateIn,
    EvidenceCurrencyTotal,
    EvidenceDocumentPreview,
    EvidenceExportOut,
    EvidenceItemPreview,
    EvidenceOptionsIn,
    EvidencePreviewIn,
    EvidencePreviewOut,
    EvidencePurchaseReference,
    EvidenceScopeIn,
)
from . import current_value as current_value_service
from . import lending, storage
from .labels import FONT_BOLD, FONT_REGULAR, _register_fonts
from .purchase_info import effective_purchase_info_status, missing_purchase_info_fields
from .serializers import item_load_options, last_verified_out
from .warranties import effective_reminder_days, warranty_status

EVIDENCE_EXPORT_TASK = "exports.evidence"
EVIDENCE_PRUNE_TASK = "maintenance.prune_exports"
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
CJK_FONT = "HeiseiKakuGo-W5"
HANGUL_FONT = "HYSMyeongJo-Medium"
CJK_PATTERN = re.compile(
    r"((?:[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|"
    r"(?:[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]+))"
)
CSV_COLUMNS = [
    "export_id",
    "exported_at",
    "timezone",
    "household_name",
    "scope_label",
    "format_version",
    "export_item_count",
    "export_unit_count",
    "item_id",
    "item_name",
    "description",
    "brand",
    "model",
    "serial_number",
    "quantity",
    "at_home_quantity",
    "on_loan_quantity",
    "condition",
    "category",
    "tags",
    "room_path",
    "property_id",
    "property_name",
    "location_path",
    "full_location_path",
    "archived",
    "purchase_status",
    "purchase_merchant",
    "purchase_date",
    "purchase_currency",
    "purchase_total_cents",
    "purchase_total_scope",
    "purchase_item_allocation_cents",
    "purchase_unallocated_cents",
    "current_value_unit_cents",
    "current_value_quantity",
    "current_value_total_cents",
    "current_value_currency",
    "current_value_basis",
    "current_value_estimated_at",
    "warranty_provider",
    "warranty_end_date",
    "warranty_status",
    "last_checked_at",
    "last_checked_status",
    "last_checked_quantity",
    "last_checked_owned_quantity",
    "last_checked_on_loan_quantity",
    "last_checked_location_path",
    "last_checked_stale",
    "photo_count",
    "evidence_count",
    "evidence_references",
]
CSS_COLORS = {
    "ink": colors.HexColor("#1c241e"),
    "muted": colors.HexColor("#667064"),
    "line": colors.HexColor("#d8ded4"),
    "soft": colors.HexColor("#f0f4ee"),
    "brass": colors.HexColor("#8a6b2f"),
    "danger": colors.HexColor("#8d3c38"),
}


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


def _money(cents: int | None, currency: str | None) -> str:
    if cents is None:
        return "Not recorded"
    return f"{cents / 100:,.2f} {currency or ''}".strip()


def _rich_text(value: Any) -> str:
    cleaned = _clean_text(value, 20000)
    if not CJK_PATTERN.search(cleaned):
        return escape(cleaned)
    parts: list[str] = []
    cursor = 0
    for match in CJK_PATTERN.finditer(cleaned):
        if match.start() > cursor:
            parts.append(escape(cleaned[cursor : match.start()]))
        segment = match.group(0)
        font = (
            HANGUL_FONT
            if all("\uac00" <= char <= "\ud7af" or "\u1100" <= char <= "\u11ff" for char in segment)
            else CJK_FONT
        )
        parts.append(f'<font name="{font}">{escape(segment)}</font>')
        cursor = match.end()
    if cursor < len(cleaned):
        parts.append(escape(cleaned[cursor:]))
    return "".join(parts)


def _paragraph(text: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(_rich_text(text), style)


def _build_styles() -> dict[str, ParagraphStyle]:
    _register_fonts()
    pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))
    pdfmetrics.registerFont(UnicodeCIDFont(HANGUL_FONT))
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "EvidenceTitle",
            parent=base["Title"],
            fontName=FONT_BOLD,
            fontSize=25,
            leading=29,
            textColor=CSS_COLORS["ink"],
            spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "EvidenceSubtitle",
            parent=base["Normal"],
            fontName=FONT_REGULAR,
            fontSize=9.5,
            leading=14,
            textColor=CSS_COLORS["muted"],
        ),
        "h1": ParagraphStyle(
            "EvidenceH1",
            parent=base["Heading1"],
            fontName=FONT_BOLD,
            fontSize=15,
            leading=19,
            textColor=CSS_COLORS["ink"],
            spaceBefore=10,
            spaceAfter=7,
        ),
        "h2": ParagraphStyle(
            "EvidenceH2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=11,
            leading=15,
            textColor=CSS_COLORS["ink"],
            spaceBefore=8,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "EvidenceBody",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=8.6,
            leading=12.3,
            textColor=CSS_COLORS["ink"],
        ),
        "small": ParagraphStyle(
            "EvidenceSmall",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.2,
            leading=10,
            textColor=CSS_COLORS["muted"],
        ),
        "tiny": ParagraphStyle(
            "EvidenceTiny",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=6.4,
            leading=8.5,
            textColor=CSS_COLORS["muted"],
        ),
        "item": ParagraphStyle(
            "EvidenceItem",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=10,
            leading=13,
            textColor=CSS_COLORS["ink"],
            spaceBefore=7,
            spaceAfter=2,
        ),
        "warning": ParagraphStyle(
            "EvidenceWarning",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.6,
            leading=10.5,
            textColor=CSS_COLORS["danger"],
        ),
    }


def _footer(canvas: pdf_canvas.Canvas, doc: Any) -> None:
    canvas.saveState()
    canvas.setStrokeColor(CSS_COLORS["line"])
    canvas.setLineWidth(0.4)
    canvas.line(16 * mm, 13 * mm, A4[0] - 16 * mm, 13 * mm)
    canvas.setFont(FONT_REGULAR, 6.7)
    canvas.setFillColor(CSS_COLORS["muted"])
    canvas.drawString(16 * mm, 8.5 * mm, "Housetory · recorded inventory, not physically verified")
    canvas.drawRightString(A4[0] - 16 * mm, 8.5 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _table(
    data: list[list[Any]],
    widths: list[float],
    *,
    header: bool = True,
    small: bool = False,
    styles: dict[str, ParagraphStyle] | None = None,
) -> Table:
    styles = styles or _build_styles()
    cell_style = styles["tiny"] if small else styles["body"]
    prepared = [
        [
            _paragraph(cell, cell_style) if not isinstance(cell, ReportlabImage) else cell
            for cell in row
        ]
        for row in data
    ]
    table = Table(prepared, colWidths=widths, repeatRows=1 if header else 0)
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("GRID", (0, 0), (-1, -1), 0.35, CSS_COLORS["line"]),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), CSS_COLORS["soft"]))
    table.setStyle(TableStyle(commands))
    return table


def _photo_flowable(
    photo: dict[str, Any],
    *,
    max_width: float,
    max_height: float,
) -> tuple[ReportlabImage | None, str | None]:
    keys: list[str] = []
    for candidate in (photo.get("thumbnail_key"), photo.get("storage_key")):
        if candidate and str(candidate) not in keys:
            keys.append(str(candidate))
    for key in keys:
        try:
            path = storage.resolve_key(key)
            with PilImage.open(path) as image:
                image = image.convert("RGB")
                image.thumbnail((620, 620))
                width, height = image.size
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=80, optimize=True)
                buffer.seek(0)
            scale = min(max_width / width, max_height / height, 1.0)
            buffer.seek(0)
            flowable = ReportlabImage(
                buffer,
                width=width * scale,
                height=height * scale,
            )
            return flowable, None
        except Exception:  # noqa: BLE001 - try the normalized copy next
            continue
    return None, f"Photo for {photo.get('item_name') or 'an item'} could not be read."


def _pdf_item_flowables(
    item: dict[str, Any],
    *,
    styles: dict[str, ParagraphStyle],
    photos: list[dict[str, Any]],
    photo_budget: list[int],
) -> list[Any]:
    lines: list[Any] = []
    archived = "  ·  Archived" if item.get("is_archived") else ""
    heading = (
        f"{item['name']}  ·  {item['quantity']} "
        f"unit{'s' if item['quantity'] != 1 else ''}{archived}"
    )
    lines.append(_paragraph(heading, styles["item"]))
    identity = " · ".join(
        part
        for part in (
            item.get("brand"),
            item.get("model"),
            f"Serial {item['serial_number']}" if item.get("serial_number") else None,
        )
        if part
    )
    detail_parts = [
        item.get("full_location_path") or "No location recorded",
        item.get("category") or "Uncategorised",
        item.get("condition") or "Unknown",
    ]
    if identity:
        detail_parts.insert(0, identity)
    lines.append(_paragraph(" · ".join(detail_parts), styles["small"]))
    if item.get("tags"):
        lines.append(_paragraph("Tags: " + ", ".join(item["tags"]), styles["tiny"]))
    if item.get("on_loan_quantity"):
        lines.append(
            _paragraph(
                f"Owned {item['quantity']} · at home {item['at_home_quantity']} · "
                f"recorded on loan {item['on_loan_quantity']}. Loaned units remain owned; "
                "the recorded home is a normal home, not a current physical location. "
                "Borrower names and loan notes are intentionally excluded.",
                styles["small"],
            )
        )
    purchase_text = f"Purchase information: {item.get('purchase_info_status') or 'unknown'}."
    purchase = item.get("purchase")
    if purchase:
        purchase_text = (
            f"Purchase total: {purchase.get('merchant') or 'merchant not recorded'} · "
            f"{purchase.get('purchase_date') or 'date not recorded'} · "
            f"{_money(purchase.get('total_cents'), purchase.get('currency'))} "
            "transaction total"
        )
        if purchase.get("has_unselected_items"):
            purchase_text += " (includes items outside this export)"
        elif purchase.get("item_count", 0) > 1:
            purchase_text += " (transaction total for all linked items)"
        if purchase.get("item_allocation_cents") is not None:
            allocation_text = _money(
                purchase["item_allocation_cents"],
                purchase.get("item_allocation_currency"),
            )
            purchase_text += f" · selected item allocation {allocation_text}"
        else:
            purchase_text += " · no reviewed per-item allocation"
        if purchase.get("unallocated_cents") is not None:
            purchase_text += (
                " · unallocated on this purchase "
                f"{_money(purchase['unallocated_cents'], purchase.get('currency'))}"
            )
    else:
        purchase_text += " No purchase record is linked."
    lines.append(_paragraph(purchase_text, styles["small"]))
    current = _snapshot_current_value(item)
    if current["total_cents"] is None:
        current_text = "Current value: not estimated (unknown, not zero)."
    elif current["basis"] == current_value_service.PER_UNIT:
        current_text = (
            "Estimated current value: "
            f"{_money(current['unit_cents'], current['currency'])} per unit x "
            f"{current['quantity']} owned unit"
            f"{'s' if current['quantity'] != 1 else ''} = "
            f"{_money(current['total_cents'], current['currency'])} total "
            "(household-supplied)."
        )
    else:
        current_text = (
            "Current value: legacy recorded total "
            f"{_money(current['total_cents'], current['currency'])} for "
            f"{current['quantity']} owned unit"
            f"{'s' if current['quantity'] != 1 else ''}; per-unit value was not "
            "recorded, so the total is reported once and not multiplied "
            "(household-supplied)."
        )
    if current.get("estimated_at"):
        current_text += f" Estimated {str(current['estimated_at'])[:10]}."
    lines.append(_paragraph(current_text, styles["small"]))
    warranty = item.get("warranty")
    if warranty:
        lines.append(
            _paragraph(
                f"Warranty: {warranty.get('provider') or 'provider not recorded'} · "
                f"{warranty.get('status') or 'unknown'} · ends "
                f"{warranty.get('end_date') or 'not recorded'}",
                styles["small"],
            )
        )
    last_checked = item.get("last_checked")
    if last_checked:
        status = str(last_checked.get("status") or "checked").replace("_", " ")
        if last_checked.get("stale"):
            checked_text = (
                f"Last checked {str(last_checked.get('at'))[:10]} as {status}; "
                "the recorded item, quantity or location changed after that check."
            )
        else:
            checked_text = (
                f"Last checked {str(last_checked.get('at'))[:10]} · {status} · "
                f"{last_checked.get('quantity')} at home"
            )
            if last_checked.get("on_loan_quantity"):
                checked_text += f" · {last_checked['on_loan_quantity']} on loan (still owned)"
            if last_checked.get("location_path"):
                checked_text += f" · {last_checked['location_path']}"
        lines.append(_paragraph(checked_text, styles["small"]))
    if item.get("description"):
        lines.append(_paragraph(item["description"], styles["body"]))
    if item.get("document_refs"):
        lines.append(
            _paragraph(
                "Evidence references: " + ", ".join(item["document_refs"]),
                styles["small"],
            )
        )
    if photos:
        image_cells: list[Any] = []
        captions: list[str] = []
        for photo in photos:
            if photo_budget[0] <= 0:
                break
            flowable, warning = _photo_flowable(photo, max_width=52 * mm, max_height=39 * mm)
            if warning:
                lines.append(_paragraph(warning, styles["warning"]))
                continue
            if flowable is not None:
                image_cells.append(flowable)
                captions.append(photo.get("original_filename") or "Item photo")
                photo_budget[0] -= 1
        if image_cells:
            widths = [52 * mm] * len(image_cells)
            photo_table = Table(
                [image_cells, [_paragraph(c, styles["tiny"]) for c in captions]], colWidths=widths
            )
            photo_table.setStyle(
                TableStyle(
                    [
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 0),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                        ("TOPPADDING", (0, 0), (-1, 0), 3),
                    ]
                )
            )
            lines.append(photo_table)
    lines.append(Spacer(1, 4))
    return lines


def _missing_evidence(snapshot: dict[str, Any]) -> list[str]:
    options = EvidenceOptionsIn.model_validate(snapshot["options"])
    missing: list[str] = []
    if not options.include_attachments:
        return missing
    for document in snapshot["documents"]:
        if not document["included"]:
            continue
        if not storage.evidence_export_key_exists(document["storage_key"]):
            missing.append(f"Normalized file for “{document['title']}” is missing.")
        if options.include_document_originals and not storage.evidence_export_key_exists(
            document["original_storage_key"]
        ):
            missing.append(f"Original file for “{document['title']}” is missing.")
        if options.include_document_originals:
            for page in document["scan_pages"]:
                if not storage.evidence_export_key_exists(page["original_storage_key"]):
                    missing.append(
                        f"Source scan page {page['index']} for “{document['title']}” is missing."
                    )
    if options.include_photos:
        for photo in snapshot["photos"]:
            if not storage.evidence_export_key_exists(photo["storage_key"]):
                missing.append(
                    f"Photo “{photo['original_filename']}” for “{photo['item_name']}” is missing."
                )
    return missing


def build_pdf(
    snapshot: dict[str, Any],
    extra_warnings: list[str] | None = None,
    *,
    deadline: float | None = None,
) -> bytes:
    styles = _build_styles()
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=15 * mm,
        bottomMargin=18 * mm,
        title=f"Inventory evidence package — {snapshot['household']['name']}",
        author="Housetory",
        subject="Recorded household inventory and supporting evidence",
        creator="Housetory inventory evidence package",
    )
    story: list[Any] = []
    story.append(_paragraph("Inventory evidence package", styles["title"]))
    story.append(
        _paragraph(
            f"{snapshot['household']['name']} · Prepared {snapshot['generated_at']} "
            f"· {snapshot['timezone']}",
            styles["subtitle"],
        )
    )
    story.append(
        _paragraph(
            f"Export {snapshot.get('export_id', 'pending generation')} · "
            f"Format {snapshot['format_version']} · Scope: {snapshot['scope_label']}",
            styles["small"],
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        _paragraph(
            "This package records what is currently recorded in Housetory. It is not a "
            "physical stocktake, a professional appraisal, an insurance acceptance or a "
            "coverage guarantee. Missing information is marked rather than estimated. "
            "Values are separated by currency and are never converted.",
            styles["body"],
        )
    )
    story.append(Spacer(1, 8))
    counts = [
        ["Selected items", str(snapshot["item_count"]), "Total units", str(snapshot["unit_count"])],
        [
            "At-home units",
            str(snapshot["at_home_unit_count"]),
            "Recorded on loan",
            str(snapshot["on_loan_unit_count"]),
        ],
        [
            "Item photos",
            f"{snapshot['included_photo_count']} / {snapshot['photo_count']}",
            "Included documents",
            f"{snapshot['included_document_count']} / {snapshot['document_count']}",
        ],
        [
            "Archived excluded",
            str(snapshot["archived_excluded_count"]),
            "Missing purchase info",
            str(snapshot["missing_purchase_count"]),
        ],
    ]
    story.append(_table(counts, [42 * mm, 32 * mm, 42 * mm, 36 * mm], header=False))
    story.append(Spacer(1, 8))
    if snapshot["currency_totals"]:
        story.append(_paragraph("Recorded value summary", styles["h2"]))
        rows = [
            [
                "Currency",
                "Selected purchase allocations",
                "Current estimate totals",
                "Items with each figure",
            ]
        ]
        for entry in snapshot["currency_totals"]:
            total_entry = _snapshot_currency_total(entry)
            rows.append(
                [
                    entry["currency"],
                    _money(entry["selected_allocated_purchase_cents"], entry["currency"]),
                    _money(total_entry["current_value_total_cents"], entry["currency"]),
                    f"{entry['allocated_item_count']} allocation · "
                    f"{entry['current_value_item_count']} estimate",
                ]
            )
        story.append(_table(rows, [20 * mm, 44 * mm, 42 * mm, 40 * mm]))
        story.append(
            _paragraph(
                "Current estimate totals multiply each per-unit estimate by owned "
                "quantity. Loaned owned units remain included; borrowed items are "
                "excluded. Legacy record totals are included once and are not "
                "multiplied. The selected purchase allocation column sums only "
                "reviewed per-item allocations; shared purchase grand totals are "
                "listed separately below and are not assigned to every item.",
                styles["tiny"],
            )
        )
        story.append(Spacer(1, 6))
    if snapshot["purchase_references"]:
        story.append(_paragraph("Referenced purchase records", styles["h2"]))
        rows = [
            [
                "Merchant / date",
                "Purchase total",
                "Selected items",
                "Selected allocation",
                "Unallocated",
            ]
        ]
        for purchase in snapshot["purchase_references"]:
            rows.append(
                [
                    (
                        f"{purchase['merchant'] or 'Not recorded'}\n"
                        f"{purchase['purchase_date'] or 'Date not recorded'}"
                    ),
                    _money(purchase["total_cents"], purchase["currency"]),
                    f"{purchase['selected_item_count']} of {purchase['item_count_in_household']}",
                    _money(purchase["selected_allocated_cents"], purchase["currency"])
                    if purchase["has_allocations"]
                    else "Not allocated",
                    _money(purchase["unallocated_cents"], purchase["currency"])
                    if purchase["unallocated_cents"] is not None
                    else "Not available",
                ]
            )
        story.append(_table(rows, [50 * mm, 30 * mm, 27 * mm, 31 * mm, 30 * mm], small=True))
        story.append(
            _paragraph(
                "A shared purchase total appears once in this table, even when several "
                "selected items belong to it. It may include items outside this export. "
                "Legacy records without reviewed allocations are not split by the report.",
                styles["tiny"],
            )
        )
        story.append(Spacer(1, 6))
    if snapshot["warnings"] or extra_warnings:
        story.append(_paragraph("Review notes", styles["h2"]))
        for warning in [*snapshot["warnings"], *(extra_warnings or [])]:
            story.append(_paragraph("• " + warning, styles["warning"]))
        story.append(Spacer(1, 6))
    story.append(PageBreak())
    story.append(_paragraph("Inventory items", styles["h1"]))
    photos_by_item: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if snapshot["options"].get("include_photos", True):
        for photo in snapshot["photos"]:
            photos_by_item[photo["item_id"]].append(photo)
    photo_budget = [get_settings().evidence_export_max_pdf_photos]
    current_location = None
    for item in snapshot["items"]:
        _check_deadline(deadline)
        location = item["full_location_path"]
        if location != current_location:
            story.append(_paragraph(location, styles["h2"]))
            current_location = location
        story.extend(
            _pdf_item_flowables(
                item,
                styles=styles,
                photos=photos_by_item.get(item["id"], [])[:3],
                photo_budget=photo_budget,
            )
        )
    if snapshot["items"]:
        story.append(PageBreak())
    story.append(_paragraph("Evidence index", styles["h1"]))
    included_documents = [document for document in snapshot["documents"] if document["included"]]
    if not included_documents:
        story.append(
            _paragraph(
                "No supporting documents were included. Item photos, where present, are "
                "shown in the item entries above.",
                styles["body"],
            )
        )
    else:
        rows = [["Ref", "Evidence", "Source / date", "Bundle access / note"]]
        for document in included_documents:
            note = (
                "Included in the attachment bundle."
                if snapshot["options"].get("include_attachments")
                else "Listed for reference; no attachment ZIP was requested."
            )
            if document["shared_with_unselected"]:
                note += (
                    " This document is also linked to items outside the selection "
                    "and may contain other products or personal information."
                )
            rows.append(
                [
                    document.get("reference") or "—",
                    (
                        f"{document['title']}\n"
                        f"{document['evidence_kind'].title()} · "
                        f"{document['document_type'].replace('_', ' ').title()}"
                    ),
                    (
                        f"{document.get('merchant') or 'Source not recorded'}\n"
                        f"{document.get('document_date') or 'Date not recorded'}"
                    ),
                    note,
                ]
            )
        story.append(_table(rows, [16 * mm, 57 * mm, 38 * mm, 59 * mm], small=True))
    story.append(Spacer(1, 10))
    story.append(_paragraph("Package notes", styles["h2"]))
    notes = [
        "Only recorded facts were used. No missing price was replaced with zero and no "
        "missing date was invented.",
        "Purchase totals and current estimates are separate. Currencies are never added "
        "together or converted.",
        "Loaned units are still owned. Borrower names, loan notes, purchase notes and "
        "document notes are excluded from this package.",
        "Photos are the stored household photo derivatives; exact uploaded photo "
        "originals have already been normalized by Housetory.",
        "Original supporting document bytes are only claimed when the attachment bundle "
        "includes the original role. Normalized or cleaned scan PDFs are labelled as "
        "such in the bundle manifest.",
        "Per-item last-checked information comes from completed stocktakes and is shown "
        "only for exact recorded observations. A changed item is labelled rather than "
        "treated as still verified.",
        "This is supporting documentation, not an insurance policy, valuation, claim or "
        "guarantee of coverage.",
    ]
    for note in notes:
        story.append(_paragraph("• " + note, styles["small"]))
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


def _csv_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = _clean_text(value, 10000)
    if text.lstrip()[:1] in {"=", "+", "-", "@", "\t", "\r"}:
        return "'" + text
    return text


def build_csv(snapshot: dict[str, Any], *, deadline: float | None = None) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for item in snapshot["items"]:
        _check_deadline(deadline)
        purchase = item.get("purchase") or {}
        current = _snapshot_current_value(item)
        if not purchase:
            total_scope = "no purchase record"
        elif purchase.get("total_cents") is None:
            total_scope = "purchase total not recorded"
        elif purchase.get("has_unselected_items"):
            total_scope = "purchase transaction total; includes items outside selection"
        elif purchase.get("item_count", 0) > 1:
            total_scope = "purchase transaction total; all linked items selected"
        else:
            total_scope = "purchase transaction total"
        row = [
            snapshot.get("export_id") or "",
            snapshot["generated_at"],
            snapshot["timezone"],
            snapshot["household"]["name"],
            snapshot["scope_label"],
            snapshot["format_version"],
            snapshot["item_count"],
            snapshot["unit_count"],
            item["id"],
            item["name"],
            item.get("description") or "",
            item.get("brand") or "",
            item.get("model") or "",
            item.get("serial_number") or "",
            item["quantity"],
            item["at_home_quantity"],
            item["on_loan_quantity"],
            item["condition"],
            item.get("category") or "",
            "; ".join(item.get("tags") or []),
            item.get("room_path") or "",
            item.get("property_id") or "",
            item.get("property_name") or "",
            item.get("location_path") or "",
            item.get("full_location_path") or "",
            "yes" if item.get("is_archived") else "no",
            item.get("purchase_info_status") or "",
            purchase.get("merchant") or "",
            purchase.get("purchase_date") or "",
            purchase.get("currency") or "",
            purchase.get("total_cents") if purchase.get("total_cents") is not None else "",
            total_scope,
            purchase.get("item_allocation_cents")
            if purchase.get("item_allocation_cents") is not None
            else "",
            purchase.get("unallocated_cents")
            if purchase.get("unallocated_cents") is not None
            else "",
            current["unit_cents"] if current["unit_cents"] is not None else "",
            current["quantity"],
            current["total_cents"] if current["total_cents"] is not None else "",
            current["currency"] or "",
            current["basis"] or "",
            current["estimated_at"] or "",
            (item.get("warranty") or {}).get("provider") or "",
            (item.get("warranty") or {}).get("end_date") or "",
            (item.get("warranty") or {}).get("status") or "",
            (item.get("last_checked") or {}).get("at") or "",
            (item.get("last_checked") or {}).get("status") or "",
            (item.get("last_checked") or {}).get("quantity")
            if (item.get("last_checked") or {}).get("quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("owned_quantity")
            if (item.get("last_checked") or {}).get("owned_quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("on_loan_quantity")
            if (item.get("last_checked") or {}).get("on_loan_quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("location_path") or "",
            "yes" if (item.get("last_checked") or {}).get("stale") else "no",
            item.get("photo_count") or 0,
            item.get("document_count") or 0,
            "; ".join(item.get("document_refs") or []),
        ]
        writer.writerow([_csv_value(value) for value in row])
    return buffer.getvalue().encode("utf-8-sig")


def _zip_readme(snapshot: dict[str, Any], pdf_name: str, csv_name: str | None) -> str:
    lines = [
        "Housetory inventory evidence package",
        "====================================",
        "",
        f"Household: {snapshot['household']['name']}",
        f"Generated: {snapshot['generated_at']} ({snapshot['timezone']})",
        f"Scope: {snapshot['scope_label']}",
        f"Items: {snapshot['item_count']} · units: {snapshot['unit_count']}",
        "",
        "This package records what is currently recorded in Housetory.",
        "It is not a physical stocktake, an appraisal, an insurance acceptance,",
        "a claim or a guarantee of coverage. Missing information is marked, not",
        "invented. Currencies are kept separate and never converted.",
        "Current-value estimates are per owned unit and extended by owned quantity.",
        "Legacy record totals are reported once and are not multiplied by quantity.",
        "",
        f"Main report: {pdf_name}",
    ]
    if csv_name:
        lines.append(f"Spreadsheet: {csv_name}")
    lines.extend(
        [
            "Manifest: manifest.json",
            "",
            "Evidence files are under documents/ and photos/. The manifest maps each",
            "file to its item/document, role, SHA-256 and byte count. Original means",
            "the exact stored upload bytes; normalized/download means the safe or",
            "cleaned derivative. A missing file is listed in manifest.json and in the",
            "report notes rather than silently omitted.",
            "",
            "No borrower names, loan notes, purchase notes or document notes are included.",
            "The package is private and should be stored securely. It is not uploaded",
            "or shared automatically by Housetory.",
        ]
    )
    return "\n".join(lines) + "\n"


def _zip_name(parts: str, fallback: str) -> str:
    cleaned = _slug(parts, fallback)
    return cleaned or fallback


class EvidenceExportTooLarge(RuntimeError):
    pass


class EvidenceExportTimeout(RuntimeError):
    pass


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() > deadline:
        raise EvidenceExportTimeout("The evidence package exceeded its generation deadline.")


def write_bundle(
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    snapshot: dict[str, Any],
    *,
    pdf_bytes: bytes,
    csv_bytes: bytes | None,
    pdf_name: str,
    csv_name: str | None,
    max_bytes: int,
    deadline: float | None = None,
) -> tuple[str, int, str, dict[str, Any], list[str]]:
    temp_path = storage.evidence_export_temp_path(household_id, export_id, ".zip")
    warnings: list[str] = []
    manifest_files: list[dict[str, Any]] = []
    missing: list[str] = []
    added = len(pdf_bytes) + (len(csv_bytes) if csv_bytes else 0)
    if added > max_bytes:
        raise EvidenceExportTooLarge("The selected files exceed the package size limit.")
    options = EvidenceOptionsIn.model_validate(snapshot["options"])
    try:
        with zipfile.ZipFile(
            temp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            archive.writestr(pdf_name, pdf_bytes)
            manifest_files.append(
                {
                    "path": pdf_name,
                    "role": "report_pdf",
                    "bytes": len(pdf_bytes),
                    "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
                }
            )
            if csv_bytes is not None and csv_name:
                archive.writestr(csv_name, csv_bytes)
                manifest_files.append(
                    {
                        "path": csv_name,
                        "role": "spreadsheet_csv",
                        "bytes": len(csv_bytes),
                        "sha256": hashlib.sha256(csv_bytes).hexdigest(),
                    }
                )

            documents = [entry for entry in snapshot["documents"] if entry["included"]]
            manifest_documents: list[dict[str, Any]] = []
            for document in documents:
                _check_deadline(deadline)
                folder = _zip_name(
                    f"{document.get('reference') or 'evidence'}-{document['title']}",
                    "document",
                )
                files: list[dict[str, Any]] = []

                def add_document_file(
                    key: str,
                    role: str,
                    suffix: str,
                    *,
                    document: dict[str, Any] = document,
                    folder: str = folder,
                    files: list[dict[str, Any]] = files,
                ) -> None:
                    nonlocal added
                    if not storage.evidence_export_key_exists(key):
                        missing.append(
                            f"Missing {role.replace('_', ' ')} file for "
                            f"“{document['title']}” ({document.get('reference') or 'evidence'})."
                        )
                        return
                    try:
                        source = storage.resolve_key(key)
                        size = source.stat().st_size
                    except (ApiError, OSError):
                        missing.append(
                            f"Missing {role.replace('_', ' ')} file for “{document['title']}”."
                        )
                        return
                    if added + size > max_bytes:
                        raise EvidenceExportTooLarge(
                            "The selected attachments exceed the package size limit."
                        )
                    try:
                        digest = storage.file_sha256(key)
                    except (OSError, ApiError):
                        missing.append(
                            f"Could not read {role.replace('_', ' ')} file for "
                            f"“{document['title']}”."
                        )
                        return
                    existing_file = next(
                        (entry for entry in files if entry.get("sha256") == digest),
                        None,
                    )
                    if existing_file is not None:
                        alias = {
                            **existing_file,
                            "role": role,
                            "alias_of": existing_file["path"],
                        }
                        files.append(alias)
                        manifest_files.append({**alias, "document_id": document["id"]})
                        return
                    arcname = f"documents/{folder}/{suffix}"
                    try:
                        archive.write(source, arcname)
                    except OSError:
                        missing.append(
                            f"Could not include {role.replace('_', ' ')} file for "
                            f"“{document['title']}”."
                        )
                        return
                    added += size
                    record = {
                        "path": arcname,
                        "role": role,
                        "bytes": size,
                        "sha256": digest,
                        "content_type": (
                            document["original_content_type"]
                            if role.startswith("original")
                            else document["content_type"]
                        ),
                    }
                    files.append(record)
                    manifest_files.append({**record, "document_id": document["id"]})

                if options.include_document_originals:
                    add_document_file(
                        document["original_storage_key"],
                        "original",
                        f"original{Path(document['original_filename']).suffix or '.bin'}",
                    )
                    if document["storage_key"] != document["original_storage_key"]:
                        add_document_file(
                            document["storage_key"],
                            "normalized_download",
                            f"download{Path(document['original_filename']).suffix or '.bin'}",
                        )
                    for page in document.get("scan_pages") or []:
                        add_document_file(
                            page["original_storage_key"],
                            f"scan_source_page_{page['index']}",
                            (
                                f"source-page-{page['index']:02d}"
                                f"{Path(page['original_filename']).suffix or '.bin'}"
                            ),
                        )
                else:
                    add_document_file(
                        document["storage_key"],
                        "normalized_download",
                        f"download{Path(document['original_filename']).suffix or '.bin'}",
                    )
                manifest_documents.append(
                    {
                        "reference": document.get("reference"),
                        "id": document["id"],
                        "title": document["title"],
                        "document_type": document["document_type"],
                        "evidence_kind": document["evidence_kind"],
                        "selected_item_ids": document["selected_item_ids"],
                        "shared_with_unselected": document["shared_with_unselected"],
                        "files": files,
                    }
                )

            photos_manifest: list[dict[str, Any]] = []
            if options.include_photos:
                for photo in snapshot["photos"]:
                    _check_deadline(deadline)
                    key = photo["storage_key"]
                    if not storage.evidence_export_key_exists(key):
                        missing.append(
                            f"Missing photo “{photo['original_filename']}” for "
                            f"“{photo['item_name']}”."
                        )
                        continue
                    try:
                        source = storage.resolve_key(key)
                        size = source.stat().st_size
                    except (ApiError, OSError):
                        missing.append(f"Missing photo “{photo['original_filename']}”.")
                        continue
                    if added + size > max_bytes:
                        raise EvidenceExportTooLarge(
                            "The selected photos and attachments exceed the package size limit."
                        )
                    folder = _zip_name(f"{photo['item_name']}-{photo['item_id'][:8]}", "item")
                    suffix = Path(photo["original_filename"]).suffix or ".bin"
                    stem = Path(photo["original_filename"]).stem or "photo"
                    arcname = (
                        f"photos/{folder}/"
                        f"{_zip_name(photo['id'][:8] + '-' + stem, 'photo')}"
                        f"{suffix}"
                    )
                    try:
                        archive.write(source, arcname)
                        digest = storage.file_sha256(key)
                    except (OSError, ApiError):
                        missing.append(f"Could not include photo “{photo['original_filename']}”.")
                        continue
                    added += size
                    record = {
                        "path": arcname,
                        "role": "item_photo",
                        "bytes": size,
                        "sha256": digest,
                        "content_type": photo["content_type"],
                        "photo_id": photo["id"],
                        "item_id": photo["item_id"],
                        "item_name": photo["item_name"],
                    }
                    photos_manifest.append(record)
                    manifest_files.append(record)

            all_warnings = [*snapshot["warnings"], *warnings, *missing]
            manifest = {
                "format_version": snapshot["format_version"],
                "export_id": str(export_id),
                "generated_at": snapshot["generated_at"],
                "timezone": snapshot["timezone"],
                "household": snapshot["household"],
                "scope": snapshot["scope"],
                "scope_label": snapshot["scope_label"],
                "include_archived": snapshot["include_archived"],
                "options": snapshot["options"],
                "counts": {
                    "items": snapshot["item_count"],
                    "units": snapshot["unit_count"],
                    "at_home_units": snapshot["at_home_unit_count"],
                    "on_loan_units": snapshot["on_loan_unit_count"],
                    "photos": snapshot["photo_count"],
                    "included_photos": snapshot["included_photo_count"],
                    "documents": snapshot["document_count"],
                    "included_documents": snapshot["included_document_count"],
                },
                "items": [
                    {
                        "id": item["id"],
                        "name": item["name"],
                        "quantity": item["quantity"],
                        "on_loan_quantity": item["on_loan_quantity"],
                        "at_home_quantity": item["at_home_quantity"],
                        "full_location_path": item["full_location_path"],
                        "property_id": item["property_id"],
                        "property_name": item["property_name"],
                        "evidence_references": item["document_refs"],
                        "current_value_unit_cents": _snapshot_current_value(item)["unit_cents"],
                        "current_value_quantity": _snapshot_current_value(item)["quantity"],
                        "current_value_total_cents": _snapshot_current_value(item)["total_cents"],
                        "current_value_currency": _snapshot_current_value(item)["currency"],
                        "current_value_basis": _snapshot_current_value(item)["basis"],
                        "current_value_estimated_at": _snapshot_current_value(item)["estimated_at"],
                        "last_checked": item.get("last_checked"),
                    }
                    for item in snapshot["items"]
                ],
                "documents": manifest_documents,
                "photos": photos_manifest,
                "files": manifest_files,
                "missing_files": missing,
                "warnings": all_warnings,
                "note": (
                    "Recorded inventory only. Not a physical stocktake, appraisal, "
                    "insurance acceptance, coverage guarantee or claim."
                ),
            }
            readme = _zip_readme(snapshot, pdf_name, csv_name)
            archive.writestr("README.txt", readme.encode("utf-8"))
            manifest_json = json.dumps(
                manifest, ensure_ascii=False, indent=2, sort_keys=True
            ).encode("utf-8")
            archive.writestr("manifest.json", manifest_json)
        artifact = storage.finalize_evidence_export_temp(
            household_id, export_id, temp_path, f"housetory-evidence-{export_id}.zip"
        )
        return *artifact, manifest, missing
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _clear_artifact_fields(package: InventoryEvidenceExport) -> None:
    package.pdf_key = None
    package.pdf_name = None
    package.pdf_bytes = None
    package.pdf_sha256 = None
    package.csv_key = None
    package.csv_name = None
    package.csv_bytes = None
    package.csv_sha256 = None
    package.bundle_key = None
    package.bundle_name = None
    package.bundle_bytes = None
    package.bundle_sha256 = None


def _expire_if_needed(db: Session, package: InventoryEvidenceExport) -> None:
    if package.expires_at is None or package.status == "expired":
        return
    now = datetime.now(UTC)
    expires = package.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires > now:
        return
    package.status = "expired"
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    db.commit()


def get_export(
    db: Session,
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> InventoryEvidenceExport:
    query = select(InventoryEvidenceExport).where(
        InventoryEvidenceExport.id == export_id,
        InventoryEvidenceExport.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update()
    package = db.scalar(query)
    if package is None:
        raise ApiError(404, "evidence_export_not_found", "Evidence package not found.")
    _expire_if_needed(db, package)
    return package


def export_out(package: InventoryEvidenceExport, *, can_manage: bool) -> EvidenceExportOut:
    return EvidenceExportOut(
        id=package.id,
        status=package.status,  # type: ignore[arg-type]
        format_version=package.format_version,
        scope_label=package.scope_label,
        scope=package.scope or {},
        include_archived=package.include_archived,
        options=EvidenceOptionsIn.model_validate(package.options or {}),
        item_count=package.item_count,
        unit_count=package.unit_count,
        evidence_counts=package.evidence_counts or {},
        warnings=package.warnings or [],
        error=package.error,
        created_at=package.created_at,
        completed_at=package.completed_at,
        expires_at=package.expires_at,
        pdf_available=bool(package.status == "succeeded" and package.pdf_key),
        csv_available=bool(package.status == "succeeded" and package.csv_key),
        bundle_available=bool(package.status == "succeeded" and package.bundle_key),
        pdf_bytes=package.pdf_bytes,
        csv_bytes=package.csv_bytes,
        bundle_bytes=package.bundle_bytes,
        pdf_sha256=package.pdf_sha256,
        csv_sha256=package.csv_sha256,
        bundle_sha256=package.bundle_sha256,
        can_manage=can_manage,
    )


def preview_export(
    db: Session, household: Household, payload: EvidencePreviewIn
) -> EvidencePreviewOut:
    snapshot = build_snapshot(
        db,
        household,
        payload.scope,
        payload.include_archived,
        payload.options,
    )
    return _preview_from_snapshot(snapshot)


def create_export(
    db: Session,
    household: Household,
    payload: EvidenceCreateIn,
    *,
    user_id: uuid.UUID,
) -> InventoryEvidenceExport:
    existing = db.scalar(
        select(InventoryEvidenceExport).where(
            InventoryEvidenceExport.household_id == household.id,
            InventoryEvidenceExport.request_id == payload.request_id,
        )
    )
    if existing is not None:
        _expire_if_needed(db, existing)
        same_selection = (
            existing.scope == payload.scope.as_json()
            and existing.options == payload.options.model_dump(mode="json")
            and existing.include_archived == payload.include_archived
        )
        if not same_selection or existing.snapshot_fingerprint != payload.fingerprint:
            raise ApiError(
                409,
                "export_request_conflict",
                "This request id was already used for a different evidence selection.",
            )
        return existing
    snapshot = build_snapshot(
        db,
        household,
        payload.scope,
        payload.include_archived,
        payload.options,
    )
    if snapshot["item_count"] == 0:
        raise ApiError(
            422,
            "export_empty",
            "No items are in this selection. Choose another room, container or item.",
        )
    if snapshot["fingerprint"] != payload.fingerprint:
        raise ApiError(
            409,
            "inventory_changed",
            "Inventory or evidence changed after the preview. Review the new preview "
            "and confirm the export again.",
        )
    if snapshot["bundle_estimated_bytes"] > snapshot["max_bundle_bytes"]:
        raise ApiError(
            422,
            "export_too_large",
            "The selected attachments are too large for one package. Exclude manuals, "
            "originals or photos, then preview again.",
        )
    package = InventoryEvidenceExport(
        household_id=household.id,
        created_by_user_id=user_id,
        request_id=payload.request_id,
        status="queued",
        format_version=snapshot["format_version"],
        scope=payload.scope.as_json(),
        scope_label=snapshot["scope_label"],
        include_archived=payload.include_archived,
        options=payload.options.model_dump(mode="json"),
        snapshot=snapshot,
        snapshot_fingerprint=snapshot["fingerprint"],
        item_count=snapshot["item_count"],
        unit_count=snapshot["unit_count"],
        evidence_counts={
            "items": snapshot["item_count"],
            "units": snapshot["unit_count"],
            "photos": snapshot["photo_count"],
            "included_photos": snapshot["included_photo_count"],
            "documents": snapshot["document_count"],
            "included_documents": snapshot["included_document_count"],
            "evidence_references": snapshot["evidence_reference_count"],
            "bundle_estimated_bytes": snapshot["bundle_estimated_bytes"],
        },
        manifest={},
        warnings=snapshot["warnings"],
        expires_at=None,
    )
    db.add(package)
    try:
        db.flush()
        job = enqueue(
            db,
            EVIDENCE_EXPORT_TASK,
            {"export_id": str(package.id)},
            commit=False,
            priority=3,
            max_attempts=2,
            queue="default",
        )
        package.job_id = job.id
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(package)
    return package


def list_exports(
    db: Session,
    household_id: uuid.UUID,
    *,
    user_id: uuid.UUID,
    role: str,
    limit: int = 20,
) -> list[InventoryEvidenceExport]:
    packages = list(
        db.scalars(
            select(InventoryEvidenceExport)
            .where(InventoryEvidenceExport.household_id == household_id)
            .order_by(InventoryEvidenceExport.created_at.desc())
            .limit(max(1, min(limit, 50)))
        ).all()
    )
    for package in packages:
        _expire_if_needed(db, package)
    return packages


def cancel_export(
    db: Session,
    package: InventoryEvidenceExport,
    *,
    user_id: uuid.UUID,
    role: str,
) -> InventoryEvidenceExport:
    if role == "viewer" and package.created_by_user_id != user_id:
        raise ApiError(403, "read_only_role", "Viewers can only manage their own exports.")
    if package.status in {"succeeded", "failed", "expired"}:
        if package.status == "succeeded":
            raise ApiError(409, "export_already_ready", "This evidence package is ready.")
        return package
    package.status = "cancelled"
    package.error = None
    package.completed_at = datetime.now(UTC)
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    db.commit()
    db.refresh(package)
    return package


def retry_export(
    db: Session,
    package: InventoryEvidenceExport,
    *,
    user_id: uuid.UUID,
    role: str,
) -> InventoryEvidenceExport:
    if role == "viewer" and package.created_by_user_id != user_id:
        raise ApiError(403, "read_only_role", "Viewers can only manage their own exports.")
    if package.status in {"queued", "running", "succeeded"}:
        raise ApiError(
            409, "export_not_retryable", "This evidence package is already active or ready."
        )
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    package.status = "queued"
    package.error = None
    package.completed_at = None
    package.expires_at = None
    package.manifest = {}
    package.warnings = (package.snapshot or {}).get("warnings", [])
    db.flush()
    job = enqueue(
        db,
        EVIDENCE_EXPORT_TASK,
        {"export_id": str(package.id)},
        commit=False,
        priority=3,
        max_attempts=2,
    )
    package.job_id = job.id
    db.commit()
    db.refresh(package)
    return package


def download_artifact(
    db: Session,
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    kind: str,
) -> tuple[Path, str, str]:
    package = get_export(db, household_id, export_id)
    _expire_if_needed(db, package)
    if package.status == "expired":
        raise ApiError(
            410,
            "export_expired",
            "This evidence package expired. Generate a new package to download it.",
        )
    if package.status != "succeeded":
        raise ApiError(409, "export_not_ready", "This evidence package is not ready yet.")
    if kind == "pdf":
        key, name, media_type = package.pdf_key, package.pdf_name, "application/pdf"
    elif kind == "csv":
        key, name, media_type = package.csv_key, package.csv_name, "text/csv; charset=utf-8"
    elif kind == "bundle":
        key, name, media_type = (
            package.bundle_key,
            package.bundle_name,
            "application/zip",
        )
    else:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.")
    if not key or not name:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.")
    try:
        path = storage.resolve_export_key(key)
    except (ApiError, OSError) as exc:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.") from exc
    return path, name, media_type


def _safe_export_error() -> str:
    return "The evidence package could not be generated. Review the selection and try again."


def run_evidence_export(payload: dict[str, Any]) -> dict[str, Any]:
    from ..db import SessionLocal

    export_id = uuid.UUID(str(payload["export_id"]))
    with SessionLocal() as db:
        package = db.get(InventoryEvidenceExport, export_id)
        if package is None:
            return {"skipped": True}
        if package.status in {"cancelled", "expired"}:
            return {"skipped": True}
        package.status = "running"
        package.error = None
        db.commit()
        snapshot = dict(package.snapshot or {})
        snapshot["export_id"] = str(package.id)
        pdf_bytes = b""
        pdf_key = csv_key = bundle_key = None
        pdf_name = csv_name = bundle_name = None
        pdf_bytes_size = csv_bytes_size = bundle_bytes_size = 0
        pdf_sha = csv_sha = bundle_sha = None
        manifest: dict[str, Any] = {}
        warnings: list[str] = list(snapshot.get("warnings") or [])
        try:
            settings = get_settings()
            deadline = time.monotonic() + settings.evidence_export_timeout_seconds
            missing = _missing_evidence(snapshot)
            pdf_bytes = build_pdf(snapshot, missing, deadline=deadline)
            date_label = datetime.fromisoformat(snapshot["generated_at"]).strftime("%Y%m%d")
            pdf_name = f"housetory-inventory-evidence-{date_label}-{package.id.hex[:8]}.pdf"
            pdf_key, pdf_bytes_size, pdf_sha = storage.write_evidence_export_bytes(
                package.household_id, package.id, pdf_name, pdf_bytes
            )
            csv_bytes = None
            if snapshot["options"].get("include_csv", True):
                csv_bytes = build_csv(snapshot, deadline=deadline)
                csv_name = f"housetory-inventory-evidence-{date_label}-{package.id.hex[:8]}.csv"
                csv_key, csv_bytes_size, csv_sha = storage.write_evidence_export_bytes(
                    package.household_id, package.id, csv_name, csv_bytes
                )
            if snapshot["options"].get("include_attachments", True):
                bundle_name = f"housetory-evidence-{package.id}.zip"
                (
                    bundle_key,
                    bundle_bytes_size,
                    bundle_sha,
                    manifest,
                    missing_from_bundle,
                ) = write_bundle(
                    package.household_id,
                    package.id,
                    snapshot,
                    pdf_bytes=pdf_bytes,
                    csv_bytes=csv_bytes,
                    pdf_name=pdf_name,
                    csv_name=csv_name,
                    max_bytes=settings.evidence_export_max_bundle_mb * 1024 * 1024,
                    deadline=deadline,
                )
                warnings.extend(missing_from_bundle)
            db.refresh(package)
            if package.status in {"cancelled", "expired"}:
                storage.delete_evidence_export_artifacts(package.household_id, package.id)
                return {"skipped": True, "cancelled": True}
            package.pdf_key = pdf_key
            package.pdf_name = pdf_name
            package.pdf_bytes = pdf_bytes_size
            package.pdf_sha256 = pdf_sha
            package.csv_key = csv_key
            package.csv_name = csv_name
            package.csv_bytes = csv_bytes_size
            package.csv_sha256 = csv_sha
            package.bundle_key = bundle_key
            package.bundle_name = bundle_name
            package.bundle_bytes = bundle_bytes_size
            package.bundle_sha256 = bundle_sha
            package.manifest = manifest
            package.warnings = list(dict.fromkeys(warnings + missing))
            package.status = "succeeded"
            package.completed_at = datetime.now(UTC)
            package.expires_at = package.completed_at + timedelta(
                hours=settings.evidence_export_retention_hours
            )
            package.error = None
            db.commit()
            return {
                "export_id": str(package.id),
                "status": "succeeded",
                "pdf_bytes": pdf_bytes_size,
                "csv_bytes": csv_bytes_size,
                "bundle_bytes": bundle_bytes_size,
            }
        except Exception:
            db.rollback()
            with SessionLocal() as failure_db:
                failed = failure_db.get(InventoryEvidenceExport, export_id)
                if failed is not None and failed.status not in {"cancelled", "expired"}:
                    failed.status = "failed"
                    failed.error = _safe_export_error()
                    failed.completed_at = datetime.now(UTC)
                    _clear_artifact_fields(failed)
                    storage.delete_evidence_export_artifacts(failed.household_id, failed.id)
                    failure_db.commit()
            raise


def prune_expired_exports() -> int:
    from ..db import SessionLocal

    now = datetime.now(UTC)
    with SessionLocal() as db:
        packages = list(
            db.scalars(
                select(InventoryEvidenceExport).where(
                    InventoryEvidenceExport.expires_at.is_not(None),
                    InventoryEvidenceExport.expires_at <= now,
                    InventoryEvidenceExport.status != "expired",
                )
            ).all()
        )
        for package in packages:
            package.status = "expired"
            _clear_artifact_fields(package)
            storage.delete_evidence_export_artifacts(package.household_id, package.id)
        db.commit()
        return len(packages)
