"""Read-only, household-scoped tools used by the assistant and smart search."""

import re
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..domain import PurchaseInfoFilter, WarrantyStatus
from ..models import (
    Category,
    Document,
    Item,
    Loan,
    Purchase,
    Room,
    StorageLocation,
    Tag,
    Warranty,
)
from ..schemas.ai import AssistantReference, NaturalSearchFilters
from ..schemas.borrowed import BorrowedOut
from ..schemas.items import ItemSummary
from ..services.hierarchy import descendant_ids
from ..services.ownership import financial_overview
from ..services.purchase_info import (
    missing_purchase_info_clause,
    purchase_info_filter_clause,
)
from ..services.query_text import clean_subject, search_term_variants
from ..services.serializers import (
    item_detail,
    item_load_options,
    item_summary,
)
from ..services.warranties import warranty_status
from ..services.warranty_dashboard import build_dashboard, load_warranties
from . import borrowed as borrowed_service
from .container_serializers import location_path_map
from .containers import (
    deterministic_summary,
    load_container_items,
    location_ancestors,
    room_ancestors,
)
from .items import get_item
from .lending import item_loan_summary, list_loans, loan_quantities_for_items


@dataclass
class ToolResult:
    tool: str
    summary: str
    filters: dict[str, Any] = field(default_factory=dict)
    items: list[ItemSummary] = field(default_factory=list)
    borrowed: list[BorrowedOut] = field(default_factory=list)
    documents: list[dict[str, Any]] = field(default_factory=list)
    locations: list[dict[str, Any]] = field(default_factory=list)
    references: list[AssistantReference] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)


def _summaries_with_paths(
    db: Session,
    household_id: uuid.UUID,
    items: list[Item],
    *,
    household_reminder_days: int,
) -> list[ItemSummary]:
    paths = location_path_map(db, household_id)
    loan_quantities = loan_quantities_for_items(db, household_id, [item.id for item in items])
    summaries = []
    for item in items:
        summary = item_summary(
            item,
            household_reminder_days=household_reminder_days,
            on_loan_quantity=loan_quantities.get(item.id, 0),
        )
        if item.storage_location_id:
            summary = summary.model_copy(
                update={"location_path": paths.get(item.storage_location_id, [])}
            )
        summaries.append(summary)
    return summaries


def _location_display(location: Any) -> str:
    identifier = getattr(location, "identifier", None)
    name = getattr(location, "name", "")
    if identifier and identifier != name:
        return f"{identifier} · {name}"
    return identifier or name


def _item_reference(item: ItemSummary | Item) -> AssistantReference:
    if isinstance(item, Item):
        property_name = (
            item.room.property.name
            if item.room is not None and item.room.property is not None
            else None
        )
        room_name = getattr(item.room, "name", None)
        household = item.household
    else:
        property_name = item.property.name if item.property else None
        room_name = item.room.name if item.room else None
        household = item.household
    subtitle = " / ".join(part for part in (property_name, room_name) if part) or None
    return AssistantReference(
        type="item",
        id=item.id,
        title=item.name,
        subtitle=subtitle,
        url=f"/items/{item.id}",
        household_id=household.id if household is not None else None,
        household_name=household.name if household is not None else None,
    )


def _borrowed_reference(record: BorrowedOut) -> AssistantReference:
    place = _borrowed_place(record)
    subtitle = (
        f"{record.physically_held_quantity} held"
        if borrowed_service.has_held_stock(record)
        else "returned"
        if record.status == "returned"
        else "cancelled"
    )
    if place:
        subtitle += f" · {borrowed_service.location_prefix(record)} {place}"
    if record.due_on:
        subtitle += f" · due {_human_date(record.due_on)}"
    return AssistantReference(
        type="borrowed",
        id=record.id,
        title=f"{record.item_name} borrowed from {record.owner_name}",
        subtitle=subtitle,
        url=f"/borrowed/{record.id}",
    )


def _borrowed_place(record: BorrowedOut) -> str | None:
    parts = [
        record.property_name,
        record.room_name,
        (
            f"{record.storage_location_identifier} · {record.storage_location_name}"
            if record.storage_location_identifier
            and record.storage_location_name
            and record.storage_location_identifier != record.storage_location_name
            else record.storage_location_identifier or record.storage_location_name
        ),
    ]
    filtered = [part for part in parts if part]
    return " / ".join(filtered) if filtered else None


def _borrowed_label(record: BorrowedOut) -> str:
    place = _borrowed_place(record)
    due = f", due {_human_date(record.due_on)}" if record.due_on else ""
    return (
        f"{record.item_name} — belongs to {record.owner_name}, "
        f"{borrowed_service.location_prefix(record)} "
        f"{place or 'no place recorded'}{due} · "
        f"{record.outstanding_quantity} outstanding"
    )


def _home_path(db: Session, household_id: uuid.UUID, item: Item) -> str | None:
    room_records = room_ancestors(db, household_id, item.room_id) if item.room_id else []
    property_name = (
        room_records[0].property.name
        if room_records and room_records[0].property is not None
        else None
    )
    room_parts = [room.name for room in room_records]
    location_parts = (
        [
            _location_display(location)
            for location in location_ancestors(db, household_id, item.storage_location_id)
        ]
        if item.storage_location_id
        else []
    )
    parts = [property_name] if property_name else []
    if room_parts:
        parts.append(" → ".join(room_parts))
    if location_parts:
        parts.append(" → ".join(location_parts))
    return " → ".join(parts) if parts else None


def _human_date(value: Any) -> str:
    if hasattr(value, "day") and hasattr(value, "strftime"):
        return f"{value.day} {value.strftime('%b %Y')}"
    return str(value)


def _item_display_name(item: Item) -> str:
    if item.brand and item.brand.lower() not in item.name.lower():
        return f"{item.brand} {item.name}"
    return item.name


def _join_natural(parts: list[str]) -> str:
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return f"{', '.join(parts[:-1])}, and {parts[-1]}"


def _borrower_breakdown(loans: list[Any]) -> str:
    grouped: dict[str, list[Any]] = {}
    for loan in loans:
        grouped.setdefault(loan.borrower_name, []).append(loan)
    pieces: list[str] = []
    for borrower, borrower_loans in grouped.items():
        quantity = sum(loan.outstanding_quantity for loan in borrower_loans)
        due = ""
        if len(borrower_loans) == 1 and borrower_loans[0].due_on is not None:
            due = f" (due {_human_date(borrower_loans[0].due_on)})"
        pieces.append(f"{borrower} has {quantity}{due}")
    return _join_natural(pieces)


def _whereabouts_summary(
    *,
    item: Item,
    owned: int,
    on_loan: int,
    at_home: int,
    home: str | None,
    open_loans: list[Any],
) -> str:
    display = _item_display_name(item)
    if on_loan <= 0:
        if home:
            return f"Your {display} is recorded at home in {home}. No open loan is recorded."
        return f"Your {display} has no open loan. No home location is recorded."

    if len(open_loans) == 1 and at_home == 0:
        loan = open_loans[0]
        date_sentence = (
            f"Due {_human_date(loan.due_on)}."
            if loan.due_on is not None
            else "No return date is set."
        )
        home_sentence = (
            f"You normally keep it in {home}." if home else "No home location is recorded."
        )
        return f"{loan.borrower_name} has your {display}. {date_sentence} {home_sentence}"

    if len(open_loans) == 1:
        loan = open_loans[0]
        first = f"{loan.borrower_name} has {on_loan} of your {owned} units of {display}."
        if loan.due_on is not None:
            first += f" Due {_human_date(loan.due_on)}."
        else:
            first += " No return date is set."
        if home:
            return (
                f"{first} The other {at_home} {'is' if at_home == 1 else 'are'} at home in {home}."
            )
        return f"{first} No home location is recorded for the other {at_home}."

    breakdown = _borrower_breakdown(open_loans)
    if at_home == 0:
        return f"All {owned} of your units of {display} are on loan: {breakdown}."
    if home:
        return (
            f"{on_loan} of your {owned} units of {display} are on loan: {breakdown}. "
            f"The other {at_home} {'is' if at_home == 1 else 'are'} at home in {home}."
        )
    return (
        f"{on_loan} of your {owned} units of {display} are on loan: {breakdown}. "
        f"No home location is recorded for the other {at_home}."
    )


def _resolve_room(
    db: Session,
    household_id: uuid.UUID,
    *,
    room_id: uuid.UUID | None = None,
    name: str | None = None,
) -> Room | None:
    if room_id:
        return db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if not name:
        return None
    normalized = name.strip().lower()
    return db.scalar(
        select(Room)
        .where(
            Room.household_id == household_id,
            func.lower(Room.name) == normalized,
        )
        .limit(1)
    ) or db.scalar(
        select(Room)
        .where(Room.household_id == household_id, Room.name.ilike(f"%{normalized}%"))
        .order_by(func.length(Room.name))
        .limit(1)
    )


def _resolve_location(
    db: Session,
    household_id: uuid.UUID,
    *,
    location_id: uuid.UUID | None = None,
    name: str | None = None,
) -> StorageLocation | None:
    if location_id:
        return db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == household_id,
            )
        )
    if not name:
        return None
    normalized = name.strip().lower()
    identifier = name.strip().upper()
    if re.fullmatch(r"[A-Z]{2,12}-[0-9]{3,6}", identifier):
        exact = db.scalar(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                func.upper(StorageLocation.identifier) == identifier,
            )
        )
        if exact is not None:
            return exact
    return db.scalar(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            func.lower(StorageLocation.name) == normalized,
        )
        .limit(1)
    ) or db.scalar(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.name.ilike(f"%{normalized}%"),
        )
        .order_by(func.length(StorageLocation.name))
        .limit(1)
    )


def _resolve_category(
    db: Session,
    household_id: uuid.UUID,
    *,
    category_id: uuid.UUID | None = None,
    name: str | None = None,
) -> Category | None:
    if category_id:
        return db.scalar(
            select(Category).where(
                Category.id == category_id, Category.household_id == household_id
            )
        )
    if not name:
        return None
    normalized = name.strip().lower()
    return db.scalar(
        select(Category)
        .where(
            Category.household_id == household_id,
            or_(
                func.lower(Category.name) == normalized,
                Category.name.ilike(f"%{normalized}%"),
            ),
        )
        .order_by(func.length(Category.name))
        .limit(1)
    )


def _inventory_conditions(
    db: Session,
    household_id: uuid.UUID,
    filters: NaturalSearchFilters,
    *,
    household_reminder_days: int,
) -> list[Any] | None:
    conditions: list[Any] = [
        Item.household_id == household_id,
        Item.is_archived.is_(False),
    ]
    if filters.property_id is not None:
        conditions.append(
            or_(
                Item.room.has(Room.property_id == filters.property_id),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == filters.property_id)
                ),
            )
        )
    room = _resolve_room(db, household_id, room_id=filters.room_id, name=filters.room_name)
    if filters.room_id and room is None:
        return None
    room_rows = db.execute(
        select(Room.id, Room.parent_id).where(Room.household_id == household_id)
    ).all()
    if room is not None:
        conditions.append(Item.room_id.in_(descendant_ids(room_rows, room.id)))
    if filters.exclude_room_id:
        excluded = _resolve_room(db, household_id, room_id=filters.exclude_room_id)
        if excluded is not None:
            conditions.append(
                or_(
                    Item.room_id.is_(None),
                    Item.room_id.not_in(descendant_ids(room_rows, excluded.id)),
                )
            )
    location = _resolve_location(
        db, household_id, location_id=filters.location_id, name=filters.location_name
    )
    if filters.location_id and location is None:
        return None
    if location is not None:
        location_rows = db.execute(
            select(StorageLocation.id, StorageLocation.parent_id).where(
                StorageLocation.household_id == household_id
            )
        ).all()
        conditions.append(Item.storage_location_id.in_(descendant_ids(location_rows, location.id)))
    category = _resolve_category(
        db, household_id, category_id=filters.category_id, name=filters.category_name
    )
    if filters.category_id and category is None:
        return None
    if category is not None:
        conditions.append(Item.category_id == category.id)
    if filters.tag:
        conditions.append(Item.tags.any(Tag.name.ilike(f"%{filters.tag}%")))
    if filters.q:
        term_conditions = []
        for value in search_term_variants(filters.q.strip()):
            search = f"%{value}%"
            term_conditions.append(
                or_(
                    Item.name.ilike(search),
                    Item.description.ilike(search),
                    Item.brand.ilike(search),
                    Item.model.ilike(search),
                    Item.serial_number.ilike(search),
                    Item.category.has(Category.name.ilike(search)),
                    Item.room.has(Room.name.ilike(search)),
                    Item.storage_location.has(
                        or_(
                            StorageLocation.name.ilike(search),
                            StorageLocation.identifier.ilike(search),
                        )
                    ),
                    Item.tags.any(Tag.name.ilike(search)),
                    Item.documents.any(
                        or_(
                            Document.title.ilike(search),
                            Document.extracted_text.ilike(search),
                        )
                    ),
                )
            )
        conditions.append(or_(*term_conditions))
    if filters.purchase_info_status:
        conditions.append(purchase_info_filter_clause(filters.purchase_info_status))
    if filters.missing_purchase:
        conditions.append(missing_purchase_info_clause())
    if filters.missing_purchase_date:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.MISSING_DATE))
    if filters.missing_purchase_price:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.MISSING_PRICE))
    if filters.missing_serial:
        conditions.append(or_(Item.serial_number.is_(None), Item.serial_number == ""))
    if filters.purchased_after or filters.purchased_before:
        purchase_conditions = []
        if filters.purchased_after:
            purchase_conditions.append(Purchase.purchase_date >= filters.purchased_after)
        if filters.purchased_before:
            purchase_conditions.append(Purchase.purchase_date <= filters.purchased_before)
        conditions.append(Item.purchase.has(and_(*purchase_conditions)))
    if filters.min_purchase_cents is not None or filters.max_purchase_cents is not None:
        price_conditions = []
        if filters.min_purchase_cents is not None:
            price_conditions.append(Purchase.price_cents >= filters.min_purchase_cents)
        if filters.max_purchase_cents is not None:
            price_conditions.append(Purchase.price_cents <= filters.max_purchase_cents)
        conditions.append(Item.purchase.has(and_(*price_conditions)))
    today = date.today()
    if filters.warranty_status:
        if filters.warranty_status == "expired":
            conditions.append(
                Item.warranty.has(and_(Warranty.end_date.is_not(None), Warranty.end_date < today))
            )
        elif filters.warranty_status == "expiring":
            conditions.append(
                Item.warranty.has(
                    and_(
                        Warranty.end_date.is_not(None),
                        Warranty.end_date >= today,
                        Warranty.end_date <= today + timedelta(days=household_reminder_days),
                    )
                )
            )
        else:
            conditions.append(
                Item.warranty.has(and_(Warranty.end_date.is_not(None), Warranty.end_date >= today))
            )

    return conditions


def search_inventory(
    db: Session,
    household_id: uuid.UUID,
    filters: NaturalSearchFilters,
    *,
    household_reminder_days: int,
    limit: int = 30,
) -> tuple[list[Item], int]:
    conditions = _inventory_conditions(
        db, household_id, filters, household_reminder_days=household_reminder_days
    )
    if conditions is None:
        return [], 0
    total = int(db.scalar(select(func.count(Item.id)).where(*conditions)) or 0)
    query = (
        select(Item)
        .options(*item_load_options())
        .outerjoin(Purchase, Purchase.id == Item.purchase_id)
        .where(*conditions)
    )
    ordering = {
        "purchase_desc": [Purchase.price_cents.desc().nullslast(), Item.name.asc()],
        "purchase_asc": [Purchase.price_cents.asc().nullslast(), Item.name.asc()],
        "name_asc": [func.lower(Item.name).asc()],
        "relevance": [Item.updated_at.desc()],
    }[filters.sort]
    return list(db.scalars(query.order_by(*ordering).limit(limit)).all()), total


def inventory_totals(
    db: Session,
    household_id: uuid.UUID,
    filters: NaturalSearchFilters,
    *,
    household_reminder_days: int,
) -> tuple[int, int]:
    """Exact matching record and unit totals, independent of any display cap."""

    conditions = _inventory_conditions(
        db, household_id, filters, household_reminder_days=household_reminder_days
    )
    if conditions is None:
        return 0, 0
    row = db.execute(
        select(
            func.count(Item.id),
            func.coalesce(func.sum(Item.quantity), 0),
        ).where(*conditions)
    ).one()
    return int(row[0] or 0), int(row[1] or 0)


def _add_item(items: list[ItemSummary], seen: set[uuid.UUID], item: Item, reminder: int) -> None:
    if item.id in seen:
        return
    seen.add(item.id)
    items.append(item_summary(item, household_reminder_days=reminder))


def tool_search_items(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    filters = NaturalSearchFilters(
        q=str(args.get("q") or "").strip() or None,
        property_id=args.get("property_id"),
        room_name=str(args.get("room_name") or "").strip() or None,
        location_name=str(args.get("location_name") or "").strip() or None,
        exclude_room_id=args.get("exclude_room_id"),
        category_name=str(args.get("category_name") or "").strip() or None,
        tag=str(args.get("tag") or "").strip() or None,
        missing_purchase=bool(args.get("missing_purchase")),
        missing_purchase_date=bool(args.get("missing_purchase_date")),
        missing_purchase_price=bool(args.get("missing_purchase_price")),
        purchase_info_status=args.get("purchase_info_status"),
        missing_serial=bool(args.get("missing_serial")),
        warranty_status=args.get("warranty_status"),
        purchased_after=args.get("purchased_after"),
        purchased_before=args.get("purchased_before"),
        min_purchase_cents=args.get("min_purchase_cents"),
        max_purchase_cents=args.get("max_purchase_cents"),
        sort=args.get("sort") or "relevance",
    )
    items, total = search_inventory(
        db, household_id, filters, household_reminder_days=household_reminder_days
    )
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    exact_total, quantity_total = inventory_totals(
        db, household_id, filters, household_reminder_days=household_reminder_days
    )
    total = max(total, exact_total)
    borrowed_matches = borrowed_service.matching_records(
        db,
        household_id,
        q=filters.q or "",
        limit=8,
        property_id=filters.property_id,
    )
    if not summaries and not borrowed_matches:
        summary = "No matching inventory items or borrowed records were found."
    elif len(summaries) == 1:
        item = summaries[0]
        place = item.room.name if item.room else "no room recorded"
        if item.location:
            place += f" / {_location_display(item.location)}"
        summary = (
            f"Found 1 owned item: {item.name} "
            f"({item.quantity} {'unit' if item.quantity == 1 else 'units'}). "
            f"Location: {place}. "
            f"Purchase information: {item.purchase_info_status.replace('_', ' ')}."
        )
        if item.on_loan_quantity:
            summary += (
                f" {item.on_loan_quantity} of {item.quantity} "
                f"{'is' if item.on_loan_quantity == 1 else 'are'} currently on loan."
            )
    else:
        summary = (
            f"Found {total} matching owned items with {quantity_total} units recorded. "
            f"The first {min(total, len(summaries))} are listed."
        )
    if borrowed_matches:
        summary += (
            f" Also found {len(borrowed_matches)} borrowed record(s); these are held "
            "from other owners and are not part of owned stock."
        )
    references = [_item_reference(item) for item in summaries]
    references.extend(_borrowed_reference(record) for record in borrowed_matches)
    return ToolResult(
        tool="search_items",
        summary=summary,
        filters=filters.model_dump(mode="json", exclude_none=True),
        items=summaries,
        borrowed=borrowed_matches,
        references=references,
        facts={
            "total": total,
            "quantity_total": quantity_total,
            "on_loan_quantity": sum(item.on_loan_quantity for item in summaries),
            "borrowed_total": len(borrowed_matches),
            "borrowed_outstanding_quantity": sum(
                record.outstanding_quantity for record in borrowed_matches
            ),
        },
    )


def tool_get_item_details(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    item_id = args.get("item_id")
    if not item_id:
        raise ValueError("item_id is required")
    item = get_item(db, household_id, uuid.UUID(str(item_id)))
    detail = item_detail(item, household_reminder_days=household_reminder_days)
    summary = f"{detail.name}: "
    parts = []
    if detail.room:
        parts.append(f"in {detail.room.name}")
    if detail.location:
        parts.append(f"at {detail.location.identifier or detail.location.name}")
    if detail.brand or detail.model:
        parts.append(f"{detail.brand or ''} {detail.model or ''}".strip())
    loan_summary = item_loan_summary(db, household_id, detail.id)
    if loan_summary.on_loan_quantity:
        parts.append(
            f"{loan_summary.on_loan_quantity} on loan, {loan_summary.available_quantity} at home"
        )
    summary += ", ".join(parts) if parts else "no location recorded"
    return ToolResult(
        tool="get_item_details",
        summary=summary,
        items=[detail],
        references=[_item_reference(detail)],
        facts=detail.model_dump(mode="json"),
    )


def tool_search_locations(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    query = str(args.get("q") or "").strip()
    property_id = args.get("property_id")
    room_conditions = [Room.household_id == household_id]
    location_conditions = [StorageLocation.household_id == household_id]
    if property_id is not None:
        room_conditions.append(Room.property_id == property_id)
        location_conditions.append(StorageLocation.room.has(Room.property_id == property_id))
    rooms = db.scalars(select(Room).where(*room_conditions)).all()
    locations = db.scalars(select(StorageLocation).where(*location_conditions)).all()
    room_map = {room.id: room for room in rooms}
    if query:
        lowered = query.lower()
        rooms = [room for room in rooms if lowered in room.name.lower()]
        locations = [
            loc
            for loc in locations
            if lowered in loc.name.lower() or (loc.identifier and lowered in loc.identifier.lower())
        ]
    results = [
        {
            "id": str(room.id),
            "type": "room",
            "name": room.name,
            "url": f"/rooms/{room.id}",
            "property": room.property.name if room.property is not None else None,
            "item_count": sum(
                1
                for item in db.scalars(
                    select(Item).where(
                        Item.household_id == household_id,
                        Item.room_id == room.id,
                        Item.is_archived.is_(False),
                    )
                ).all()
            ),
        }
        for room in rooms[:20]
    ] + [
        {
            "id": str(location.id),
            "type": "storage_location",
            "name": location.name,
            "identifier": location.identifier,
            "is_container": location.is_container,
            "container_type": location.container_type,
            "room": room_map.get(location.room_id).name if room_map.get(location.room_id) else None,
            "property": (
                room_map.get(location.room_id).property.name
                if room_map.get(location.room_id)
                and room_map.get(location.room_id).property is not None
                else None
            ),
            "url": f"/containers/{location.id}",
        }
        for location in locations[:20]
    ]
    return ToolResult(
        tool="search_locations",
        summary=f"Found {len(results)} matching rooms or storage places.",
        locations=results,
        filters={"q": query},
    )


def tool_list_room_contents(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    room = _resolve_room(
        db,
        household_id,
        room_id=args.get("room_id"),
        name=args.get("room_name"),
    )
    if room is None:
        raise ValueError("Room not found")
    if args.get("property_id") is not None and room.property_id != args["property_id"]:
        raise ValueError("Room not found in the selected property")
    rooms = db.scalars(select(Room).where(Room.household_id == household_id)).all()
    children = {room.id}
    changed = True
    while changed:
        changed = False
        for child in rooms:
            if child.parent_id in children and child.id not in children:
                children.add(child.id)
                changed = True
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(
            Item.household_id == household_id,
            Item.is_archived.is_(False),
            Item.room_id.in_(children),
        )
        .order_by(func.lower(Item.name))
    ).all()
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    locations = db.scalars(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.room_id.in_(children),
        )
        .order_by(StorageLocation.sort_order, StorageLocation.name)
    ).all()
    location_results = [
        {
            "id": str(location.id),
            "type": "storage_location",
            "name": location.name,
            "identifier": location.identifier,
            "is_container": location.is_container,
            "room": room.name,
            "url": f"/containers/{location.id}",
        }
        for location in locations
    ]
    item_word = "item" if len(summaries) == 1 else "items"
    room_word = "room" if len(children) == 1 else "rooms"
    return ToolResult(
        tool="list_room_contents",
        summary=(
            f"{room.name} contains {len(summaries)} {item_word} in {len(children)} {room_word}."
        ),
        items=summaries,
        locations=location_results,
        references=[_item_reference(item) for item in summaries]
        + [AssistantReference(type="room", id=room.id, title=room.name, url=f"/rooms/{room.id}")],
        facts={"room_id": str(room.id), "room_name": room.name, "total": len(summaries)},
    )


def tool_get_container_contents(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    location_id = args.get("container_id")
    identifier = str(args.get("identifier") or "").strip().upper()
    if location_id:
        location = _resolve_location(db, household_id, location_id=uuid.UUID(str(location_id)))
    elif identifier:
        location = _resolve_location(db, household_id, name=identifier)
    else:
        location = _resolve_location(
            db, household_id, name=str(args.get("container_name") or "").strip()
        )
    if location is None:
        raise ValueError("Container not found")
    if (
        args.get("property_id") is not None
        and location.room is not None
        and location.room.property_id != args["property_id"]
    ):
        raise ValueError("Container not found in the selected property")
    items = load_container_items(db, household_id, location.id)
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    live = deterministic_summary(items)
    room_chain = room_ancestors(db, household_id, location.room_id)
    property_name = (
        room_chain[0].property.name if room_chain and room_chain[0].property is not None else None
    )
    path = " / ".join(
        ([property_name] if property_name else [])
        + [entry.name for entry in room_chain]
        + [entry.name for entry in location_ancestors(db, household_id, location.id)]
    )
    label = location.identifier or location.name
    summary = (
        f"{label} is in {path} and contains {len(summaries)} items "
        f"({sum(item.quantity for item in items)} units)."
        if summaries
        else f"{label} is in {path} and is empty."
    )
    return ToolResult(
        tool="get_container_contents",
        summary=summary,
        items=summaries,
        locations=[
            {
                "id": str(location.id),
                "type": "storage_location",
                "name": location.name,
                "identifier": location.identifier,
                "room": location.room.name if location.room else None,
                "url": f"/containers/{location.id}",
            }
        ],
        references=[_item_reference(item) for item in summaries]
        + [
            AssistantReference(
                type="location",
                id=location.id,
                title=label,
                subtitle=path,
                url=f"/containers/{location.id}",
            )
        ],
        facts={
            "container_id": str(location.id),
            "identifier": location.identifier,
            "name": location.name,
            "path": path,
            "room": location.room.name if location.room else None,
            "item_count": len(summaries),
            "total_quantity": sum(item.quantity for item in items),
            "summary": live.short,
        },
    )


def tool_search_documents(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    query = str(args.get("q") or "").strip()
    item_id = args.get("item_id")
    conditions = [Document.household_id == household_id]
    if args.get("property_id") is not None:
        conditions.append(
            Document.items.any(
                or_(
                    Item.room.has(Room.property_id == args["property_id"]),
                    Item.storage_location.has(
                        StorageLocation.room.has(Room.property_id == args["property_id"])
                    ),
                )
            )
        )
    if item_id:
        conditions.append(Document.items.any(Item.id == uuid.UUID(str(item_id))))
    if query:
        search = f"%{query}%"
        conditions.append(
            or_(
                Document.title.ilike(search),
                Document.merchant.ilike(search),
                Document.extracted_text.ilike(search),
                Document.original_filename.ilike(search),
                Document.items.any(Item.name.ilike(search)),
            )
        )
    documents = db.scalars(
        select(Document).where(*conditions).order_by(Document.created_at.desc()).limit(20)
    ).all()
    output = [
        {
            "id": str(document.id),
            "title": document.title,
            "type": document.document_type,
            "merchant": document.merchant,
            "document_date": document.document_date.isoformat() if document.document_date else None,
            "items": [item.name for item in document.items],
            "url": f"/documents/{document.id}",
        }
        for document in documents
    ]
    return ToolResult(
        tool="search_documents",
        summary=f"Found {len(output)} matching documents.",
        documents=output,
        filters={"q": query, "item_id": str(item_id) if item_id else None},
        references=[
            AssistantReference(
                type="document",
                id=document.id,
                title=document.title,
                subtitle=document.merchant,
                url=f"/documents/{document.id}",
            )
            for document in documents
        ],
    )


def tool_get_purchase_history(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    conditions = [Purchase.household_id == household_id]
    if args.get("property_id") is not None:
        conditions.append(
            Purchase.items.any(
                or_(
                    Item.room.has(Room.property_id == args["property_id"]),
                    Item.storage_location.has(
                        StorageLocation.room.has(Room.property_id == args["property_id"])
                    ),
                )
            )
        )
    if args.get("merchant"):
        conditions.append(Purchase.vendor.ilike(f"%{args['merchant']}%"))
    if args.get("item_id"):
        conditions.append(Purchase.items.any(Item.id == uuid.UUID(str(args["item_id"]))))
    if args.get("date_from"):
        conditions.append(Purchase.purchase_date >= date.fromisoformat(str(args["date_from"])))
    if args.get("date_to"):
        conditions.append(Purchase.purchase_date <= date.fromisoformat(str(args["date_to"])))
    purchases = db.scalars(
        select(Purchase)
        .where(*conditions)
        .order_by(Purchase.purchase_date.desc().nullslast(), Purchase.created_at.desc())
        .limit(20)
    ).all()
    output = []
    for purchase in purchases:
        output.append(
            {
                "id": str(purchase.id),
                "merchant": purchase.vendor,
                "purchase_date": purchase.purchase_date.isoformat()
                if purchase.purchase_date
                else None,
                "price_cents": purchase.price_cents,
                "currency": purchase.currency,
                "items": [item.name for item in purchase.items],
                "receipt": purchase.receipt_document.title if purchase.receipt_document else None,
            }
        )
    return ToolResult(
        tool="get_purchase_history",
        summary=f"Found {len(output)} purchase records.",
        filters=args,
        facts={"purchases": output},
        references=[
            AssistantReference(
                type="purchase",
                id=purchase.id,
                title=purchase.vendor or "Purchase",
                subtitle=purchase.purchase_date.isoformat() if purchase.purchase_date else None,
                url="/purchases",
            )
            for purchase in purchases
        ],
    )


def tool_get_warranty_status(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    warranties = load_warranties(db, household_id)
    category_name = str(args.get("category") or "").strip().lower()
    status_filter = args.get("status")
    today = date.today()
    rows = []
    property_id = args.get("property_id")
    for warranty in warranties:
        if property_id is not None and warranty.item is not None:
            item = warranty.item
            item_property_id = (
                item.room.property_id
                if item.room is not None
                else (
                    item.storage_location.room.property_id
                    if item.storage_location is not None and item.storage_location.room is not None
                    else None
                )
            )
            if item_property_id != property_id:
                continue
        effective = warranty.reminder_days or household_reminder_days
        status, days = warranty_status(warranty.end_date, reminder_days=effective)
        if status_filter == "active" and status == WarrantyStatus.EXPIRED:
            continue
        if status_filter == "expiring" and status != WarrantyStatus.EXPIRING:
            continue
        if status_filter == "expired" and status != WarrantyStatus.EXPIRED:
            continue
        if category_name and (
            not warranty.item.category or category_name not in warranty.item.category.name.lower()
        ):
            continue
        if not warranty.item:
            continue
        rows.append(
            {
                "warranty_id": str(warranty.id),
                "item_id": str(warranty.item.id),
                "item": warranty.item.name,
                "provider": warranty.provider,
                "end_date": warranty.end_date.isoformat() if warranty.end_date else None,
                "status": status.value,
                "days_remaining": days,
                "url": f"/items/{warranty.item.id}",
            }
        )
    return ToolResult(
        tool="get_warranty_status",
        summary=f"Found {len(rows)} warranties matching that request.",
        filters=args,
        facts={"warranties": rows, "today": today.isoformat()},
        references=[
            AssistantReference(
                type="warranty",
                id=uuid.UUID(row["warranty_id"]),
                title=row["item"],
                subtitle=row["end_date"],
                url=row["url"],
            )
            for row in rows
        ][:20],
    )


def tool_get_inventory_summary(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    property_id = args.get("property_id")
    if property_id is not None:
        property_condition = or_(
            Item.room.has(Room.property_id == property_id),
            Item.storage_location.has(StorageLocation.room.has(Room.property_id == property_id)),
        )
        item_count = int(
            db.scalar(
                select(func.count(Item.id)).where(
                    Item.household_id == household_id,
                    Item.is_archived.is_(False),
                    property_condition,
                )
            )
            or 0
        )
        total_quantity = int(
            db.scalar(
                select(func.coalesce(func.sum(Item.quantity), 0)).where(
                    Item.household_id == household_id,
                    Item.is_archived.is_(False),
                    property_condition,
                )
            )
            or 0
        )
        property_item_ids = select(Item.id).where(
            Item.household_id == household_id,
            property_condition,
        )
        on_loan = int(
            db.scalar(
                select(func.coalesce(func.sum(Loan.quantity - Loan.returned_quantity), 0)).where(
                    Loan.household_id == household_id,
                    Loan.status.in_({"outstanding", "partially_returned"}),
                    Loan.item_id.in_(property_item_ids),
                )
            )
            or 0
        )
        borrowed = borrowed_service.borrowed_totals(db, household_id, property_id=property_id)
        borrowed_sentence = (
            f" Separately, {borrowed.outstanding_quantity} borrowed unit(s) are held "
            f"here from {borrowed.open_count} external owner record(s); borrowed goods "
            "are not included in owned item or value totals."
            if borrowed.open_count
            else ""
        )
        return ToolResult(
            tool="get_inventory_summary",
            summary=(
                f"This property has {item_count} active item records with "
                f"{total_quantity} units. {on_loan} units are currently on loan."
                f"{borrowed_sentence}"
            ),
            facts={
                "item_count": item_count,
                "total_quantity": total_quantity,
                "on_loan_quantity": on_loan,
                "borrowed_quantity": borrowed.total_borrowed_quantity,
                "borrowed_outstanding_quantity": borrowed.outstanding_quantity,
                "borrowed_returned_quantity": borrowed.returned_quantity,
                "borrowed_physically_held_quantity": borrowed.physically_held_quantity,
                "items_missing_purchase_count": 0,
                "warranties": {"active": 0, "expiring": 0, "expired": 0},
                "property_id": str(property_id),
            },
        )
    financial = financial_overview(
        db,
        household_id,
        household_reminder_days=household_reminder_days,
        valuable_limit=5,
        missing_limit=5,
    )
    warranties = build_dashboard(
        load_warranties(db, household_id), household_reminder_days, limit=5
    )
    total_quantity = int(
        db.scalar(
            select(func.coalesce(func.sum(Item.quantity), 0)).where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
            )
        )
        or 0
    )
    on_loan = int(
        db.scalar(
            select(func.coalesce(func.sum(Loan.quantity - Loan.returned_quantity), 0)).where(
                Loan.household_id == household_id,
                Loan.status.in_({"outstanding", "partially_returned"}),
            )
        )
        or 0
    )
    borrowed = borrowed_service.borrowed_totals(db, household_id)
    facts = {
        "item_count": financial.item_count,
        "total_quantity": total_quantity,
        "on_loan_quantity": on_loan,
        "borrowed_quantity": borrowed.total_borrowed_quantity,
        "borrowed_outstanding_quantity": borrowed.outstanding_quantity,
        "borrowed_returned_quantity": borrowed.returned_quantity,
        "borrowed_physically_held_quantity": borrowed.physically_held_quantity,
        "currency_totals": [entry.model_dump(mode="json") for entry in financial.currency_totals],
        "items_missing_purchase_count": financial.items_missing_purchase_count,
        "warranties": {
            "active": warranties.active_count,
            "expiring": warranties.expiring_count,
            "expired": warranties.expired_count,
        },
    }
    borrowed_sentence = (
        f" Separately, {borrowed.outstanding_quantity} borrowed unit(s) are held here "
        f"from {borrowed.open_count} external owner record(s); borrowed goods are not "
        "included in owned item or value totals."
        if borrowed.open_count
        else ""
    )
    summary = (
        f"There are {financial.item_count} active item records with {total_quantity} units. "
        f"{on_loan} units are currently on loan. "
        f"{financial.items_missing_purchase_count} items have missing or unresolved "
        f"purchase information. "
        f"Warranties: {warranties.active_count} active, {warranties.expiring_count} expiring soon, "
        f"{warranties.expired_count} expired."
        f"{borrowed_sentence}"
    )
    return ToolResult(
        tool="get_inventory_summary",
        summary=summary,
        facts=facts,
        items=[entry.item for entry in financial.most_valuable_items[:5]],
    )


def tool_list_borrowed_items(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    del household_reminder_days
    today = date.today()
    result = borrowed_service.list_records(
        db,
        household_id,
        status="open",
        property_id=args.get("property_id"),
        on_date=today,
        limit=50,
        offset=0,
    )
    records = result.items
    if not records:
        summary = "No items are currently recorded as borrowed from others."
    else:
        summary = (
            f"{result.open_count} borrowed record(s), {result.outstanding_quantity} "
            f"unit(s) held here and {result.returned_quantity} unit(s) returned so far"
            f"{f', {result.overdue_count} past due' if result.overdue_count else ''}. "
            "These are owned by other people and are not part of household stock."
        )
    references = [_borrowed_reference(record) for record in records]
    return ToolResult(
        tool="list_borrowed_items",
        summary=summary,
        borrowed=records,
        references=references,
        facts={
            "total": result.total,
            "open_count": result.open_count,
            "overdue_count": result.overdue_count,
            "borrowed_quantity": result.total_borrowed_quantity,
            "borrowed_outstanding_quantity": result.outstanding_quantity,
            "borrowed_returned_quantity": result.returned_quantity,
            "borrowed_physically_held_quantity": result.physically_held_quantity,
            "borrowed": [record.model_dump(mode="json") for record in records],
        },
    )


def tool_find_borrowed_owner(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    del household_reminder_days
    raw = str(args.get("q") or args.get("item_name") or "").strip()
    subject = clean_subject(raw) or raw
    borrowed_matches = (
        borrowed_service.matching_records(
            db,
            household_id,
            q=subject,
            limit=20,
            property_id=args.get("property_id"),
        )
        if subject
        else []
    )
    owned_matches = (
        borrowed_service.find_owned_items_matching(db, household_id, subject, limit=5)
        if subject
        else []
    )
    filters = {"q": subject} if subject else {}
    if borrowed_matches:
        lines = [_borrowed_label(record) for record in borrowed_matches[:8]]
        summary = (
            f"I found {len(borrowed_matches)} borrowed record(s) matching "
            f"“{subject}”: " + "; ".join(lines) + "."
        )
        if owned_matches:
            summary += (
                " The household also owns item record(s) with a similar name; "
                "those are separate from the borrowed goods."
            )
    elif owned_matches:
        names = ", ".join(item.name for item in owned_matches)
        summary = (
            f"{names} is recorded as household-owned inventory. No borrowed record "
            "lists another owner for that item."
        )
    else:
        summary = (
            f"I couldn't find an owned item or borrowed record matching "
            f"“{subject or 'that item'}” in this household."
        )
    references = [_borrowed_reference(record) for record in borrowed_matches]
    owned_summaries = [item_summary(item, household_reminder_days=0) for item in owned_matches]
    references.extend(_item_reference(item) for item in owned_summaries)
    return ToolResult(
        tool="find_borrowed_owner",
        summary=summary,
        filters=filters,
        items=owned_summaries,
        borrowed=borrowed_matches,
        references=references,
        facts={
            "total": len(borrowed_matches) + len(owned_matches),
            "borrowed_total": len(borrowed_matches),
            "owned_item_total": len(owned_matches),
            "borrowed": [record.model_dump(mode="json") for record in borrowed_matches],
            "owned_items": [item.model_dump(mode="json") for item in owned_summaries],
        },
    )


def tool_list_outstanding_loans(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    today = date.today()
    result = list_loans(
        db,
        household_id,
        status="open",
        on_date=today,
        limit=50,
        offset=0,
    )
    property_id = args.get("property_id")
    property_item_ids: set[uuid.UUID] | None = None
    if property_id is not None:
        property_item_ids = set(
            db.scalars(
                select(Item.id).where(
                    Item.household_id == household_id,
                    or_(
                        Item.room.has(Room.property_id == property_id),
                        Item.storage_location.has(
                            StorageLocation.room.has(Room.property_id == property_id)
                        ),
                    ),
                )
            ).all()
        )
        result.items = [loan for loan in result.items if loan.item_id in property_item_ids]
        result.outstanding_count = sum(1 for loan in result.items if loan.outstanding_quantity > 0)
        result.on_loan_quantity = sum(loan.outstanding_quantity for loan in result.items)
        result.overdue_count = sum(1 for loan in result.items if loan.overdue)
    item_ids = [loan.item_id for loan in result.items if loan.item_id]
    items = (
        list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    Item.household_id == household_id,
                    Item.id.in_(item_ids),
                )
            ).all()
        )
        if item_ids
        else []
    )
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    item_name_by_id = {item.id: item.name for item in summaries}
    facts_loans = [
        {
            "loan_id": str(loan.id),
            "item_id": str(loan.item_id) if loan.item_id else None,
            "item_name": item_name_by_id.get(loan.item_id) if loan.item_id else loan.item_name,
            "borrower_name": loan.borrower_name,
            "quantity": loan.outstanding_quantity,
            "lent_on": loan.lent_on.isoformat(),
            "due_on": loan.due_on.isoformat() if loan.due_on else None,
            "overdue": loan.overdue,
            "status": loan.status,
        }
        for loan in result.items
    ]
    if not result.items:
        summary = "No items are currently recorded as on loan."
    else:
        summary = (
            f"{result.outstanding_count} open loan(s), "
            f"{result.on_loan_quantity} unit(s) on loan"
            f"{', ' + str(result.overdue_count) + ' past due' if result.overdue_count else ''}."
        )
    references = [_item_reference(item) for item in summaries]
    return ToolResult(
        tool="list_outstanding_loans",
        summary=summary,
        items=summaries,
        references=references,
        facts={
            "outstanding_count": result.outstanding_count,
            "overdue_count": result.overdue_count,
            "on_loan_quantity": result.on_loan_quantity,
            "loans": facts_loans,
        },
    )


def tool_find_missing_information(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    field = str(args.get("field") or "purchase")
    conditions = [Item.household_id == household_id, Item.is_archived.is_(False)]
    if args.get("property_id") is not None:
        conditions.append(
            or_(
                Item.room.has(Room.property_id == args["property_id"]),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == args["property_id"])
                ),
            )
        )
    criterion = None
    if field in {"purchase", "purchase_info"}:
        conditions.append(missing_purchase_info_clause())
        label = (
            "with missing or unresolved purchase information "
            "(items marked not applicable are excluded)"
        )
        criterion = "missing_purchase"
    elif field in {"purchase_date", "missing_purchase_date"}:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.MISSING_DATE))
        label = "with a recorded purchase but no purchase date"
        criterion = "missing_purchase_date"
    elif field in {"purchase_price", "missing_purchase_price"}:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.MISSING_PRICE))
        label = "with a recorded purchase but no purchase price"
        criterion = "missing_purchase_price"
    elif field in {"purchase_unknown", "unknown_purchase"}:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.UNKNOWN))
        label = "explicitly marked purchase information unknown"
        criterion = "purchase_unknown"
    elif field in {"purchase_not_applicable", "not_applicable_purchase"}:
        conditions.append(purchase_info_filter_clause(PurchaseInfoFilter.NOT_APPLICABLE))
        label = "marked purchase information not applicable"
        criterion = "purchase_not_applicable"
    elif field in {"serial", "serial_number"}:
        conditions.append(or_(Item.serial_number.is_(None), Item.serial_number == ""))
        label = "missing serial numbers"
    elif field in {"room", "location"}:
        if field == "room":
            conditions.append(Item.room_id.is_(None))
        else:
            conditions.append(Item.storage_location_id.is_(None))
        label = f"missing {field} assignments"
    elif field in {"warranty", "warranty_info"}:
        conditions.append(~Item.warranty.has())
        label = "without warranty information"
    else:
        raise ValueError("Unsupported missing-information field")
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*conditions)
        .order_by(func.lower(Item.name))
        .limit(50)
    ).all()
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    return ToolResult(
        tool="find_missing_information",
        summary=f"Found {len(summaries)} items {label}.",
        items=summaries,
        filters={"field": field},
        references=[_item_reference(item) for item in summaries],
        facts={
            "total": len(summaries),
            "field": field,
            "criterion": criterion,
        },
    )


def _locate_candidates(
    db: Session,
    household_id: uuid.UUID,
    subject: str,
    *,
    property_id: uuid.UUID | None = None,
) -> list[Item]:
    cleaned = clean_subject(subject) or subject.strip()
    if not cleaned:
        return []
    property_conditions = []
    if property_id is not None:
        property_conditions.append(
            or_(
                Item.room.has(Room.property_id == property_id),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == property_id)
                ),
            )
        )
    exact = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                *property_conditions,
                func.lower(Item.name) == cleaned.lower(),
            )
            .limit(12)
        ).all()
    )
    if exact:
        return exact
    tokens: list[str] = []
    for variant in search_term_variants(cleaned):
        for token in re.findall(r"[a-z0-9]+", variant.lower()):
            if len(token) < 2 or token in {
                "my",
                "our",
                "the",
                "a",
                "an",
                "is",
                "are",
                "where",
                "what",
                "which",
                "of",
                "in",
                "on",
                "for",
                "to",
                "item",
                "items",
            }:
                continue
            if token not in tokens:
                tokens.append(token)
    if not tokens:
        return []
    token_conditions = [
        or_(
            Item.name.ilike(f"%{token}%"),
            Item.brand.ilike(f"%{token}%"),
            Item.model.ilike(f"%{token}%"),
        )
        for token in tokens
    ]
    return list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                *property_conditions,
                and_(*token_conditions),
            )
            .order_by(func.lower(Item.name))
            .limit(12)
        ).all()
    )


def tool_locate_item(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    query = str(args.get("q") or args.get("item_name") or "").strip()
    item_id = args.get("item_id")
    if item_id:
        item = get_item(db, household_id, uuid.UUID(str(item_id)))
        property_id = args.get("property_id")
        if property_id is not None:
            property_rooms = {
                row[0]
                for row in db.execute(
                    select(Room.id).where(
                        Room.household_id == household_id,
                        Room.property_id == property_id,
                    )
                ).all()
            }
            candidates = [] if item.room_id not in property_rooms else [item]
        else:
            candidates = [item]
    else:
        candidates = _locate_candidates(
            db, household_id, query, property_id=args.get("property_id")
        )
    borrowed_matches = (
        borrowed_service.matching_records(
            db,
            household_id,
            q=query,
            limit=8,
            property_id=args.get("property_id"),
        )
        if query
        else []
    )
    if not candidates:
        if borrowed_matches:
            summary = (
                f"I didn't find an owned item matching “{query}”, but this is recorded "
                "as borrowed: "
                + "; ".join(_borrowed_label(record) for record in borrowed_matches[:8])
                + ". Borrowed goods are kept here but owned by someone else."
            )
            return ToolResult(
                tool="locate_item",
                summary=summary,
                filters={"q": query},
                borrowed=borrowed_matches,
                references=[_borrowed_reference(record) for record in borrowed_matches],
                facts={
                    "total": 0,
                    "ambiguous": False,
                    "whereabouts": None,
                    "borrowed_total": len(borrowed_matches),
                    "borrowed": [record.model_dump(mode="json") for record in borrowed_matches],
                },
            )
        return ToolResult(
            tool="locate_item",
            summary=(
                f"I couldn't find an item matching “{query or 'that description'}” "
                "in this household, including borrowed records."
                if query
                else "Tell me the item name to look up its recorded whereabouts."
            ),
            filters={"q": query} if query else {},
            facts={"total": 0, "ambiguous": False, "whereabouts": None},
        )
    candidates = sorted(candidates, key=lambda item: item.name.lower())
    summaries = _summaries_with_paths(
        db, household_id, candidates, household_reminder_days=household_reminder_days
    )
    if len(candidates) > 1:
        names = ", ".join(
            f"{item.name} ({item.property.name + ' / ' if item.property else ''}"
            f"{item.room.name if item.room else 'No room'})"
            for item in summaries[:6]
        )
        summary = (
            f"I found {len(candidates)} owned items that could match “{query}”: {names}. "
            "Which one did you mean?"
        )
        if borrowed_matches:
            summary += (
                " Borrowed records also match and are listed separately: "
                + "; ".join(_borrowed_label(record) for record in borrowed_matches[:4])
                + "."
            )
        return ToolResult(
            tool="locate_item",
            summary=summary,
            filters={"q": query},
            items=summaries,
            borrowed=borrowed_matches,
            references=[_item_reference(item) for item in summaries]
            + [_borrowed_reference(record) for record in borrowed_matches],
            facts={
                "total": len(candidates),
                "ambiguous": True,
                "whereabouts": None,
                "borrowed_total": len(borrowed_matches),
            },
        )

    item = candidates[0]
    loan_summary = item_loan_summary(db, household_id, item.id)
    home = _home_path(db, household_id, item)
    owned = loan_summary.owned_quantity
    on_loan = loan_summary.on_loan_quantity
    at_home = loan_summary.available_quantity
    open_loans = [loan for loan in loan_summary.loans if loan.outstanding_quantity > 0]
    loan_facts = [
        {
            "loan_id": str(loan.id),
            "borrower_name": loan.borrower_name,
            "outstanding_quantity": loan.outstanding_quantity,
            "due_on": loan.due_on.isoformat() if loan.due_on else None,
            "overdue": loan.overdue,
        }
        for loan in open_loans
    ]
    summary = _whereabouts_summary(
        item=item,
        owned=owned,
        on_loan=on_loan,
        at_home=at_home,
        home=home,
        open_loans=open_loans,
    )
    if borrowed_matches:
        summary += (
            " Separately, these borrowed records also match: "
            + "; ".join(_borrowed_label(record) for record in borrowed_matches[:4])
            + ". Borrowed goods are not owned stock."
        )
    references = [_item_reference(item)]
    references.extend(
        AssistantReference(
            type="loan",
            id=loan.id,
            title=f"{item.name} loan to {loan.borrower_name}",
            subtitle=(
                f"{loan.outstanding_quantity} on loan"
                + (f" · due {loan.due_on.isoformat()}" if loan.due_on else "")
            ),
            url=f"/loans/{loan.id}",
        )
        for loan in open_loans
    )
    references.extend(_borrowed_reference(record) for record in borrowed_matches)
    return ToolResult(
        tool="locate_item",
        summary=summary,
        filters={"q": query} if query else {},
        items=summaries,
        borrowed=borrowed_matches,
        references=references,
        facts={
            "total": 1,
            "ambiguous": False,
            "borrowed_total": len(borrowed_matches),
            "whereabouts": {
                "item_id": str(item.id),
                "item_name": item.name,
                "owned_quantity": owned,
                "on_loan_quantity": on_loan,
                "at_home_quantity": at_home,
                "home_path": home,
                "loans": loan_facts,
            },
        },
    )


def tool_count_items(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    subject = clean_subject(str(args.get("q") or args.get("item_name") or ""))
    if not subject:
        return tool_get_inventory_summary(
            db, household_id, args, household_reminder_days=household_reminder_days
        )
    filters = NaturalSearchFilters(
        q=subject,
        property_id=args.get("property_id"),
        sort="name_asc",
    )
    items, total = search_inventory(
        db,
        household_id,
        filters,
        household_reminder_days=household_reminder_days,
        limit=50,
    )
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    exact_total, quantity_total = inventory_totals(
        db, household_id, filters, household_reminder_days=household_reminder_days
    )
    total = max(total, exact_total)
    on_loan = sum(item.on_loan_quantity for item in summaries)
    borrowed_matches = borrowed_service.matching_records(
        db, household_id, q=subject, limit=8, property_id=filters.property_id
    )
    if total == 0:
        summary = f"No owned items matching “{subject}” were found in this household."
    elif total == 1:
        item = summaries[0]
        summary = (
            f"You have {item.quantity} "
            f"{'unit' if item.quantity == 1 else 'units'} of {item.name} recorded."
        )
        if item.on_loan_quantity:
            summary += f" {item.on_loan_quantity} are currently on loan."
    else:
        summary = (
            f"You own {quantity_total} units across {total} matching item records for “{subject}”."
        )
        if on_loan:
            summary += f" {on_loan} units are currently on loan."
    if borrowed_matches:
        held = sum(record.outstanding_quantity for record in borrowed_matches)
        summary += (
            f" Separately, {held} borrowed unit(s) match “{subject}” across "
            f"{len(borrowed_matches)} record(s); borrowed goods are not owned stock."
        )
    return ToolResult(
        tool="count_items",
        summary=summary,
        filters=filters.model_dump(mode="json", exclude_none=True),
        items=summaries,
        borrowed=borrowed_matches,
        references=[_item_reference(item) for item in summaries]
        + [_borrowed_reference(record) for record in borrowed_matches],
        facts={
            "total": total,
            "quantity_total": quantity_total,
            "on_loan_quantity": on_loan,
            "borrowed_total": len(borrowed_matches),
            "borrowed_outstanding_quantity": sum(
                record.outstanding_quantity for record in borrowed_matches
            ),
            "subject": subject,
        },
    )


def execute_tool(
    db: Session,
    household_id: uuid.UUID,
    tool: str,
    arguments: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    handlers = {
        "search_items": lambda: tool_search_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_item_details": lambda: tool_get_item_details(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "search_locations": lambda: tool_search_locations(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_room_contents": lambda: tool_list_room_contents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_container_contents": lambda: tool_get_container_contents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "search_documents": lambda: tool_search_documents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_purchase_history": lambda: tool_get_purchase_history(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_warranty_status": lambda: tool_get_warranty_status(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_inventory_summary": lambda: tool_get_inventory_summary(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "find_missing_information": lambda: tool_find_missing_information(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_outstanding_loans": lambda: tool_list_outstanding_loans(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_borrowed_items": lambda: tool_list_borrowed_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "find_borrowed_owner": lambda: tool_find_borrowed_owner(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "locate_item": lambda: tool_locate_item(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "count_items": lambda: tool_count_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
    }
    handler = handlers.get(tool)
    if handler is None:
        raise ValueError("Unknown tool")
    return handler()


def document_relations(
    db: Session,
    household_id: uuid.UUID,
    document: Document,
    *,
    household_reminder_days: int,
    limit: int = 8,
) -> list[dict[str, Any]]:
    metadata = document.extracted_metadata or {}
    text = " ".join(
        [
            str(metadata.get("merchant") or ""),
            " ".join(str(name) for name in metadata.get("product_names") or []),
            " ".join(str(serial) for serial in metadata.get("serial_numbers") or []),
            document.merchant or "",
        ]
    )
    if not text.strip():
        return []
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(Item.household_id == household_id, Item.is_archived.is_(False))
    ).all()
    serials = {str(value).lower() for value in metadata.get("serial_numbers") or []}
    results = []
    for item in items:
        score = 0
        reasons = []
        if item.serial_number and item.serial_number.lower() in serials:
            score += 80
            reasons.append("serial number matches the document")
        haystack = " ".join(
            filter(
                None,
                [item.name, item.brand, item.model, item.serial_number, item.description],
            )
        ).lower()
        tokens = [
            token.lower()
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9-]{2,}", text)
            if len(token) >= 4
            and token.lower()
            not in {"with", "from", "that", "this", "your", "their", "receipt", "invoice"}
        ]
        matched = [token for token in tokens if token in haystack]
        if matched:
            score += min(35, len(set(matched)) * 8)
            reasons.append("text matches " + ", ".join(sorted(set(matched))[:3]))
        if score >= 20:
            results.append((score, reasons, item))
    results.sort(key=lambda entry: entry[0], reverse=True)
    return [
        {
            "item": item_summary(item, household_reminder_days=household_reminder_days).model_dump(
                mode="json"
            ),
            "score": score,
            "reasons": reasons,
        }
        for score, reasons, item in results[:limit]
    ]
