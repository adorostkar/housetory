import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from .auth import Household
    from .inventory import Room


class Property(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A physical home or site within one household.

    Households remain the membership/security boundary. Properties are an
    inventory grouping only and do not carry their own permissions yet.
    """

    __tablename__ = "properties"
    __table_args__ = (
        CheckConstraint("length(name) between 1 and 120", name="name_length"),
        UniqueConstraint("household_id", "name", name="uq_properties_household_name"),
        Index("ix_properties_household_sort", "household_id", "sort_order", "name"),
        Index("ix_properties_household_archived", "household_id", "is_archived"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")

    household: Mapped["Household"] = relationship(back_populates="properties")
    rooms: Mapped[list["Room"]] = relationship(back_populates="property")


__all__ = ["Property"]
