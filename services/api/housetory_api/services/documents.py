import uuid
from typing import Any

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..api.errors import ApiError
from ..domain import DocumentType, OcrStatus
from ..models import Document, DocumentScan, Item
from . import storage
from .document_ocr import enqueue_ocr


def document_load_options() -> list:
    return [
        selectinload(Document.items),
        selectinload(Document.scan).selectinload(DocumentScan.pages),
    ]


def get_document(db: Session, household_id: uuid.UUID, document_id: uuid.UUID) -> Document:
    document = db.scalar(
        select(Document)
        .options(*document_load_options())
        .execution_options(populate_existing=True)
        .where(Document.id == document_id, Document.household_id == household_id)
    )
    if document is None:
        raise ApiError(404, "document_not_found", "Document not found.")
    return document


def resolve_document_items(
    db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]
) -> list[Item]:
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        return []
    items = list(
        db.scalars(
            select(Item).where(Item.household_id == household_id, Item.id.in_(unique_ids))
        ).all()
    )
    if len(items) != len(unique_ids):
        raise ApiError(422, "item_not_found", "One or more selected items do not exist.")
    return items


def create_document(
    db: Session,
    household_id: uuid.UUID,
    upload: UploadFile,
    *,
    title: str | None,
    document_type: DocumentType,
    item_ids: list[uuid.UUID],
    merchant: str | None,
    document_date,
    notes: str | None,
    metadata: dict[str, Any] | None = None,
) -> Document:  # noqa: ANN001
    clean_title = (title or "").strip()
    if len(clean_title) > 200:
        raise ApiError(422, "invalid_title", "Document titles must be 200 characters or fewer.")
    if not clean_title:
        clean_title = (upload.filename or "Document").rsplit(".", 1)[0][:200] or "Document"

    items = resolve_document_items(db, household_id, item_ids)
    stored = storage.store_document(household_id, upload)
    content_sha256 = storage.file_sha256(stored.original_storage_key)
    extracted_metadata = dict(metadata or {})
    duplicates = list(
        db.scalars(
            select(Document)
            .where(
                Document.household_id == household_id,
                Document.content_sha256 == content_sha256,
            )
            .order_by(Document.created_at.desc())
            .limit(10)
        ).all()
    )
    if duplicates:
        extracted_metadata["duplicate_documents"] = [
            {"id": str(duplicate.id), "title": duplicate.title} for duplicate in duplicates
        ]
    document = Document(
        household_id=household_id,
        storage_key=stored.storage_key,
        original_storage_key=stored.original_storage_key,
        content_sha256=content_sha256,
        original_filename=stored.original_filename,
        content_type=stored.content_type,
        original_content_type=stored.original_content_type,
        byte_size=stored.byte_size,
        original_byte_size=stored.original_byte_size,
        title=clean_title,
        document_type=document_type.value,
        document_date=document_date,
        merchant=merchant,
        notes=notes,
        extracted_metadata=extracted_metadata,
        ocr_status=OcrStatus.NOT_REQUESTED.value,
    )
    document.items = items
    db.add(document)
    try:
        db.flush()
        enqueue_ocr(db, document, commit=False)
        db.commit()
    except Exception:
        db.rollback()
        storage.delete_key(stored.storage_key)
        storage.delete_key(stored.original_storage_key)
        raise
    return get_document(db, household_id, document.id)


def delete_document(db: Session, document: Document) -> None:
    keys = [document.storage_key, document.original_storage_key]
    if document.scan is not None:
        keys.extend(
            key
            for page in document.scan.pages
            for key in (page.original_storage_key, page.cleaned_storage_key)
        )
        db.delete(document.scan)
    db.delete(document)
    db.commit()
    for key in keys:
        storage.delete_key(key)
