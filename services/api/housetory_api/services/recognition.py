"""AI item recognition with a deterministic OCR fallback."""

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from ..config import get_settings
from ..db import SessionLocal
from ..domain import AiTask, RecognitionStatus
from ..jobs import enqueue
from ..models import AiRecognition, Category, RecognitionItemLink, Tag
from ..schemas.ai import (
    AiRecognitionApplyRequest,
    AiRecognitionApplyResult,
    AiRecognitionDuplicateGroup,
    AiRecognitionOut,
    AiRecognitionResult,
    AiRecognitionSuggestion,
)
from ..schemas.imports import ProposedItem
from ..schemas.items import ItemCreate, ItemUpdate
from . import ai, storage
from .import_matching import find_duplicates
from .items import create_item_record, get_item, resolve_location, update_item_record
from .ocr import extract_text, parse_receipt

logger = logging.getLogger("housetory.recognition")

RECOGNITION_TASK = "ai.recognize"

AI_RECOGNITION_SYSTEM = """Identify clearly visible, movable household possessions in the image.
Return JSON exactly shaped as:
{"suggestions":[{"name":"...","quantity":1,"description":null,"category":null,"brand":null,
"model":null,"tags":[],"notes":null,"confidence":0,"review":false,"review_reason":null,
"field_sources":{"name":"inferred"}}],"warnings":[]}
Focus on things a person could pack, carry, store or move. Do not present fixed
architectural features or installed fixtures as possessions: exclude windows,
walls, doors, floors, ceilings, built-in cabinets, sinks, toilets, baths, showers,
fireplaces, light fixtures, smoke detectors, thermostats and HVAC equipment.
A portable heater or fan may be movable; a built-in radiator usually is not.
If mobility is genuinely ambiguous, keep the observation only with confidence below
40, set review=true, and explain why in review_reason. Do not invent items to fill
the frame. Never create one suggestion per identical object if a quantity is clearer.
Only claim a brand or model when visibly identifiable. Never invent or read a
serial number unless it is clearly legible. Never infer purchase price or date.
Return at most 20 suggestions, best first. Confidence is 0-100."""


FIXED_FEATURE_TERMS = {
    "window": "Windows are fixed architectural features, not movable possessions.",
    "wall": "Walls are fixed architectural features, not movable possessions.",
    "door": "Doors are fixed architectural features, not movable possessions.",
    "floor": "Floors are fixed architectural features, not movable possessions.",
    "ceiling": "Ceilings are fixed architectural features, not movable possessions.",
    "radiator": (
        "Radiators are usually installed fixtures. Verify whether this is a fixed "
        "radiator or a portable heater before creating an item."
    ),
    "built-in": "Built-in fixtures are not movable possessions.",
    "built in": "Built-in fixtures are not movable possessions.",
    "fixture": "Installed fixtures are not movable possessions.",
    "sink": "Sinks are installed fixtures, not movable possessions.",
    "toilet": "Toilets are installed fixtures, not movable possessions.",
    "bathtub": "Bathtubs are installed fixtures, not movable possessions.",
    "shower": "Showers are installed fixtures, not movable possessions.",
    "fireplace": "Fireplaces are fixed architectural features, not movable possessions.",
    "staircase": "Staircases are fixed architectural features, not movable possessions.",
    "stairs": "Stairs are fixed architectural features, not movable possessions.",
    "light fixture": "Light fixtures are installed fixtures, not movable possessions.",
    "ceiling light": "Ceiling lights are installed fixtures, not movable possessions.",
    "smoke detector": "Smoke detectors are installed fixtures, not movable possessions.",
    "thermostat": "Thermostats are installed fixtures, not movable possessions.",
    "hvac": "HVAC equipment is installed and is not a movable possession.",
    "boiler": "Boilers are installed appliances, not movable possessions.",
}


def _review_fixed_features(suggestions: list[AiRecognitionSuggestion]) -> None:
    for suggestion in suggestions:
        if suggestion.source != "vision":
            continue
        name = suggestion.name.lower()
        for term, reason in FIXED_FEATURE_TERMS.items():
            if re.search(rf"(?<![a-z]){re.escape(term)}s?(?![a-z])", name):
                suggestion.review = True
                if not suggestion.review_reason:
                    suggestion.review_reason = reason
                break
        if suggestion.review and not suggestion.review_reason:
            suggestion.review_reason = "Verify that this is a movable possession."
        if (
            not suggestion.review
            and suggestion.confidence is not None
            and suggestion.confidence < 40
        ):
            suggestion.review = True
            suggestion.review_reason = "Low-confidence suggestion; verify before creating."


def _processing_path(recognition: AiRecognition) -> str:
    if recognition.status == RecognitionStatus.FAILED.value:
        return "failed"
    if recognition.status != RecognitionStatus.SUCCEEDED.value:
        return "unavailable"
    suggestions = (recognition.result or {}).get("suggestions") or []
    if not suggestions:
        return "none"
    if any(str(suggestion.get("source")) == "vision" for suggestion in suggestions):
        return "vision"
    if any(str(suggestion.get("source")) == "ocr" for suggestion in suggestions):
        return "ocr"
    return "none"


def enqueue_recognition(db, recognition: AiRecognition) -> Any:
    recognition.status = RecognitionStatus.QUEUED.value
    recognition.error = None
    job = enqueue(
        db,
        RECOGNITION_TASK,
        {"recognition_id": str(recognition.id)},
        commit=False,
        max_attempts=3,
        priority=4,
    )
    db.commit()
    return job


def serialize_recognition(
    recognition: AiRecognition,
    db=None,
    household_id=None,
) -> AiRecognitionOut:
    prefix = get_settings().api_prefix
    location_label = None
    if recognition.location_id is not None and db is not None:
        from ..models import StorageLocation

        location = db.get(StorageLocation, recognition.location_id)
        if location is not None:
            location_label = location.identifier or location.name
    duplicates: list[AiRecognitionDuplicateGroup] = []
    result = recognition.result or {}
    suggestions = result.get("suggestions") or []
    if db is not None and household_id is not None:
        for index, suggestion in enumerate(suggestions):
            try:
                proposed = ProposedItem(
                    name=str(suggestion.get("name") or "Item"),
                    description=suggestion.get("description"),
                    quantity=int(suggestion.get("quantity") or 1),
                    brand=suggestion.get("brand"),
                    model=suggestion.get("model"),
                    serial_number=None,
                )
                candidates = find_duplicates(db, household_id, proposed)
            except (ValueError, TypeError):
                candidates = []
            if candidates:
                duplicates.append(
                    AiRecognitionDuplicateGroup(
                        suggestion_index=index,
                        candidates=[candidate.model_dump(mode="json") for candidate in candidates],
                    )
                )
    return AiRecognitionOut(
        id=recognition.id,
        status=recognition.status,
        original_filename=recognition.original_filename,
        content_type=recognition.content_type,
        width=recognition.width,
        height=recognition.height,
        result=recognition.result or {},
        field_sources=recognition.field_sources or {},
        confidence=recognition.confidence,
        error=recognition.error,
        model_provider=recognition.model_provider,
        model_name=recognition.model_name,
        room_id=recognition.room_id,
        location_id=recognition.location_id,
        location_label=location_label,
        suggestion_duplicates=duplicates,
        processing_mode=recognition.processing_mode or "unavailable",
        processing_path=_processing_path(recognition),
        applied_at=recognition.applied_at,
        applied_items=recognition.applied_items or [],
        created_at=recognition.created_at,
        completed_at=recognition.completed_at,
        image_url=f"{prefix}/ai/recognitions/{recognition.id}/image",
        original_url=f"{prefix}/ai/recognitions/{recognition.id}/original",
    )


def _fallback_from_ocr(path, content_type: str) -> tuple[AiRecognitionResult, int | None]:
    extracted = extract_text(path, content_type)
    text = extracted.text.strip()
    if not text:
        raise ai.AiUnavailable(
            "No AI model is available and no readable text was found in the image."
        )
    parsed = parse_receipt(text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    product_names = [str(name) for name in parsed.get("product_names") or [] if str(name).strip()]
    name = product_names[0] if product_names else None
    if not name:
        for line in lines[:10]:
            candidate = re.sub(r"[^A-Za-z0-9&.' -]", "", line).strip()
            if len(candidate) >= 3 and re.search(r"[A-Za-z]{2,}", candidate):
                name = candidate[:200]
                break
    if not name:
        raise ai.AiUnavailable("No readable product name was found in the image.")
    description = text[:1000] if len(text) > len(name) else None
    suggestion = AiRecognitionSuggestion(
        name=name[:200],
        description=description,
        category=None,
        brand=parsed.get("brand"),
        model=parsed.get("model"),
        tags=[],
        notes="Generated from readable text because an AI vision model was not available.",
        confidence=extracted.confidence,
        source="ocr",
        field_sources={
            "name": "inferred",
            **({"brand": "explicit"} if parsed.get("brand") else {}),
            **({"model": "explicit"} if parsed.get("model") else {}),
        },
    )
    return AiRecognitionResult(
        suggestions=[suggestion],
        warnings=["AI unavailable; OCR text was used for suggestions."],
    ), extracted.confidence


def run_recognition(recognition_id: uuid.UUID | str) -> dict[str, Any] | None:
    with SessionLocal() as db:
        recognition = db.get(AiRecognition, recognition_id)
        if recognition is None:
            return None
        if recognition.status == RecognitionStatus.SUCCEEDED.value:
            return {"recognition_id": str(recognition.id), "skipped": True}
        recognition.status = RecognitionStatus.PROCESSING.value
        recognition.error = None
        recognition.model_provider = None
        recognition.model_name = None
        recognition.processing_mode = "unavailable"
        db.commit()
        source_path = None
        try:
            source_path = storage.resolve_key(
                recognition.original_storage_key or recognition.storage_key
            )
            status = ai.status_for(db, recognition.household_id, AiTask.VISION.value, probe=False)
            if status.configured:
                recognition.model_provider = status.provider
                recognition.model_name = status.model
            result = None
            confidence = None
            vision_error = None
            vision_succeeded = False
            if status.configured:
                try:
                    raw = ai.complete_json(
                        AI_RECOGNITION_SYSTEM,
                        "Identify clearly visible, movable household possessions in this "
                        "image. Return only the requested JSON.",
                        image_path=source_path,
                        image_mime=recognition.original_content_type,
                        config=ai.config_for(db, recognition.household_id, AiTask.VISION.value),
                    )
                    result = AiRecognitionResult.model_validate(raw)
                    vision_succeeded = True
                    _review_fixed_features(result.suggestions)
                    confidence = result.suggestions[0].confidence if result.suggestions else None
                    if not result.suggestions:
                        result.warnings.append(
                            "The vision model returned no suggestions. No inventory was created."
                        )
                except (ai.AiError, ValueError) as exc:
                    vision_error = (
                        f"AI vision via {status.provider}/{status.model} failed; "
                        "OCR text was used instead."
                    )
                    logger.info(
                        "Recognition %s falling back to OCR (%s)",
                        recognition_id,
                        type(exc).__name__,
                    )
            processing_mode = status.mode if vision_succeeded else "deterministic"
            if result is None:
                try:
                    result, confidence = _fallback_from_ocr(
                        source_path, recognition.original_content_type
                    )
                except ai.AiUnavailable as exc:
                    reasons = [reason for reason in (status.error, vision_error) if reason]
                    message = " ".join([*reasons, str(exc)]).strip()
                    raise ai.AiUnavailable(message) from exc
                if status.error:
                    result.warnings.append(status.error)
                if vision_error:
                    result.warnings.append(vision_error)
            recognition.result = result.model_dump(mode="json")
            recognition.field_sources = (
                result.suggestions[0].field_sources if result.suggestions else {}
            )
            recognition.confidence = confidence
            recognition.status = RecognitionStatus.SUCCEEDED.value
            recognition.processing_mode = processing_mode
            recognition.completed_at = datetime.now(UTC)
            recognition.error = None
            db.commit()
            return {"recognition_id": str(recognition.id), "suggestions": len(result.suggestions)}
        except Exception as exc:  # noqa: BLE001 - persisted for retry
            db.rollback()
            recognition = db.get(AiRecognition, recognition_id)
            logger.error("Recognition %s failed (%s)", recognition_id, type(exc).__name__)
            if recognition is not None:
                recognition.status = RecognitionStatus.FAILED.value
                recognition.error = (
                    str(exc)
                    if isinstance(exc, ai.AiUnavailable)
                    else "Image recognition failed. Try another photo or configure AI."
                )[:2000]
                recognition.completed_at = datetime.now(UTC)
                db.commit()
            return {"recognition_id": str(recognition_id), "failed": True}


def _resolve_category_id(db, household_id, name: str | None) -> uuid.UUID | None:
    if not name:
        return None
    normalized = name.strip()
    if not normalized:
        return None
    category = db.scalar(
        select(Category).where(
            Category.household_id == household_id,
            func.lower(Category.name) == normalized.lower(),
        )
    )
    if category is None:
        category = Category(household_id=household_id, name=normalized[:80])
        db.add(category)
        db.flush()
    return category.id


def _resolve_tag_ids(db, household_id, names: list[str]) -> list[uuid.UUID]:
    ids: list[uuid.UUID] = []
    for raw in names:
        name = raw.strip().lstrip("#")[:60]
        if not name:
            continue
        tag = db.scalar(
            select(Tag).where(
                Tag.household_id == household_id, func.lower(Tag.name) == name.lower()
            )
        )
        if tag is None:
            tag = Tag(household_id=household_id, name=name)
            db.add(tag)
            db.flush()
        ids.append(tag.id)
    return list(dict.fromkeys(ids))


def apply_recognition(
    db,
    household_id: uuid.UUID,
    recognition: AiRecognition,
    payload: AiRecognitionApplyRequest,
) -> AiRecognitionApplyResult:
    if recognition.status != RecognitionStatus.SUCCEEDED.value:
        raise ValueError("This recognition is not ready to apply.")
    suggestions = (recognition.result or {}).get("suggestions") or []
    applied = list(recognition.applied_items or [])
    applied_by_key = {
        str(entry.get("entry_key") or entry.get("suggestion_index")): entry
        for entry in applied
        if isinstance(entry, dict) and entry.get("suggestion_index") is not None
    }
    created = updated = rejected = skipped = failed = 0
    failures: list[dict[str, Any]] = []
    for entry in payload.entries:
        if entry.suggestion_index >= len(suggestions):
            failures.append(
                {"suggestion_index": entry.suggestion_index, "message": "Suggestion not found."}
            )
            failed += 1
            continue
        entry_key = entry.entry_key or str(entry.suggestion_index)
        if entry.action == "reject":
            rejected += 1
            continue
        existing = applied_by_key.get(entry_key)
        if existing and entry.action == "create":
            skipped += 1
            continue
        raw = (
            entry.proposal
            or AiRecognitionSuggestion.model_validate(suggestions[entry.suggestion_index])
        ).model_dump(mode="json")
        quantity = max(1, int(raw.get("quantity") or 1))
        category_id = entry.category_id or _resolve_category_id(
            db, household_id, raw.get("category")
        )
        tag_ids = _resolve_tag_ids(db, household_id, raw.get("tags") or [])
        requested_room_id = (
            entry.room_id if "room_id" in entry.model_fields_set else recognition.room_id
        )
        requested_location_id = (
            entry.location_id
            if "location_id" in entry.model_fields_set
            else recognition.location_id
        )
        savepoint = db.begin_nested()
        try:
            room_id, location_record = resolve_location(
                db, household_id, requested_room_id, requested_location_id
            )
            location_id = location_record.id if location_record is not None else None
            if entry.action == "update":
                if not entry.item_id:
                    raise ValueError("Choose an existing item to update.")
                item = get_item(db, household_id, entry.item_id)
                update_item_record(
                    db,
                    household_id,
                    item,
                    ItemUpdate(
                        name=raw.get("name"),
                        description=raw.get("description"),
                        brand=raw.get("brand"),
                        model=raw.get("model"),
                        quantity=quantity,
                        category_id=category_id,
                        room_id=room_id,
                        storage_location_id=location_id,
                        tag_ids=tag_ids,
                    ),
                )
                updated += 1
            else:
                proposed = ProposedItem(
                    name=str(raw.get("name") or "Item"),
                    description=raw.get("description"),
                    quantity=quantity,
                    brand=raw.get("brand"),
                    model=raw.get("model"),
                    serial_number=None,
                )
                candidates = find_duplicates(db, household_id, proposed)
                strong = [candidate for candidate in candidates if candidate.score >= 55]
                if strong and not entry.allow_duplicate:
                    raise ValueError(
                        "A possible duplicate was found. Choose update, allow a new item, "
                        "or reject this suggestion."
                    )
                item = create_item_record(
                    db,
                    household_id,
                    ItemCreate(
                        name=str(raw.get("name") or "Item"),
                        description=raw.get("description"),
                        brand=raw.get("brand"),
                        model=raw.get("model"),
                        quantity=quantity,
                        room_id=room_id,
                        storage_location_id=location_id,
                        category_id=category_id,
                        tag_ids=tag_ids,
                    ),
                )
                created += 1
            link = db.scalar(
                select(RecognitionItemLink).where(
                    RecognitionItemLink.recognition_id == recognition.id,
                    RecognitionItemLink.item_id == item.id,
                )
            )
            if link is None:
                db.add(
                    RecognitionItemLink(
                        recognition_id=recognition.id,
                        item_id=item.id,
                        suggestion_index=entry.suggestion_index,
                    )
                )
            applied_by_key[entry_key] = {
                "suggestion_index": entry.suggestion_index,
                "entry_key": entry_key,
                "item_id": str(item.id),
                "name": item.name,
                "action": entry.action,
            }
            savepoint.commit()
        except Exception as exc:  # noqa: BLE001 - one suggestion must not lose the batch
            savepoint.rollback()
            failed += 1
            message = str(exc)
            if not message or "Check the source" in message:
                message = "Could not apply this suggestion."
            failures.append({"suggestion_index": entry.suggestion_index, "message": message[:500]})
    db.flush()
    recognition.applied_items = [
        applied_by_key[key]
        for key in sorted(
            applied_by_key,
            key=lambda value: (
                int(applied_by_key[value].get("suggestion_index") or 0),
                value,
            ),
        )
    ]
    if failed == 0:
        recognition.applied_at = datetime.now(UTC)
    db.commit()
    return AiRecognitionApplyResult(
        recognition=serialize_recognition(recognition, db, household_id),
        created=created,
        updated=updated,
        rejected=rejected,
        skipped=skipped,
        failed=failed,
        failures=failures,
    )


def run_job(payload: dict[str, Any]) -> dict[str, Any] | None:
    recognition_id = payload.get("recognition_id")
    if not recognition_id:
        raise ValueError("Recognition job payload is missing recognition_id.")
    return run_recognition(recognition_id)
