"""Background OCR orchestration for documents.

The job only updates the document's OCR metadata. Inventory records are changed
exclusively through the explicit review/apply endpoint.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..domain import OcrStatus
from ..jobs import enqueue
from ..models import Document
from . import storage
from .ocr import OcrError, extract_text, parse_receipt

logger = logging.getLogger("housetory.ocr")

OCR_TASK = "documents.ocr"


def enqueue_ocr(db: Session, document: Document, *, commit: bool = True) -> Any:
    document.ocr_status = OcrStatus.QUEUED.value
    document.ocr_error = None
    document.ocr_processed_at = None
    job = enqueue(
        db,
        OCR_TASK,
        {"document_id": str(document.id)},
        commit=False,
        max_attempts=3,
        priority=5,
    )
    if commit:
        db.commit()
    return job


def _apply_result(
    document: Document,
    *,
    text: str,
    metadata: dict[str, Any],
    confidence: int | None,
) -> None:
    document.extracted_text = text[:200_000]
    document.extracted_metadata = metadata
    document.ocr_confidence = confidence
    document.ocr_status = OcrStatus.SUCCEEDED.value
    document.ocr_error = None
    document.ocr_processed_at = datetime.now(UTC)
    if not document.merchant and metadata.get("merchant"):
        document.merchant = str(metadata["merchant"])[:160]
    if document.document_date is None and metadata.get("purchase_date"):
        try:
            from datetime import date

            document.document_date = date.fromisoformat(str(metadata["purchase_date"]))
        except ValueError:
            pass


def run_document_ocr(
    document_id: Any,
    *,
    extractor=None,
    parser=None,
    force: bool = False,
) -> dict[str, Any] | None:
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        if document is None:
            return None
        if document.ocr_status == OcrStatus.SUCCEEDED.value and not force:
            return {"document_id": str(document.id), "skipped": True}

        document.ocr_status = OcrStatus.PROCESSING.value
        document.ocr_error = None
        db.commit()

        try:
            key = document.original_storage_key or document.storage_key
            path = storage.resolve_key(key)
            content_type = document.original_content_type or document.content_type
            extracted = (extractor or extract_text)(path, content_type)
            metadata = (parser or parse_receipt)(extracted.text)
            metadata["source"] = extracted.source
            metadata["confidence"] = extracted.confidence
            _apply_result(
                document,
                text=extracted.text,
                metadata=metadata,
                confidence=extracted.confidence,
            )
            db.commit()
            return {
                "document_id": str(document.id),
                "source": extracted.source,
                "characters": len(extracted.text),
            }
        except Exception as exc:  # noqa: BLE001 - persisted for the review screen
            logger.exception("OCR failed for document %s", document_id)
            db.rollback()
            document = db.get(Document, document_id)
            if document is not None:
                document.ocr_status = OcrStatus.FAILED.value
                document.ocr_error = f"{type(exc).__name__}: {exc}"[:2000]
                document.ocr_processed_at = datetime.now(UTC)
                db.commit()
            raise OcrError(f"{type(exc).__name__}: {exc}") from exc


def run_job(payload: dict[str, Any]) -> dict[str, Any] | None:
    document_id = payload.get("document_id")
    if not document_id:
        raise ValueError("OCR job payload is missing document_id.")
    return run_document_ocr(document_id)
