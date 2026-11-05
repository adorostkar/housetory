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
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class InventoryEvidenceExport(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A private, generated inventory evidence package.

    The snapshot is captured and fingerprinted at preview/confirmation time so
    the generated PDF, CSV and ZIP use a consistent set of recorded facts.
    Original household documents and photos are never deleted by package
    cleanup; only these derived artifacts are removed.
    """

    __tablename__ = "inventory_evidence_exports"
    __table_args__ = (
        CheckConstraint(
            "status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')",
            name="valid_status",
        ),
        CheckConstraint("item_count >= 0", name="item_count_non_negative"),
        CheckConstraint("unit_count >= 0", name="unit_count_non_negative"),
        CheckConstraint("pdf_bytes is null or pdf_bytes > 0", name="pdf_bytes_positive"),
        CheckConstraint("csv_bytes is null or csv_bytes > 0", name="csv_bytes_positive"),
        CheckConstraint("bundle_bytes is null or bundle_bytes > 0", name="bundle_bytes_positive"),
        UniqueConstraint(
            "household_id", "request_id", name="uq_evidence_exports_household_request"
        ),
        Index("ix_evidence_exports_household_created", "household_id", "created_at"),
        Index("ix_evidence_exports_status_expires", "status", "expires_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="queued")
    format_version: Mapped[str] = mapped_column(
        String(40), nullable=False, server_default="inventory-evidence-v1"
    )
    scope: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    scope_label: Mapped[str] = mapped_column(String(300), nullable=False, server_default="")
    include_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    snapshot_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, server_default="")
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    unit_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    evidence_counts: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    warnings: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default="[]")
    pdf_key: Mapped[str | None] = mapped_column(String(500))
    pdf_name: Mapped[str | None] = mapped_column(String(255))
    pdf_bytes: Mapped[int | None] = mapped_column(BigInteger)
    pdf_sha256: Mapped[str | None] = mapped_column(String(64))
    csv_key: Mapped[str | None] = mapped_column(String(500))
    csv_name: Mapped[str | None] = mapped_column(String(255))
    csv_bytes: Mapped[int | None] = mapped_column(BigInteger)
    csv_sha256: Mapped[str | None] = mapped_column(String(64))
    bundle_key: Mapped[str | None] = mapped_column(String(500))
    bundle_name: Mapped[str | None] = mapped_column(String(255))
    bundle_bytes: Mapped[int | None] = mapped_column(BigInteger)
    bundle_sha256: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


__all__ = ["InventoryEvidenceExport"]
