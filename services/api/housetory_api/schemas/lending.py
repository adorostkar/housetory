import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from ..schemas.common import Description, trimmed

LoanStatusName = Literal["outstanding", "partially_returned", "returned", "cancelled"]
LoanFilterStatus = Literal[
    "all", "open", "outstanding", "partially_returned", "returned", "cancelled"
]


class LoanCreate(BaseModel):
    item_id: uuid.UUID
    borrower_name: trimmed(1, 120)
    quantity: int = Field(ge=1, le=1_000_000)
    lent_on: date
    due_on: date | None = None
    notes: Description | None = None
    request_id: uuid.UUID

    @model_validator(mode="after")
    def _dates_in_order(self) -> "LoanCreate":
        if self.due_on is not None and self.due_on < self.lent_on:
            raise ValueError("The due date cannot be before the lent date.")
        return self


class LoanCorrect(BaseModel):
    borrower_name: trimmed(1, 120) | None = None
    quantity: int | None = Field(default=None, ge=1, le=1_000_000)
    lent_on: date | None = None
    due_on: date | None = None
    notes: Description | None = None
    request_id: uuid.UUID


class LoanReturnCreate(BaseModel):
    quantity: int = Field(ge=1, le=1_000_000)
    returned_on: date
    notes: Description | None = None
    request_id: uuid.UUID


class LoanCancelRequest(BaseModel):
    reason: trimmed(1, 500) | None = None
    request_id: uuid.UUID


class LoanOut(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID | None
    item_name: str
    item_name_snapshot: str
    home_room_id: uuid.UUID | None
    home_room_name_snapshot: str | None
    home_location_id: uuid.UUID | None
    home_location_name_snapshot: str | None
    home_location_identifier_snapshot: str | None
    borrower_name: str
    quantity: int
    returned_quantity: int
    outstanding_quantity: int
    status: LoanStatusName
    lent_on: date
    due_on: date | None
    notes: str | None
    overdue: bool
    days_past_due: int | None
    latest_returned_on: date | None
    created_by_user_id: uuid.UUID | None
    created_by_name: str | None
    cancelled_at: datetime | None
    created_at: datetime
    updated_at: datetime


class LoanReturnOut(BaseModel):
    id: uuid.UUID
    quantity: int
    returned_on: date
    notes: str | None
    created_by_name: str | None
    created_at: datetime
    reversed_at: datetime | None
    reversed_by_event_id: uuid.UUID | None


class ActivityEventOut(BaseModel):
    id: uuid.UUID
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    item_id: uuid.UUID | None
    container_id: uuid.UUID | None
    loan_id: uuid.UUID | None
    actor_user_id: uuid.UUID | None
    actor_name: str
    summary: str
    details: dict[str, Any]
    created_at: datetime
    undoes_event_id: uuid.UUID | None
    undo_event_id: uuid.UUID | None
    can_undo: bool
    undo_blocked_reason: str | None


class ActivityHistoryOut(BaseModel):
    items: list[ActivityEventOut]
    total: int
    limit: int
    offset: int


class LoanDetailOut(LoanOut):
    returns: list[LoanReturnOut]
    history: list[ActivityEventOut]


class LoanListOut(BaseModel):
    items: list[LoanOut]
    total: int
    limit: int
    offset: int
    outstanding_count: int
    overdue_count: int
    on_loan_quantity: int


class ItemLoanSummaryOut(BaseModel):
    item_id: uuid.UUID
    item_name: str
    owned_quantity: int
    on_loan_quantity: int
    available_quantity: int
    outstanding_loan_count: int
    overdue_count: int
    loans: list[LoanOut]


class UndoRequest(BaseModel):
    request_id: uuid.UUID


class UndoResult(BaseModel):
    event: ActivityEventOut
    undone_event_id: uuid.UUID
    message: str
