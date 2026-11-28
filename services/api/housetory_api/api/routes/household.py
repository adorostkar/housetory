from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...api.deps import AuthContext, require_auth, require_owner
from ...db import get_db
from ...schemas.auth import HouseholdOut, HouseholdUpdate
from ...services.households import household_out

router = APIRouter(prefix="/household", tags=["household"])


@router.get("", response_model=HouseholdOut)
def get_household(auth: AuthContext = Depends(require_auth)) -> HouseholdOut:
    return household_out(auth.household)


@router.patch("", response_model=HouseholdOut)
def update_household(
    payload: HouseholdUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> HouseholdOut:
    if "name" in payload.model_fields_set and payload.name is not None:
        auth.household.name = payload.name
    if "default_currency" in payload.model_fields_set and payload.default_currency is not None:
        auth.household.default_currency = payload.default_currency
    if (
        "warranty_reminder_days" in payload.model_fields_set
        and payload.warranty_reminder_days is not None
    ):
        auth.household.warranty_reminder_days = payload.warranty_reminder_days
    if (
        "item_image_auto_reference" in payload.model_fields_set
        and payload.item_image_auto_reference is not None
    ):
        auth.household.item_image_auto_reference = payload.item_image_auto_reference
    if "offline_copy_policy" in payload.model_fields_set and payload.offline_copy_policy:
        auth.household.offline_copy_policy = payload.offline_copy_policy
    db.commit()
    return household_out(auth.household)
