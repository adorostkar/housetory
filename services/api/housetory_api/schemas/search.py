import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from .items import ItemSummary


class SearchHousehold(BaseModel):
    id: uuid.UUID
    name: str
    role: str


class SearchProperty(BaseModel):
    id: uuid.UUID
    name: str
    is_archived: bool = False


class SearchScopeHousehold(SearchHousehold):
    properties: list[SearchProperty] = Field(default_factory=list)


class SearchScopeList(BaseModel):
    items: list[SearchScopeHousehold] = Field(default_factory=list)


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
    household: SearchHousehold | None = None
    loan: QuickSearchLoan | None = None


class QuickSearchResponse(BaseModel):
    query: str
    effective_query: str | None = None
    question_like: bool = False
    results: list[QuickSearchResult]
    scope_label: str = "All my places"
    households: list[SearchHousehold] = Field(default_factory=list)
    property: SearchProperty | None = None
    notices: list[str] = Field(default_factory=list)


class SearchItemList(BaseModel):
    items: list[ItemSummary]
    total: int
    limit: int
    offset: int
    scope_label: str = "All my places"
    households: list[SearchHousehold] = Field(default_factory=list)
    property: SearchProperty | None = None
    notices: list[str] = Field(default_factory=list)


__all__ = [
    "QuickSearchLoan",
    "QuickSearchResponse",
    "QuickSearchResult",
    "SearchHousehold",
    "SearchItemList",
    "SearchProperty",
    "SearchScopeHousehold",
    "SearchScopeList",
]
