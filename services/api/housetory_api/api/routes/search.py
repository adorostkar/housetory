import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Category, Item, Room, StorageLocation, Tag
from ...schemas.search import QuickSearchResponse, QuickSearchResult
from ...services.container_serializers import location_path_map
from ...services.hierarchy import descendant_ids
from ...services.serializers import item_load_options
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/search", tags=["search"])


def _alias_like(column, term: str):
    return func.lower(cast(column, Text)).like(f"%{term.lower()}%")


def _result_context(location: StorageLocation, room: Room, path: list) -> str:
    parts = [room.name]
    for entry in path:
        label = entry.identifier or entry.name
        if label and label not in parts:
            parts.append(label)
    return " · ".join(parts)


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
    q: Annotated[str, Query(min_length=2, max_length=120)],
    limit: Annotated[int, Query(ge=1, le=20)] = 4,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> QuickSearchResponse:
    term = q.strip()
    if len(term) < 2:
        return QuickSearchResponse(query=term, results=[])
    search = f"%{term}%"
    household_id = auth.household.id
    results: list[QuickSearchResult] = []

    room_rows = db.execute(
        select(Room.id, Room.parent_id).where(Room.household_id == household_id)
    ).all()
    location_rows = db.execute(
        select(StorageLocation.id, StorageLocation.parent_id).where(
            StorageLocation.household_id == household_id
        )
    ).all()
    rooms = {
        room.id: room for room in db.scalars(select(Room).where(Room.household_id == household_id))
    }
    matched_room_ids: set[uuid.UUID] = set()
    for matched_id in db.scalars(
        select(Room.id).where(
            Room.household_id == household_id,
            Room.name.ilike(search),
        )
    ):
        matched_room_ids.update(descendant_ids(room_rows, matched_id))

    matched_location_ids: set[uuid.UUID] = set()
    for matched_id in db.scalars(
        select(StorageLocation.id).where(
            StorageLocation.household_id == household_id,
            or_(
                StorageLocation.name.ilike(search),
                StorageLocation.identifier.ilike(search),
                StorageLocation.legacy_identifier.ilike(search),
                _alias_like(StorageLocation.aliases, term),
            ),
        )
    ):
        matched_location_ids.update(descendant_ids(location_rows, matched_id))

    item_conditions = [
        Item.household_id == household_id,
        Item.is_archived.is_(False),
        or_(
            Item.name.ilike(search),
            Item.description.ilike(search),
            Item.brand.ilike(search),
            Item.model.ilike(search),
            Item.serial_number.ilike(search),
            Item.category.has(Category.name.ilike(search)),
            Item.tags.any(Tag.name.ilike(search)),
            Item.room_id.in_(matched_room_ids) if matched_room_ids else False,
            Item.storage_location_id.in_(matched_location_ids) if matched_location_ids else False,
        ),
    ]
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(*item_conditions)
        .order_by(func.lower(Item.name))
        .limit(limit)
    ).all()
    path_map = location_path_map(db, household_id)
    for item in items:
        room = rooms.get(item.room_id) if item.room_id else None
        path = path_map.get(item.storage_location_id, []) if item.storage_location_id else []
        context_parts = [room.name] if room else []
        for entry in path:
            label = entry.identifier or entry.name
            if label and label not in context_parts:
                context_parts.append(label)
        results.append(
            QuickSearchResult(
                id=item.id,
                kind="item",
                title=item.name,
                subtitle=_item_subtitle(item),
                context=" · ".join(context_parts) or None,
                url=f"/items/{item.id}",
            )
        )

    location_conditions = [
        StorageLocation.household_id == household_id,
        or_(
            StorageLocation.name.ilike(search),
            StorageLocation.identifier.ilike(search),
            StorageLocation.legacy_identifier.ilike(search),
            _alias_like(StorageLocation.aliases, term),
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
        room = rooms.get(location.room_id)
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
                context=_result_context(location, room, path) if room else None,
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
        room = rooms.get(location.room_id)
        results.append(
            QuickSearchResult(
                id=location.id,
                kind="location",
                title=location.name,
                subtitle=location.identifier or re.sub(r"[_-]+", " ", location.kind),
                context=_result_context(location, room, path) if room else None,
                url=f"/rooms/{location.room_id}?location_id={location.id}",
            )
        )

    return QuickSearchResponse(query=term, results=results)
