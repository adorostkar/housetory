import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from .evidence_exports import EvidenceScopeIn
from .valuation import ItemValuationPreviewOut


class InsuranceScopePreviewIn(BaseModel):
    scope: EvidenceScopeIn
    include_archived: bool = False


class InsuranceItemOut(BaseModel):
    item_id: uuid.UUID
    name: str
    description: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    quantity: int
    condition: str
    is_archived: bool
    valuation_fingerprint: str
    ai_eligible: bool
    ai_ineligible_reason: str | None = None


class InsuranceScopePreviewOut(BaseModel):
    items: list[InsuranceItemOut]
    scope_label: str
    archived_excluded_count: int = 0
    max_items: int


class InsuranceBatchIn(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=10)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    include_web: bool = False
    request_id: uuid.UUID


class InsuranceEstimateEntryOut(BaseModel):
    item_id: uuid.UUID
    status: Literal["queued", "running", "estimated", "failed", "cancelled"]
    estimate: ItemValuationPreviewOut | None = None
    error: str | None = None


class InsuranceBatchOut(BaseModel):
    request_id: uuid.UUID
    status: Literal["queued", "running", "completed", "partial", "cancelled"]
    total: int
    processed: int
    estimated: int
    failed: int
    items: list[InsuranceEstimateEntryOut]


class InsuranceValueIn(BaseModel):
    item_id: uuid.UUID
    estimate_id: uuid.UUID | None = None
    expected_fingerprint: str = Field(min_length=64, max_length=64)
    amount_cents: int = Field(ge=0, le=10**12)


class InsuranceListIn(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    reviewed_on: date
    values: list[InsuranceValueIn] = Field(default_factory=list, max_length=500)
    request_id: uuid.UUID


class InsuranceJobOut(BaseModel):
    id: uuid.UUID
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    error: str | None = None
    pdf_url: str | None = None
    csv_url: str | None = None


__all__ = [
    "InsuranceBatchIn",
    "InsuranceBatchOut",
    "InsuranceEstimateEntryOut",
    "InsuranceItemOut",
    "InsuranceJobOut",
    "InsuranceListIn",
    "InsuranceScopePreviewIn",
    "InsuranceScopePreviewOut",
    "InsuranceValueIn",
]
