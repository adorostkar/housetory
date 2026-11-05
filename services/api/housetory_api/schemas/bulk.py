import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

BULK_ITEM_LIMIT = 100
BULK_TAG_LIMIT = 20


class BulkItemRequest(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=BULK_ITEM_LIMIT)
    request_id: uuid.UUID

    @field_validator("item_ids")
    @classmethod
    def _unique_items(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(value) != len(set(value)):
            raise ValueError("Each selected item must appear once.")
        return value


class BulkMoveRequest(BulkItemRequest):
    room_id: uuid.UUID
    storage_location_id: uuid.UUID | None = None


class BulkTagRequest(BulkItemRequest):
    mode: Literal["add", "remove"]
    tag_ids: list[uuid.UUID] = Field(min_length=1, max_length=BULK_TAG_LIMIT)

    @field_validator("tag_ids")
    @classmethod
    def _dedupe_tags(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        return list(dict.fromkeys(value))


class BulkCategoryRequest(BulkItemRequest):
    mode: Literal["set", "clear"]
    category_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _category_mode(self) -> "BulkCategoryRequest":
        if self.mode == "set" and self.category_id is None:
            raise ValueError("Choose a category to set.")
        if self.mode == "clear" and self.category_id is not None:
            raise ValueError("Clearing a category does not take a category id.")
        return self


class BulkDestinationOut(BaseModel):
    room_id: uuid.UUID
    room_name: str
    storage_location_id: uuid.UUID | None
    storage_location_name: str | None
    storage_location_identifier: str | None
    path: list[dict[str, str | None]] = Field(default_factory=list)


class BulkMoveResult(BaseModel):
    request_id: uuid.UUID
    batch_id: uuid.UUID
    history_event_id: uuid.UUID
    selected_count: int
    moved_count: int
    unchanged_count: int
    selected_unit_count: int
    moved_unit_count: int
    on_loan_quantity: int
    moved_item_ids: list[uuid.UUID]
    destination: BulkDestinationOut


class BulkTagResult(BaseModel):
    request_id: uuid.UUID
    batch_id: uuid.UUID
    history_event_id: uuid.UUID
    mode: Literal["add", "remove"]
    selected_count: int
    updated_count: int
    unchanged_count: int
    tag_ids: list[uuid.UUID]
    tag_names: list[str]
    updated_item_ids: list[uuid.UUID]


class BulkCategoryResult(BaseModel):
    request_id: uuid.UUID
    batch_id: uuid.UUID
    history_event_id: uuid.UUID
    mode: Literal["set", "clear"]
    selected_count: int
    updated_count: int
    unchanged_count: int
    category_id: uuid.UUID | None
    category_name: str | None
    updated_item_ids: list[uuid.UUID]
