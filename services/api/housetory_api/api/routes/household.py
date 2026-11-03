from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...api.deps import AuthContext, require_auth, require_owner
from ...db import get_db
from ...schemas.auth import HouseholdOut, HouseholdUpdate

router = APIRouter(prefix="/household", tags=["household"])


@router.get("", response_model=HouseholdOut)
def get_household(auth: AuthContext = Depends(require_auth)) -> HouseholdOut:
    return HouseholdOut(id=auth.household.id, name=auth.household.name)


@router.patch("", response_model=HouseholdOut)
def update_household(
    payload: HouseholdUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> HouseholdOut:
    auth.household.name = payload.name
    db.commit()
    return HouseholdOut(id=auth.household.id, name=auth.household.name)
