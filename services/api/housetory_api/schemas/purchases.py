import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, model_validator

from ..schemas.common import Description, ItemReference, ORMModel, trimmed
from ..schemas.documents import DocumentBrief


class PurchaseIn(BaseModel):
    """Purchase payload accepted by both the purchase and item endpoints.

    ``merchant`` is the Phase 3 name. ``vendor`` remains accepted and emitted so
    existing integrations and item forms keep working.
    """

    merchant: trimmed(1, 160) | None = None
    vendor: trimmed(1, 160) | None = None
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    order_number: trimmed(1, 120) | None = None
    notes: Description | None = None
    receipt_document_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _one_merchant_name(self) -> "PurchaseIn":
        if self.merchant and self.vendor and self.merchant != self.vendor:
            raise ValueError("merchant and vendor must not disagree.")
        return self

    @property
    def merchant_name(self) -> str | None:
        return self.merchant or self.vendor


class PurchaseCreate(PurchaseIn):
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def _at_least_one_item(self) -> "PurchaseCreate":
        if not self.item_ids:
            raise ValueError("A purchase must be linked to at least one item.")
        return self


class PurchaseUpdate(BaseModel):
    merchant: trimmed(1, 160) | None = None
    vendor: trimmed(1, 160) | None = None
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    order_number: trimmed(1, 120) | None = None
    notes: Description | None = None
    receipt_document_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _one_merchant_name(self) -> "PurchaseUpdate":
        if self.merchant and self.vendor and self.merchant != self.vendor:
            raise ValueError("merchant and vendor must not disagree.")
        return self

    @property
    def merchant_name(self) -> str | None:
        return self.merchant or self.vendor


class PurchaseAllocationOut(ORMModel):
    id: uuid.UUID
    item_id: uuid.UUID
    item: ItemReference
    document_id: uuid.UUID | None
    extraction_version: str | None
    source_line_id: str | None
    description: str
    quantity: int
    unit_price_cents: int | None
    line_total_cents: int | None
    allocated_cents: int | None
    currency: str
    source_evidence: str | None
    created_at: datetime


class PurchaseBrief(ORMModel):
    id: uuid.UUID
    merchant: str | None
    vendor: str | None
    purchase_date: date | None
    price_cents: int | None
    currency: str
    order_number: str | None
    notes: str | None
    receipt_document_id: uuid.UUID | None
    receipt: DocumentBrief | None
    item_count: int
    is_shared: bool
    created_at: datetime
    updated_at: datetime


class PurchaseOut(PurchaseBrief):
    items: list[ItemReference]
    allocations: list[PurchaseAllocationOut] = Field(default_factory=list)
    allocated_total_cents: int = 0
    unallocated_cents: int | None = None


class PurchaseList(BaseModel):
    items: list[PurchaseOut]
    total: int
    limit: int
    offset: int


class PurchaseMutationResponse(BaseModel):
    purchase: PurchaseOut
    updated_item_ids: list[uuid.UUID] = Field(default_factory=list)
