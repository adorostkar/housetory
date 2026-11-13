import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..schemas.ai import AiStatus
from ..schemas.common import Description, ItemReference, trimmed
from ..schemas.documents import DocumentBrief, DocumentOut
from ..schemas.purchases import PurchaseIn
from .enrichment import EnhancementState

LineKind = Literal[
    "product",
    "discount",
    "tax",
    "shipping",
    "payment",
    "change",
    "other",
]
MatchQuality = Literal["exact_identifier", "strong", "possible", "none"]
LineAction = Literal["skip", "link", "update", "create"]


class SourceEvidence(BaseModel):
    page: int | None = Field(default=None, ge=1)
    line_number: int | None = Field(default=None, ge=1)
    text: str = Field(default="", max_length=1000)


class ExtractionFields(BaseModel):
    merchant: str | None = Field(default=None, max_length=160)
    purchase_date: date | None = None
    document_date: date | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    total_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    subtotal_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    tax_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    discount_cents: int | None = Field(default=None, ge=0, le=10**12)
    shipping_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    order_number: str | None = Field(default=None, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)
    serial_numbers: list[str] = Field(default_factory=list, max_length=50)
    warranty_provider: str | None = Field(default=None, max_length=160)
    warranty_start: date | None = None
    warranty_end: date | None = None
    warranty_months: int | None = Field(default=None, ge=1, le=1200)
    field_sources: dict[str, str] = Field(default_factory=dict)
    uncertain_fields: list[str] = Field(default_factory=list)


class ExtractionLine(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    line_number: int = Field(ge=1)
    kind: LineKind
    description: str = Field(min_length=1, max_length=300)
    quantity: int | None = Field(default=None, ge=1, le=100_000)
    unit_price_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    line_total_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    evidence: SourceEvidence
    warnings: list[str] = Field(default_factory=list)
    purchase_eligible: bool = True


class FinancialCheck(BaseModel):
    code: str
    severity: Literal["warning", "error"] = "warning"
    message: str
    line_ids: list[str] = Field(default_factory=list)


class FinancialComputedTotals(BaseModel):
    product_total_cents: int | None = None
    discount_cents: int | None = None
    shipping_cents: int | None = None
    tax_cents: int | None = None
    expected_total_cents: int | None = None
    total_difference_cents: int | None = None


class FinancialValidation(BaseModel):
    status: Literal["consistent", "needs_attention", "insufficient_evidence"] = (
        "insufficient_evidence"
    )
    tax_treatment: Literal["inclusive", "exclusive", "unknown"] = "unknown"
    computed: FinancialComputedTotals = Field(default_factory=FinancialComputedTotals)
    checks: list[FinancialCheck] = Field(default_factory=list)


class CandidatePurchase(BaseModel):
    id: uuid.UUID
    merchant: str | None
    purchase_date: date | None
    price_cents: int | None
    currency: str


class CandidateWarranty(BaseModel):
    provider: str | None
    start_date: date | None
    end_date: date | None
    duration_months: int | None


class CandidateItem(BaseModel):
    id: uuid.UUID
    name: str
    brand: str | None
    model: str | None
    serial_number: str | None
    quantity: int
    on_loan_quantity: int = 0
    room_name: str | None
    location_name: str | None
    purchase: CandidatePurchase | None
    warranty: CandidateWarranty | None = None
    reasons: list[str] = Field(default_factory=list)
    match_quality: MatchQuality = "possible"
    exact_identifier: bool = False


class LineMatch(BaseModel):
    line_id: str
    candidates: list[CandidateItem] = Field(default_factory=list)
    quality: MatchQuality = "none"
    reasons: list[str] = Field(default_factory=list)


class DuplicateDocumentBrief(DocumentBrief):
    created_at: datetime


class ExtractionApplySummary(BaseModel):
    request_id: uuid.UUID
    applied_at: datetime
    created_item_ids: list[uuid.UUID] = Field(default_factory=list)
    updated_item_ids: list[uuid.UUID] = Field(default_factory=list)
    linked_item_ids: list[uuid.UUID] = Field(default_factory=list)
    skipped_line_ids: list[str] = Field(default_factory=list)
    purchase_id: uuid.UUID | None = None


class ExtractionReviewOut(BaseModel):
    document_id: uuid.UUID
    version: str
    source_artifact: str
    document_type: str
    generated_at: datetime
    purchase_eligible: bool
    fields: ExtractionFields
    lines: list[ExtractionLine]
    warnings: list[str] = Field(default_factory=list)
    financial_validation: FinancialValidation = Field(default_factory=FinancialValidation)
    matches: list[LineMatch] = Field(default_factory=list)
    duplicate_documents: list[DuplicateDocumentBrief] = Field(default_factory=list)
    applied: list[ExtractionApplySummary] = Field(default_factory=list)
    ai_status: AiStatus
    enhancement: EnhancementState | None = None
    suggested_refinement: "ExtractionRefinementOut | None" = None


class LineMatchInput(BaseModel):
    line_id: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=300)
    quantity: int | None = Field(default=None, ge=1, le=100_000)
    brand: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)
    serial_numbers: list[str] = Field(default_factory=list, max_length=20)


class ExtractionMatchRequest(BaseModel):
    lines: list[LineMatchInput] | None = Field(default=None, max_length=30)
    use_ai: bool = False


class ExtractionMatchOut(BaseModel):
    document_id: uuid.UUID
    version: str
    matches: list[LineMatch] = Field(default_factory=list)
    ai_status: AiStatus
    ai_used: bool = False
    warnings: list[str] = Field(default_factory=list)


class AiLineRanking(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line_id: str = Field(min_length=1, max_length=80)
    candidate_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5)
    reasons: list[str] = Field(default_factory=list, max_length=5)


class AiExtractionMatchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    matches: list[AiLineRanking] = Field(default_factory=list, max_length=30)
    warnings: list[str] = Field(default_factory=list, max_length=20)


class ExtractionNewItem(BaseModel):
    name: trimmed(1, 200)
    description: Description | None = None
    quantity: int = Field(default=1, ge=1, le=1_000_000)
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    room_id: uuid.UUID
    storage_location_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class ExtractionItemUpdates(BaseModel):
    name: trimmed(1, 200) | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    room_id: uuid.UUID | None = None
    storage_location_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class ExtractionWarranty(BaseModel):
    provider: trimmed(1, 160) | None = None
    start_date: date | None = None
    duration_months: int | None = Field(default=None, ge=1, le=1200)
    end_date: date | None = None
    reminder_days: int | None = Field(default=None, ge=1, le=3650)
    notes: Description | None = None


class ExtractionLineDecision(BaseModel):
    line_id: str = Field(min_length=1, max_length=80)
    action: LineAction = "skip"
    item_id: uuid.UUID | None = None
    new_item: ExtractionNewItem | None = None
    updates: ExtractionItemUpdates | None = None
    add_quantity: bool = False
    quantity: int | None = Field(default=None, ge=1, le=1_000_000)
    line_total_cents: int | None = Field(default=None, ge=0, le=10**12)
    warranty: ExtractionWarranty | None = None


class ExtractionDocumentFieldsUpdate(BaseModel):
    merchant: trimmed(1, 160) | None = None
    document_date: date | None = None


class ExtractionApplyRequest(BaseModel):
    request_id: uuid.UUID
    extraction_version: str = Field(min_length=1, max_length=80)
    document_fields: ExtractionDocumentFieldsUpdate | None = None
    purchase_action: Literal["none", "create", "existing"] = "none"
    purchase_id: uuid.UUID | None = None
    purchase: PurchaseIn | None = None
    attach_as_receipt: bool = True
    link_document: bool = True
    allow_reapply: bool = False
    lines: list[ExtractionLineDecision] = Field(default_factory=list, max_length=50)

    @field_validator("lines")
    @classmethod
    def _unique_lines(cls, value: list[ExtractionLineDecision]) -> list[ExtractionLineDecision]:
        ids = [entry.line_id for entry in value]
        if len(ids) != len(set(ids)):
            raise ValueError("Each extracted line may be reviewed once.")
        return value


class ExtractionApplyResult(BaseModel):
    document: DocumentOut
    request_id: uuid.UUID
    created_item_ids: list[uuid.UUID] = Field(default_factory=list)
    updated_item_ids: list[uuid.UUID] = Field(default_factory=list)
    linked_item_ids: list[uuid.UUID] = Field(default_factory=list)
    skipped_line_ids: list[str] = Field(default_factory=list)
    purchase_id: uuid.UUID | None = None
    warranty_item_ids: list[uuid.UUID] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    applied_at: datetime
    items: list[ItemReference] = Field(default_factory=list)


class AiRefinedFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    merchant: trimmed(1, 160) | None = None
    purchase_date: date | None = None
    document_date: date | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    total_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    subtotal_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    tax_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    discount_cents: int | None = Field(default=None, ge=0, le=10**12)
    shipping_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    order_number: str | None = Field(default=None, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)
    serial_numbers: list[str] = Field(default_factory=list, max_length=50)
    warranty_provider: str | None = Field(default=None, max_length=160)
    warranty_start: date | None = None
    warranty_end: date | None = None
    warranty_months: int | None = Field(default=None, ge=1, le=1200)
    evidence: dict[str, str] = Field(default_factory=dict)


class AiRefinedLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str = Field(min_length=1, max_length=300)
    kind: LineKind
    quantity: int | None = Field(default=None, ge=1, le=100_000)
    unit_price_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    line_total_cents: int | None = Field(default=None, ge=-(10**12), le=10**12)
    evidence: str = Field(min_length=1, max_length=1000)
    uncertainty: list[str] = Field(default_factory=list, max_length=10)


class AiExtractionRefinementResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fields: AiRefinedFields = Field(default_factory=AiRefinedFields)
    lines: list[AiRefinedLine] = Field(default_factory=list, max_length=50)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    notes: list[str] = Field(default_factory=list, max_length=20)


class ExtractionRefinementOut(BaseModel):
    document_id: uuid.UUID
    base_version: str
    version: str
    source_artifact: str
    generated_at: datetime
    fields: ExtractionFields
    lines: list[ExtractionLine]
    warnings: list[str] = Field(default_factory=list)
    financial_validation: FinancialValidation = Field(default_factory=FinancialValidation)
    matches: list[LineMatch] = Field(default_factory=list)
    ai_status: AiStatus
    ai_used: bool = False
