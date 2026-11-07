import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from ..domain import LocationKind
from ..schemas.common import Description, Name, ORMModel


class StorageLocationCreate(BaseModel):
    room_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    name: Name
    description: Description | None = None
    kind: LocationKind = LocationKind.SHELF
    sort_order: int = Field(default=0, ge=-10000, le=10000)


class StorageLocationUpdate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: Name | None = None
    description: Description | None = None
    kind: LocationKind | None = None
    sort_order: int | None = Field(default=None, ge=-10000, le=10000)


class StorageLocationOut(ORMModel):
    id: uuid.UUID
    room_id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    description: str | None
    kind: str
    is_container: bool = False
    container_type: str | None = None
    identifier: str | None = None
    summary_headline: str | None = None
    summary_short: str | None = None
    label_generated_at: datetime | None = None
    sort_order: int
    item_count: int = 0
    total_item_count: int = 0
    recoverable_deleted_child_count: int = 0
    created_at: datetime
    updated_at: datetime


class StorageLocationList(BaseModel):
    items: list[StorageLocationOut]
