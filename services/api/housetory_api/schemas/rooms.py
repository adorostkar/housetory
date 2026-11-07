import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from ..schemas.common import Description, Name, ORMModel
from ..schemas.properties import PropertyBrief


class RoomCreate(BaseModel):
    name: Name
    description: Description | None = None
    property_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    sort_order: int = Field(default=0, ge=-10000, le=10000)


class RoomUpdate(BaseModel):
    name: Name | None = None
    description: Description | None = None
    parent_id: uuid.UUID | None = None
    sort_order: int | None = Field(default=None, ge=-10000, le=10000)


class RoomOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    property_id: uuid.UUID
    property: PropertyBrief
    parent_id: uuid.UUID | None
    sort_order: int
    item_count: int = 0
    location_count: int = 0
    total_item_count: int = 0
    total_location_count: int = 0
    recoverable_deleted_location_count: int = 0
    created_at: datetime
    updated_at: datetime


class RoomList(BaseModel):
    items: list[RoomOut]
