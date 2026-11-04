import uuid
from typing import Literal

from pydantic import BaseModel


class QuickSearchResult(BaseModel):
    id: uuid.UUID
    kind: Literal["item", "container", "location"]
    title: str
    subtitle: str | None = None
    context: str | None = None
    url: str


class QuickSearchResponse(BaseModel):
    query: str
    results: list[QuickSearchResult]
