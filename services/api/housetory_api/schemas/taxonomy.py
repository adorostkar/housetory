import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from ..schemas.common import Description, ORMModel, trimmed


class CategoryCreate(BaseModel):
    name: trimmed(1, 80)
    parent_id: uuid.UUID | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    description: Description | None = None
    sort_order: int = Field(default=0, ge=-10000, le=10000)


class CategoryUpdate(BaseModel):
    name: trimmed(1, 80) | None = None
    parent_id: uuid.UUID | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    description: Description | None = None
    sort_order: int | None = Field(default=None, ge=-10000, le=10000)


class CategoryOut(ORMModel):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None
    color: str | None
    description: str | None
    sort_order: int
    item_count: int = 0
    created_at: datetime
    updated_at: datetime


class CategoryList(BaseModel):
    items: list[CategoryOut]


class TagCreate(BaseModel):
    name: trimmed(1, 60)

    @field_validator("name")
    @classmethod
    def _normalize(cls, value: str) -> str:
        return value.strip()


class TagUpdate(BaseModel):
    name: trimmed(1, 60)


class TagOut(ORMModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    item_count: int = 0


class TagList(BaseModel):
    items: list[TagOut]
