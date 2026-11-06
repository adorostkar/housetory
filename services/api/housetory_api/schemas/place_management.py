import uuid
from typing import Literal

from pydantic import BaseModel, Field

PlaceSourceKind = Literal["location", "room"]


class PlaceDestinationOut(BaseModel):
    property_id: uuid.UUID | None = None
    property_name: str | None = None
    room_id: uuid.UUID
    room_name: str
    location_id: uuid.UUID | None = None
    location_name: str | None = None
    location_identifier: str | None = None
    path: list[str] = Field(default_factory=list)


class PlacePreviewItemOut(BaseModel):
    id: uuid.UUID
    name: str
    quantity: int
    is_archived: bool
    place_label: str
    on_loan_quantity: int = 0


class PlacePreviewLocationOut(BaseModel):
    id: uuid.UUID
    name: str
    identifier: str | None = None
    kind: str
    is_container: bool = False
    total_item_count: int = 0
    total_quantity: int = 0


class PlacePreviewRoomOut(BaseModel):
    id: uuid.UUID
    name: str
    total_item_count: int = 0


class PlaceTransferPreviewOut(BaseModel):
    source_kind: PlaceSourceKind
    source_id: uuid.UUID
    source_label: str
    source_path: list[str] = Field(default_factory=list)
    destination: PlaceDestinationOut | None = None
    direct_item_count: int = 0
    nested_item_count: int = 0
    total_item_count: int = 0
    total_quantity: int = 0
    archived_item_count: int = 0
    on_loan_quantity: int = 0
    nested_place_count: int = 0
    child_room_count: int = 0
    borrowed_record_count: int = 0
    source_photo_count: int = 0
    items_preview: list[PlacePreviewItemOut] = Field(default_factory=list)
    nested_places_preview: list[PlacePreviewLocationOut] = Field(default_factory=list)
    child_rooms_preview: list[PlacePreviewRoomOut] = Field(default_factory=list)
    blockers: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    can_proceed: bool = False
    fingerprint: str


class PlaceTransferRequest(BaseModel):
    destination_room_id: uuid.UUID
    destination_location_id: uuid.UUID | None = None
    delete_source: bool = False
    expected_fingerprint: str = Field(min_length=16, max_length=128)
    request_id: uuid.UUID


class PlaceTransferResult(BaseModel):
    request_id: uuid.UUID
    history_event_id: uuid.UUID
    source_kind: PlaceSourceKind
    source_id: uuid.UUID
    source_label: str
    deleted: bool
    direct_items_moved: int
    nested_items_moved: int
    total_items_preserved: int
    total_quantity: int
    nested_places_moved: int
    child_rooms_moved: int
    borrowed_records_moved: int
    on_loan_quantity: int
    destination: PlaceDestinationOut


__all__ = [
    "PlaceDestinationOut",
    "PlacePreviewItemOut",
    "PlacePreviewLocationOut",
    "PlacePreviewRoomOut",
    "PlaceSourceKind",
    "PlaceTransferPreviewOut",
    "PlaceTransferRequest",
    "PlaceTransferResult",
]
