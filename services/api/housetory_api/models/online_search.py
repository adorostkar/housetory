import uuid
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin


class HouseholdOnlineSearchSettings(TimestampMixin, Base):
    """Owner-managed online search configuration for one household.

    The Brave subscription token is encrypted with the installation credential
    key. Environment variables remain an installation fallback only when no row
    exists for the household.
    """

    __tablename__ = "household_online_search_settings"
    __table_args__ = (
        CheckConstraint("provider in ('brave')", name="valid_provider"),
        CheckConstraint(
            "jsonb_typeof(permitted_source_domains) = 'array'",
            name="valid_permitted_domains",
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("households.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, server_default="brave")
    encrypted_api_key: Mapped[str | None] = mapped_column(Text)
    api_key_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    manual_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    reference_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    permitted_source_domains: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )


__all__ = ["HouseholdOnlineSearchSettings"]
