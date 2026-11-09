"""Structured inventory filtering shared by search and counting tools."""

import re
import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ...domain import PurchaseInfoFilter
from ...models import (
    Category,
    Document,
    Item,
    Purchase,
    Room,
    StorageLocation,
    Tag,
    Warranty,
)
from ...schemas.ai import NaturalSearchFilters
from ...services.hierarchy import descendant_ids
from ...services.purchase_info import (
    missing_purchase_info_clause,
    purchase_info_filter_clause,
)
from ...services.query_text import (
    contains_non_latin,
    item_words,
    normalize_for_match,
    search_term_variants,
)
from ...services.serializers import (
    item_load_options,
)


def property_item_conditions(property_id: Any) -> list[Any]:
    if property_id is None:
        return []
    return [
        or_(
            Item.room.has(Room.property_id == property_id),
            Item.storage_location.has(
                StorageLocation.room.has(Room.property_id == property_id)
            ),
        )
    ]


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
    found = db.scalar(
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
    if found is not None or not contains_non_latin(name):
        return found
    target = normalize_for_match(name)
    candidates = db.scalars(
        select(Room).where(Room.household_id == household_id)
    ).all()
    matches = [
        room
        for room in candidates
        if target in normalize_for_match(room.name)
    ]
    return min(matches, key=lambda room: len(room.name), default=None)


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
                StorageLocation.active(),
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
                StorageLocation.active(),
                func.upper(StorageLocation.identifier) == identifier,
            )
        )
        if exact is not None:
            return exact
    found = db.scalar(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
            func.lower(StorageLocation.name) == normalized,
        )
        .limit(1)
    ) or db.scalar(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
            StorageLocation.name.ilike(f"%{normalized}%"),
        )
        .order_by(func.length(StorageLocation.name))
        .limit(1)
    )
    if found is not None or not contains_non_latin(name):
        return found
    target = normalize_for_match(name)
    candidates = db.scalars(
        select(StorageLocation).where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
        )
    ).all()
    matches = []
    for location in candidates:
        labels = [location.name, location.identifier or "", *(location.aliases or [])]
        if any(
            target in normalize_for_match(label) for label in labels if label
        ):
            matches.append(location)
    return min(matches, key=lambda entry: len(entry.name), default=None)


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
    found = db.scalar(
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
    if found is not None or not contains_non_latin(name):
        return found
    target = normalize_for_match(name)
    candidates = db.scalars(
        select(Category).where(Category.household_id == household_id)
    ).all()
    matches = [
        category
        for category in candidates
        if target in normalize_for_match(category.name)
    ]
    return min(matches, key=lambda category: len(category.name), default=None)


def _inventory_conditions(
    db: Session,
    household_id: uuid.UUID,
    filters: NaturalSearchFilters,
    *,
    household_reminder_days: int,
    include_q: bool = True,
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
    if filters.q and include_q:
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


def _item_matches_text(item: Item, query: str) -> bool:
    labels = [
        item.name,
        item.brand or "",
        item.model or "",
        item.serial_number or "",
        item.description or "",
    ]
    if item.category is not None:
        labels.append(item.category.name)
    if item.room is not None:
        labels.append(item.room.name)
    if item.storage_location is not None:
        labels.append(item.storage_location.name)
        labels.append(item.storage_location.identifier or "")
    labels.extend(tag.name for tag in item.tags)
    haystack = normalize_for_match(" ".join(label for label in labels if label))
    tokens = item_words(query)
    if not tokens:
        return False
    return all(token in haystack for token in tokens)


def _unicode_q_fallback(
    db: Session,
    household_id: uuid.UUID,
    filters: NaturalSearchFilters,
    *,
    household_reminder_days: int,
    limit: int | None = None,
) -> tuple[list[Item], int] | None:
    if not filters.q or not contains_non_latin(filters.q):
        return None
    conditions = _inventory_conditions(
        db,
        household_id,
        filters,
        household_reminder_days=household_reminder_days,
        include_q=False,
    )
    if conditions is None:
        return None
    candidates = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(*conditions)
            .order_by(func.lower(Item.name))
            .limit(800)
        ).all()
    )
    matched = [item for item in candidates if _item_matches_text(item, filters.q)]
    total = len(matched)
    if filters.sort == "name_asc":
        matched.sort(key=lambda item: item.name.casefold())
    if limit is not None:
        matched = matched[:limit]
    return matched, total


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
    rows = list(db.scalars(query.order_by(*ordering).limit(limit)).all())
    if total == 0:
        fallback = _unicode_q_fallback(
            db,
            household_id,
            filters,
            household_reminder_days=household_reminder_days,
            limit=limit,
        )
        if fallback is not None:
            return fallback
    return rows, total


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
    total, quantity = int(row[0] or 0), int(row[1] or 0)
    if total == 0:
        fallback = _unicode_q_fallback(
            db,
            household_id,
            filters,
            household_reminder_days=household_reminder_days,
        )
        if fallback is not None:
            items, fallback_total = fallback
            return fallback_total, sum(item.quantity for item in items)
    return total, quantity
