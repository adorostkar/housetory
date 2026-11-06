import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.inventory_review import (
    ReviewAcceptRequest,
    ReviewBulkAcceptOut,
    ReviewBulkAcceptRequest,
    ReviewDecisionOut,
    ReviewDismissRequest,
    ReviewRunOut,
    ReviewRunRequest,
    ReviewScheduleOut,
    ReviewScheduleUpdate,
    ReviewScopeItemsOut,
    ReviewSuggestionListOut,
    ReviewSummaryOut,
)
from ...services import inventory_review, inventory_review_schedule
from ..deps import AuthContext, require_auth, require_owner
from ..errors import ApiError

router = APIRouter(prefix="/inventory-review", tags=["inventory-review"])


@router.get("/schedule", response_model=ReviewScheduleOut | None)
def read_review_schedule(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> ReviewScheduleOut | None:
    return inventory_review_schedule.schedule_out(db, auth.household.id)


@router.put("/schedule", response_model=ReviewScheduleOut)
def update_review_schedule(
    payload: ReviewScheduleUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> ReviewScheduleOut:
    try:
        return inventory_review_schedule.save_schedule(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
        )
    except Exception:
        db.rollback()
        raise


@router.get("/summary", response_model=ReviewSummaryOut)
def read_review_summary(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewSummaryOut:
    return inventory_review.review_summary(db, auth.household.id)


@router.get("/suggestions", response_model=ReviewSuggestionListOut)
def list_review_suggestions(
    status: str | None = None,
    suggestion_type: str | None = None,
    scope_type: str | None = None,
    scope_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=160)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewSuggestionListOut:
    return inventory_review.list_suggestions(
        db,
        auth.household.id,
        status=status,
        suggestion_type=suggestion_type,
        scope_type=scope_type,
        scope_id=scope_id,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.get("/scope-items", response_model=ReviewScopeItemsOut)
def read_review_scope_items(
    item_ids: Annotated[list[uuid.UUID] | None, Query()] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewScopeItemsOut:
    return inventory_review.scope_items(db, auth.household.id, item_ids or [])


@router.post("/runs", response_model=ReviewRunOut)
def create_review_run(
    payload: ReviewRunRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewRunOut:
    if payload.include_ai and auth.role != "owner":
        raise ApiError(
            403,
            "owner_required",
            "Only the household owner can run the optional AI review pass.",
        )
    try:
        result = inventory_review.run_review(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
            allow_ai=auth.role == "owner",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post(
    "/suggestions/{suggestion_id}/accept",
    response_model=ReviewDecisionOut,
)
def accept_review_suggestion(
    suggestion_id: uuid.UUID,
    payload: ReviewAcceptRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewDecisionOut:
    try:
        result = inventory_review.accept_suggestion(
            db,
            auth.household.id,
            suggestion_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post(
    "/suggestions/{suggestion_id}/dismiss",
    response_model=ReviewDecisionOut,
)
def dismiss_review_suggestion(
    suggestion_id: uuid.UUID,
    payload: ReviewDismissRequest | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewDecisionOut:
    try:
        result = inventory_review.dismiss_suggestion(
            db,
            auth.household.id,
            suggestion_id,
            payload.reason if payload else None,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post(
    "/suggestions/{suggestion_id}/undo",
    response_model=ReviewDecisionOut,
)
def undo_review_suggestion(
    suggestion_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewDecisionOut:
    try:
        result = inventory_review.undo_suggestion(
            db,
            auth.household.id,
            suggestion_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/suggestions/bulk-accept", response_model=ReviewBulkAcceptOut)
def bulk_accept_review_suggestions(
    payload: ReviewBulkAcceptRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ReviewBulkAcceptOut:
    try:
        result = inventory_review.bulk_accept(
            db,
            auth.household.id,
            payload.suggestion_ids,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


__all__ = ["router"]
