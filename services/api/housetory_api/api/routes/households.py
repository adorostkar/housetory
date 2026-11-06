import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.auth import SessionState
from ...schemas.households import HouseholdCreate, HouseholdList
from ...services import auth as auth_service
from ...services import households as household_service
from ..abuse import enforce_login_limit, login_limiter
from ..deps import AccountContext, require_account

router = APIRouter(prefix="/households", tags=["households"])


def _state(db: Session, account: AccountContext) -> SessionState:
    return auth_service.build_session_state(db, user=account.user, session=account.session)


@router.get("", response_model=HouseholdList)
def list_households(
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> HouseholdList:
    state = _state(db, account)
    return HouseholdList(items=state.households)


@router.post("", response_model=SessionState, status_code=201)
def create_household(
    payload: HouseholdCreate,
    request: Request,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> SessionState:
    # Household creation is an account-level action, not a write inside the
    # currently selected household, so it is available even to a viewer there.
    keys = [
        f"household-create:{account.user.id}",
    ]
    ip_key = login_limiter.ip_key(request.client.host if request.client else None)
    if ip_key:
        keys.append(f"household-create-ip:{ip_key}")
    enforce_login_limit(keys)
    login_limiter.record_failure(keys)
    household = household_service.create_household(db, account.user, payload)
    account.session.household_id = household.id
    db.commit()
    return _state(db, account)


@router.post("/{household_id}/select", response_model=SessionState)
def select_household(
    household_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> SessionState:
    household = household_service.select_household(db, account.user, household_id)
    account.session.household_id = household.id
    db.commit()
    return _state(db, account)
