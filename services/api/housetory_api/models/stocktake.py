import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
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

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class StocktakeSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A bounded room/container stocktake with an immutable expected snapshot.

    Observations are append-only evidence. Inventory edits only happen through a
    separately reviewed application, and completion records coverage rather than
    pretending every item was checked.
    """

    __tablename__ = "stocktake_sessions"
    __table_args__ = (
        CheckConstraint(
            "status in ('in_progress', 'completed', 'abandoned')",
            name="valid_status",
        ),
        CheckConstraint("expected_item_count >= 0", name="item_count_non_negative"),
        CheckConstraint("expected_unit_count >= 0", name="unit_count_non_negative"),
        UniqueConstraint("household_id", "request_id", name="uq_stocktake_sessions_request"),
        UniqueConstraint(
            "household_id", "close_request_id", name="uq_stocktake_sessions_close_request"
        ),
        Index("ix_stocktake_sessions_household_status", "household_id", "status", "updated_at"),
        Index("ix_stocktake_sessions_household_created", "household_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    completed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_by_name_snapshot: Mapped[str] = mapped_column(
        String(120), nullable=False, server_default="Housetory"
    )
    completed_by_name_snapshot: Mapped[str | None] = mapped_column(String(120))
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    close_request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="in_progress")
    scope: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    scope_label: Mapped[str] = mapped_column(String(300), nullable=False, server_default="")
    snapshot_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, server_default="")
    expected_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    expected_unit_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    expected_at_home_unit_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    expected_on_loan_unit_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    checked_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    checked_unit_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    verified_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    missing_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    quantity_discrepancy_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    unknown_item_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    unexpected_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    coverage: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    abandoned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    snapshot_items: Mapped[list["StocktakeSnapshotItem"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    observations: Mapped[list["StocktakeObservation"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class StocktakeSnapshotItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The expected item state captured when a stocktake started (or refreshed)."""

    __tablename__ = "stocktake_snapshot_items"
    __table_args__ = (
        UniqueConstraint("session_id", "item_id", name="uq_stocktake_snapshot_session_item"),
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
        CheckConstraint("at_home_quantity >= 0", name="at_home_non_negative"),
        CheckConstraint("on_loan_quantity >= 0", name="on_loan_non_negative"),
        Index("ix_stocktake_snapshot_session_position", "session_id", "position"),
        Index("ix_stocktake_snapshot_household_item", "household_id", "item_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    item_name: Mapped[str] = mapped_column(String(200), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    at_home_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    on_loan_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    room_name: Mapped[str | None] = mapped_column(String(120))
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    location_name: Mapped[str | None] = mapped_column(String(120))
    location_identifier: Mapped[str | None] = mapped_column(String(32))
    location_path: Mapped[str] = mapped_column(String(600), nullable=False, server_default="")
    item_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    session: Mapped[StocktakeSession] = relationship(back_populates="snapshot_items")


class StocktakeObservation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Immutable field observation. It never edits inventory by itself."""

    __tablename__ = "stocktake_observations"
    __table_args__ = (
        CheckConstraint(
            "status in ('present', 'missing', 'moved', 'quantity_discrepancy', "
            "'unknown', 'unexpected')",
            name="valid_status",
        ),
        CheckConstraint(
            "counted_quantity is null or counted_quantity >= 0",
            name="counted_non_negative",
        ),
        CheckConstraint(
            "status = 'unexpected' or snapshot_item_id is not null",
            name="snapshot_required_for_item_observation",
        ),
        CheckConstraint(
            "status <> 'unexpected' or (snapshot_item_id is null and unexpected_name is not null)",
            name="unexpected_shape",
        ),
        UniqueConstraint("household_id", "request_id", name="uq_stocktake_observations_request"),
        Index("ix_stocktake_observations_session_created", "session_id", "created_at"),
        Index(
            "ix_stocktake_observations_snapshot_created",
            "snapshot_item_id",
            "created_at",
        ),
        Index("ix_stocktake_observations_household_item", "household_id", "item_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    snapshot_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_snapshot_items.id", ondelete="CASCADE"),
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    counted_quantity: Mapped[int | None] = mapped_column(Integer)
    observed_room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    observed_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    observed_room_name: Mapped[str | None] = mapped_column(String(120))
    observed_location_name: Mapped[str | None] = mapped_column(String(120))
    observed_location_identifier: Mapped[str | None] = mapped_column(String(32))
    observed_location_path: Mapped[str | None] = mapped_column(String(600))
    unexpected_name: Mapped[str | None] = mapped_column(String(200))
    linked_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(Text)
    owned_quantity_at_observation: Mapped[int | None] = mapped_column(Integer)
    on_loan_quantity_at_observation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    at_home_quantity_at_observation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    item_updated_at_at_observation: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    verifier_name_snapshot: Mapped[str] = mapped_column(
        String(120), nullable=False, server_default="Housetory"
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped[StocktakeSession] = relationship(back_populates="observations")


class StocktakeApplication(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One atomic, reviewed application of observation-derived corrections."""

    __tablename__ = "stocktake_applications"
    __table_args__ = (
        UniqueConstraint("household_id", "request_id", name="uq_stocktake_applications_request"),
        CheckConstraint("applied_count >= 0", name="applied_count_non_negative"),
        CheckConstraint("skipped_count >= 0", name="skipped_count_non_negative"),
        Index("ix_stocktake_applications_session", "session_id", "created_at"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    review_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    applied_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")


class StocktakeCorrection(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Audit record linking an applied observation to its inventory edits."""

    __tablename__ = "stocktake_corrections"
    __table_args__ = (
        UniqueConstraint("observation_id", name="uq_stocktake_corrections_observation"),
        Index("ix_stocktake_corrections_session", "session_id", "created_at"),
        Index("ix_stocktake_corrections_household_item", "household_id", "item_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_applications.id", ondelete="CASCADE"),
        nullable=False,
    )
    observation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stocktake_observations.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="SET NULL")
    )
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    previous: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    applied: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    activity_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("activity_events.id", ondelete="SET NULL")
    )


class StocktakeItemState(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Current derived 'last checked' state for an item.

    Historical observations remain in the append-only observation tables. This
    row is only a fast display cache and is recomputed from a completed session.
    """

    __tablename__ = "stocktake_item_states"
    __table_args__ = (
        UniqueConstraint("item_id", name="uq_stocktake_item_states_item"),
        CheckConstraint("counted_quantity >= 0", name="counted_non_negative"),
        CheckConstraint("owned_quantity >= 0", name="owned_non_negative"),
        CheckConstraint("on_loan_quantity >= 0", name="on_loan_non_negative"),
        Index("ix_stocktake_item_states_household_verified", "household_id", "verified_at"),
        Index("ix_stocktake_item_states_session", "session_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stocktake_sessions.id", ondelete="SET NULL")
    )
    observation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stocktake_observations.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    counted_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    owned_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    on_loan_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    location_path: Mapped[str] = mapped_column(String(600), nullable=False, server_default="")
    item_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    item = relationship("Item", back_populates="last_verification")


__all__ = [
    "StocktakeApplication",
    "StocktakeCorrection",
    "StocktakeItemState",
    "StocktakeObservation",
    "StocktakeSession",
    "StocktakeSnapshotItem",
]
