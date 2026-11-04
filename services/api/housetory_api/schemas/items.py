import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from ..domain import ItemCondition
from ..schemas.common import Description, ORMModel, trimmed
from ..schemas.documents import DocumentList, DocumentOut
from ..schemas.purchases import PurchaseIn, PurchaseOut
from ..schemas.warranties import WarrantyIn, WarrantyOut


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
    parent_id: uuid.UUID | None = None


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
    purchase_id: uuid.UUID | None = None
    purchase: PurchaseIn | None = None
    warranty: WarrantyIn | None = None
    current_value_cents: int | None = Field(default=None, ge=0, le=10**12)
    current_value_currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")

    @model_validator(mode="after")
    def _one_purchase_source(self) -> "ItemCreate":
        if self.purchase_id is not None and self.purchase is not None:
            raise ValueError("Choose either an existing purchase or new purchase details.")
        return self


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
    purchase_id: uuid.UUID | None = None
    purchase: PurchaseIn | None = None
    warranty: WarrantyIn | None = None
    current_value_cents: int | None = Field(default=None, ge=0, le=10**12)
    current_value_currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    is_archived: bool | None = None

    @model_validator(mode="after")
    def _one_purchase_source(self) -> "ItemUpdate":
        if "purchase_id" in self.model_fields_set and "purchase" in self.model_fields_set:
            raise ValueError("Choose either an existing purchase or purchase details.")
        return self


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
    current_value_cents: int | None
    current_value_currency: str
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


class ItemTagsUpdate(BaseModel):
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)


__all__ = [
    "DocumentList",
    "DocumentOut",
    "ItemCreate",
    "ItemDetail",
    "ItemDetailResponse",
    "ItemList",
    "ItemSummary",
    "ItemTagsUpdate",
    "ItemUpdate",
    "PhotoList",
    "PhotoOut",
    "PurchaseIn",
    "PurchaseOut",
    "WarrantyIn",
    "WarrantyOut",
]
