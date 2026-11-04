import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import WarrantyStatus
from ...models import Item
from ...schemas.warranties import WarrantyList
from ...services.warranty_dashboard import load_warranties, serialize_warranties
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/warranties", tags=["warranties"])

WarrantyFilter = Literal["all", "active", "expiring", "expired", "unknown"]


@router.get("", response_model=WarrantyList)
def list_warranties(
    status: Annotated[WarrantyFilter, Query()] = "all",
    item_id: uuid.UUID | None = None,
    include_archived: bool = False,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> WarrantyList:
    if item_id is not None:
        item = db.scalar(
            select(Item.id).where(Item.id == item_id, Item.household_id == auth.household.id)
        )
        if item is None:
            raise ApiError(422, "item_not_found", "The selected item does not exist.")

    warranties = load_warranties(db, auth.household.id, include_archived=include_archived)
    if item_id is not None:
        warranties = [warranty for warranty in warranties if warranty.item_id == item_id]
    serialized = serialize_warranties(warranties, auth.household.warranty_reminder_days)

    active = [entry for entry in serialized if entry.status == WarrantyStatus.ACTIVE.value]
    expiring = [entry for entry in serialized if entry.status == WarrantyStatus.EXPIRING.value]
    expired = [entry for entry in serialized if entry.status == WarrantyStatus.EXPIRED.value]
    unknown = [entry for entry in serialized if entry.status == WarrantyStatus.UNKNOWN.value]

    selected = {
        "all": serialized,
        "active": active,
        "expiring": expiring,
        "expired": expired,
        "unknown": unknown,
    }[status]

    order = {
        "all": lambda entry: (
            entry.status != WarrantyStatus.EXPIRING.value,
            entry.end_date.isoformat() if entry.end_date else "9999-12-31",
        ),
        "active": lambda entry: entry.end_date.isoformat() if entry.end_date else "9999-12-31",
        "expiring": lambda entry: (
            entry.days_remaining if entry.days_remaining is not None else 99999
        ),
        "expired": lambda entry: entry.end_date.isoformat() if entry.end_date else "",
        "unknown": lambda entry: entry.provider or "",
    }[status]
    if status == "expired":
        selected = sorted(selected, key=order, reverse=True)
    else:
        selected = sorted(selected, key=order)

    return WarrantyList(
        items=selected,
        active_count=len(active),
        expiring_count=len(expiring),
        expired_count=len(expired),
        unknown_count=len(unknown),
        reminder_days=auth.household.warranty_reminder_days,
    )
