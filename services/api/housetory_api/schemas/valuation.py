import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator

ValuationPurpose = Literal["resale", "replacement"]
ValuationSource = Literal["ai", "ai_web", "manual"]
ValuationConfidence = Literal["low", "medium", "high"]
MAX_VALUATION_CENTS = 10**12


class ValuationSourceOut(BaseModel):
    model_config = {"extra": "forbid"}

    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2000)
    snippet: str | None = Field(default=None, max_length=500)
    price_text: str | None = Field(default=None, max_length=80)
    price_cents: int | None = Field(default=None, ge=0, le=MAX_VALUATION_CENTS)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    currency_inferred: bool = False
    price_kind: Literal["asking"] = "asking"
    retrieved_on: date

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        lowered = value.strip().lower()
        if not lowered.startswith(("http://", "https://")):
            raise ValueError("Valuation sources must be absolute http(s) URLs.")
        return value.strip()


class ItemValueEstimateOut(BaseModel):
    model_config = {"extra": "forbid"}

    purpose: ValuationPurpose
    source: ValuationSource
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    low_cents: int | None = Field(default=None, ge=0, le=MAX_VALUATION_CENTS)
    high_cents: int | None = Field(default=None, ge=0, le=MAX_VALUATION_CENTS)
    as_of: date
    confidence: ValuationConfidence | None = None
    reasoning: str | None = Field(default=None, max_length=1200)
    assumptions: list[str] = Field(default_factory=list, max_length=5)
    web_used: bool = False
    web_reason: str | None = Field(default=None, max_length=500)
    sources: list[ValuationSourceOut] = Field(default_factory=list, max_length=5)


class ItemValuationEstimateIn(BaseModel):
    purpose: ValuationPurpose
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    include_web: bool = False


class ItemValuationPreviewOut(BaseModel):
    estimate_id: uuid.UUID
    item_id: uuid.UUID
    item_name: str
    fingerprint: str
    purpose: ValuationPurpose
    source: ValuationSource
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    low_cents: int = Field(ge=0, le=MAX_VALUATION_CENTS)
    suggested_cents: int = Field(ge=0, le=MAX_VALUATION_CENTS)
    high_cents: int = Field(ge=0, le=MAX_VALUATION_CENTS)
    owned_quantity: int = Field(ge=0)
    low_total_cents: int = Field(ge=0)
    suggested_total_cents: int = Field(ge=0)
    high_total_cents: int = Field(ge=0)
    as_of: date
    confidence: ValuationConfidence
    reasoning: str
    assumptions: list[str] = Field(default_factory=list)
    web_used: bool = False
    web_reason: str | None = None
    web_query: str | None = None
    sources: list[ValuationSourceOut] = Field(default_factory=list)
    existing_value_cents: int | None = None
    existing_value_basis: str | None = None
    existing_value_currency: str | None = None
    disclaimer: str


class ItemValuationApplyIn(BaseModel):
    estimate_id: uuid.UUID | None = None
    purpose: ValuationPurpose
    amount_cents: int = Field(ge=0, le=MAX_VALUATION_CENTS)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    expected_fingerprint: str = Field(min_length=64, max_length=64)


__all__ = [
    "ItemValueEstimateOut",
    "ItemValuationApplyIn",
    "ItemValuationEstimateIn",
    "ItemValuationPreviewOut",
    "MAX_VALUATION_CENTS",
    "ValuationConfidence",
    "ValuationPurpose",
    "ValuationSource",
    "ValuationSourceOut",
]
