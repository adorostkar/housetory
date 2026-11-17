"""Voice-note recording, upload and transcription."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...db import SessionLocal
from ...domain import AiTask, VoiceNoteStatus
from ...jobs import enqueue
from ...models import VoiceNote
from ...schemas.voice import VoiceSuggestion
from .. import ai, storage, transcription

logger = logging.getLogger("housetory.voice")

TRANSCRIBE_TASK = "voice.transcribe"


def _now() -> datetime:
    return datetime.now(UTC)


def serialize_voice_note(note: VoiceNote) -> dict[str, Any]:
    return {
        "id": note.id,
        "status": note.status,
        "original_filename": note.audio_original_filename,
        "content_type": note.audio_content_type,
        "byte_size": note.audio_byte_size,
        "duration_seconds": note.duration_seconds,
        "audio_retained": note.audio_storage_key is not None,
        "default_property_id": note.default_property_id,
        "default_room_id": note.default_room_id,
        "default_location_id": note.default_location_id,
        "transcript": note.transcript,
        "transcript_provider": note.transcript_provider,
        "transcript_model": note.transcript_model,
        "transcript_mode": note.transcript_mode,
        "transcript_error": note.transcript_error,
        "interpretation_provider": note.interpretation_provider,
        "interpretation_model": note.interpretation_model,
        "interpretation_mode": note.interpretation_mode,
        "interpretation_error": note.interpretation_error,
        "suggestions": [VoiceSuggestion.model_validate(item) for item in note.suggestions or []],
        "warnings": note.warnings or [],
        "applied_items": note.applied_items or [],
        "applied_at": note.applied_at,
        "completed_at": note.completed_at,
        "cancelled_at": note.cancelled_at,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def get_voice_note(
    db: Session,
    household_id: uuid.UUID,
    note_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> VoiceNote:
    query = select(VoiceNote).where(
        VoiceNote.id == note_id,
        VoiceNote.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update()
    note = db.scalar(query)
    if note is None:
        raise ApiError(404, "voice_note_not_found", "Voice note not found.")
    return note


def enqueue_transcription(db: Session, note: VoiceNote) -> None:
    note.status = VoiceNoteStatus.QUEUED.value
    note.transcript_error = None
    note.interpretation_error = None
    enqueue(
        db,
        TRANSCRIBE_TASK,
        {"voice_note_id": str(note.id)},
        commit=False,
        max_attempts=3,
        priority=6,
    )
    db.commit()


def _safe_transcription_error(exc: Exception) -> str:
    if isinstance(exc, (ai.AiUnavailable, ai.AiInvalidOutput)):
        return str(exc)[:1000]
    if isinstance(exc, ApiError):
        return exc.message[:1000]
    return "Transcription failed. Check the audio and try again."


def process_transcription(note_id: uuid.UUID | str) -> dict[str, Any] | None:
    with SessionLocal() as db:
        note = db.get(VoiceNote, note_id)
        if note is None:
            return None
        if note.status in {
            VoiceNoteStatus.CANCELLED.value,
            VoiceNoteStatus.CONFIRMED.value,
        }:
            return {"voice_note_id": str(note.id), "skipped": True}
        if note.transcript and note.status in {
            VoiceNoteStatus.TRANSCRIBED.value,
            VoiceNoteStatus.INTERPRETING.value,
            VoiceNoteStatus.REVIEW.value,
        }:
            return {"voice_note_id": str(note.id), "skipped": True}
        if note.status == VoiceNoteStatus.FAILED.value:
            # A failed note is final; a repeated job must not transcribe leftover audio.
            return {"voice_note_id": str(note.id), "skipped": True}
        if not note.audio_storage_key:
            note.status = VoiceNoteStatus.FAILED.value
            note.transcript_error = "The recording is no longer available. Record the note again."
            db.commit()
            return {"voice_note_id": str(note.id), "failed": True}
        note.status = VoiceNoteStatus.TRANSCRIBING.value
        note.transcript_error = None
        db.commit()
        key = note.audio_storage_key
        content_type = note.audio_content_type or "audio/webm"
        filename = note.audio_original_filename or "voice-note.webm"
        try:
            config = ai.config_for(db, note.household_id, AiTask.TRANSCRIPTION.value)
            if not config.configured:
                raise ai.AiUnavailable(config.error or "Transcription is not configured.")
            path = storage.resolve_import_key(key)
            text = transcription.transcribe_audio(
                config,
                path=path,
                content_type=content_type,
                filename=filename,
            ).strip()[: get_settings().voice_max_transcript_chars]
            if not text:
                raise ai.AiInvalidOutput(
                    "No speech was recognised. Try a clearer recording or upload."
                )
            note = db.get(VoiceNote, note_id)
            if note is None or note.status == VoiceNoteStatus.CANCELLED.value:
                return {"voice_note_id": str(note_id), "cancelled": True}
            note.transcript = text
            note.status = VoiceNoteStatus.TRANSCRIBED.value
            note.transcript_provider = config.provider
            note.transcript_model = config.model
            note.transcript_mode = config.mode
            note.transcript_error = None
            db.commit()
            logger.info("Voice note %s transcribed (%s characters)", note.id, len(text))
            outcome = {"voice_note_id": str(note.id), "transcribed": True}
        except Exception as exc:  # noqa: BLE001 - recorded on the note
            db.rollback()
            logger.warning("Voice note %s transcription failed (%s)", note_id, type(exc).__name__)
            note = db.get(VoiceNote, note_id)
            if note is None or note.status == VoiceNoteStatus.CANCELLED.value:
                return {"voice_note_id": str(note_id), "failed": True}
            note.status = VoiceNoteStatus.FAILED.value
            note.transcript_error = _safe_transcription_error(exc)
            db.commit()
            outcome = {"voice_note_id": str(note_id), "failed": True}
        # The outcome above is committed. Nothing can retry a finished note, so its
        # audio is removed either way; a cleanup problem never changes the outcome.
        _delete_audio(db, note_id, key)
        return outcome


def _delete_audio(db: Session, note_id: uuid.UUID | str, key: str) -> None:
    """Remove a finished note's audio; on failure keep the key so the file stays traceable."""
    try:
        storage.delete_import_key(key)
        note = db.get(VoiceNote, note_id)
        if note is not None and note.audio_storage_key == key:
            note.audio_storage_key = None
            note.audio_deleted_at = _now()
            db.commit()
    except Exception:  # noqa: BLE001 - cleanup must not affect the transcription result
        db.rollback()
        logger.exception("Voice note %s audio could not be deleted", note_id)


def active_voice_note_count(db: Session, household_id: uuid.UUID) -> int:
    # Bound concurrent uploads and in-flight paid jobs. Only notes waiting for or
    # in transcription hold audio and a worker slot; finished, failed and legacy
    # review notes must not lock a household out.
    active = {
        VoiceNoteStatus.QUEUED.value,
        VoiceNoteStatus.TRANSCRIBING.value,
    }
    return int(
        db.scalar(
            select(func.count(VoiceNote.id)).where(
                VoiceNote.household_id == household_id,
                VoiceNote.status.in_(active),
            )
        )
        or 0
    )


def transcription_config(db: Session, household_id: uuid.UUID):
    return ai.config_for(db, household_id, AiTask.TRANSCRIPTION.value)
