from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.online_search import (
    OnlineSearchSettingsOut,
    OnlineSearchSettingsUpdate,
    OnlineSearchTestOut,
    OnlineSearchTestRequest,
)
from ...services import online_search_settings
from ..deps import AuthContext, require_owner

router = APIRouter(prefix="/settings/online-search", tags=["online-search"])


@router.get("", response_model=OnlineSearchSettingsOut)
def read_online_search_settings(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> OnlineSearchSettingsOut:
    return online_search_settings.serialize_settings(db, auth.household.id)


@router.put("", response_model=OnlineSearchSettingsOut)
def update_online_search_settings(
    payload: OnlineSearchSettingsUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> OnlineSearchSettingsOut:
    try:
        result = online_search_settings.update_settings(db, auth.household.id, payload)
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/test", response_model=OnlineSearchTestOut)
def test_online_search_connection(
    payload: OnlineSearchTestRequest,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> OnlineSearchTestOut:
    return online_search_settings.test_connection(db, auth.household.id, confirm=payload.confirm)
