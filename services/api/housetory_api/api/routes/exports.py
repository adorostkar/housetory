import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_db
from ...models import Document, Purchase
from ...services.ownership import financial_rows_for_export
from ...services.purchases import purchase_load_options
from ...services.warranty_dashboard import load_warranties, serialize_warranties
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/exports", tags=["exports"])


def _safe_cell(value: object) -> object:
    """Neutralize spreadsheet formula prefixes in user-controlled text."""
    if isinstance(value, str) and value[:1] in {"=", "+", "-", "@"}:
        return f"'{value}"
    return value


def _csv_response(rows: list[list[object]], filename: str) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerows([[_safe_cell(value) for value in row] for row in rows])
    stamp = date.today().strftime("%Y%m%d")
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="housetory-{filename}-{stamp}.csv"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/documents.csv")
def export_documents(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    documents = db.scalars(
        select(Document)
        .where(Document.household_id == auth.household.id)
        .order_by(Document.created_at.desc())
    ).all()
    rows: list[list[object]] = [
        [
            "title",
            "type",
            "filename",
            "merchant",
            "document_date",
            "ocr_status",
            "items",
            "created_at",
            "download_url",
        ]
    ]
    for document in documents:
        rows.append(
            [
                document.title,
                document.document_type,
                document.original_filename,
                document.merchant or "",
                document.document_date.isoformat() if document.document_date else "",
                document.ocr_status,
                "; ".join(sorted(item.name for item in document.items)),
                document.created_at.isoformat(),
                f"{get_settings().api_prefix}/documents/{document.id}/file",
            ]
        )
    return _csv_response(rows, "documents")


@router.get("/purchases.csv")
def export_purchases(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    purchases = db.scalars(
        select(Purchase)
        .options(*purchase_load_options())
        .where(Purchase.household_id == auth.household.id)
        .order_by(Purchase.purchase_date.desc().nullslast(), Purchase.created_at.desc())
    ).all()
    rows: list[list[object]] = [
        [
            "merchant",
            "purchase_date",
            "price_cents",
            "amount",
            "currency",
            "order_number",
            "items",
            "receipt_document",
            "notes",
            "allocated_total_cents",
            "unallocated_cents",
            "allocations",
        ]
    ]
    for purchase in purchases:
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
        rows.append(
            [
                purchase.vendor or "",
                purchase.purchase_date.isoformat() if purchase.purchase_date else "",
                purchase.price_cents if purchase.price_cents is not None else "",
                f"{(purchase.price_cents or 0) / 100:.2f}",
                purchase.currency,
                purchase.order_number or "",
                "; ".join(sorted(item.name for item in purchase.items)),
                purchase.receipt_document.title if purchase.receipt_document is not None else "",
                purchase.notes or "",
                allocated_total,
                (purchase.price_cents - allocated_total)
                if purchase.price_cents is not None
                else "",
                "; ".join(
                    f"{allocation.item.name if allocation.item else 'Deleted item'} "
                    f"×{allocation.quantity}: "
                    f"{(allocation.allocated_cents or 0) / 100:.2f} "
                    f"{allocation.currency}"
                    for allocation in allocations
                ),
            ]
        )
    return _csv_response(rows, "purchases")


@router.get("/warranties.csv")
def export_warranties(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    warranties = load_warranties(db, auth.household.id, include_archived=True)
    serialized = serialize_warranties(warranties, auth.household.warranty_reminder_days)
    rows: list[list[object]] = [
        [
            "item",
            "provider",
            "start_date",
            "duration_months",
            "end_date",
            "status",
            "days_remaining",
            "reminder_days",
            "document",
            "coverage_notes",
        ]
    ]
    for warranty in serialized:
        rows.append(
            [
                warranty.item.name if warranty.item else "",
                warranty.provider or "",
                warranty.start_date.isoformat() if warranty.start_date else "",
                warranty.duration_months if warranty.duration_months is not None else "",
                warranty.end_date.isoformat() if warranty.end_date else "",
                warranty.status,
                warranty.days_remaining if warranty.days_remaining is not None else "",
                warranty.effective_reminder_days,
                warranty.document.title if warranty.document else "",
                warranty.notes or "",
            ]
        )
    return _csv_response(rows, "warranties")


@router.get("/inventory.csv")
def export_inventory(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    data = financial_rows_for_export(db, auth.household.id)
    headers = [
        "item",
        "quantity",
        "category",
        "room",
        "container",
        "storage_location",
        "purchase_date",
        "merchant",
        "purchase_currency",
        "purchase_total_cents",
        "purchase_total_scope",
        "purchase_allocated_cents",
        "current_value_unit_cents",
        "current_value_quantity",
        "current_value_total_cents",
        "current_value_currency",
        "current_value_basis",
        "current_value_estimated_at",
        "purchase_info_status",
        "missing_purchase_information",
    ]
    rows: list[list[object]] = [headers]
    for entry in data:
        rows.append([entry[header] for header in headers])
    return _csv_response(rows, "inventory")
