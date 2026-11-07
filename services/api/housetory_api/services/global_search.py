"""Authorised all-places search across a user's current household memberships."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.orm import Session, joinedload

from ..api.errors import ApiError
from ..models import (
    Category,
    Household,
    HouseholdMember,
    Item,
    Property,
    Room,
    StorageLocation,
    Tag,
)
from ..schemas.ai import NaturalSearchFilters
from ..schemas.search import (
    QuickSearchLoan,
    QuickSearchResult,
    SearchHousehold,
    SearchItemList,
    SearchProperty,
    SearchScopeHousehold,
    SearchScopeList,
)
from . import auth as auth_service
from . import borrowed as borrowed_service
from .ai_tools import _summaries_with_paths, search_inventory
from .container_serializers import location_path_map
from .hierarchy import descendant_ids
from .lending import loan_overview_for_items
from .properties import get_property
from .query_text import search_term_variants
from .serializers import item_load_options

MAX_SEARCH_HOUSEHOLDS = 20
MAX_SEARCH_WINDOW = 500


@dataclass(frozen=True)
class SearchScope:
    households: list[tuple[Household, str]]
    property: Property | None
    label: str
    notices: list[str]


def _scope_household(household: Household, role: str) -> SearchHousehold:
    return SearchHousehold(id=household.id, name=household.name, role=role)


def scope_property(record: Property | None) -> SearchProperty | None:
    if record is None:
        return None
    return SearchProperty(id=record.id, name=record.name, is_archived=record.is_archived)


def list_search_scope_options(db: Session, user_id: uuid.UUID) -> SearchScopeList:
    memberships = auth_service.list_memberships(db, user_id)[:MAX_SEARCH_HOUSEHOLDS]
    household_ids = [household.id for household, _membership, _count in memberships]
    properties_by_household: dict[uuid.UUID, list[Property]] = {
        household_id: [] for household_id in household_ids
    }
    if household_ids:
        properties = db.scalars(
            select(Property)
            .where(
                Property.household_id.in_(household_ids),
                Property.is_archived.is_(False),
            )
            .order_by(Property.sort_order, func.lower(Property.name))
        ).all()
        for record in properties:
            properties_by_household.setdefault(record.household_id, []).append(record)
    return SearchScopeList(
        items=[
            SearchScopeHousehold(
                id=household.id,
                name=household.name,
                role=membership.role,
                properties=[
                    SearchProperty(
                        id=record.id,
                        name=record.name,
                        is_archived=record.is_archived,
                    )
                    for record in properties_by_household.get(household.id, [])
                ],
            )
            for household, membership, _count in memberships
        ]
    )


def resolve_search_scope(
    db: Session,
    user_id: uuid.UUID,
    *,
    household_id: uuid.UUID | None,
    property_id: uuid.UUID | None,
) -> SearchScope:
    memberships = auth_service.list_memberships(db, user_id)
    if property_id is not None and household_id is None:
        # Compatibility for links and clients that carry only a property id.
        # Resolve it through a current membership; an arbitrary property id from
        # another household is never trusted as a scope.
        row = db.execute(
            select(Property, Household, HouseholdMember)
            .join(Household, Household.id == Property.household_id)
            .join(
                HouseholdMember,
                HouseholdMember.household_id == Household.id,
            )
            .where(
                Property.id == property_id,
                HouseholdMember.user_id == user_id,
            )
        ).first()
        if row is None:
            raise ApiError(404, "property_not_found", "Property not found.")
        property_record, household, membership = row
        return SearchScope(
            households=[(household, membership.role)],
            property=property_record,
            label=f"{household.name} · {property_record.name}",
            notices=[],
        )
    if household_id is not None:
        matching = next((entry for entry in memberships if entry[0].id == household_id), None)
        if matching is None:
            raise ApiError(404, "household_not_found", "Household not found.")
        household, membership, _count = matching
        property_record = None
        if property_id is not None:
            property_record = get_property(db, household.id, property_id)
        return SearchScope(
            households=[(household, membership.role)],
            property=property_record,
            label=(
                f"{household.name} · {property_record.name}"
                if property_record is not None
                else household.name
            ),
            notices=[],
        )
    selected = memberships[:MAX_SEARCH_HOUSEHOLDS]
    notices = []
    if len(memberships) > MAX_SEARCH_HOUSEHOLDS:
        notices.append(
            f"Search covered the first {MAX_SEARCH_HOUSEHOLDS} households. "
            "Narrow the search to a household to reach the rest."
        )
    return SearchScope(
        households=[(household, membership.role) for household, membership, _count in selected],
        property=None,
        label="All my places",
        notices=notices,
    )


def scope_households(scope: SearchScope) -> list[SearchHousehold]:
    return [_scope_household(household, role) for household, role in scope.households]


def _patterns(term: str) -> list[str]:
    return [f"%{value}%" for value in search_term_variants(term)]


def _any_like(column: Any, patterns: list[str]) -> Any:
    return or_(*[column.ilike(pattern) for pattern in patterns])


def _alias_like(column: Any, term: str) -> Any:
    return or_(
        *[
            func.lower(cast(column, Text)).like(f"%{value.lower()}%")
            for value in search_term_variants(term)
        ]
    )


def _location_label(entry: Any) -> str:
    if entry.identifier and entry.identifier != entry.name:
        return f"{entry.identifier} · {entry.name}"
    return entry.identifier or entry.name


def _room_path_labels(room_id: uuid.UUID | None, rooms: dict[uuid.UUID, Room]) -> list[str]:
    if room_id is None:
        return []
    labels: list[str] = []
    seen: set[uuid.UUID] = set()
    cursor = rooms.get(room_id)
    while cursor is not None and cursor.id not in seen:
        labels.append(cursor.name)
        seen.add(cursor.id)
        cursor = rooms.get(cursor.parent_id) if cursor.parent_id else None
    labels.reverse()
    return labels


def _context(
    room_id: uuid.UUID | None,
    path: list[Any],
    rooms: dict[uuid.UUID, Room],
) -> str | None:
    room = rooms.get(room_id) if room_id else None
    property_name = room.property.name if room is not None and room.property is not None else None
    parts = _room_path_labels(room_id, rooms)
    if property_name:
        parts.insert(0, property_name)
    for entry in path:
        label = _location_label(entry)
        if label and label not in parts:
            parts.append(label)
    return " · ".join(parts) if parts else None


def _item_subtitle(item: Item) -> str | None:
    parts = [value for value in (item.brand, item.model) if value]
    if item.serial_number:
        parts.append(f"Serial {item.serial_number}")
    if parts:
        return " · ".join(parts)
    if item.category is not None:
        return item.category.name
    return None


def _borrowed_context(record) -> str | None:  # noqa: ANN001
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
    place = " / ".join(part for part in parts if part) or None
    labels = []
    if place:
        labels.append(f"{borrowed_service.location_prefix(record)} {place}")
    if record.due_on is not None:
        labels.append(f"due {record.due_on.isoformat()}")
    return " · ".join(labels) if labels else None


def _quick_household(
    db: Session,
    household: Household,
    role: str,
    *,
    property_id: uuid.UUID | None,
    effective_term: str,
    patterns: list[str],
    limit: int,
) -> tuple[
    list[QuickSearchResult],
    list[QuickSearchResult],
    list[QuickSearchResult],
    list[QuickSearchResult],
]:
    household_id = household.id
    property_room_ids: set[uuid.UUID] | None = None
    property_location_ids: set[uuid.UUID] | None = None
    if property_id is not None:
        property_room_ids = set(
            db.scalars(
                select(Room.id).where(
                    Room.household_id == household_id,
                    Room.property_id == property_id,
                )
            ).all()
        )
        property_location_ids = set(
            db.scalars(
                select(StorageLocation.id)
                .join(Room, Room.id == StorageLocation.room_id)
                .where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.active(),
                    Room.property_id == property_id,
                )
            ).all()
        )

    room_rows = db.execute(
        select(Room.id, Room.parent_id).where(
            Room.household_id == household_id,
            *([Room.id.in_(property_room_ids)] if property_room_ids is not None else []),
        )
    ).all()
    location_rows = db.execute(
        select(StorageLocation.id, StorageLocation.parent_id).where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
            *(
                [StorageLocation.id.in_(property_location_ids)]
                if property_location_ids is not None
                else []
            ),
        )
    ).all()
    rooms = {
        room.id: room
        for room in db.scalars(
            select(Room)
            .options(joinedload(Room.property))
            .where(
                Room.household_id == household_id,
                *([Room.id.in_(property_room_ids)] if property_room_ids is not None else []),
            )
        ).all()
    }
    matched_room_ids: set[uuid.UUID] = set()
    for matched_id in db.scalars(
        select(Room.id).where(
            Room.household_id == household_id,
            _any_like(Room.name, patterns),
            *([Room.id.in_(property_room_ids)] if property_room_ids is not None else []),
        )
    ):
        matched_room_ids.update(descendant_ids(room_rows, matched_id))

    matched_location_ids: set[uuid.UUID] = set()
    for matched_id in db.scalars(
        select(StorageLocation.id).where(
            StorageLocation.household_id == household_id,
            StorageLocation.active(),
            or_(
                _any_like(StorageLocation.name, patterns),
                _any_like(StorageLocation.identifier, patterns),
                _any_like(StorageLocation.legacy_identifier, patterns),
                _alias_like(StorageLocation.aliases, effective_term),
            ),
            *(
                [StorageLocation.id.in_(property_location_ids)]
                if property_location_ids is not None
                else []
            ),
        )
    ):
        matched_location_ids.update(descendant_ids(location_rows, matched_id))

    item_conditions = [
        Item.household_id == household_id,
        Item.is_archived.is_(False),
        or_(
            _any_like(Item.name, patterns),
            _any_like(Item.description, patterns),
            _any_like(Item.brand, patterns),
            _any_like(Item.model, patterns),
            _any_like(Item.serial_number, patterns),
            Item.category.has(_any_like(Category.name, patterns)),
            Item.tags.any(_any_like(Tag.name, patterns)),
            Item.room_id.in_(matched_room_ids) if matched_room_ids else False,
            Item.storage_location_id.in_(matched_location_ids) if matched_location_ids else False,
        ),
    ]
    if property_room_ids is not None:
        item_conditions.append(
            or_(
                Item.room_id.in_(property_room_ids),
                Item.storage_location_id.in_(property_location_ids or set()),
            )
        )
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*item_conditions)
        .order_by(func.lower(Item.name))
        .limit(limit)
    ).all()
    path_map = location_path_map(db, household_id)
    loan_overview = loan_overview_for_items(db, household_id, [item.id for item in items])
    item_results: list[QuickSearchResult] = []
    for item in items:
        path = path_map.get(item.storage_location_id, []) if item.storage_location_id else []
        loan = loan_overview.get(item.id)
        item_results.append(
            QuickSearchResult(
                id=item.id,
                kind="item",
                title=item.name,
                subtitle=_item_subtitle(item),
                context=_context(item.room_id, path, rooms),
                url=f"/items/{item.id}",
                household=_scope_household(household, role),
                loan=(
                    QuickSearchLoan(
                        on_loan_quantity=loan["on_loan_quantity"],
                        borrower_names=loan["borrower_names"],
                        next_due_on=loan["next_due_on"],
                    )
                    if loan
                    else None
                ),
            )
        )

    location_conditions = [
        StorageLocation.household_id == household_id,
        StorageLocation.active(),
        *(
            [StorageLocation.id.in_(property_location_ids)]
            if property_location_ids is not None
            else []
        ),
        or_(
            _any_like(StorageLocation.name, patterns),
            _any_like(StorageLocation.identifier, patterns),
            _any_like(StorageLocation.legacy_identifier, patterns),
            _alias_like(StorageLocation.aliases, effective_term),
        ),
    ]
    containers = db.scalars(
        select(StorageLocation)
        .where(*location_conditions, StorageLocation.is_container.is_(True))
        .order_by(
            StorageLocation.identifier.asc().nullslast(),
            func.lower(StorageLocation.name),
        )
        .limit(limit)
    ).all()
    container_results: list[QuickSearchResult] = []
    for location in containers:
        path = path_map.get(location.id, [])[:-1]
        title = location.identifier or location.name
        subtitle_parts = []
        if location.name and location.name != title:
            subtitle_parts.append(location.name)
        for alias in [location.legacy_identifier, *(location.aliases or [])]:
            cleaned = str(alias).strip() if alias else ""
            if cleaned and cleaned != title and cleaned not in subtitle_parts:
                subtitle_parts.append(cleaned)
        subtitle = " · ".join(subtitle_parts[:3]) or location.container_type or "container"
        container_results.append(
            QuickSearchResult(
                id=location.id,
                kind="container",
                title=title,
                subtitle=subtitle,
                context=_context(location.room_id, path, rooms),
                url=f"/containers/{location.id}",
                household=_scope_household(household, role),
            )
        )

    fixed_locations = db.scalars(
        select(StorageLocation)
        .where(*location_conditions, StorageLocation.is_container.is_(False))
        .order_by(func.lower(StorageLocation.name))
        .limit(limit)
    ).all()
    location_results: list[QuickSearchResult] = []
    for location in fixed_locations:
        path = path_map.get(location.id, [])[:-1]
        location_results.append(
            QuickSearchResult(
                id=location.id,
                kind="location",
                title=location.name,
                subtitle=location.identifier or re.sub(r"[_-]+", " ", location.kind),
                context=_context(location.room_id, path, rooms),
                url=f"/rooms/{location.room_id}?location_id={location.id}",
                household=_scope_household(household, role),
            )
        )
    borrowed_rows, _borrowed_total = borrowed_service.quick_search_records(
        db,
        household.id,
        q=effective_term,
        limit=limit,
        property_id=property_id,
    )
    borrowed_results = [
        QuickSearchResult(
            id=record.id,
            kind="borrowed",
            title=record.item_name,
            subtitle=f"Borrowed from {record.owner_name}"
            + (f" · {record.brand} {record.model}".strip() if record.brand or record.model else ""),
            context=_borrowed_context(record),
            url=f"/borrowed/{record.id}",
            household=_scope_household(household, role),
        )
        for record in borrowed_rows
    ]
    return item_results, borrowed_results, container_results, location_results


def quick_search(
    db: Session,
    scope: SearchScope,
    *,
    effective_term: str,
    limit: int,
) -> tuple[list[QuickSearchResult], list[str]]:
    patterns = _patterns(effective_term)
    items: list[QuickSearchResult] = []
    borrowed: list[QuickSearchResult] = []
    containers: list[QuickSearchResult] = []
    locations: list[QuickSearchResult] = []
    for household, role in scope.households:
        (
            household_items,
            household_borrowed,
            household_containers,
            household_locations,
        ) = _quick_household(
            db,
            household,
            role,
            property_id=scope.property.id if scope.property is not None else None,
            effective_term=effective_term,
            patterns=patterns,
            limit=limit,
        )
        items.extend(household_items)
        borrowed.extend(household_borrowed)
        containers.extend(household_containers)
        locations.extend(household_locations)
    return (
        [
            *items[:limit],
            *borrowed[:limit],
            *containers[:limit],
            *locations[:limit],
        ],
        scope.notices,
    )


def _sort_summaries(items: list[Any], sort: str) -> list[Any]:
    if sort == "name_asc":
        return sorted(items, key=lambda item: item.name.lower())
    if sort == "name_desc":
        return sorted(items, key=lambda item: item.name.lower(), reverse=True)
    if sort == "created_asc":
        return sorted(items, key=lambda item: item.created_at)
    if sort == "created_desc":
        return sorted(items, key=lambda item: item.created_at, reverse=True)
    return sorted(items, key=lambda item: item.updated_at, reverse=True)


def search_items(
    db: Session,
    scope: SearchScope,
    *,
    q: str | None,
    include_archived: bool,
    sort: str,
    limit: int,
    offset: int,
) -> tuple[SearchItemList, list[str]]:
    if offset + limit > MAX_SEARCH_WINDOW:
        raise ApiError(
            422,
            "search_window_too_large",
            f"Search pagination is limited to the first {MAX_SEARCH_WINDOW} results. "
            "Narrow the scope or query.",
        )
    summaries: list[Any] = []
    borrowed: list[Any] = []
    total = 0
    borrowed_total = 0
    for household, _role in scope.households:
        filters = NaturalSearchFilters(
            q=(q or "").strip() or None,
            property_id=scope.property.id if scope.property is not None else None,
            sort="name_asc" if sort.startswith("name") else "relevance",
        )
        items, household_total = search_inventory(
            db,
            household.id,
            filters,
            household_reminder_days=household.warranty_reminder_days,
            limit=offset + limit,
        )
        total += household_total
        summaries.extend(
            _summaries_with_paths(
                db,
                household.id,
                items,
                household_reminder_days=household.warranty_reminder_days,
            )
        )
        borrowed_rows, household_borrowed_total = borrowed_service.quick_search_records(
            db,
            household.id,
            q=(q or "").strip(),
            limit=limit if offset == 0 else 1,
            property_id=scope.property.id if scope.property is not None else None,
        )
        if offset == 0:
            borrowed.extend(borrowed_rows)
        borrowed_total += household_borrowed_total
    ordered = _sort_summaries(summaries, sort)
    return (
        SearchItemList(
            items=ordered[offset : offset + limit],
            total=total,
            limit=limit,
            offset=offset,
            borrowed=borrowed[:limit],
            borrowed_total=borrowed_total,
            scope_label=scope.label,
            households=scope_households(scope),
            property=scope_property(scope.property),
        ),
        scope.notices,
    )
