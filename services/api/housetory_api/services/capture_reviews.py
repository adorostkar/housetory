"""Expose unfinished captures through the existing authorized Review queue."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from ..api.errors import ApiError
from ..models import AiRecognition, Document, ImportBatch
from ..schemas.inventory_review import CaptureReviewOut


def capture_metadata(source: ImportBatch | Document | AiRecognition) -> dict:
    if isinstance(source, ImportBatch):
        return dict(source.metadata_json or {})
    if isinstance(source, Document):
        return dict(source.extracted_metadata or {})
    return dict((source.result or {}).get("_add_items") or {})


def store_capture_metadata(source: ImportBatch | Document | AiRecognition, metadata: dict) -> None:
    if isinstance(source, ImportBatch):
        source.metadata_json = metadata
    elif isinstance(source, Document):
        source.extracted_metadata = metadata
    else:
        source.result = {**(source.result or {}), "_add_items": metadata}


def reset_review_dismissal(source: ImportBatch | Document | AiRecognition) -> None:
    metadata = capture_metadata(source)
    metadata.pop("review_dismissed", None)
    metadata.pop("review_notification_suppressed", None)
    store_capture_metadata(source, metadata)


def _review(source: ImportBatch | Document | AiRecognition) -> CaptureReviewOut:
    metadata = capture_metadata(source)
    marker = metadata.get("review_dismissed")
    retry = None
    if isinstance(source, ImportBatch):
        kind, title, status = "import", source.title, source.status
        enhancement = metadata.get("enhancement") or {}
        generation = enhancement.get("job_id") or metadata.get("processing_attempt")
        if status == "failed":
            retry = "processing"
        elif (
            status == "review"
            and enhancement.get("status") in {"failed", "skipped"}
            and metadata.get("_enhancement_snapshot")
        ):
            retry = "enhancement"
    elif isinstance(source, Document):
        kind, title = "document", source.title
        processing = metadata.get("processing") or {}
        status = str(processing.get("stage") or source.ocr_status)
        generation = processing.get("correlation_id") or source.source_generation
        if status in {"failed", "cancelled", "needs_attention"} and processing.get("can_retry"):
            retry = "processing"
    else:
        kind, title, status = "photo", source.original_filename, source.status
        generation = metadata.get("processing_attempt")
        if status in {"failed", "cancelled"}:
            retry = "processing"
    return CaptureReviewOut(
        id=source.id,
        kind=kind,
        title=title,
        status=status,
        generation=str(generation or source.id),
        dismissal_id=marker.get("id") if isinstance(marker, dict) else None,
        notify=not bool(metadata.get("review_notification_suppressed")),
        retry=retry,
    )


def pending_captures(
    db: Session, household_id: uuid.UUID, *, dismissed: bool = False
) -> list[CaptureReviewOut]:
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
        if bool(metadata.get("review_dismissed")) != dismissed:
            continue
        captures.append(_review(batch))
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
        if metadata.get("applied_at") or bool(metadata.get("review_dismissed")) != dismissed:
            continue
        captures.append(_review(document))
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
        if (
            not context.get("assistant_capture")
            or context.get("import_batch_id")
            or bool(context.get("review_dismissed")) != dismissed
        ):
            continue
        captures.append(_review(photo))
    return captures


def change_capture_review(
    db: Session,
    household_id: uuid.UUID,
    kind: str,
    capture_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID,
    generation: str | None = None,
    dismissal_id: uuid.UUID | None = None,
    undo: bool = False,
) -> CaptureReviewOut:
    model = {"import": ImportBatch, "document": Document, "photo": AiRecognition}[kind]
    source = db.scalar(
        select(model)
        .where(model.id == capture_id, model.household_id == household_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if source is None:
        raise ApiError(404, "capture_not_found", "Capture not found.")
    metadata = capture_metadata(source)
    if (
        (isinstance(source, ImportBatch) and source.status == "completed")
        or (isinstance(source, Document) and metadata.get("applied_at"))
        or (
            isinstance(source, AiRecognition)
            and (source.applied_at or metadata.get("import_batch_id"))
        )
    ):
        raise ApiError(
            409, "capture_resolved", "This capture is no longer pending. Refresh reviews."
        )
    marker = metadata.get("review_dismissed")
    review = _review(source)
    if undo:
        current_id = marker.get("id") if isinstance(marker, dict) else None
        if not marker or current_id != (str(dismissal_id) if dismissal_id else None):
            raise ApiError(409, "dismissal_changed", "This dismissal changed. Refresh reviews.")
        metadata.pop("review_dismissed")
    else:
        if generation != review.generation:
            raise ApiError(
                409, "capture_changed", "A new capture attempt started. Refresh reviews."
            )
        if not marker:
            metadata["review_dismissed"] = {
                "id": str(uuid.uuid4()),
                "generation": review.generation,
                "at": datetime.now(UTC).isoformat(),
                "actor_user_id": str(actor_user_id),
            }
        # Undo restores the review, not a second completion notification.
        metadata["review_notification_suppressed"] = True
    store_capture_metadata(source, metadata)
    db.commit()
    return _review(source)
