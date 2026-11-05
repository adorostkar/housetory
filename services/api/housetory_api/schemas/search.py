import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class QuickSearchLoan(BaseModel):
    on_loan_quantity: int
    borrower_names: list[str] = Field(default_factory=list)
    next_due_on: date | None = None


class QuickSearchResult(BaseModel):
    id: uuid.UUID
    kind: Literal["item", "container", "location"]
    title: str
    subtitle: str | None = None
    context: str | None = None
    url: str
    loan: QuickSearchLoan | None = None


class QuickSearchResponse(BaseModel):
    query: str
    effective_query: str | None = None
    question_like: bool = False
    results: list[QuickSearchResult]
