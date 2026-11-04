import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ..domain import WarrantyStatus
from ..models import Item, Warranty
from ..schemas.warranties import WarrantyDashboard, WarrantyOut
from .serializers import warranty_out


def load_warranties(
    db: Session, household_id: uuid.UUID, *, include_archived: bool = False
) -> list[Warranty]:
    conditions = [Item.household_id == household_id]
    if not include_archived:
        conditions.append(Item.is_archived.is_(False))
    return list(
        db.scalars(
            select(Warranty)
            .join(Item, Item.id == Warranty.item_id)
            .options(joinedload(Warranty.item), joinedload(Warranty.document))
            .where(*conditions)
        ).all()
    )


def serialize_warranties(
    warranties: list[Warranty], household_reminder_days: int
) -> list[WarrantyOut]:
    return [
        warranty_out(warranty, household_reminder_days, include_item=True)
        for warranty in warranties
    ]


def build_dashboard(
    warranties: list[Warranty],
    household_reminder_days: int,
    *,
    limit: int = 6,
) -> WarrantyDashboard:
    serialized = serialize_warranties(warranties, household_reminder_days)
    active = sorted(
        (entry for entry in serialized if entry.status == WarrantyStatus.ACTIVE.value),
        key=lambda entry: (
            entry.end_date.isoformat() if entry.end_date else "",
            entry.item.name if entry.item else "",
        ),
    )
    expiring = sorted(
        (entry for entry in serialized if entry.status == WarrantyStatus.EXPIRING.value),
        key=lambda entry: entry.days_remaining if entry.days_remaining is not None else 0,
    )
    expired = sorted(
        (entry for entry in serialized if entry.status == WarrantyStatus.EXPIRED.value),
        key=lambda entry: entry.end_date.isoformat() if entry.end_date else "",
        reverse=True,
    )
    return WarrantyDashboard(
        active=active[:limit],
        expiring_soon=expiring[:limit],
        expired=expired[:limit],
        active_count=len(active),
        expiring_count=len(expiring),
        expired_count=len(expired),
        unknown_count=sum(
            1 for entry in serialized if entry.status == WarrantyStatus.UNKNOWN.value
        ),
        reminder_days=household_reminder_days,
    )
