import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class BuiltinOption(BaseModel):
    key: str
    label: str


class ItemImageOut(BaseModel):
    id: uuid.UUID | None = None
    source_type: Literal["reference", "ai", "builtin"]
    label: str
    status: str = "active"
    illustration_key: str | None = None
    url: str | None = None
    thumbnail_url: str | None = None
    width: int | None = None
    height: int | None = None
    source_name: str | None = None
    source_url: str | None = None
    source_page_url: str | None = None
    license_note: str | None = None
    retrieved_at: datetime | None = None
    exact_model_confirmed: bool = False
    model_label: str | None = None
    provider_label: str | None = None
    automatic: bool = False
    created_at: datetime | None = None


class ItemImageSettingsOut(BaseModel):
    auto_reference: bool = False
    auto_generate: bool = False
    daily_generation_cap: int = 10
    daily_generations_used: int = 0
    daily_generations_remaining: int = 10


class ItemImageState(BaseModel):
    item_id: uuid.UUID
    actual_photo_count: int = 0
    image: ItemImageOut | None = None
    selected: ItemImageOut | None = None
    automatic_builtin: ItemImageOut | None = None
    pending: list[ItemImageOut] = Field(default_factory=list)
    builtin_options: list[BuiltinOption] = Field(default_factory=list)
    settings: ItemImageSettingsOut
    search_configured: bool = False
    search_provider_label: str | None = None
    search_reason: str | None = None
    generation_configured: bool = False
    generation_provider_label: str | None = None
    generation_reason: str | None = None


class ItemImageFindRequest(BaseModel):
    force: bool = False


class BuiltinImageChoice(BaseModel):
    illustration_key: str = Field(min_length=1, max_length=40)


class ItemImageBatchPreviewRequest(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    action: Literal["reference", "illustration"]


class ItemImageBatchPreview(BaseModel):
    action: Literal["reference", "illustration"]
    selected_count: int
    eligible_count: int
    skipped_has_photo: int
    skipped_unavailable: int
    estimated_generations: int
    daily_generation_remaining: int
    hard_cap: int
    notices: list[str] = Field(default_factory=list)


class ItemImageBatchRequest(ItemImageBatchPreviewRequest):
    request_id: uuid.UUID


class ItemImageBatchJobOut(BaseModel):
    job_id: uuid.UUID
    status: str
    action: str
    total: int = 0
    completed: int = 0
    failed: int = 0
    skipped: int = 0
    error: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None


__all__ = [
    "BuiltinImageChoice",
    "BuiltinOption",
    "ItemImageBatchJobOut",
    "ItemImageBatchPreview",
    "ItemImageBatchPreviewRequest",
    "ItemImageBatchRequest",
    "ItemImageFindRequest",
    "ItemImageOut",
    "ItemImageSettingsOut",
    "ItemImageState",
]
