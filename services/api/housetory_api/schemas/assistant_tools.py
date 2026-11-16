import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .ai import AssistantReference, SearchPageReference
from .assistant_actions import AssistantActionProposalOut
from .inventory_review import ReviewRunOut


class CaptureLink(BaseModel):
    kind: Literal["items", "document", "photo"]
    id: uuid.UUID


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    query: str = Field(min_length=2, max_length=4000)
    household_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    local_date: date | None = None
    page_context: list[SearchPageReference] = Field(default_factory=list, max_length=12)
    capture_context: list[CaptureLink] = Field(default_factory=list, max_length=6)


class ToolOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    facts: dict[str, Any] = Field(default_factory=dict)
    references: list[AssistantReference] = Field(default_factory=list, max_length=12)
    proposal: AssistantActionProposalOut | None = None
    capture: CaptureLink | None = None
    review: ReviewRunOut | None = None
    error: str | None = None


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["tool"]
    call: ToolCall


class AnswerStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["answer", "clarify", "unsupported"]
    message: str = Field(min_length=1, max_length=4000)


class RunOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    household_id: uuid.UUID
    property_id: uuid.UUID | None
    query: str
    state: str
    generation: int
    message: str
    steps: list[dict[str, Any]]
    model_calls: int
    max_model_calls: int
    can_retry: bool
    worker_available: bool | None = None
