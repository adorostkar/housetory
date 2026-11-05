import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.stocktake import (
    StocktakeAbandonIn,
    StocktakeApplyIn,
    StocktakeApplyOut,
    StocktakeCompleteIn,
    StocktakeObservationIn,
    StocktakeObservationOut,
    StocktakeRefreshIn,
    StocktakeReviewOut,
    StocktakeScopeSummaryOut,
    StocktakeSessionDetail,
    StocktakeSessionList,
    StocktakeSessionOut,
    StocktakeStartIn,
)
from ...services import stocktake as service
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/stocktake", tags=["stocktake"])


@router.post("/sessions", response_model=StocktakeSessionOut, status_code=201)
def start_stocktake(
    payload: StocktakeStartIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionOut:
    session = service.start_session(db, auth.household.id, user=auth.user, payload=payload)
    return service._session_out(session)


@router.get("/sessions", response_model=StocktakeSessionList)
def list_stocktakes(
    room_id: uuid.UUID | None = None,
    container_id: uuid.UUID | None = None,
    status: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionList:
    return service.list_sessions(
        db,
        auth.household.id,
        room_id=room_id,
        container_id=container_id,
        status=status,
        limit=limit,
        offset=offset,
    )


@router.get("/sessions/{session_id}", response_model=StocktakeSessionDetail)
def read_stocktake(
    session_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionDetail:
    return service.session_detail(db, auth.household.id, session_id)


@router.post(
    "/sessions/{session_id}/observations",
    response_model=StocktakeObservationOut,
    status_code=201,
)
def create_stocktake_observation(
    session_id: uuid.UUID,
    payload: StocktakeObservationIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeObservationOut:
    observation = service.create_observation(
        db, auth.household.id, session_id, user=auth.user, payload=payload
    )
    return service._observation_out(observation)


@router.post("/sessions/{session_id}/refresh", response_model=StocktakeSessionDetail)
def refresh_stocktake(
    session_id: uuid.UUID,
    payload: StocktakeRefreshIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionDetail:
    return service.refresh_session(db, auth.household.id, session_id)


@router.get("/sessions/{session_id}/review", response_model=StocktakeReviewOut)
def review_stocktake(
    session_id: uuid.UUID,
    observation_ids: Annotated[list[uuid.UUID] | None, Query()] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeReviewOut:
    return service.review_session(
        db,
        auth.household.id,
        session_id,
        observation_ids=observation_ids or None,
    )


@router.post("/sessions/{session_id}/apply", response_model=StocktakeApplyOut)
def apply_stocktake(
    session_id: uuid.UUID,
    payload: StocktakeApplyIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeApplyOut:
    return service.apply_session(db, auth.household.id, session_id, user=auth.user, payload=payload)


@router.post("/sessions/{session_id}/complete", response_model=StocktakeSessionOut)
def complete_stocktake(
    session_id: uuid.UUID,
    payload: StocktakeCompleteIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionOut:
    return service.complete_session(
        db, auth.household.id, session_id, user=auth.user, payload=payload
    )


@router.post("/sessions/{session_id}/abandon", response_model=StocktakeSessionOut)
def abandon_stocktake(
    session_id: uuid.UUID,
    payload: StocktakeAbandonIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeSessionOut:
    return service.abandon_session(
        db, auth.household.id, session_id, user=auth.user, payload=payload
    )


@router.get("/summary", response_model=StocktakeScopeSummaryOut)
def stocktake_scope_summary(
    room_id: uuid.UUID | None = None,
    container_id: uuid.UUID | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> StocktakeScopeSummaryOut:
    return service.scope_summary(
        db,
        auth.household.id,
        room_id=room_id,
        container_id=container_id,
    )
