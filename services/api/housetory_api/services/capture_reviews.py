"""Expose unfinished captures through the existing authorized Review queue."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from ..models import AiRecognition, Document, ImportBatch
from ..schemas.inventory_review import CaptureReviewOut


def pending_captures(db: Session, household_id: uuid.UUID) -> list[CaptureReviewOut]:
    captures = []
    batches = db.scalars(
        select(ImportBatch)
        .where(
            ImportBatch.household_id == household_id,
            ImportBatch.status != "completed",
        )
        .order_by(ImportBatch.created_at)
    )
    for batch in batches:
        metadata = batch.metadata_json or {}
        if metadata.get("review_dismissed"):
            continue
        enhancement = metadata.get("enhancement") or {}
        captures.append(
            CaptureReviewOut(
                id=batch.id,
                kind="import",
                title=batch.title,
                status=batch.status,
                generation=str(
                    enhancement.get("job_id") or metadata.get("processing_attempt") or batch.id
                ),
            )
        )
    documents = db.scalars(
        select(Document)
        .options(defer(Document.extracted_text))
        .where(
            Document.household_id == household_id,
            Document.extracted_metadata["assistant_capture"].as_boolean() == True,  # noqa: E712
        )
        .order_by(Document.created_at)
    )
    for document in documents:
        metadata = document.extracted_metadata or {}
        if metadata.get("applied_at") or metadata.get("review_dismissed"):
            continue
        processing = metadata.get("processing") or {}
        captures.append(
            CaptureReviewOut(
                id=document.id,
                kind="document",
                title=document.title,
                status=str(processing.get("stage") or document.ocr_status),
                generation=str(processing.get("correlation_id") or document.source_generation),
            )
        )
    photos = db.scalars(
        select(AiRecognition)
        .where(
            AiRecognition.household_id == household_id,
            AiRecognition.applied_at.is_(None),
        )
        .order_by(AiRecognition.created_at)
    )
    for photo in photos:
        context = (photo.result or {}).get("_add_items") or {}
        if not context.get("assistant_capture") or context.get("import_batch_id"):
            continue
        captures.append(
            CaptureReviewOut(
                id=photo.id,
                kind="photo",
                title=photo.original_filename,
                status=photo.status,
                generation=str(context.get("processing_attempt") or photo.id),
            )
        )
    return captures
