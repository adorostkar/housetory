"""Household creation and explicit household selection for an account."""

import uuid

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..models import Household, HouseholdMember, Property, User
from ..schemas.auth import HouseholdOut
from ..schemas.households import HouseholdCreate

MAX_HOUSEHOLDS_PER_ACCOUNT = 20
WRITER_ROLES = {"owner", "member"}


def household_out(household: Household) -> HouseholdOut:
    return HouseholdOut(
        id=household.id,
        name=household.name,
        default_currency=household.default_currency,
        warranty_reminder_days=household.warranty_reminder_days,
        item_image_auto_reference=household.item_image_auto_reference,
        offline_copy_policy=household.offline_copy_policy,
    )


def offline_copy_allowed(household: Household, role: str | None) -> bool:
    """Whether this role may keep a read-only copy of the household on a device."""
    if role is None:
        return False
    if household.offline_copy_policy == "everyone":
        return True
    if household.offline_copy_policy == "members":
        return role in WRITER_ROLES
    return False


def _user_lock(db: Session, user_id: uuid.UUID) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"housetory-households-{user_id}"},
    )


def create_household(
    db: Session,
    user: User,
    payload: HouseholdCreate,
) -> Household:
    _user_lock(db, user.id)
    count = int(
        db.scalar(
            select(func.count(HouseholdMember.household_id)).where(
                HouseholdMember.user_id == user.id
            )
        )
        or 0
    )
    if count >= MAX_HOUSEHOLDS_PER_ACCOUNT:
        raise ApiError(
            409,
            "household_limit_reached",
            f"An account can belong to at most {MAX_HOUSEHOLDS_PER_ACCOUNT} households.",
        )
    household = Household(name=payload.name)
    db.add(household)
    db.flush()
    db.add(
        HouseholdMember(
            household_id=household.id,
            user_id=user.id,
            role="owner",
        )
    )
    db.add(
        Property(
            household_id=household.id,
            name=payload.property_name,
            sort_order=0,
        )
    )
    db.commit()
    db.refresh(household)
    return household


def select_household(
    db: Session,
    user: User,
    household_id: uuid.UUID,
) -> Household:
    household = db.scalar(
        select(Household)
        .join(HouseholdMember, HouseholdMember.household_id == Household.id)
        .where(
            Household.id == household_id,
            HouseholdMember.user_id == user.id,
        )
    )
    if household is None:
        # Do not reveal whether another account's household exists.
        raise ApiError(404, "household_not_found", "Household not found.")
    return household
