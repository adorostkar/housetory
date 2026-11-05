import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.orm import Session, joinedload

from ...db import get_db
from ...models import Category, Item, Room, StorageLocation, Tag
from ...schemas.search import QuickSearchLoan, QuickSearchResponse, QuickSearchResult
from ...services.container_serializers import location_path_map
from ...services.hierarchy import descendant_ids
from ...services.lending import loan_overview_for_items
from ...services.properties import get_property
from ...services.query_text import clean_subject, looks_like_question, search_term_variants
from ...services.serializers import item_load_options
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/search", tags=["search"])


def _patterns(term: str) -> list[str]:
    return [f"%{value}%" for value in search_term_variants(term)]


def _any_like(column, patterns: list[str]):
    return or_(*[column.ilike(pattern) for pattern in patterns])


def _alias_like(column, term: str):
    return or_(
        *[
            func.lower(cast(column, Text)).like(f"%{value.lower()}%")
            for value in search_term_variants(term)
        ]
    )


def _location_label(entry) -> str:  # noqa: ANN001
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
    path: list,
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


@router.get("/quick", response_model=QuickSearchResponse)
def quick_search(
    q: Annotated[str, Query(min_length=2, max_length=200)],
    property_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=20)] = 4,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> QuickSearchResponse:
    term = q.strip()
    if len(term) < 2:
        return QuickSearchResponse(query=term, results=[])
    question_like = looks_like_question(term)
    effective_term = clean_subject(term) if question_like else term
    if len(effective_term) < 2:
        effective_term = term
    patterns = _patterns(effective_term)
    household_id = auth.household.id
    results: list[QuickSearchResult] = []
    property_room_ids: set[uuid.UUID] | None = None
    property_location_ids: set[uuid.UUID] | None = None
    if property_id is not None:
        get_property(db, household_id, property_id)
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
    for item in items:
        path = path_map.get(item.storage_location_id, []) if item.storage_location_id else []
        loan = loan_overview.get(item.id)
        results.append(
            QuickSearchResult(
                id=item.id,
                kind="item",
                title=item.name,
                subtitle=_item_subtitle(item),
                context=_context(item.room_id, path, rooms),
                url=f"/items/{item.id}",
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
        results.append(
            QuickSearchResult(
                id=location.id,
                kind="container",
                title=title,
                subtitle=subtitle,
                context=_context(location.room_id, path, rooms),
                url=f"/containers/{location.id}",
            )
        )

    fixed_locations = db.scalars(
        select(StorageLocation)
        .where(*location_conditions, StorageLocation.is_container.is_(False))
        .order_by(func.lower(StorageLocation.name))
        .limit(limit)
    ).all()
    for location in fixed_locations:
        path = path_map.get(location.id, [])[:-1]
        results.append(
            QuickSearchResult(
                id=location.id,
                kind="location",
                title=location.name,
                subtitle=location.identifier or re.sub(r"[_-]+", " ", location.kind),
                context=_context(location.room_id, path, rooms),
                url=f"/rooms/{location.room_id}?location_id={location.id}",
            )
        )

    return QuickSearchResponse(
        query=term,
        effective_query=effective_term if effective_term != term else None,
        question_like=question_like,
        results=results,
    )
