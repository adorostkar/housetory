import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class InventoryReviewRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "inventory_review_runs"
    __table_args__ = (
        UniqueConstraint(
            "household_id", "request_id", name="uq_inventory_review_runs_household_request"
        ),
        CheckConstraint(
            "status in ('completed', 'partial', 'failed')",
            name="valid_status",
        ),
        CheckConstraint(
            "scope_type in ('items', 'room', 'container', 'property', 'household')",
            name="valid_scope_type",
        ),
        Index("ix_inventory_review_runs_household_created", "household_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    scope_label: Mapped[str] = mapped_column(String(200), nullable=False)
    include_ai: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="completed")
    total_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    item_count_scanned: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_suggestion_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    existing_suggestion_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    stale_suggestion_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    suppressed_suggestion_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    ai_used: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    ai_provider_label: Mapped[str | None] = mapped_column(String(160))
    ai_model: Mapped[str | None] = mapped_column(String(160))
    ai_error: Mapped[str | None] = mapped_column(Text)
    partial_reason: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class InventoryReviewSuggestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "inventory_review_suggestions"
    __table_args__ = (
        CheckConstraint(
            "type in ('category', 'name', 'possible_duplicate', 'missing_detail', "
            "'location_conflict')",
            name="valid_type",
        ),
        CheckConstraint(
            "action_kind in ('apply_category', 'apply_name', 'advisory')",
            name="valid_action_kind",
        ),
        CheckConstraint(
            "status in ('pending', 'accepted', 'dismissed', 'stale', 'reverted')",
            name="valid_status",
        ),
        CheckConstraint(
            "scope_type in ('items', 'room', 'container', 'property', 'household')",
            name="valid_scope_type",
        ),
        Index(
            "ix_inventory_review_suggestions_household_status",
            "household_id",
            "status",
        ),
        Index(
            "ix_inventory_review_suggestions_household_type",
            "household_id",
            "type",
        ),
        Index("ix_inventory_review_suggestions_item", "item_id"),
        Index("ix_inventory_review_suggestions_fingerprint", "household_id", "fingerprint"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_review_runs.id", ondelete="SET NULL"),
    )
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    action_kind: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    source: Mapped[str] = mapped_column(String(20), nullable=False, server_default="rules")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    secondary_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL")
    )
    before_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    after_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    evidence_json: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_item_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_history_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("activity_events.id", ondelete="SET NULL")
    )
    applied_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revert_history_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("activity_events.id", ondelete="SET NULL")
    )


__all__ = ["InventoryReviewRun", "InventoryReviewSuggestion"]
