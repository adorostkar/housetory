import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_db
from ...domain import VoiceNoteStatus
from ...models import Property, Room, StorageLocation, VoiceNote
from ...schemas.voice import (
    VoiceApplyRequest,
    VoiceApplyResult,
    VoiceConfigOut,
    VoiceNoteOut,
    VoiceTranscriptRequest,
)
from ...services import properties as property_service
from ...services import storage
from ...services.voice import (
    active_voice_note_count,
    apply_voice_note,
    cancel_voice_note,
    enqueue_interpretation,
    enqueue_transcription,
    get_voice_note,
    has_applied_suggestions,
    interpretation_config,
    retry_transcription,
    serialize_voice_note,
    transcription_config,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/voice", tags=["voice"])

SUPPORTED_AUDIO_FORMATS = ["WebM", "Ogg", "WAV", "MP3", "M4A"]


def _note_out(note: VoiceNote) -> VoiceNoteOut:
    return VoiceNoteOut.model_validate(serialize_voice_note(note))


def _context(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
    property_id: uuid.UUID | None = None,
) -> tuple[Property, Room | None, StorageLocation | None]:
    room: Room | None = None
    location: StorageLocation | None = None
    if room_id is not None:
        room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(404, "room_not_found", "Room not found.")
    if location_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            raise ApiError(404, "location_not_found", "Storage location not found.")
        if room is not None and location.room_id != room.id:
            raise ApiError(
                422,
                "context_mismatch",
                "The selected place does not belong to the selected room.",
            )
        if room is None:
            room = db.scalar(
                select(Room).where(
                    Room.id == location.room_id,
                    Room.household_id == household_id,
                )
            )
    property_record = None
    if room is not None:
        property_record = room.property
        if property_id is not None and property_id != property_record.id:
            raise ApiError(
                422,
                "context_mismatch",
                "The selected room belongs to a different property.",
            )
    elif property_id is not None:
        property_record = property_service.get_property(db, household_id, property_id)
    else:
        property_record = property_service.resolve_room_property(db, household_id, None)
    if property_record.is_archived:
        raise ApiError(
            422,
            "property_archived",
            "Restore the selected property before recording a voice note.",
        )
    return property_record, room, location


@router.get("/config", response_model=VoiceConfigOut)
def voice_config(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceConfigOut:
    settings = get_settings()
    config = transcription_config(db, auth.household.id)
    return VoiceConfigOut(
        transcription_configured=config.configured,
        max_duration_seconds=settings.voice_max_duration_seconds,
        max_upload_mb=settings.voice_max_upload_mb,
        supported_formats=SUPPORTED_AUDIO_FORMATS,
        retention_note=(
            "Audio is deleted after a successful transcript or when you cancel. "
            "A failed recording is kept privately so you can retry; cancel it to delete "
            "the audio immediately."
        ),
    )


@router.post("", response_model=VoiceNoteOut, status_code=201)
def create_voice_note(
    file: Annotated[UploadFile, File()],
    duration_seconds: Annotated[int | None, Form(ge=0, le=86_400)] = None,
    property_id: Annotated[uuid.UUID | None, Form()] = None,
    room_id: Annotated[uuid.UUID | None, Form()] = None,
    location_id: Annotated[uuid.UUID | None, Form()] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceNoteOut:
    settings = get_settings()
    if file.filename is None:
        raise ApiError(422, "audio_required", "Choose an audio file to upload.")
    if duration_seconds is not None and duration_seconds > settings.voice_max_duration_seconds:
        raise ApiError(
            422,
            "audio_too_long",
            f"Recordings are limited to {settings.voice_max_duration_seconds} seconds.",
        )
    config = transcription_config(db, auth.household.id)
    if not config.configured:
        raise ApiError(
            422,
            "transcription_not_configured",
            config.error
            or "Choose OpenAI, OpenRouter or Google Gemini for voice transcription in AI settings.",
        )
    if active_voice_note_count(db, auth.household.id) >= settings.voice_max_active_notes:
        raise ApiError(
            429,
            "too_many_voice_notes",
            "Too many voice notes are waiting for review. Finish or cancel one first.",
        )
    property_record, room, location = _context(
        db, auth.household.id, room_id, location_id, property_id
    )
    note = VoiceNote(
        household_id=auth.household.id,
        created_by_user_id=auth.user.id,
        status=VoiceNoteStatus.QUEUED.value,
        duration_seconds=duration_seconds,
        default_property_id=property_record.id,
        default_room_id=room.id if room else None,
        default_location_id=location.id if location else None,
        warnings=[],
        suggestions=[],
        applied_items=[],
    )
    stored = None
    try:
        db.add(note)
        db.flush()
        stored = storage.store_voice_audio(auth.household.id, note.id, file)
        if stored.byte_size < 128:
            raise ApiError(
                422,
                "empty_audio",
                "This recording is empty. Record again or choose a non-empty audio file.",
            )
        note.audio_storage_key = stored.storage_key
        note.audio_original_filename = stored.original_filename
        note.audio_content_type = stored.content_type
        note.audio_byte_size = stored.byte_size
        enqueue_transcription(db, note)
        db.refresh(note)
        return _note_out(note)
    except Exception:
        db.rollback()
        if stored is not None:
            storage.delete_import_key(stored.storage_key)
        raise


@router.get("/{note_id}", response_model=VoiceNoteOut)
def read_voice_note(
    note_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceNoteOut:
    return _note_out(get_voice_note(db, auth.household.id, note_id))


@router.post("/{note_id}/interpret", response_model=VoiceNoteOut)
def interpret_voice_note(
    note_id: uuid.UUID,
    payload: VoiceTranscriptRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceNoteOut:
    settings = get_settings()
    note = get_voice_note(db, auth.household.id, note_id, for_update=True)
    if note.status == VoiceNoteStatus.CONFIRMED.value:
        raise ApiError(409, "voice_note_confirmed", "This voice note was already applied.")
    if note.status in {
        VoiceNoteStatus.QUEUED.value,
        VoiceNoteStatus.TRANSCRIBING.value,
        VoiceNoteStatus.INTERPRETING.value,
        VoiceNoteStatus.APPLYING.value,
    }:
        raise ApiError(409, "voice_note_busy", "Wait for the current step to finish.")
    if has_applied_suggestions(note):
        raise ApiError(
            409,
            "voice_note_already_reviewed",
            "This voice note already has applied suggestions.",
        )
    transcript = payload.transcript.strip()
    if not transcript:
        raise ApiError(422, "transcript_required", "Enter a transcript first.")
    if len(transcript) > settings.voice_max_transcript_chars:
        raise ApiError(
            422,
            "transcript_too_long",
            f"Transcripts are limited to {settings.voice_max_transcript_chars} characters.",
        )
    config = interpretation_config(db, auth.household.id)
    if not config.configured:
        raise ApiError(
            422,
            "interpretation_not_configured",
            config.error
            or "Choose a Smart imports task provider in AI settings before interpreting.",
        )
    note.transcript = transcript
    note.suggestions = []
    note.warnings = []
    note.interpretation_error = None
    enqueue_interpretation(db, note)
    db.refresh(note)
    return _note_out(note)


@router.post("/{note_id}/transcription/retry", response_model=VoiceNoteOut)
def retry_voice_transcription(
    note_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceNoteOut:
    note = get_voice_note(db, auth.household.id, note_id, for_update=True)
    retry_transcription(db, note)
    db.refresh(note)
    return _note_out(note)


@router.post("/{note_id}/confirm", response_model=VoiceApplyResult)
def confirm_voice_note(
    note_id: uuid.UUID,
    payload: VoiceApplyRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceApplyResult:
    note = get_voice_note(db, auth.household.id, note_id)
    result = apply_voice_note(db, note, payload.entries)
    return VoiceApplyResult.model_validate(result)


@router.post("/{note_id}/cancel", response_model=VoiceNoteOut)
def cancel_voice_note_route(
    note_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> VoiceNoteOut:
    note = get_voice_note(db, auth.household.id, note_id)
    cancelled = cancel_voice_note(db, note)
    return _note_out(cancelled)
