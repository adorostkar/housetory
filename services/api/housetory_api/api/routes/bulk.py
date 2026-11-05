from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.bulk import (
    BulkCategoryRequest,
    BulkCategoryResult,
    BulkMoveRequest,
    BulkMoveResult,
    BulkTagRequest,
    BulkTagResult,
)
from ...services import bulk as bulk_service
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/items/bulk", tags=["bulk"])


@router.post("/move", response_model=BulkMoveResult)
def bulk_move_items(
    payload: BulkMoveRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BulkMoveResult:
    try:
        result = bulk_service.bulk_move(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/tags", response_model=BulkTagResult)
def bulk_tag_items(
    payload: BulkTagRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BulkTagResult:
    try:
        result = bulk_service.bulk_tags(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/category", response_model=BulkCategoryResult)
def bulk_categorise_items(
    payload: BulkCategoryRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> BulkCategoryResult:
    try:
        result = bulk_service.bulk_category(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result
