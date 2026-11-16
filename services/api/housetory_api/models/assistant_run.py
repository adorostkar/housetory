import uuid

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class AssistantRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "assistant_runs"
    __table_args__ = (UniqueConstraint("actor_user_id", "request_id"),)

    actor_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    property_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assistant_runs.id", ondelete="SET NULL")
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
