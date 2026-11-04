"""AI item recognition with a deterministic OCR fallback."""

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from ..config import get_settings
from ..db import SessionLocal
from ..domain import RecognitionStatus
from ..jobs import enqueue
from ..models import AiRecognition
from ..schemas.ai import AiRecognitionOut, AiRecognitionResult, AiRecognitionSuggestion
from . import ai, storage
from .ocr import extract_text, parse_receipt

logger = logging.getLogger("housetory.recognition")

RECOGNITION_TASK = "ai.recognize"

AI_RECOGNITION_SYSTEM = """Identify the main household possession in the image.
Return JSON exactly shaped as:
{"suggestions":[{"name":"...","description":null,"category":null,"brand":null,
"model":null,"tags":[],"notes":null,"confidence":0,
"field_sources":{"name":"inferred"}}],"warnings":[]}
Only claim a brand or model when visibly identifiable. Never invent or read a
serial number unless it is clearly legible. Never infer purchase price or date.
Return at most 3 suggestions, best first. Confidence is 0-100."""


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


def serialize_recognition(recognition: AiRecognition) -> AiRecognitionOut:
    prefix = get_settings().api_prefix
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
        db.commit()
        source_path = None
        try:
            source_path = storage.resolve_key(
                recognition.original_storage_key or recognition.storage_key
            )
            status = ai.provider_status(probe=False)
            recognition.model_provider = status.provider
            recognition.model_name = status.model
            result = None
            confidence = None
            ai_error = None
            if status.configured:
                try:
                    raw = ai.complete_json(
                        AI_RECOGNITION_SYSTEM,
                        "Identify the main household possession in this image. "
                        "Return only the requested JSON.",
                        image_path=source_path,
                        image_mime=recognition.original_content_type,
                    )
                    result = AiRecognitionResult.model_validate(raw)
                    confidence = result.suggestions[0].confidence if result.suggestions else None
                except (ai.AiError, ValueError) as exc:
                    ai_error = "AI vision was unavailable or returned invalid data."
                    logger.info(
                        "Recognition %s falling back to OCR (%s)",
                        recognition_id,
                        type(exc).__name__,
                    )
            if result is None:
                result, confidence = _fallback_from_ocr(
                    source_path, recognition.original_content_type
                )
                if ai_error:
                    result.warnings.append(ai_error)
            recognition.result = result.model_dump(mode="json")
            recognition.field_sources = (
                result.suggestions[0].field_sources if result.suggestions else {}
            )
            recognition.confidence = confidence
            recognition.status = RecognitionStatus.SUCCEEDED.value
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


def run_job(payload: dict[str, Any]) -> dict[str, Any] | None:
    recognition_id = payload.get("recognition_id")
    if not recognition_id:
        raise ValueError("Recognition job payload is missing recognition_id.")
    return run_recognition(recognition_id)
