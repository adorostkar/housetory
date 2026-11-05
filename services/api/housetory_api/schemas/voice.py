import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..domain import ContainerType
from ..schemas.common import Description, trimmed
from ..schemas.imports import (
    DuplicateCandidate,
    LocationCandidate,
    LocationProposal,
    NamedMatch,
)

VoiceStatus = Literal[
    "queued",
    "transcribing",
    "transcribed",
    "interpreting",
    "review",
    "applying",
    "confirmed",
    "failed",
    "cancelled",
]

VoiceSuggestionState = Literal[
    "proposed",
    "imported",
    "skipped",
    "rejected",
    "failed",
]


class AiVoiceMention(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: trimmed(1, 200) | None = None
    quantity: int | None = Field(default=None, ge=0, le=1_000_000)
    variant: trimmed(1, 160) | None = None
    description: Description | None = None
    category: trimmed(1, 80) | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    room: trimmed(1, 120) | None = None
    storage_location: trimmed(1, 120) | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    notes: Description | None = None
    evidence: trimmed(1, 2000)
    role: Literal["item", "summary", "correction"] = "item"
    target: trimmed(1, 200) | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _name_required_for_non_correction(self) -> "AiVoiceMention":
        if self.role in {"item", "summary"} and not self.name:
            raise ValueError("Item and summary mentions require a name.")
        if self.role == "correction" and not self.name and self.target is None:
            # A bare correction such as "actually four" is valid; the server
            # applies it to the most recent item mention.
            return self
        return self


class AiVoiceMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: trimmed(1, 1000)
    item: trimmed(1, 200) | None = None
    from_location: trimmed(1, 200) | None = None
    to_location: trimmed(1, 200) | None = None


class AiVoiceResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mentions: list[AiVoiceMention] = Field(default_factory=list, max_length=200)
    moves: list[AiVoiceMove] = Field(default_factory=list, max_length=50)
    warnings: list[str] = Field(default_factory=list, max_length=50)


class VoiceSourceSpan(BaseModel):
    text: str
    start: int | None = None
    end: int | None = None
    role: Literal["item", "summary", "correction"] = "item"
    quantity: int | None = None
    quantity_explicit: bool = False


class VoiceLocation(LocationProposal):
    evidence: str | None = None
    create: bool = False
    create_kind: ContainerType = ContainerType.BOX


class VoiceSuggestionEdit(BaseModel):
    id: uuid.UUID
    name: trimmed(1, 200)
    description: Description | None = None
    quantity: int = Field(default=1, ge=0, le=1_000_000)
    variant: trimmed(1, 160) | None = None
    category: NamedMatch | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    tags: list[str] = Field(default_factory=list, max_length=50)
    notes: Description | None = None
    room: VoiceLocation | None = None
    storage_location: VoiceLocation | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)
    split_of: uuid.UUID | None = None

    @model_validator(mode="after")
    def _location_room_consistency(self) -> "VoiceSuggestionEdit":
        if (
            self.storage_location
            and self.storage_location.matched_id
            and self.room
            and self.room.matched_id
            and self.storage_location.room_id
            and self.storage_location.room_id != self.room.matched_id
        ):
            raise ValueError("The selected container belongs to a different room.")
        return self


class VoiceSuggestion(VoiceSuggestionEdit):
    mention_count: int = Field(default=1, ge=1)
    quantity_explicit: bool = False
    sources: list[VoiceSourceSpan] = Field(default_factory=list)
    duplicate_candidates: list[DuplicateCandidate] = Field(default_factory=list)
    state: VoiceSuggestionState = "proposed"
    imported_item_id: uuid.UUID | None = None
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)


class VoiceNoteOut(BaseModel):
    id: uuid.UUID
    status: VoiceStatus
    original_filename: str | None
    content_type: str | None
    byte_size: int | None
    duration_seconds: int | None
    audio_retained: bool
    default_property_id: uuid.UUID | None
    default_room_id: uuid.UUID | None
    default_location_id: uuid.UUID | None
    transcript: str | None
    transcript_provider: str | None
    transcript_model: str | None
    transcript_mode: str | None
    transcript_error: str | None
    interpretation_provider: str | None
    interpretation_model: str | None
    interpretation_mode: str | None
    interpretation_error: str | None
    suggestions: list[VoiceSuggestion]
    warnings: list[Any]
    applied_items: list[Any]
    applied_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    created_at: datetime
    updated_at: datetime


class VoiceTranscriptRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=50_000)


class VoiceApplyEntry(VoiceSuggestionEdit):
    action: Literal["import", "skip", "reject"] = "import"
    duplicate_resolution: Literal["new", "add_quantity", "skip"] | None = None
    merge_item_id: uuid.UUID | None = None


class VoiceApplyRequest(BaseModel):
    entries: list[VoiceApplyEntry] = Field(min_length=1, max_length=100)


class VoiceApplyFailure(BaseModel):
    suggestion_id: uuid.UUID
    message: str


class VoiceApplyResult(BaseModel):
    note: VoiceNoteOut
    created: int
    added_quantity: int
    skipped: int
    rejected: int
    failed: int
    failures: list[VoiceApplyFailure]


class VoiceConfigOut(BaseModel):
    transcription_configured: bool
    max_duration_seconds: int
    max_upload_mb: int
    supported_formats: list[str]
    retention_note: str


class VoiceLocationCandidate(LocationCandidate):
    pass
