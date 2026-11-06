import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..domain import ItemCondition
from ..schemas.common import Description, ORMModel, trimmed
from ..schemas.documents import DocumentList, DocumentOut
from ..schemas.households import HouseholdBrief
from ..schemas.imports import ImportSourceBrief
from ..schemas.item_images import ItemImageOut
from ..schemas.properties import PropertyBrief
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
    identifier: str | None = None
    container_type: str | None = None
    is_container: bool = False


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
    purchase_info_status: Literal["auto", "unknown", "not_applicable"] = "auto"
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
    purchase_info_status: Literal["auto", "unknown", "not_applicable"] | None = None
    warranty: WarrantyIn | None = None
    current_value_cents: int | None = Field(default=None, ge=0, le=10**12)
    current_value_currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    is_archived: bool | None = None

    @model_validator(mode="after")
    def _one_purchase_source(self) -> "ItemUpdate":
        if "purchase_id" in self.model_fields_set and "purchase" in self.model_fields_set:
            raise ValueError("Choose either an existing purchase or purchase details.")
        return self


class LastVerifiedOut(BaseModel):
    at: datetime
    session_id: uuid.UUID | None = None
    status: str
    quantity: int
    owned_quantity: int
    on_loan_quantity: int
    location_path: str = ""
    room_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    stale: bool = False
    stale_reason: str | None = None


class ItemSummary(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    brand: str | None
    model: str | None
    quantity: int
    on_loan_quantity: int = 0
    condition: str
    is_archived: bool
    room: RoomBrief | None
    household: HouseholdBrief | None = None
    property: PropertyBrief | None = None
    location: LocationBrief | None
    location_path: list[LocationBrief] = Field(default_factory=list)
    category: CategoryBrief | None
    tags: list[TagBrief]
    primary_photo: PhotoOut | None
    representative_image: ItemImageOut | None = None
    purchase: PurchaseOut | None
    purchase_info_status: Literal["recorded", "unrecorded", "unknown", "not_applicable"] = (
        "unrecorded"
    )
    purchase_info_missing_fields: list[Literal["date", "price"]] = Field(default_factory=list)
    warranty: WarrantyOut | None
    current_value_cents: int | None
    current_value_currency: str
    created_at: datetime
    updated_at: datetime
    last_verified: LastVerifiedOut | None = None


class ItemDetail(ItemSummary):
    serial_number: str | None
    photos: list[PhotoOut]
    documents: list[DocumentOut]
    import_source: ImportSourceBrief | None = None


class ItemList(BaseModel):
    items: list[ItemSummary]
    total: int
    limit: int
    offset: int


class ItemDetailResponse(BaseModel):
    item: ItemDetail


class PhotoOrderRequest(BaseModel):
    photo_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


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
    "LastVerifiedOut",
    "PhotoList",
    "PhotoOut",
    "PurchaseIn",
    "PurchaseOut",
    "WarrantyIn",
    "WarrantyOut",
]
