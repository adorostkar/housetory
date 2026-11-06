import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..domain import LoanStatus
from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class BorrowedRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A possession borrowed from an external owner, never household stock."""

    __tablename__ = "borrowed_records"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint(
            "returned_quantity >= 0 and returned_quantity <= quantity",
            name="returned_quantity_range",
        ),
        CheckConstraint(
            "status in ('outstanding', 'partially_returned', 'returned', 'cancelled')",
            name="valid_status",
        ),
        CheckConstraint("due_on is null or due_on >= borrowed_on", name="dates_in_order"),
        UniqueConstraint(
            "household_id", "request_id", name="uq_borrowed_records_household_request_id"
        ),
        Index("ix_borrowed_records_household_status_due", "household_id", "status", "due_on"),
        Index("ix_borrowed_records_household_borrowed", "household_id", "borrowed_on"),
        Index("ix_borrowed_records_household_room", "household_id", "room_id"),
        Index(
            "ix_borrowed_records_household_location",
            "household_id",
            "storage_location_id",
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    item_name: Mapped[str] = mapped_column(String(200), nullable=False)
    brand: Mapped[str | None] = mapped_column(String(120))
    model: Mapped[str | None] = mapped_column(String(120))
    owner_name: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    returned_quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, server_default=LoanStatus.OUTSTANDING.value
    )
    borrowed_on: Mapped[date] = mapped_column(Date, nullable=False)
    due_on: Mapped[date | None] = mapped_column(Date)
    property_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("properties.id", ondelete="SET NULL")
    )
    property_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    room_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    storage_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    location_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    location_identifier_snapshot: Mapped[str | None] = mapped_column(String(32))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)


class BorrowedReturn(UUIDPrimaryKeyMixin, Base):
    """An append-only partial return of a borrowed record."""

    __tablename__ = "borrowed_returns"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        UniqueConstraint(
            "household_id", "request_id", name="uq_borrowed_returns_household_request_id"
        ),
        Index("ix_borrowed_returns_household_record", "household_id", "borrowed_record_id"),
        Index("ix_borrowed_returns_record_created", "borrowed_record_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    borrowed_record_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("borrowed_records.id", ondelete="CASCADE"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    returned_on: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )


class BorrowedPhoto(UUIDPrimaryKeyMixin, Base):
    """A private actual-photo attachment for one borrowed record."""

    __tablename__ = "borrowed_photos"
    __table_args__ = (
        CheckConstraint("byte_size > 0", name="byte_size_positive"),
        UniqueConstraint("borrowed_record_id", name="uq_borrowed_photos_record"),
        Index("ix_borrowed_photos_household", "household_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    borrowed_record_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("borrowed_records.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(500), unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = ["BorrowedPhoto", "BorrowedRecord", "BorrowedReturn"]
