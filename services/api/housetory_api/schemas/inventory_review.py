import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from .common import trimmed

ReviewScopeType = Literal["items", "room", "container", "property", "household"]
ReviewSuggestionType = Literal[
    "category",
    "name",
    "possible_duplicate",
    "missing_detail",
    "location_conflict",
]
ReviewSuggestionStatus = Literal["pending", "accepted", "dismissed", "stale", "reverted"]
ReviewActionKind = Literal["apply_category", "apply_name", "advisory"]


class ReviewRunRequest(BaseModel):
    scope_type: ReviewScopeType
    scope_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    include_ai: bool = False
    request_id: uuid.UUID

    @model_validator(mode="after")
    def _scope_shape(self) -> "ReviewRunRequest":
        if self.scope_type == "items":
            if not self.item_ids:
                raise ValueError("Select at least one item to review.")
            if self.scope_id is not None:
                raise ValueError("A selected-items review does not take a scope id.")
            if len(self.item_ids) != len(set(self.item_ids)):
                raise ValueError("Each selected item must appear once.")
        elif self.scope_type == "household":
            if self.scope_id is not None or self.item_ids:
                raise ValueError("A household review does not take a scope id or items.")
        else:
            if self.scope_id is None:
                raise ValueError("Choose the property, room or container to review.")
            if self.item_ids:
                raise ValueError("A place review uses one scope id, not item ids.")
        return self


class ReviewRunOut(BaseModel):
    id: uuid.UUID
    request_id: uuid.UUID
    scope_type: ReviewScopeType
    scope_id: uuid.UUID | None = None
    scope_label: str
    include_ai: bool
    status: Literal["completed", "partial", "failed"]
    total_item_count: int
    item_count_scanned: int
    created_suggestion_count: int
    existing_suggestion_count: int
    stale_suggestion_count: int
    suppressed_suggestion_count: int
    ai_used: bool
    ai_provider_label: str | None = None
    ai_model: str | None = None
    ai_error: str | None = None
    partial_reason: str | None = None
    created_at: datetime
    completed_at: datetime | None = None


class ReviewSuggestionOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID | None = None
    type: ReviewSuggestionType
    action_kind: ReviewActionKind
    status: ReviewSuggestionStatus
    source: str
    priority: int
    title: str
    explanation: str
    scope_type: ReviewScopeType
    scope_id: uuid.UUID | None = None
    item_id: uuid.UUID | None = None
    secondary_item_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    fingerprint: str
    created_at: datetime
    updated_at: datetime
    accepted_at: datetime | None = None
    applied_at: datetime | None = None
    dismissed_at: datetime | None = None
    reverted_at: datetime | None = None
    can_undo: bool = False
    undo_blocked_reason: str | None = None
    item: dict[str, Any] | None = None
    secondary_item: dict[str, Any] | None = None


class ReviewSuggestionListOut(BaseModel):
    items: list[ReviewSuggestionOut]
    total: int
    pending_count: int
    status_counts: dict[str, int] = Field(default_factory=dict)
    type_counts: dict[str, int] = Field(default_factory=dict)


class ReviewSummaryOut(BaseModel):
    pending_count: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    type_counts: dict[str, int] = Field(default_factory=dict)
    last_run: ReviewRunOut | None = None


class ReviewAcceptRequest(BaseModel):
    category_id: uuid.UUID | None = None
    name: trimmed(1, 200) | None = None


class ReviewBulkAcceptRequest(BaseModel):
    suggestion_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def _unique(self) -> "ReviewBulkAcceptRequest":
        if len(self.suggestion_ids) != len(set(self.suggestion_ids)):
            raise ValueError("Each suggestion must appear once.")
        return self


class ReviewDecisionOut(BaseModel):
    suggestion_id: uuid.UUID
    status: Literal["applied", "stale", "skipped", "unsupported"]
    message: str
    suggestion: ReviewSuggestionOut | None = None


class ReviewBulkAcceptOut(BaseModel):
    applied_count: int
    skipped_count: int
    stale_count: int
    unsupported_count: int
    results: list[ReviewDecisionOut] = Field(default_factory=list)


class ReviewScopeItemsOut(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)


class ReviewDismissRequest(BaseModel):
    reason: trimmed(0, 300) | None = None


__all__ = [
    "ReviewAcceptRequest",
    "ReviewActionKind",
    "ReviewBulkAcceptOut",
    "ReviewBulkAcceptRequest",
    "ReviewDecisionOut",
    "ReviewDismissRequest",
    "ReviewRunOut",
    "ReviewRunRequest",
    "ReviewScopeItemsOut",
    "ReviewScopeType",
    "ReviewSuggestionListOut",
    "ReviewSuggestionOut",
    "ReviewSuggestionStatus",
    "ReviewSuggestionType",
    "ReviewSummaryOut",
]
