import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator

from ..domain import DocumentType
from ..schemas.common import Description, ItemReference, ORMModel, trimmed


class DocumentUpdate(BaseModel):
    title: trimmed(1, 200) | None = None
    document_type: DocumentType | None = None
    document_date: date | None = None
    merchant: trimmed(1, 160) | None = None
    notes: Description | None = None
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)


class DocumentBrief(ORMModel):
    id: uuid.UUID
    title: str
    document_type: str
    content_type: str
    url: str


class DocumentOut(ORMModel):
    id: uuid.UUID
    title: str
    document_type: str
    original_filename: str
    content_type: str
    original_content_type: str
    byte_size: int
    original_byte_size: int
    document_date: date | None
    merchant: str | None
    notes: str | None
    extracted_text: str | None
    extracted_metadata: dict[str, Any]
    ocr_status: str
    ocr_error: str | None
    ocr_confidence: int | None
    ocr_processed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    items: list[ItemReference]
    item_count: int
    url: str
    original_url: str


class DocumentList(BaseModel):
    items: list[DocumentOut]
    total: int
    limit: int
    offset: int


class OcrItemUpdate(BaseModel):
    item_id: uuid.UUID
    name: trimmed(1, 200) | None = None
    serial_number: trimmed(1, 200) | None = None


class OcrApplyRequest(BaseModel):
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    create_purchase: bool = True
    merchant: trimmed(1, 160) | None = None
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    order_number: trimmed(1, 120) | None = None
    notes: Description | None = None
    document_date: date | None = None
    attach_as_receipt: bool = True
    item_updates: list[OcrItemUpdate] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def _confirmable(self) -> "OcrApplyRequest":
        if self.create_purchase and not self.item_ids:
            raise ValueError("Choose at least one item for the confirmed purchase.")
        return self


class OcrApplyResponse(BaseModel):
    document: DocumentOut
    purchase_id: uuid.UUID | None
    updated_item_ids: list[uuid.UUID]
