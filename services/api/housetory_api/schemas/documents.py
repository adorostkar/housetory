import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from ..domain import DocumentType
from ..schemas.common import Description, ItemReference, ORMModel, trimmed


def _full_corners() -> list["ScanPoint"]:
    return [
        ScanPoint(x=0.0, y=0.0),
        ScanPoint(x=1.0, y=0.0),
        ScanPoint(x=1.0, y=1.0),
        ScanPoint(x=0.0, y=1.0),
    ]


def _validate_corners(corners: list["ScanPoint"]) -> list["ScanPoint"]:
    if len(corners) != 4:
        raise ValueError("Choose exactly four page corners.")
    area = abs(
        sum(
            corners[index].x * corners[(index + 1) % 4].y
            - corners[(index + 1) % 4].x * corners[index].y
            for index in range(4)
        )
        / 2
    )
    if area < 0.01:
        raise ValueError("Choose a larger page area.")
    return corners


class ScanPoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class ScanAdjustments(BaseModel):
    rotation: Literal[0, 90, 180, 270] = 0
    corners: list[ScanPoint] = Field(default_factory=_full_corners)
    color_mode: Literal["color", "grayscale", "document"] = "color"
    contrast: float = Field(default=1.0, ge=0.5, le=2.0)

    @field_validator("corners")
    @classmethod
    def _corners_valid(cls, value: list[ScanPoint]) -> list[ScanPoint]:
        return _validate_corners(value)


class DocumentScanPageUpdate(BaseModel):
    rotation: Literal[0, 90, 180, 270] | None = None
    corners: list[ScanPoint] | None = Field(default=None, min_length=4, max_length=4)
    color_mode: Literal["color", "grayscale", "document"] | None = None
    contrast: float | None = Field(default=None, ge=0.5, le=2.0)

    @field_validator("corners")
    @classmethod
    def _corners_valid(cls, value: list[ScanPoint] | None) -> list[ScanPoint] | None:
        if value is not None:
            _validate_corners(value)
        return value


class DocumentPageOut(BaseModel):
    id: uuid.UUID
    page_number: int
    width: int
    height: int
    original_filename: str
    original_content_type: str
    original_byte_size: int
    cleaned_content_type: str
    cleaned_byte_size: int
    original_url: str
    cleaned_url: str
    adjustments: ScanAdjustments
    updated_at: datetime


class DocumentScanOut(BaseModel):
    id: uuid.UUID
    status: Literal["draft", "committed"]
    pages: list[DocumentPageOut]
    created_at: datetime
    updated_at: datetime


class DocumentScanReorder(BaseModel):
    page_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)

    @field_validator("page_ids")
    @classmethod
    def _unique_pages(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(value) != len(set(value)):
            raise ValueError("Each page must appear once.")
        return value


class DocumentScanCommit(BaseModel):
    request_id: uuid.UUID
    title: trimmed(1, 200) | None = None
    document_type: DocumentType = DocumentType.OTHER
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    merchant: trimmed(1, 160) | None = None
    document_date: date | None = None
    notes: Description | None = None


class DocumentItemLink(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


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
    pages: list[DocumentPageOut] = Field(default_factory=list)
    page_count: int = 0
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
