import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from ..schemas.ai import AiStatus
from ..schemas.common import ORMModel, trimmed
from ..schemas.documents import DocumentOut

GENERIC_MANUFACTURERS = {
    "unknown",
    "generic",
    "unbranded",
    "n/a",
    "na",
    "none",
    "other",
    "tool",
    "drill",
}
GENERIC_MODELS = {
    "unknown",
    "model",
    "n/a",
    "na",
    "none",
    "generic",
    "drill",
    "tool",
    "manual",
    "heavy drill",
}


def validate_manual_identifiers(
    manufacturer: str, model_identifier: str, variant: str | None
) -> tuple[str, str, str | None]:
    maker = " ".join(manufacturer.split()).strip()
    model = " ".join(model_identifier.split()).strip()
    variant_value = " ".join(variant.split()).strip() if variant else None
    if len(maker) < 2 or maker.lower() in GENERIC_MANUFACTURERS:
        raise ValueError(
            "Confirm the actual manufacturer; a generic or empty label is not enough."
        )
    if not any(character.isalpha() for character in maker):
        raise ValueError("The manufacturer must contain letters.")
    if len(model) < 3 or model.lower() in GENERIC_MODELS:
        raise ValueError(
            "Confirm the complete model identifier; a generic item name is not enough."
        )
    if not any(character.isdigit() for character in model):
        raise ValueError(
            "The complete model identifier must include its identifying digits."
        )
    if variant_value is not None and len(variant_value) > 120:
        raise ValueError("Variant details must be 120 characters or fewer.")
    return maker, model, variant_value


class ManualProfileIn(BaseModel):
    manufacturer: trimmed(2, 120)
    model_identifier: trimmed(3, 120)
    variant: trimmed(1, 120) | None = None
    confirmed: bool = False

    @field_validator("confirmed")
    @classmethod
    def _confirmed(cls, value: bool) -> bool:
        if not value:
            raise ValueError(
                "Confirm that the manufacturer and complete model identifier are correct."
            )
        return value

    @field_validator("variant", mode="before")
    @classmethod
    def _empty_variant(cls, value: Any) -> Any:
        return None if value in {None, ""} else value


class ManualProfileOut(ORMModel):
    id: uuid.UUID
    item_id: uuid.UUID
    manufacturer: str
    model_identifier: str
    variant: str | None
    confirmed_at: datetime
    updated_at: datetime

    @property
    def display(self) -> str:
        return " ".join(
            part for part in (self.manufacturer, self.model_identifier, self.variant) if part
        )


class ManualSearchStatusOut(BaseModel):
    configured: bool
    provider_label: str | None = None
    reason: str | None = None
    profile: ManualProfileOut | None = None
    can_search: bool = False


class ManualsOut(BaseModel):
    item_id: uuid.UUID
    manuals: list[DocumentOut]
    search: ManualSearchStatusOut


class ManualCitationOut(BaseModel):
    document_id: uuid.UUID
    document_title: str
    page: int | None = None
    section: str | None = None
    excerpt: str
    url: str


class ManualAskRequest(BaseModel):
    question: trimmed(2, 1000)


class ManualAnswerOut(BaseModel):
    item_id: uuid.UUID
    item_name: str
    answer: str
    mode: Literal["ai", "extractive", "no_evidence"]
    citations: list[ManualCitationOut] = Field(default_factory=list)
    manuals: list[dict[str, Any]] = Field(default_factory=list)
    notices: list[str] = Field(default_factory=list)
    ai_status: AiStatus
    source_kind: Literal["attached_manual"] = "attached_manual"


class ManualCandidateOut(ORMModel):
    id: uuid.UUID
    item_id: uuid.UUID
    title: str
    source_url: str
    file_url: str
    publisher: str | None
    language: str | None
    source_type: str
    model_coverage: list[str]
    snippet: str | None
    retrieved_at: datetime
    document_id: uuid.UUID | None
    created_at: datetime


class ManualCandidateList(BaseModel):
    item_id: uuid.UUID
    candidates: list[ManualCandidateOut]
    notices: list[str] = Field(default_factory=list)


class ManualDownloadIn(BaseModel):
    request_id: uuid.UUID
    confirm_model: bool

    @field_validator("confirm_model")
    @classmethod
    def _confirmed(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Review and confirm the manual compatibility before downloading.")
        return value


class ManualDownloadOut(BaseModel):
    document: DocumentOut
    candidate: ManualCandidateOut
    duplicate_documents: list[dict[str, Any]] = Field(default_factory=list)


class ManualOnlineAskRequest(BaseModel):
    question: trimmed(2, 1000)


class WebCitationOut(BaseModel):
    title: str
    url: str
    publisher: str | None = None
    language: str | None = None
    source_type: str = "other"
    excerpt: str


class ManualOnlineAnswerOut(BaseModel):
    item_id: uuid.UUID
    answer: str
    mode: Literal["ai", "extractive", "no_evidence"]
    citations: list[WebCitationOut] = Field(default_factory=list)
    notices: list[str] = Field(default_factory=list)
    ai_status: AiStatus
    source_kind: Literal["online"] = "online"
