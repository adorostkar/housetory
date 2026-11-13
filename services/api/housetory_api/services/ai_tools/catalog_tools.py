"""Read-only inventory, document, purchase and warranty tools."""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ...domain import PurchaseInfoFilter, WarrantyStatus
from ...models import (
    Document,
    Item,
    Loan,
    Purchase,
    Room,
    StorageLocation,
)
from ...schemas.ai import AssistantReference, NaturalSearchFilters
from ...services.ownership import financial_overview
from ...services.purchase_info import (
    missing_purchase_info_clause,
    purchase_info_filter_clause,
)
from ...services.query_text import (
    clean_subject,
)
from ...services.serializers import (
    item_detail,
    item_load_options,
)
from ...services.warranties import warranty_status
from ...services.warranty_dashboard import build_dashboard, load_warranties
from .. import borrowed as borrowed_service
from ..containers import (
    load_container_items,
    location_ancestors,
    room_ancestors,
)
from ..items import get_item
from ..lending import item_loan_summary
from .inventory_query import _resolve_location, _resolve_room, inventory_totals, search_inventory
from .references import (
    ToolResult,
    _borrowed_reference,
    _item_reference,
    _location_display,
    _summaries_with_paths,
)


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
    location_conditions = [
        StorageLocation.household_id == household_id,
        StorageLocation.active(),
    ]
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
            StorageLocation.active(),
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
            "summary": summary,
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
    if args.get("document_id"):
        conditions.append(Document.id == uuid.UUID(str(args["document_id"])))
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
