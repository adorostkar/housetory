import uuid
from datetime import datetime
from typing import TYPE_CHECKING

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
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from .auth import Household, User
    from .intelligence import AiProvider
    from .inventory import Item


class ItemImage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A non-photographic display image for an item.

    Actual user photographs stay in ``item_photos``. This table stores reference
    downloads and accepted AI illustrations with provenance. Legacy
    ``source_type='builtin'`` rows are retained for compatibility but are
    superseded/ignored and never rendered.
    """

    __tablename__ = "item_images"
    __table_args__ = (
        CheckConstraint("source_type in ('reference', 'ai', 'builtin')", name="valid_source_type"),
        CheckConstraint(
            "status in ('pending', 'active', 'superseded', 'rejected', 'failed')",
            name="valid_status",
        ),
        CheckConstraint("byte_size IS NULL OR byte_size > 0", name="byte_size_positive"),
        CheckConstraint(
            "permission_basis IS NULL OR permission_basis in "
            "('public_web', 'configured_source_policy', 'provider_license')",
            name="valid_permission_basis",
        ),
        Index("ix_item_images_item_status", "item_id", "status"),
        Index("ix_item_images_household_created", "household_id", "created_at"),
        Index(
            "uq_item_images_active_item",
            "item_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_providers.id", ondelete="SET NULL")
    )
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="active")
    # Legacy built-in illustration identifier; no new rows use this column.
    illustration_key: Mapped[str | None] = mapped_column(String(40))
    storage_key: Mapped[str | None] = mapped_column(String(500), unique=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(500), unique=True)
    original_filename: Mapped[str | None] = mapped_column(String(255))
    content_type: Mapped[str | None] = mapped_column(String(100))
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_name: Mapped[str | None] = mapped_column(String(200))
    source_page_url: Mapped[str | None] = mapped_column(Text)
    license_note: Mapped[str | None] = mapped_column(String(400))
    license_name: Mapped[str | None] = mapped_column(String(120))
    license_url: Mapped[str | None] = mapped_column(Text)
    permission_basis: Mapped[str | None] = mapped_column(String(40))
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exact_model_confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    model_label: Mapped[str | None] = mapped_column(String(160))
    search_fingerprint: Mapped[str | None] = mapped_column(String(64))
    prompt: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)

    household: Mapped["Household"] = relationship()
    item: Mapped["Item"] = relationship(back_populates="images")
    created_by: Mapped["User | None"] = relationship()
    provider: Mapped["AiProvider | None"] = relationship()


__all__ = ["ItemImage"]
