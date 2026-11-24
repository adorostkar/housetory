import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .ai import AssistantReference, SearchPageReference
from .assistant_actions import AssistantActionProposalOut
from .inventory_review import ReviewRunOut
from .manuals import ManualCitationOut


class CaptureLink(BaseModel):
    kind: Literal["items", "document", "photo"]
    id: uuid.UUID


class ManualLink(BaseModel):
    """A manual the application links to directly.

    ``url`` is the page that shows the file itself. ``details_url`` is the document
    page, where its record is managed. ``download_url`` is the stored file.
    """

    document_id: uuid.UUID
    title: str
    url: str
    download_url: str
    details_url: str | None = None
    state: Literal["readable", "ocr_pending", "ocr_failed", "no_text"]
    # Pages in the file and pages whose text is read so far.
    pages: int | None = None
    pages_read: int | None = None
    # Pages whose reading failed: they have no text.
    pages_failed: int | None = None


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
    manuals: list[ManualLink] = Field(default_factory=list, max_length=8)
    # Only in results stored by earlier versions. Citations now belong to the answer.
    citations: list[ManualCitationOut] = Field(default_factory=list, max_length=4)
    error: str | None = None


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["tool"]
    call: ToolCall


QUOTE_CHARS = 600


class ManualSource(BaseModel):
    """A source the model names for its answer. It helps the reader to check the answer,
    so a badly formed one is repaired or dropped: it never makes the answer invalid."""

    model_config = ConfigDict(extra="ignore")

    document_id: uuid.UUID
    pages: list[int] = Field(min_length=1)
    quote: str | None = Field(
        default=None,
        description=(
            "A few words (one sentence at most) copied exactly from one of those pages "
            "that support the answer. The application shows them only when they really "
            "stand on the page."
        ),
    )

    @field_validator("pages", mode="before")
    @classmethod
    def _page_numbers(cls, value: Any) -> Any:
        if isinstance(value, int) and not isinstance(value, bool):
            return [value]
        if isinstance(value, list):
            numbers = [n for n in value if isinstance(n, int) and not isinstance(n, bool)]
            return numbers[:12]
        return value

    @field_validator("quote", mode="before")
    @classmethod
    def _short_quote(cls, value: Any) -> Any:
        return value[:QUOTE_CHARS] if isinstance(value, str) else None


class AnswerStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["answer", "clarify", "unsupported"]
    sources: list[ManualSource] = Field(
        default_factory=list,
        description=(
            "When the answer uses a manual: the document_id and the page numbers the "
            "facts come from. Only pages whose text a tool returned in this request. "
            "The application shows them as links to those pages."
        ),
    )

    @field_validator("sources", mode="before")
    @classmethod
    def _usable_sources(cls, value: Any) -> list[ManualSource]:
        kept = []
        for entry in value if isinstance(value, list) else []:
            try:
                kept.append(ManualSource.model_validate(entry))
            except ValidationError:
                continue
        return kept[:6]

    message: str = Field(
        default="",
        max_length=4000,
        description=(
            "Everything the user must read that the application does not already display: "
            "the answer to every question asked, clarifying questions, limitations, parts "
            "that could not be completed and unsupported parts. Required even when a "
            "proposal, capture or review was also prepared. Never restate proposal fields "
            "or review/capture progress here. Empty only when prepared work is the whole reply."
        ),
    )
    prepared_note: str | None = Field(
        default=None,
        max_length=1000,
        description=(
            "Optional remark about the prepared proposal, capture or review. The application "
            "shows that work itself, so this is kept for diagnostics and not shown as the answer."
        ),
    )


class RunOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    household_id: uuid.UUID
    property_id: uuid.UUID | None
    query: str
    state: str
    generation: int
    message: str
    answer: str | None = None
    steps: list[dict[str, Any]]
    # Manual pages the answer rests on. Each was read by a tool in this conversation.
    citations: list[ManualCitationOut] = Field(default_factory=list)
    model_calls: int
    max_model_calls: int
    can_retry: bool
    worker_available: bool | None = None
