from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import (
    Document,
    Item,
    ItemPhoto,
    Purchase,
    Room,
    StorageLocation,
    Warranty,
)
from ...schemas.overview import OverviewOut
from ...services.serializers import item_load_options, item_summary
from ..deps import AuthContext, require_auth

router = APIRouter(tags=["overview"])


@router.get("/overview", response_model=OverviewOut)
def overview(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> OverviewOut:
    household_id = auth.household.id
    active_items = [Item.household_id == household_id, Item.is_archived.is_(False)]

    room_count = int(
        db.scalar(select(func.count(Room.id)).where(Room.household_id == household_id)) or 0
    )
    location_count = int(
        db.scalar(
            select(func.count(StorageLocation.id)).where(
                StorageLocation.household_id == household_id
            )
        )
        or 0
    )
    item_count = int(db.scalar(select(func.count(Item.id)).where(*active_items)) or 0)
    total_quantity = int(
        db.scalar(select(func.coalesce(func.sum(Item.quantity), 0)).where(*active_items)) or 0
    )
    value_rows = db.execute(
        select(Purchase.currency, func.sum(Purchase.price_cents))
        .join(Item, Item.id == Purchase.item_id)
        .where(*active_items, Purchase.price_cents.is_not(None))
        .group_by(Purchase.currency)
        .order_by(Purchase.currency)
    ).all()
    document_count = int(
        db.scalar(select(func.count(Document.id)).where(Document.household_id == household_id)) or 0
    )
    photo_bytes = int(
        db.scalar(
            select(func.coalesce(func.sum(ItemPhoto.byte_size), 0))
            .join(Item, Item.id == ItemPhoto.item_id)
            .where(Item.household_id == household_id)
        )
        or 0
    )
    document_bytes = int(
        db.scalar(
            select(func.coalesce(func.sum(Document.byte_size), 0)).where(
                Document.household_id == household_id
            )
        )
        or 0
    )
    soon = date.today() + timedelta(days=30)
    warranties_expiring_soon = int(
        db.scalar(
            select(func.count(Warranty.id))
            .join(Item, Item.id == Warranty.item_id)
            .where(
                *active_items,
                Warranty.end_date.is_not(None),
                Warranty.end_date >= date.today(),
                Warranty.end_date <= soon,
            )
        )
        or 0
    )
    recent_items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*active_items)
        .order_by(Item.created_at.desc())
        .limit(6)
    ).all()

    return OverviewOut(
        room_count=room_count,
        location_count=location_count,
        item_count=item_count,
        total_quantity=total_quantity,
        value_by_currency=[
            {"currency": currency, "total_cents": int(total or 0)} for currency, total in value_rows
        ],
        document_count=document_count,
        warranties_expiring_soon=warranties_expiring_soon,
        photo_bytes=photo_bytes,
        document_bytes=document_bytes,
        recent_items=[item_summary(item) for item in recent_items],
    )
