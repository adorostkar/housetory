import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, raiseload

from ..domain import WarrantyStatus
from ..models import Document, Item, Warranty
from ..schemas.warranties import WarrantyDashboard, WarrantyOut
from .serializers import warranty_out
from .warranties import effective_reminder_days, warranty_status


def load_dashboard(
    db: Session,
    household_id: uuid.UUID,
    household_reminder_days: int,
    *,
    limit: int = 6,
) -> WarrantyDashboard:
    today = date.today()
    conditions = [Item.household_id == household_id, Item.is_archived.is_(False)]
    metadata = db.execute(
        select(Warranty.id, Warranty.end_date, Warranty.reminder_days, Item.name)
        .join(Item, Item.id == Warranty.item_id)
        .where(*conditions)
    ).all()
    groups: dict[WarrantyStatus, list[tuple[uuid.UUID, date | None, str]]] = {
        status: [] for status in WarrantyStatus
    }
    for warranty_id, end_date, reminder_days, name in metadata:
        status, _ = warranty_status(
            end_date,
            reminder_days=effective_reminder_days(reminder_days, household_reminder_days),
            today=today,
        )
        groups[status].append((warranty_id, end_date, name))
    groups[WarrantyStatus.ACTIVE].sort(key=lambda row: (row[1] or date.max, row[2]))
    groups[WarrantyStatus.EXPIRING].sort(key=lambda row: row[1] or date.max)
    groups[WarrantyStatus.EXPIRED].sort(key=lambda row: row[1] or date.min, reverse=True)
    preview_ids = [
        row[0]
        for status in (WarrantyStatus.ACTIVE, WarrantyStatus.EXPIRING, WarrantyStatus.EXPIRED)
        for row in groups[status][:limit]
    ]
    previews = (
        list(
            db.scalars(
                select(Warranty)
                .join(Item, Item.id == Warranty.item_id)
                .where(*conditions, Warranty.id.in_(preview_ids))
                .options(
                    joinedload(Warranty.item).load_only(Item.id, Item.name, raiseload=True),
                    joinedload(Warranty.document).load_only(
                        Document.id,
                        Document.title,
                        Document.document_type,
                        Document.content_type,
                        raiseload=True,
                    ),
                    raiseload("*"),
                )
            ).all()
        )
        if preview_ids
        else []
    )
    dashboard = build_dashboard(previews, household_reminder_days, limit=limit, today=today)
    return dashboard.model_copy(
        update={
            "active_count": len(groups[WarrantyStatus.ACTIVE]),
            "expiring_count": len(groups[WarrantyStatus.EXPIRING]),
            "expired_count": len(groups[WarrantyStatus.EXPIRED]),
            "unknown_count": len(groups[WarrantyStatus.UNKNOWN]),
        }
    )


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
    warranties: list[Warranty], household_reminder_days: int, *, today: date | None = None
) -> list[WarrantyOut]:
    return [
        warranty_out(warranty, household_reminder_days, include_item=True, today=today)
        for warranty in warranties
    ]


def build_dashboard(
    warranties: list[Warranty],
    household_reminder_days: int,
    *,
    limit: int = 6,
    today: date | None = None,
) -> WarrantyDashboard:
    serialized = serialize_warranties(warranties, household_reminder_days, today=today)
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
