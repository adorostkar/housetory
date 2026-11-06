from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...api.deps import AuthContext, require_auth, require_owner
from ...db import get_db
from ...schemas.auth import HouseholdOut, HouseholdUpdate

router = APIRouter(prefix="/household", tags=["household"])


@router.get("", response_model=HouseholdOut)
def get_household(auth: AuthContext = Depends(require_auth)) -> HouseholdOut:
    return HouseholdOut(
        id=auth.household.id,
        name=auth.household.name,
        warranty_reminder_days=auth.household.warranty_reminder_days,
        item_image_auto_reference=auth.household.item_image_auto_reference,
        item_image_auto_generate=auth.household.item_image_auto_generate,
        item_image_daily_generation_cap=auth.household.item_image_daily_generation_cap,
    )


@router.patch("", response_model=HouseholdOut)
def update_household(
    payload: HouseholdUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> HouseholdOut:
    if "name" in payload.model_fields_set and payload.name is not None:
        auth.household.name = payload.name
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
    if (
        "item_image_auto_generate" in payload.model_fields_set
        and payload.item_image_auto_generate is not None
    ):
        auth.household.item_image_auto_generate = payload.item_image_auto_generate
    if (
        "item_image_daily_generation_cap" in payload.model_fields_set
        and payload.item_image_daily_generation_cap is not None
    ):
        auth.household.item_image_daily_generation_cap = payload.item_image_daily_generation_cap
    db.commit()
    return HouseholdOut(
        id=auth.household.id,
        name=auth.household.name,
        warranty_reminder_days=auth.household.warranty_reminder_days,
        item_image_auto_reference=auth.household.item_image_auto_reference,
        item_image_auto_generate=auth.household.item_image_auto_generate,
        item_image_daily_generation_cap=auth.household.item_image_daily_generation_cap,
    )
