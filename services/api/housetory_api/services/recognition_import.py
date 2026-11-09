"""Adapt successful photo recognitions into the ordinary import review."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import ImportSourceType, ImportStatus, RecognitionStatus
from ..models import AiRecognition, ImportBatch, ImportEntry, Room, StorageLocation
from .import_matching import build_index, find_duplicates
from .import_parse import ProposalDraft
from .import_pipeline import _apply_context_destination, _context_property, to_proposed_item


def create_batch_from_recognition(
    db: Session,
    household_id: uuid.UUID,
    recognition_id: uuid.UUID,
) -> ImportBatch:
    recognition = db.scalar(
        select(AiRecognition)
        .where(
            AiRecognition.id == recognition_id,
            AiRecognition.household_id == household_id,
        )
        .with_for_update()
    )
    if recognition is None:
        raise ApiError(404, "recognition_not_found", "Recognition not found.")
    add_items = (recognition.result or {}).get("_add_items") or {}
    existing_id = add_items.get("import_batch_id")
    if existing_id:
        existing = db.scalar(
            select(ImportBatch).where(
                ImportBatch.id == uuid.UUID(str(existing_id)),
                ImportBatch.household_id == household_id,
            )
        )
        if existing is not None:
            return existing
    if recognition.status != RecognitionStatus.SUCCEEDED.value:
        raise ApiError(
            409,
            "recognition_not_ready",
            "Wait for image recognition to finish before creating the import review.",
        )

    room = db.get(Room, recognition.room_id) if recognition.room_id else None
    location = (
        db.get(StorageLocation, recognition.location_id) if recognition.location_id else None
    )
    property_record = room.property if room is not None else None
    context: dict[str, str] = {}
    property_id = add_items.get("property_id") or (
        str(property_record.id) if property_record is not None else None
    )
    if property_id:
        context["property_id"] = str(property_id)
        if property_record is not None:
            context["property_name"] = property_record.name
    if room is not None:
        context.update({"room_id": str(room.id), "room_name": room.name})
    if location is not None:
        context.update(
            {
                "location_id": str(location.id),
                "location_name": location.name,
                "location_identifier": location.identifier or "",
            }
        )

    suggestions = list((recognition.result or {}).get("suggestions") or [])
    batch = ImportBatch(
        household_id=household_id,
        title=f"Photo review: {recognition.original_filename}"[:200],
        source_type=ImportSourceType.IMAGE.value,
        status=ImportStatus.REVIEW.value,
        original_filename=recognition.original_filename,
        content_type=recognition.content_type,
        byte_size=recognition.byte_size,
        total_entries=len(suggestions),
        imported_entries=0,
        skipped_entries=0,
        failed_entries=0,
        warnings=[
            {"type": "recognition_warning", "message": str(message)[:500]}
            for message in (recognition.result or {}).get("warnings") or []
        ],
        metadata_json={
            "context": context,
            "hierarchy": False,
            "recognition_id": str(recognition.id),
        },
    )
    db.add(batch)
    db.flush()
    index = build_index(db, household_id, _context_property(db, batch).id)
    context_text = str(add_items.get("text") or "").strip()

    for position, suggestion in enumerate(suggestions):
        review_reason = suggestion.get("review_reason")
        relationships = dict(suggestion.get("relationships") or {})
        relationships.update(
            {
                "review": bool(suggestion.get("review")),
                "review_reason": review_reason,
            }
        )
        draft = ProposalDraft(
            name=str(suggestion.get("name") or "Item")[:200],
            description=suggestion.get("description"),
            quantity=max(0, int(suggestion.get("quantity") or 1)),
            category_text=suggestion.get("category"),
            brand=suggestion.get("brand"),
            model=suggestion.get("model"),
            tags=list(suggestion.get("tags") or []),
            notes=suggestion.get("notes"),
            relationships=relationships,
            field_sources=dict(suggestion.get("field_sources") or {}),
            confidence=suggestion.get("confidence"),
            source_path=recognition.original_filename,
            source_excerpt=context_text or review_reason,
            note_title="AI photo recognition",
        )
        proposed = to_proposed_item(draft, index)
        proposed = _apply_context_destination(db, batch, proposed)
        duplicates = find_duplicates(db, household_id, proposed)
        db.add(
            ImportEntry(
                batch_id=batch.id,
                source_path=draft.source_path,
                source_excerpt=draft.source_excerpt,
                note_title=draft.note_title,
                proposed=proposed.model_dump(mode="json"),
                field_sources=proposed.field_sources,
                confidence=proposed.confidence,
                duplicate_candidates=[
                    candidate.model_dump(mode="json") for candidate in duplicates
                ],
                position=position,
            )
        )

    recognition.result = {
        **(recognition.result or {}),
        "_add_items": {**add_items, "import_batch_id": str(batch.id)},
    }
    db.commit()
    return batch


__all__ = ["create_batch_from_recognition"]
