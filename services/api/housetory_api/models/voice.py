import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..domain import VoiceNoteStatus
from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class VoiceNote(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "voice_notes"
    __table_args__ = (
        CheckConstraint(
            "status in ('queued', 'transcribing', 'transcribed', 'interpreting', "
            "'review', 'applying', 'confirmed', 'failed', 'cancelled')",
            name="valid_status",
        ),
        Index("ix_voice_notes_household_created", "household_id", "created_at"),
        Index("ix_voice_notes_household_property", "household_id", "default_property_id"),
        Index("ix_voice_notes_status", "status"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=VoiceNoteStatus.QUEUED.value
    )
    audio_storage_key: Mapped[str | None] = mapped_column(String(500))
    audio_original_filename: Mapped[str | None] = mapped_column(String(255))
    audio_content_type: Mapped[str | None] = mapped_column(String(100))
    audio_byte_size: Mapped[int | None] = mapped_column(BigInteger)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    default_property_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("properties.id", ondelete="SET NULL")
    )
    default_room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    default_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    transcript: Mapped[str | None] = mapped_column(Text)
    transcript_provider: Mapped[str | None] = mapped_column(String(40))
    transcript_model: Mapped[str | None] = mapped_column(String(160))
    transcript_mode: Mapped[str | None] = mapped_column(String(20))
    transcript_error: Mapped[str | None] = mapped_column(Text)
    interpretation_provider: Mapped[str | None] = mapped_column(String(40))
    interpretation_model: Mapped[str | None] = mapped_column(String(160))
    interpretation_mode: Mapped[str | None] = mapped_column(String(20))
    interpretation_error: Mapped[str | None] = mapped_column(Text)
    suggestions: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default="[]")
    warnings: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default="[]")
    applied_items: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default="[]")
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audio_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
