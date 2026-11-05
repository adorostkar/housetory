import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
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
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..domain import LoanStatus
from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Loan(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "loans"
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
        CheckConstraint("due_on is null or due_on >= lent_on", name="dates_in_order"),
        UniqueConstraint("household_id", "request_id", name="uq_loans_household_request_id"),
        Index("ix_loans_household_status_due", "household_id", "status", "due_on"),
        Index("ix_loans_household_item", "household_id", "item_id"),
        Index("ix_loans_household_lent", "household_id", "lent_on"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    item_name_snapshot: Mapped[str] = mapped_column(String(200), nullable=False)
    home_room_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    home_room_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    home_location_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    home_location_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    home_location_identifier_snapshot: Mapped[str | None] = mapped_column(String(32))
    borrower_name: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    returned_quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    lent_on: Mapped[date] = mapped_column(Date, nullable=False)
    due_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, server_default=LoanStatus.OUTSTANDING.value
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class LoanReturn(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "loan_returns"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        UniqueConstraint("household_id", "request_id", name="uq_loan_returns_household_request_id"),
        Index("ix_loan_returns_household_loan", "household_id", "loan_id"),
        Index("ix_loan_returns_loan_created", "loan_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    loan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("loans.id", ondelete="CASCADE"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    returned_on: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )


class ActivityEvent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "activity_events"
    __table_args__ = (
        CheckConstraint(
            "entity_type in ('item', 'container', 'loan', 'batch', 'room')",
            name="valid_entity_type",
        ),
        UniqueConstraint(
            "household_id", "request_id", name="uq_activity_events_household_request_id"
        ),
        UniqueConstraint("undoes_event_id", name="uq_activity_events_undoes_event_id"),
        Index("ix_activity_events_household_created", "household_id", "created_at"),
        Index("ix_activity_events_household_item", "household_id", "item_id", "created_at"),
        Index(
            "ix_activity_events_household_container",
            "household_id",
            "container_id",
            "created_at",
        ),
        Index("ix_activity_events_household_loan", "household_id", "loan_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    actor_name_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    container_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    loan_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("loans.id", ondelete="SET NULL")
    )
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    undoes_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("activity_events.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
