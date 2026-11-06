import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..schemas.common import Description, trimmed
from ..schemas.lending import ActivityEventOut

BorrowedStatusName = Literal["outstanding", "partially_returned", "returned", "cancelled"]
BorrowedFilterStatus = Literal[
    "all", "open", "outstanding", "partially_returned", "returned", "cancelled"
]


class BorrowedCreate(BaseModel):
    item_name: trimmed(1, 200)
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    owner_name: trimmed(1, 120)
    quantity: int = Field(ge=1, le=1_000_000)
    borrowed_on: date
    due_on: date | None = None
    property_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    storage_location_id: uuid.UUID | None = None
    notes: Description | None = None
    request_id: uuid.UUID

    @model_validator(mode="after")
    def _dates_in_order(self) -> "BorrowedCreate":
        if self.due_on is not None and self.due_on < self.borrowed_on:
            raise ValueError("The due date cannot be before the borrowed date.")
        return self


class BorrowedCorrect(BaseModel):
    item_name: trimmed(1, 200) | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    owner_name: trimmed(1, 120) | None = None
    quantity: int | None = Field(default=None, ge=1, le=1_000_000)
    borrowed_on: date | None = None
    due_on: date | None = None
    property_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    storage_location_id: uuid.UUID | None = None
    notes: Description | None = None
    request_id: uuid.UUID


class BorrowedReturnCreate(BaseModel):
    quantity: int = Field(ge=1, le=1_000_000)
    returned_on: date
    notes: Description | None = None
    request_id: uuid.UUID


class BorrowedCancelRequest(BaseModel):
    reason: trimmed(1, 500) | None = None
    request_id: uuid.UUID


class BorrowedPhotoOut(BaseModel):
    id: uuid.UUID
    original_filename: str
    content_type: str
    byte_size: int
    width: int
    height: int
    created_at: datetime
    url: str
    thumbnail_url: str


class BorrowedOut(BaseModel):
    id: uuid.UUID
    direction: Literal["borrowed"] = "borrowed"
    household_id: uuid.UUID | None = None
    household_name: str | None = None
    item_name: str
    brand: str | None = None
    model: str | None = None
    owner_name: str
    quantity: int
    returned_quantity: int
    outstanding_quantity: int
    physically_held_quantity: int
    status: BorrowedStatusName
    borrowed_on: date
    due_on: date | None = None
    notes: str | None = None
    overdue: bool
    days_past_due: int | None = None
    latest_returned_on: date | None = None
    property_id: uuid.UUID | None = None
    property_name: str | None = None
    room_id: uuid.UUID | None = None
    room_name: str | None = None
    storage_location_id: uuid.UUID | None = None
    storage_location_name: str | None = None
    storage_location_identifier: str | None = None
    photo: BorrowedPhotoOut | None = None
    created_by_user_id: uuid.UUID | None = None
    created_by_name: str | None = None
    cancelled_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class BorrowedReturnOut(BaseModel):
    id: uuid.UUID
    quantity: int
    returned_on: date
    notes: str | None = None
    created_by_name: str | None = None
    created_at: datetime


class BorrowedDetailOut(BorrowedOut):
    returns: list[BorrowedReturnOut] = Field(default_factory=list)
    history: list[ActivityEventOut] = Field(default_factory=list)


class BorrowedListOut(BaseModel):
    items: list[BorrowedOut]
    total: int
    limit: int
    offset: int
    open_count: int = 0
    overdue_count: int = 0
    total_borrowed_quantity: int = 0
    outstanding_quantity: int = 0
    returned_quantity: int = 0
    physically_held_quantity: int = 0


__all__ = [
    "BorrowedCancelRequest",
    "BorrowedCorrect",
    "BorrowedCreate",
    "BorrowedDetailOut",
    "BorrowedFilterStatus",
    "BorrowedListOut",
    "BorrowedOut",
    "BorrowedPhotoOut",
    "BorrowedReturnCreate",
    "BorrowedReturnOut",
    "BorrowedStatusName",
]
