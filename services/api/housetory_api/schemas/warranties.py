import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from ..schemas.common import Description, ItemReference, ORMModel, trimmed
from ..schemas.documents import DocumentBrief


class WarrantyIn(BaseModel):
    provider: trimmed(1, 160) | None = None
    start_date: date | None = None
    duration_months: int | None = Field(default=None, ge=1, le=1200)
    end_date: date | None = None
    reminder_days: int | None = Field(default=None, ge=1, le=3650)
    notes: Description | None = None
    document_id: uuid.UUID | None = None

    @field_validator("end_date")
    @classmethod
    def _dates_order(cls, value: date | None, info) -> date | None:  # noqa: ANN001
        start = info.data.get("start_date")
        if value is not None and start is not None and value < start:
            raise ValueError("Warranty end date must not precede its start date.")
        return value


class WarrantyOut(ORMModel):
    id: uuid.UUID
    provider: str | None
    start_date: date | None
    duration_months: int | None
    end_date: date | None
    reminder_days: int | None
    effective_reminder_days: int
    notes: str | None
    coverage_notes: str | None
    status: str
    days_remaining: int | None
    document_id: uuid.UUID | None
    document: DocumentBrief | None
    item: ItemReference | None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WarrantyList(BaseModel):
    items: list[WarrantyOut]
    active_count: int
    expiring_count: int
    expired_count: int
    unknown_count: int
    reminder_days: int


class WarrantyDashboard(BaseModel):
    active: list[WarrantyOut]
    expiring_soon: list[WarrantyOut]
    expired: list[WarrantyOut]
    active_count: int
    expiring_count: int
    expired_count: int
    unknown_count: int
    reminder_days: int
