import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from ..domain import ItemCondition
from ..schemas.common import Description, ORMModel, trimmed


class PurchaseIn(BaseModel):
    vendor: trimmed(1, 160) | None = None
    purchase_date: date | None = None
    price_cents: int | None = Field(default=None, ge=0, le=10**12)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    order_number: trimmed(1, 120) | None = None
    notes: Description | None = None


class PurchaseOut(ORMModel):
    vendor: str | None
    purchase_date: date | None
    price_cents: int | None
    currency: str
    order_number: str | None
    notes: str | None


class WarrantyIn(BaseModel):
    provider: trimmed(1, 160) | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: Description | None = None

    @field_validator("end_date")
    @classmethod
    def _dates_order(cls, value: date | None, info) -> date | None:  # noqa: ANN001
        start = info.data.get("start_date")
        if value is not None and start is not None and value < start:
            raise ValueError("Warranty end date must not precede its start date.")
        return value


class WarrantyOut(ORMModel):
    provider: str | None
    start_date: date | None
    end_date: date | None
    notes: str | None


class PhotoOut(ORMModel):
    id: uuid.UUID
    original_filename: str
    content_type: str
    byte_size: int
    width: int
    height: int
    sort_order: int
    created_at: datetime
    url: str
    thumbnail_url: str


class DocumentOut(ORMModel):
    id: uuid.UUID
    original_filename: str
    content_type: str
    byte_size: int
    title: str
    created_at: datetime
    url: str


class TagBrief(ORMModel):
    id: uuid.UUID
    name: str


class CategoryBrief(ORMModel):
    id: uuid.UUID
    name: str
    color: str | None


class RoomBrief(ORMModel):
    id: uuid.UUID
    name: str


class LocationBrief(ORMModel):
    id: uuid.UUID
    name: str
    kind: str


class ItemCreate(BaseModel):
    name: trimmed(1, 200)
    description: Description | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    quantity: int = Field(default=1, ge=0, le=1_000_000)
    condition: ItemCondition = ItemCondition.GOOD
    room_id: uuid.UUID | None = None
    storage_location_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)
    purchase: PurchaseIn | None = None
    warranty: WarrantyIn | None = None


class ItemUpdate(BaseModel):
    name: trimmed(1, 200) | None = None
    description: Description | None = None
    brand: trimmed(1, 120) | None = None
    model: trimmed(1, 120) | None = None
    serial_number: trimmed(1, 200) | None = None
    quantity: int | None = Field(default=None, ge=0, le=1_000_000)
    condition: ItemCondition | None = None
    room_id: uuid.UUID | None = None
    storage_location_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    tag_ids: list[uuid.UUID] | None = Field(default=None, max_length=30)
    purchase: PurchaseIn | None = None
    warranty: WarrantyIn | None = None
    is_archived: bool | None = None


class ItemSummary(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    brand: str | None
    model: str | None
    quantity: int
    condition: str
    is_archived: bool
    room: RoomBrief | None
    location: LocationBrief | None
    category: CategoryBrief | None
    tags: list[TagBrief]
    primary_photo: PhotoOut | None
    purchase: PurchaseOut | None
    warranty: WarrantyOut | None
    created_at: datetime
    updated_at: datetime


class ItemDetail(ItemSummary):
    serial_number: str | None
    photos: list[PhotoOut]
    documents: list[DocumentOut]


class ItemList(BaseModel):
    items: list[ItemSummary]
    total: int
    limit: int
    offset: int


class ItemDetailResponse(BaseModel):
    item: ItemDetail


class PhotoList(BaseModel):
    items: list[PhotoOut]


class DocumentList(BaseModel):
    items: list[DocumentOut]


class ItemTagsUpdate(BaseModel):
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)
