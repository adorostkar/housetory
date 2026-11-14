import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..domain import ItemCondition
from .ai import SearchPageReference
from .borrowed import BorrowedCreate, BorrowedReturnCreate
from .bulk import BULK_ITEM_LIMIT
from .common import Description, trimmed
from .lending import LoanCreate, LoanReturnCreate


class ItemEditChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: trimmed(1, 200) | None = None
    description: Description | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    quantity: int | None = Field(default=None, ge=0, le=1_000_000)
    condition: ItemCondition | None = None

    @model_validator(mode="after")
    def require_changes(self) -> "ItemEditChanges":
        if not self.model_fields_set:
            raise ValueError("Choose at least one change.")
        if any(
            field in self.model_fields_set and getattr(self, field) is None
            for field in ("name", "quantity", "condition")
        ):
            raise ValueError("Name, quantity and condition cannot be empty.")
        return self


class ItemEditProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["edit_item"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    item_id: uuid.UUID
    changes: ItemEditChanges


class ItemMoveProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["move_items"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=BULK_ITEM_LIMIT)
    room_id: uuid.UUID
    storage_location_id: uuid.UUID | None = None

    @field_validator("item_ids")
    @classmethod
    def unique_items(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Each selected item must appear once.")
        return value


class LendingProposalRequest(LoanCreate):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["lend"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    include_contents: Literal[False] = False
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4, exclude=True)


class LoanReturnProposalRequest(LoanReturnCreate):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["return_loan"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    loan_id: uuid.UUID
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4, exclude=True)


class BorrowingProposalRequest(BorrowedCreate):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["borrow"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4, exclude=True)


class BorrowedReturnProposalRequest(BorrowedReturnCreate):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["return_borrowed"]
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    record_id: uuid.UUID
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4, exclude=True)


class AssistantActionTarget(BaseModel):
    id: uuid.UUID
    name: str


class AssistantActionProposalOut(BaseModel):
    id: uuid.UUID
    kind: str
    state: str
    scope_label: str
    targets: list[AssistantActionTarget]
    changes: dict
    before: dict = Field(default_factory=dict)
    destination: AssistantActionTarget | None = None


class ItemEditReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    changes: ItemEditChanges


class ItemMoveReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    room_id: uuid.UUID
    storage_location_id: uuid.UUID | None = None


class LendingReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    borrower_name: trimmed(1, 120)
    quantity: int = Field(ge=1, le=1_000_000)
    lent_on: date
    due_on: date | None = None

    @model_validator(mode="after")
    def dates_in_order(self) -> "LendingReviewRequest":
        if self.due_on is not None and self.due_on < self.lent_on:
            raise ValueError("The due date cannot be before the lent date.")
        return self


class BorrowingReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_name: trimmed(1, 200)
    owner_name: trimmed(1, 120)
    quantity: int = Field(ge=1, le=1_000_000)
    borrowed_on: date
    due_on: date | None = None

    @model_validator(mode="after")
    def dates_in_order(self) -> "BorrowingReviewRequest":
        if self.due_on is not None and self.due_on < self.borrowed_on:
            raise ValueError("The due date cannot be before the borrowed date.")
        return self


class ReturnReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: int = Field(ge=1, le=1_000_000)
    returned_on: date


class AssistantMoveDestination(BaseModel):
    room_id: uuid.UUID
    storage_location_id: uuid.UUID | None
    name: str


class AssistantMoveDestinationList(BaseModel):
    items: list[AssistantMoveDestination]


class AssistantActionApplyRequest(BaseModel):
    request_id: uuid.UUID


class AssistantActionApplyOut(BaseModel):
    proposal_id: uuid.UUID
    request_id: uuid.UUID
    message: str


class AssistantActionStateOut(BaseModel):
    id: uuid.UUID
    state: str


class AssistantActionInterpretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=4000)
    local_date: date | None = None
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None
    page_context: list[SearchPageReference] = Field(default_factory=list, max_length=12)
    conversation_item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=6)
    clarified_item_id: uuid.UUID | None = None
    clarified_item_location: trimmed(1, 120) | None = None

    @model_validator(mode="after")
    def one_clarification(self) -> "AssistantActionInterpretRequest":
        if self.clarified_item_id and self.clarified_item_location:
            raise ValueError("Choose either an item or a location.")
        return self


class AssistantIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=4000)
    household_id: uuid.UUID | None = None
    scope_property_id: uuid.UUID | None = None


class AssistantIntentOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal[
        "question",
        "supported_action",
        "unsupported_action",
        "ambiguous",
        "create_item",
        "unavailable",
    ]
    form: Literal["items", "rooms", "loans", "documents", "account"] | None = None


class AssistantActionInterpretOut(BaseModel):
    handled: bool
    message: str
    proposal: AssistantActionProposalOut | None = None
    item_choices: list[AssistantActionTarget] = Field(default_factory=list)
    reason: (
        Literal[
            "model_schema",
            "ambiguity",
            "unsupported_semantics",
            "domain_resolution",
            "provider_unavailable",
        ]
        | None
    ) = None
