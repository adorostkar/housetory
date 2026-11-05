import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import DocumentType, OcrStatus
from ...models import Document, Item, Purchase
from ...schemas.documents import (
    DocumentList,
    DocumentOut,
    DocumentUpdate,
    OcrApplyRequest,
    OcrApplyResponse,
)
from ...services import storage
from ...services.document_ocr import enqueue_ocr
from ...services.documents import (
    create_document,
    delete_document,
    document_load_options,
    get_document,
    resolve_document_items,
)
from ...services.purchases import (
    get_purchase,
    prune_orphan_purchases,
    resolve_items,
)
from ...services.serializers import document_out
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["documents"])


def _file_headers(document: Document) -> dict[str, str]:
    return {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": f'attachment; filename="{document.original_filename}"',
    }


def _document_query(household_id: uuid.UUID):
    return (
        select(Document)
        .options(*document_load_options())
        .where(Document.household_id == household_id)
    )


@router.get("/documents", response_model=DocumentList)
def list_documents(
    q: Annotated[str | None, Query(max_length=200)] = None,
    document_type: Annotated[DocumentType | None, Query(alias="type")] = None,
    item_id: uuid.UUID | None = None,
    merchant: Annotated[str | None, Query(max_length=160)] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    ocr_status: OcrStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    sort: Literal["created_desc", "created_asc", "document_date_desc", "title_asc"] = (
        "created_desc"
    ),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentList:
    conditions = [Document.household_id == auth.household.id]
    if document_type is not None:
        conditions.append(Document.document_type == document_type.value)
    if ocr_status is not None:
        conditions.append(Document.ocr_status == ocr_status.value)
    if merchant:
        conditions.append(Document.merchant.ilike(f"%{merchant.strip()}%"))
    if date_from is not None:
        conditions.append(
            or_(
                Document.document_date >= date_from,
                Document.items.any(Item.purchase.has(Purchase.purchase_date >= date_from)),
            )
        )
    if date_to is not None:
        conditions.append(
            or_(
                Document.document_date <= date_to,
                Document.items.any(Item.purchase.has(Purchase.purchase_date <= date_to)),
            )
        )
    if item_id is not None:
        item = db.scalar(
            select(Item.id).where(Item.id == item_id, Item.household_id == auth.household.id)
        )
        if item is None:
            raise ApiError(422, "item_not_found", "The selected item does not exist.")
        conditions.append(Document.items.any(Item.id == item_id))

    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        conditions.append(
            or_(
                Document.title.ilike(search),
                Document.original_filename.ilike(search),
                Document.merchant.ilike(search),
                Document.notes.ilike(search),
                Document.extracted_text.ilike(search),
                cast(Document.extracted_metadata, Text).ilike(search),
                Document.items.any(Item.name.ilike(search)),
            )
        )

    total = int(db.scalar(select(func.count(Document.id)).where(*conditions)) or 0)
    ordering = {
        "created_desc": [Document.created_at.desc()],
        "created_asc": [Document.created_at.asc()],
        "document_date_desc": [
            Document.document_date.desc().nullslast(),
            Document.created_at.desc(),
        ],
        "title_asc": [func.lower(Document.title).asc()],
    }[sort]
    documents = db.scalars(
        _document_query(auth.household.id)
        .where(*conditions)
        .order_by(*ordering)
        .limit(limit)
        .offset(offset)
    ).all()
    return DocumentList(
        items=[document_out(document) for document in documents],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/documents", response_model=DocumentOut, status_code=201)
def upload_document(
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    document_type: Annotated[DocumentType, Form()] = DocumentType.OTHER,
    item_ids: Annotated[list[uuid.UUID], Form()] = [],  # noqa: B006
    merchant: Annotated[str | None, Form(max_length=160)] = None,
    document_date: Annotated[date | None, Form()] = None,
    notes: Annotated[str | None, Form(max_length=4000)] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    document = create_document(
        db,
        auth.household.id,
        file,
        title=title,
        document_type=document_type,
        item_ids=item_ids,
        merchant=merchant.strip() if merchant and merchant.strip() else None,
        document_date=document_date,
        notes=notes,
    )
    return document_out(document)


@router.post("/items/{item_id}/documents", response_model=DocumentOut, status_code=201)
def upload_item_document(
    item_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    document_type: Annotated[DocumentType, Form()] = DocumentType.OTHER,
    merchant: Annotated[str | None, Form(max_length=160)] = None,
    document_date: Annotated[date | None, Form()] = None,
    notes: Annotated[str | None, Form(max_length=4000)] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == auth.household.id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    document = create_document(
        db,
        auth.household.id,
        file,
        title=title,
        document_type=document_type,
        item_ids=[item.id],
        merchant=merchant.strip() if merchant and merchant.strip() else None,
        document_date=document_date,
        notes=notes,
    )
    return document_out(document)


@router.get("/documents/{document_id}", response_model=DocumentOut)
def read_document(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    return document_out(get_document(db, auth.household.id, document_id))


@router.patch("/documents/{document_id}", response_model=DocumentOut)
def update_document(
    document_id: uuid.UUID,
    payload: DocumentUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    document = get_document(db, auth.household.id, document_id)
    fields = payload.model_fields_set
    if "title" in fields and payload.title is not None:
        document.title = payload.title
    if "document_type" in fields and payload.document_type is not None:
        document.document_type = payload.document_type.value
    if "document_date" in fields:
        document.document_date = payload.document_date
    if "merchant" in fields:
        document.merchant = payload.merchant
    if "notes" in fields:
        document.notes = payload.notes
    if "item_ids" in fields and payload.item_ids is not None:
        document.items = resolve_document_items(db, auth.household.id, payload.item_ids)
    db.commit()
    document = get_document(db, auth.household.id, document.id)
    return document_out(document)


@router.get("/documents/{document_id}/file")
def get_document_file(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    document = get_document(db, auth.household.id, document_id)
    path = storage.resolve_key(document.storage_key)
    return FileResponse(
        path,
        media_type=document.content_type,
        headers=_file_headers(document),
    )


@router.get("/documents/{document_id}/original")
def get_document_original(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    document = get_document(db, auth.household.id, document_id)
    path = storage.resolve_key(document.original_storage_key)
    headers = _file_headers(document)
    headers["X-Housetory-Original"] = "true"
    return FileResponse(
        path,
        media_type=document.original_content_type,
        headers=headers,
    )


@router.delete("/documents/{document_id}", status_code=204)
def delete_document_route(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    document = get_document(db, auth.household.id, document_id)
    delete_document(db, document)
    return Response(status_code=204)


@router.post("/documents/{document_id}/ocr", response_model=DocumentOut)
def retry_document_ocr(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    document = get_document(db, auth.household.id, document_id)
    if document.ocr_status in {OcrStatus.QUEUED.value, OcrStatus.PROCESSING.value}:
        raise ApiError(
            409,
            "ocr_in_progress",
            "OCR is already queued or running for this document.",
        )
    enqueue_ocr(db, document)
    document = get_document(db, auth.household.id, document.id)
    return document_out(document)


@router.post("/documents/{document_id}/ocr/apply", response_model=OcrApplyResponse)
def apply_document_ocr(
    document_id: uuid.UUID,
    payload: OcrApplyRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> OcrApplyResponse:
    document = get_document(db, auth.household.id, document_id)
    selected_items = resolve_items(db, auth.household.id, payload.item_ids)
    update_items = resolve_items(
        db, auth.household.id, [entry.item_id for entry in payload.item_updates]
    )
    update_by_id = {item.id: item for item in update_items}

    purchase: Purchase | None = None
    if payload.create_purchase:
        if not selected_items:
            raise ApiError(
                422, "item_required", "Choose at least one item for the confirmed purchase."
            )
        shared_ids = {item.purchase_id for item in selected_items}
        if len(shared_ids) == 1 and None not in shared_ids:
            purchase = get_purchase(db, auth.household.id, next(iter(shared_ids)))
        else:
            previous_purchase_ids = {
                item.purchase_id for item in selected_items if item.purchase_id is not None
            }
            purchase = Purchase(household_id=auth.household.id, currency="USD")
            db.add(purchase)
            db.flush()
            for item in selected_items:
                item.purchase_id = purchase.id
            db.flush()
            if previous_purchase_ids:
                prune_orphan_purchases(db, auth.household.id)
        purchase.vendor = payload.merchant
        purchase.purchase_date = payload.purchase_date
        purchase.price_cents = payload.price_cents
        purchase.currency = payload.currency
        purchase.order_number = payload.order_number
        purchase.notes = payload.notes
        if payload.attach_as_receipt:
            purchase.receipt_document_id = document.id

    for entry in payload.item_updates:
        item = update_by_id.get(entry.item_id)
        if item is None:
            continue
        if entry.name is not None:
            item.name = entry.name
        if entry.serial_number is not None:
            item.serial_number = entry.serial_number

    if payload.merchant is not None:
        document.merchant = payload.merchant
    if payload.document_date is not None:
        document.document_date = payload.document_date
    metadata = dict(document.extracted_metadata or {})
    metadata["confirmed"] = {
        "merchant": payload.merchant,
        "purchase_date": payload.purchase_date.isoformat() if payload.purchase_date else None,
        "price_cents": payload.price_cents,
        "currency": payload.currency,
        "order_number": payload.order_number,
        "document_date": payload.document_date.isoformat() if payload.document_date else None,
    }
    metadata["applied_at"] = datetime.now(UTC).isoformat()
    metadata["applied_item_ids"] = [str(item.id) for item in selected_items]
    document.extracted_metadata = metadata

    db.commit()
    document = get_document(db, auth.household.id, document.id)
    return OcrApplyResponse(
        document=document_out(document),
        purchase_id=purchase.id if purchase is not None else None,
        updated_item_ids=[item.id for item in update_items],
    )
