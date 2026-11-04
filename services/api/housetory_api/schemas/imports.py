import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from ..schemas.common import Description, ORMModel, trimmed


class LocationCandidate(BaseModel):
    id: uuid.UUID
    name: str
    kind: str | None = None
    room_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    score: int = 0


class LocationProposal(BaseModel):
    text: str
    entity_type: Literal["room", "storage_location"]
    status: Literal["matched", "ambiguous", "missing", "none"] = "none"
    matched_id: uuid.UUID | None = None
    name: str | None = None
    room_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    suggested_parent_id: uuid.UUID | None = None
    candidates: list[LocationCandidate] = Field(default_factory=list)


class NamedMatch(BaseModel):
    text: str
    status: Literal["matched", "ambiguous", "missing", "none"] = "none"
    matched_id: uuid.UUID | None = None
    name: str | None = None
    candidates: list[LocationCandidate] = Field(default_factory=list)


class ProposedPurchase(BaseModel):
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    merchant: trimmed(1, 160) | None = None
    order_number: trimmed(1, 120) | None = None
    notes: Description | None = None


class ProposedWarranty(BaseModel):
    provider: trimmed(1, 160) | None = None
    start_date: date | None = None
    duration_months: int | None = Field(default=None, ge=1, le=1200)
    end_date: date | None = None
    notes: Description | None = None


class ProposedItem(BaseModel):
    name: trimmed(1, 200)
    description: Description | None = None
    quantity: int = Field(default=1, ge=0, le=1_000_000)
    category: NamedMatch | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    room: LocationProposal | None = None
    storage_location: LocationProposal | None = None
    purchase: ProposedPurchase | None = None
    warranty: ProposedWarranty | None = None
    tags: list[str] = Field(default_factory=list, max_length=50)
    notes: Description | None = None
    collection: trimmed(1, 200) | None = None
    relationships: dict[str, Any] = Field(default_factory=dict)
    field_sources: dict[str, str] = Field(default_factory=dict)
    confidence: int | None = Field(default=None, ge=0, le=100)

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        cleaned: list[str] = []
        for tag in value:
            name = tag.strip().lstrip("#")[:60]
            if name and name.lower() not in seen:
                seen.add(name.lower())
                cleaned.append(name)
        return cleaned[:50]


class DuplicateCandidate(BaseModel):
    item_id: uuid.UUID
    name: str
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    room_name: str | None = None
    location_name: str | None = None
    purchase_date: date | None = None
    score: int = 0
    reasons: list[str] = Field(default_factory=list)


class ImportSourceBrief(BaseModel):
    batch_id: uuid.UUID
    title: str
    source_path: str | None
    note_title: str | None
    source_excerpt: str | None
    created_at: datetime
    url: str


class ImportSourceFileOut(ORMModel):
    id: uuid.UUID
    relative_path: str
    kind: str
    content_type: str
    byte_size: int
    is_referenced: bool
    url: str


class ImportEntryOut(ORMModel):
    id: uuid.UUID
    source_file_id: uuid.UUID | None
    source_path: str | None
    source_excerpt: str | None
    note_title: str | None
    proposed: ProposedItem
    field_sources: dict[str, str]
    confidence: int | None
    status: str
    duplicate_candidates: list[DuplicateCandidate]
    duplicate_resolution: str | None
    matched_item_id: uuid.UUID | None
    imported_item_id: uuid.UUID | None
    error: str | None
    position: int


class ImportBatchOut(ORMModel):
    id: uuid.UUID
    title: str
    source_type: str
    status: str
    original_filename: str | None
    content_type: str | None
    byte_size: int | None
    error: str | None
    warnings: list[Any]
    total_entries: int
    imported_entries: int
    skipped_entries: int
    failed_entries: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    source_url: str | None
    entry_count: int = 0


class ImportBatchList(BaseModel):
    items: list[ImportBatchOut]
    total: int
    limit: int
    offset: int


class ImportBatchDetail(ImportBatchOut):
    entries: list[ImportEntryOut]
    files: list[ImportSourceFileOut]
    vault_tree: list[dict[str, Any]]
    ignored_notes: list[dict[str, Any]]
    broken_links: list[dict[str, Any]]
    metadata: dict[str, Any]


class ImportProposedInput(ProposedItem):
    pass


class ImportApplyEntry(BaseModel):
    id: uuid.UUID
    action: Literal["import", "skip", "reject", "merge"]
    proposed: ImportProposedInput | None = None
    merge_item_id: uuid.UUID | None = None
    merge_fields: list[
        Literal[
            "name",
            "description",
            "brand",
            "model",
            "serial_number",
            "quantity",
            "category",
            "room",
            "storage_location",
            "purchase",
            "warranty",
            "tags",
            "notes",
        ]
    ] = Field(default_factory=list)


class ImportApplyRequest(BaseModel):
    entries: list[ImportApplyEntry] = Field(min_length=1, max_length=1000)


class ImportApplyFailure(BaseModel):
    entry_id: uuid.UUID
    message: str


class ImportApplyResult(BaseModel):
    batch: ImportBatchDetail
    created: int
    merged: int
    skipped: int
    rejected: int
    failed: int
    failures: list[ImportApplyFailure]
