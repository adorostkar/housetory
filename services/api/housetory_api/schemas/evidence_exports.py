import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

EvidenceExportStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "expired"]
EvidenceDocumentKind = Literal["receipt", "warranty", "manual", "other"]


class EvidenceScopeIn(BaseModel):
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    room_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    container_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    include_home: bool = False

    @model_validator(mode="after")
    def _not_empty(self) -> "EvidenceScopeIn":
        if (
            not self.include_home
            and not self.item_ids
            and not self.room_ids
            and not self.container_ids
        ):
            raise ValueError("Choose at least one item, room, container or the current home.")
        return self

    def as_json(self) -> dict[str, Any]:
        return {
            "item_ids": [str(value) for value in self.item_ids],
            "room_ids": [str(value) for value in self.room_ids],
            "container_ids": [str(value) for value in self.container_ids],
            "include_home": self.include_home,
        }


class EvidenceOptionsIn(BaseModel):
    include_photos: bool = True
    include_receipts: bool = True
    include_warranty_documents: bool = True
    include_manuals: bool = False
    include_other_documents: bool = False
    include_document_originals: bool = True
    include_csv: bool = True
    include_attachments: bool = True
    excluded_document_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)


class EvidencePreviewIn(BaseModel):
    scope: EvidenceScopeIn
    include_archived: bool = False
    options: EvidenceOptionsIn = Field(default_factory=EvidenceOptionsIn)


class EvidenceCreateIn(EvidencePreviewIn):
    fingerprint: str = Field(min_length=1, max_length=64)
    request_id: uuid.UUID


class EvidenceItemPreview(BaseModel):
    id: uuid.UUID
    name: str
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    quantity: int
    on_loan_quantity: int
    at_home_quantity: int
    condition: str
    is_archived: bool
    category: str | None = None
    full_location_path: str
    purchase_info_status: str
    purchase_currency: str | None = None
    item_allocation_cents: int | None = None
    current_value_cents: int | None = None
    current_value_currency: str | None = None
    photo_count: int
    document_count: int


class EvidenceDocumentPreview(BaseModel):
    id: uuid.UUID
    title: str
    document_type: str
    evidence_kind: EvidenceDocumentKind
    merchant: str | None = None
    document_date: date | None = None
    byte_size: int
    original_byte_size: int
    scan_page_count: int = 0
    original_available: bool = True
    normalized_available: bool = True
    shared_with_unselected: bool = False
    category_included: bool = True
    excluded_by_user: bool = False
    included: bool = True
    selected_item_ids: list[uuid.UUID] = Field(default_factory=list)


class EvidenceCurrencyTotal(BaseModel):
    currency: str
    selected_allocated_purchase_cents: int
    current_value_cents: int
    allocated_item_count: int
    current_value_item_count: int


class EvidencePurchaseReference(BaseModel):
    purchase_id: uuid.UUID
    merchant: str | None = None
    purchase_date: date | None = None
    total_cents: int | None = None
    currency: str
    item_count_in_household: int
    selected_item_count: int
    allocated_total_cents: int
    selected_allocated_cents: int
    unallocated_cents: int | None = None
    has_unselected_items: bool
    has_allocations: bool
    receipt_document_id: uuid.UUID | None = None


class EvidencePreviewOut(BaseModel):
    fingerprint: str
    format_version: str
    household_name: str
    generated_at: datetime
    timezone: str
    scope_label: str
    scope: dict[str, Any]
    include_archived: bool
    options: EvidenceOptionsIn
    item_count: int
    unit_count: int
    at_home_unit_count: int
    on_loan_unit_count: int
    archived_excluded_count: int = 0
    missing_purchase_count: int = 0
    photo_count: int
    included_photo_count: int
    photo_bytes: int
    document_count: int
    included_document_count: int
    document_bytes: int
    evidence_reference_count: int
    bundle_estimated_bytes: int
    max_bundle_bytes: int
    bundle_within_limit: bool
    can_generate: bool
    items: list[EvidenceItemPreview] = Field(default_factory=list)
    documents: list[EvidenceDocumentPreview] = Field(default_factory=list)
    currency_totals: list[EvidenceCurrencyTotal] = Field(default_factory=list)
    purchase_references: list[EvidencePurchaseReference] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class EvidenceExportOut(BaseModel):
    id: uuid.UUID
    status: EvidenceExportStatus
    format_version: str
    scope_label: str
    scope: dict[str, Any]
    include_archived: bool
    options: EvidenceOptionsIn
    item_count: int
    unit_count: int
    evidence_counts: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    created_at: datetime
    completed_at: datetime | None = None
    expires_at: datetime | None = None
    pdf_available: bool = False
    csv_available: bool = False
    bundle_available: bool = False
    pdf_bytes: int | None = None
    csv_bytes: int | None = None
    bundle_bytes: int | None = None
    pdf_sha256: str | None = None
    csv_sha256: str | None = None
    bundle_sha256: str | None = None
    can_manage: bool = False


class EvidenceExportList(BaseModel):
    items: list[EvidenceExportOut] = Field(default_factory=list)
