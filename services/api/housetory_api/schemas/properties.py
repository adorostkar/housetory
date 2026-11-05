import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from ..schemas.common import Description, Name, ORMModel


class PropertyBrief(ORMModel):
    id: uuid.UUID
    name: str
    is_archived: bool = False


class PropertyCreate(BaseModel):
    name: Name
    description: Description | None = None
    sort_order: int = Field(default=0, ge=-10000, le=10000)


class PropertyUpdate(BaseModel):
    name: Name | None = None
    description: Description | None = None
    sort_order: int | None = Field(default=None, ge=-10000, le=10000)
    is_archived: bool | None = None


class PropertyOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    sort_order: int
    is_archived: bool
    room_count: int = 0
    container_count: int = 0
    location_count: int = 0
    item_count: int = 0
    total_quantity: int = 0
    created_at: datetime
    updated_at: datetime


class PropertyList(BaseModel):
    items: list[PropertyOut] = Field(default_factory=list)


class RoomPropertyMoveRequest(BaseModel):
    property_id: uuid.UUID
    preview_fingerprint: str = Field(min_length=1, max_length=64)
    request_id: uuid.UUID


class RoomPropertyMovePreview(BaseModel):
    room_id: uuid.UUID
    room_name: str
    current_property: PropertyBrief
    destination_property: PropertyBrief
    descendant_room_count: int
    descendant_container_count: int
    item_count: int
    total_quantity: int
    on_loan_quantity: int
    fingerprint: str
    can_move: bool = True
    warning: str | None = None


class RoomPropertyMoveResult(RoomPropertyMovePreview):
    history_event_id: uuid.UUID
    affected_item_ids: list[uuid.UUID] = Field(default_factory=list)


class RoomPropertyMoveResponse(BaseModel):
    preview: RoomPropertyMovePreview
    result: RoomPropertyMoveResult | None = None


__all__ = [
    "PropertyBrief",
    "PropertyCreate",
    "PropertyList",
    "PropertyOut",
    "PropertyUpdate",
    "RoomPropertyMovePreview",
    "RoomPropertyMoveRequest",
    "RoomPropertyMoveResponse",
    "RoomPropertyMoveResult",
]
