import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..domain import (
    ImportEntityType,
    ImportEntryStatus,
    ImportSourceType,
    ImportStatus,
    RecognitionStatus,
)
from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class AiProvider(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ai_providers"
    __table_args__ = (
        CheckConstraint(
            "provider in ('openai', 'anthropic', 'gemini', 'xai', 'openrouter', 'ollama')",
            name="valid_provider",
        ),
        UniqueConstraint("household_id", "provider", name="uq_ai_providers_household_provider"),
        Index("ix_ai_providers_household", "household_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    base_url: Mapped[str | None] = mapped_column(String(500))
    default_model: Mapped[str | None] = mapped_column(String(160))
    encrypted_api_key: Mapped[str | None] = mapped_column(Text)
    api_key_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    cloud_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")


class AiTextDefault(Base):
    __tablename__ = "ai_text_defaults"

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("households.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_providers.id", ondelete="SET NULL")
    )
    model: Mapped[str | None] = mapped_column(String(160))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AiTaskSetting(Base):
    __tablename__ = "ai_task_settings"
    __table_args__ = (
        CheckConstraint(
            "task in ('assistant', 'imports', 'documents', 'search', 'vision', "
            "'labels', 'transcription', 'item_images')",
            name="valid_task",
        ),
        CheckConstraint(
            "last_test_status is null or last_test_status in ('passed', 'failed', 'unsupported')",
            name="valid_last_test_status",
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), primary_key=True
    )
    task: Mapped[str] = mapped_column(String(20), primary_key=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_providers.id", ondelete="SET NULL")
    )
    model: Mapped[str | None] = mapped_column(String(160))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    inherits_text_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    last_test_status: Mapped[str | None] = mapped_column(String(24))
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_test_error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ImportBatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "import_batches"
    __table_args__ = (
        CheckConstraint(
            "source_type in ('text', 'file', 'vault', 'image')",
            name="valid_source_type",
        ),
        CheckConstraint(
            "status in ('queued', 'processing', 'review', 'applying', 'completed', 'failed')",
            name="valid_status",
        ),
        Index("ix_import_batches_household_created", "household_id", "created_at"),
        Index("ix_import_batches_status", "status"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    source_type: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=ImportSourceType.FILE.value
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=ImportStatus.QUEUED.value
    )
    original_filename: Mapped[str | None] = mapped_column(String(255))
    content_type: Mapped[str | None] = mapped_column(String(100))
    storage_key: Mapped[str | None] = mapped_column(String(500), unique=True)
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    error: Mapped[str | None] = mapped_column(Text)
    warnings: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default="[]")
    metadata_json: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, server_default="{}"
    )
    total_entries: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    imported_entries: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    skipped_entries: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    failed_entries: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    entries: Mapped[list["ImportEntry"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )
    files: Mapped[list["ImportSourceFile"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )


class ImportSourceFile(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "import_source_files"
    __table_args__ = (
        CheckConstraint("kind in ('note', 'attachment')", name="valid_kind"),
        UniqueConstraint("batch_id", "relative_path", name="uq_import_files_batch_path"),
        Index("ix_import_source_files_batch", "batch_id"),
    )

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_batches.id", ondelete="CASCADE"), nullable=False
    )
    relative_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64))
    is_referenced: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    batch: Mapped[ImportBatch] = relationship(back_populates="files")
    entries: Mapped[list["ImportEntry"]] = relationship(back_populates="source_file")


class ImportEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "import_entries"
    __table_args__ = (
        CheckConstraint(
            "status in ('proposed', 'approved', 'rejected', 'imported', 'skipped', "
            "'merged', 'failed')",
            name="valid_status",
        ),
        CheckConstraint(
            "duplicate_resolution is null or duplicate_resolution in ('new', 'skip', 'merge')",
            name="valid_duplicate_resolution",
        ),
        CheckConstraint(
            "confidence is null or confidence between 0 and 100",
            name="confidence_range",
        ),
        Index("ix_import_entries_batch_position", "batch_id", "position"),
        Index("ix_import_entries_status", "status"),
        Index("ix_import_entries_imported_item", "imported_item_id"),
        Index("ix_import_entries_parent_entry", "parent_entry_id"),
    )

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_batches.id", ondelete="CASCADE"), nullable=False
    )
    entity_type: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=ImportEntityType.ITEM.value
    )
    parent_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_entries.id", ondelete="SET NULL")
    )
    created_room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    created_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    legacy_identifier: Mapped[str | None] = mapped_column(String(120))
    source_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_source_files.id", ondelete="SET NULL")
    )
    source_path: Mapped[str | None] = mapped_column(String(1000))
    source_excerpt: Mapped[str | None] = mapped_column(Text)
    note_title: Mapped[str | None] = mapped_column(String(200))
    proposed: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    field_sources: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    confidence: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=ImportEntryStatus.PROPOSED.value
    )
    duplicate_candidates: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    duplicate_resolution: Mapped[str | None] = mapped_column(String(20))
    matched_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    imported_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL"), unique=True
    )
    error: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    batch: Mapped[ImportBatch] = relationship(back_populates="entries")
    source_file: Mapped[ImportSourceFile | None] = relationship(back_populates="entries")


class RecognitionItemLink(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "recognition_item_links"
    __table_args__ = (
        UniqueConstraint("recognition_id", "item_id", name="uq_recognition_item"),
        Index("ix_recognition_item_links_recognition", "recognition_id"),
        Index("ix_recognition_item_links_item", "item_id"),
    )

    recognition_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_recognitions.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), nullable=False
    )
    suggestion_index: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AiRecognition(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ai_recognitions"
    __table_args__ = (
        CheckConstraint(
            "status in ('queued', 'processing', 'succeeded', 'failed')",
            name="valid_status",
        ),
        Index("ix_ai_recognitions_household_created", "household_id", "created_at"),
        Index("ix_ai_recognitions_location", "location_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    original_content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    original_byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=RecognitionStatus.QUEUED.value
    )
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    field_sources: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    confidence: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    model_provider: Mapped[str | None] = mapped_column(String(40))
    model_name: Mapped[str | None] = mapped_column(String(160))
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    processing_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="unavailable"
    )
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_items: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default="[]")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
