import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.ai import SearchQueryRequest, SearchQueryResponse
from ...schemas.search import (
    QuickSearchResponse,
    SearchItemList,
    SearchScopeList,
)
from ...services import global_search, unified_search
from ...services.query_text import clean_subject, looks_like_question
from ..abuse import enforce_search_limit
from ..deps import AccountContext, require_account

router = APIRouter(prefix="/search", tags=["search"])


@router.get("/scopes", response_model=SearchScopeList)
def search_scopes(
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> SearchScopeList:
    enforce_search_limit(account.user.id)
    return global_search.list_search_scope_options(db, account.user.id)


@router.post("/query", response_model=SearchQueryResponse)
def unified_query(
    payload: SearchQueryRequest,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> SearchQueryResponse:
    """The single submit-time flow shared by every search/assistant entry point."""
    enforce_search_limit(account.user.id)
    return unified_search.execute_search(
        db,
        user_id=account.user.id,
        query=payload.query,
        explicit_ask=payload.explicit_ask,
        history=payload.history,
        context=payload.context,
        household_id=payload.household_id,
        property_id=payload.property_id,
        limit=payload.limit,
    )


@router.get("/quick", response_model=QuickSearchResponse)
def quick_search(
    q: Annotated[str, Query(min_length=2, max_length=200)],
    household_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=20)] = 4,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> QuickSearchResponse:
    enforce_search_limit(account.user.id)
    term = q.strip()
    if len(term) < 2:
        return QuickSearchResponse(query=term, results=[])
    question_like = looks_like_question(term)
    effective_term = clean_subject(term) if question_like else term
    if len(effective_term) < 2:
        effective_term = term
    scope = global_search.resolve_search_scope(
        db,
        account.user.id,
        household_id=household_id,
        property_id=property_id,
    )
    results, notices = global_search.quick_search(
        db,
        scope,
        effective_term=effective_term,
        limit=limit,
    )
    return QuickSearchResponse(
        query=term,
        effective_query=effective_term if effective_term != term else None,
        question_like=question_like,
        results=results,
        scope_label=scope.label,
        households=global_search.scope_households(scope),
        property=global_search.scope_property(scope.property),
        notices=notices,
    )


@router.get("/items", response_model=SearchItemList)
def search_items(
    q: Annotated[str | None, Query(max_length=200)] = None,
    household_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    sort: Annotated[
        str,
        Query(pattern="^(relevance|name_asc|name_desc|created_desc|created_asc|updated_desc)$"),
    ] = "relevance",
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> SearchItemList:
    enforce_search_limit(account.user.id)
    scope = global_search.resolve_search_scope(
        db,
        account.user.id,
        household_id=household_id,
        property_id=property_id,
    )
    result, _notices = global_search.search_items(
        db,
        scope,
        q=q,
        include_archived=False,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return result
