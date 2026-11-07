from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Document, Item, ItemPhoto, Room, StorageLocation
from ...schemas.overview import CurrencyTotal, OverviewOut
from ...services import lending
from ...services.ownership import financial_overview
from ...services.serializers import item_load_options, item_summary
from ...services.warranty_dashboard import build_dashboard, load_warranties
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
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        or 0
    )
    item_count = int(db.scalar(select(func.count(Item.id)).where(*active_items)) or 0)
    total_quantity = int(
        db.scalar(select(func.coalesce(func.sum(Item.quantity), 0)).where(*active_items)) or 0
    )
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
    recent_items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*active_items)
        .order_by(Item.created_at.desc())
        .limit(6)
    ).all()

    financial = financial_overview(
        db,
        household_id,
        household_reminder_days=auth.household.warranty_reminder_days,
        valuable_limit=4,
        missing_limit=5,
    )
    warranties = build_dashboard(
        load_warranties(db, household_id),
        auth.household.warranty_reminder_days,
        limit=5,
    )
    loan_quantities = lending.loan_quantities_for_items(
        db, household_id, [item.id for item in recent_items]
    )
    loans = lending.list_loans(
        db,
        household_id,
        status="open",
        on_date=date.today(),
        limit=1,
        offset=0,
    )

    return OverviewOut(
        room_count=room_count,
        location_count=location_count,
        item_count=item_count,
        total_quantity=total_quantity,
        value_by_currency=[
            CurrencyTotal(currency=entry.currency, total_cents=entry.purchase_total_cents)
            for entry in financial.currency_totals
            if entry.purchase_item_count > 0
        ],
        current_value_by_currency=[
            CurrencyTotal(currency=entry.currency, total_cents=entry.current_value_total_cents)
            for entry in financial.currency_totals
            if entry.current_value_item_count > 0
        ],
        document_count=document_count,
        warranties_expiring_soon=warranties.expiring_count,
        warranties=warranties,
        items_missing_purchase_count=financial.items_missing_purchase_count,
        photo_bytes=photo_bytes,
        document_bytes=document_bytes,
        outstanding_loan_count=loans.outstanding_count,
        overdue_loan_count=loans.overdue_count,
        on_loan_quantity=loans.on_loan_quantity,
        recent_items=[
            item_summary(
                item,
                household_reminder_days=auth.household.warranty_reminder_days,
                on_loan_quantity=loan_quantities.get(item.id, 0),
            )
            for item in recent_items
        ],
    )
