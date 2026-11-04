import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..schemas.common import Description, ORMModel, trimmed
from ..schemas.items import ItemSummary

AssistantTool = Literal[
    "search_items",
    "get_item_details",
    "search_locations",
    "list_room_contents",
    "get_container_contents",
    "search_documents",
    "get_purchase_history",
    "get_warranty_status",
    "get_inventory_summary",
    "find_missing_information",
    "list_outstanding_loans",
]


class AiStatus(BaseModel):
    provider: str
    mode: Literal["disabled", "local", "private", "cloud"]
    source: Literal["disabled", "environment", "database"] = "disabled"
    task: str = "assistant"
    provider_id: uuid.UUID | None = None
    provider_label: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    model: str | None
    configured: bool
    available: bool
    catalog_checked: bool = False
    catalog_count: int = 0
    # Kept for internal compatibility, but never serialize a provider catalog.
    models: list[str] = Field(default_factory=list, exclude=True)
    cloud_enabled: bool = False
    cloud_consent: bool = False
    data_leaves_server: bool = False
    error: str | None = None
    privacy_note: str


class AiImportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: trimmed(1, 200)
    description: Description | None = None
    quantity: int = Field(default=1, ge=0, le=1_000_000)
    category: trimmed(1, 80) | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    room: trimmed(1, 120) | None = None
    storage_location: trimmed(1, 120) | None = None
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    merchant: trimmed(1, 160) | None = None
    order_number: trimmed(1, 120) | None = None
    warranty_provider: trimmed(1, 160) | None = None
    warranty_start: date | None = None
    warranty_end: date | None = None
    warranty_months: int | None = Field(default=None, ge=1, le=1200)
    tags: list[str] = Field(default_factory=list, max_length=50)
    notes: Description | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)


class AiImportResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AiImportItem] = Field(max_length=200)
    warnings: list[str] = Field(default_factory=list)


class AiRecognitionSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: trimmed(1, 200)
    quantity: int = Field(default=1, ge=0, le=1_000_000)
    description: Description | None = None
    category: trimmed(1, 80) | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    notes: Description | None = None
    confidence: int | None = Field(default=None, ge=0, le=100)
    source: Literal["vision", "ocr"] = "vision"
    review: bool = False
    review_reason: str | None = Field(default=None, max_length=500)
    field_sources: dict[str, str] = Field(default_factory=dict)


class AiRecognitionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggestions: list[AiRecognitionSuggestion] = Field(max_length=30)
    warnings: list[str] = Field(default_factory=list)


class AiRecognitionDuplicateGroup(BaseModel):
    suggestion_index: int
    candidates: list[Any] = Field(default_factory=list)


class AiRecognitionOut(ORMModel):
    id: uuid.UUID
    status: str
    original_filename: str
    content_type: str
    width: int
    height: int
    result: dict[str, Any]
    field_sources: dict[str, str]
    confidence: int | None
    error: str | None
    model_provider: str | None
    model_name: str | None
    room_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    location_label: str | None = None
    suggestion_duplicates: list[AiRecognitionDuplicateGroup] = Field(default_factory=list)
    processing_mode: Literal["deterministic", "local", "private", "cloud", "unavailable"] = (
        "unavailable"
    )
    processing_path: Literal["vision", "ocr", "none", "failed", "unavailable"] = "unavailable"
    applied_at: datetime | None = None
    applied_items: list[Any] = Field(default_factory=list)
    created_at: datetime
    completed_at: datetime | None
    image_url: str
    original_url: str


class AiRecognitionList(BaseModel):
    items: list[AiRecognitionOut]


class AssistantHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class AssistantRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    history: list[AssistantHistoryMessage] = Field(default_factory=list, max_length=20)


class AssistantPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: AssistantTool
    arguments: dict[str, Any] = Field(default_factory=dict)
    rationale: str | None = Field(default=None, max_length=500)


class AssistantReference(BaseModel):
    type: Literal["item", "document", "room", "location", "purchase", "warranty"]
    id: uuid.UUID
    title: str
    subtitle: str | None = None
    url: str


class NaturalSearchFilters(BaseModel):
    q: str | None = None
    room_id: uuid.UUID | None = None
    room_name: str | None = None
    exclude_room_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    location_name: str | None = None
    category_id: uuid.UUID | None = None
    category_name: str | None = None
    tag: str | None = None
    missing_purchase: bool = False
    missing_serial: bool = False
    warranty_status: Literal["active", "expiring", "expired"] | None = None
    purchased_after: date | None = None
    purchased_before: date | None = None
    min_purchase_cents: int | None = None
    max_purchase_cents: int | None = None
    sort: Literal["relevance", "purchase_desc", "purchase_asc", "name_asc"] = "relevance"


class AiDocumentMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    merchant: str | None = Field(default=None, max_length=160)
    purchase_date: date | None = None
    total_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    product_names: list[str] | None = Field(default=None, max_length=50)
    invoice_number: str | None = Field(default=None, max_length=120)
    serial_numbers: list[str] | None = Field(default=None, max_length=50)
    brand: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)


class AiSearchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    q: str | None = Field(default=None, max_length=400)
    room_name: str | None = Field(default=None, max_length=200)
    location_name: str | None = Field(default=None, max_length=200)
    category_name: str | None = Field(default=None, max_length=120)
    tag: str | None = Field(default=None, max_length=80)
    missing_purchase: bool | None = None
    missing_serial: bool | None = None
    warranty_status: Literal["active", "expiring", "expired"] | None = None
    purchased_after: date | None = None
    purchased_before: date | None = None
    min_purchase_cents: int | None = Field(default=None, ge=0, le=10**12)
    max_purchase_cents: int | None = Field(default=None, ge=0, le=10**12)
    sort: Literal["relevance", "purchase_desc", "purchase_asc", "name_asc"] | None = None


class NaturalSearchRequest(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    limit: int = Field(default=30, ge=1, le=100)


class NaturalSearchResponse(BaseModel):
    question: str
    interpretation: str
    filters: NaturalSearchFilters
    items: list[ItemSummary]
    total: int
    mode: Literal["deterministic", "ai"]
    ai_available: bool


class AssistantResponse(BaseModel):
    answer: str
    mode: Literal["deterministic", "ai"]
    tool: str | None = None
    filters: dict[str, Any] = Field(default_factory=dict)
    items: list[ItemSummary] = Field(default_factory=list)
    documents: list[dict[str, Any]] = Field(default_factory=list)
    locations: list[dict[str, Any]] = Field(default_factory=list)
    references: list[AssistantReference] = Field(default_factory=list)
    notices: list[str] = Field(default_factory=list)
    ai_status: AiStatus


class DocumentRelationSuggestion(BaseModel):
    item: ItemSummary
    score: int
    reasons: list[str]


class DocumentRelations(BaseModel):
    items: list[DocumentRelationSuggestion]
    suggested_item_ids: list[uuid.UUID]


class AiRecognitionApplyEntry(BaseModel):
    suggestion_index: int = Field(ge=0, le=29)
    entry_key: str | None = Field(default=None, max_length=80)
    action: Literal["create", "update", "reject"] = "create"
    proposal: AiRecognitionSuggestion | None = None
    item_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    allow_duplicate: bool = False


class AiRecognitionApplyRequest(BaseModel):
    entries: list[AiRecognitionApplyEntry] = Field(min_length=1, max_length=30)


class AiRecognitionApplyResult(BaseModel):
    recognition: AiRecognitionOut
    created: int
    updated: int
    rejected: int
    skipped: int
    failed: int
    failures: list[dict[str, Any]] = Field(default_factory=list)


class AiHierarchyNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=200)
    name: trimmed(1, 200)
    entity_type: Literal["room", "container", "location"]
    legacy_identifier: trimmed(1, 120) | None = None
    container_type: trimmed(1, 20) | None = None


class AiHierarchyItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=200)
    name: trimmed(1, 200)
    quantity: int = Field(default=1, ge=0, le=1_000_000)


class AiHierarchyResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: list[AiHierarchyNode] = Field(default_factory=list, max_length=200)
    items: list[AiHierarchyItem] = Field(default_factory=list, max_length=2000)
    warnings: list[str] = Field(default_factory=list)
