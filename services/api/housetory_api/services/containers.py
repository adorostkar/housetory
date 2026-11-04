"""Movable containers, permanent identifiers, summaries and hierarchy movement."""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import ContainerType, prefix_for_container_type, prefix_for_location_kind
from ..models import (
    Document,
    Item,
    LocationIdentifierCounter,
    Room,
    StorageLocation,
)
from ..schemas.items import LocationBrief
from .hierarchy import descendant_ids
from .serializers import item_load_options


@dataclass
class LocationSummary:
    short: str
    detailed: str
    headline: str | None
    lines: list[str] = field(default_factory=list)
    detailed_lines: list[str] = field(default_factory=list)
    item_count: int = 0
    total_quantity: int = 0
    empty: bool = True
    contents_hash: str = ""
    generated_at: datetime | None = None
    source: str | None = None
    stored: bool = False


def household_hierarchy_lock(db: Session, household_id: uuid.UUID) -> None:
    """Serialize hierarchy mutations for one household.

    A transaction-scoped advisory lock is cheaper and less deadlock-prone than
    locking every room/location row for ordinary reads. In combination with the
    row locks used by moves, it guarantees that two concurrent moves cannot
    interleave their descendant and item updates.
    """
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"housetory-hierarchy-{household_id}"},
    )


def get_location(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> StorageLocation:
    query = select(StorageLocation).where(
        StorageLocation.id == location_id,
        StorageLocation.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update()
    location = db.scalar(query)
    if location is None:
        raise ApiError(404, "location_not_found", "Storage location not found.")
    return location


def get_room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if room is None:
        raise ApiError(404, "room_not_found", "Room not found.")
    return room


def location_rows(db: Session, household_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
    return list(
        db.execute(
            select(StorageLocation.id, StorageLocation.parent_id).where(
                StorageLocation.household_id == household_id
            )
        ).all()
    )


def location_ancestors(
    db: Session, household_id: uuid.UUID, location_id: uuid.UUID
) -> list[StorageLocation]:
    locations = {
        location.id: location
        for location in db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    }
    path: list[StorageLocation] = []
    cursor = locations.get(location_id)
    seen: set[uuid.UUID] = set()
    while cursor is not None and cursor.id not in seen:
        path.append(cursor)
        seen.add(cursor.id)
        cursor = locations.get(cursor.parent_id) if cursor.parent_id else None
    path.reverse()
    return path


def room_ancestors(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> list[Room]:
    rooms = {
        room.id: room
        for room in db.scalars(select(Room).where(Room.household_id == household_id)).all()
    }
    path: list[Room] = []
    cursor = rooms.get(room_id)
    seen: set[uuid.UUID] = set()
    while cursor is not None and cursor.id not in seen:
        path.append(cursor)
        seen.add(cursor.id)
        cursor = rooms.get(cursor.parent_id) if cursor.parent_id else None
    path.reverse()
    return path


def location_brief(location: StorageLocation) -> LocationBrief:
    return LocationBrief(
        id=location.id,
        name=location.name,
        kind=location.kind,
        parent_id=location.parent_id,
        identifier=location.identifier,
        container_type=location.container_type,
        is_container=location.is_container,
    )


def location_breadcrumb(
    db: Session, household_id: uuid.UUID, location_id: uuid.UUID
) -> list[LocationBrief]:
    return [
        location_brief(location) for location in location_ancestors(db, household_id, location_id)
    ]


def allocate_identifiers(
    db: Session, household_id: uuid.UUID, prefix: str, quantity: int
) -> list[str]:
    if quantity < 1 or quantity > 1000:
        raise ValueError("Identifier quantity must be between 1 and 1000.")
    prefix = re.sub(r"[^A-Z]", "", prefix.upper())[:12]
    if not prefix:
        raise ValueError("Identifier prefix is invalid.")
    statement = (
        pg_insert(LocationIdentifierCounter)
        .values(household_id=household_id, prefix=prefix, last_value=quantity)
        .on_conflict_do_update(
            index_elements=[
                LocationIdentifierCounter.household_id,
                LocationIdentifierCounter.prefix,
            ],
            set_={
                "last_value": LocationIdentifierCounter.last_value + quantity,
            },
        )
        .returning(LocationIdentifierCounter.last_value)
    )
    last_value = db.scalar(statement)
    if last_value is None:
        raise ValueError("Identifier allocation failed.")
    start = int(last_value) - quantity + 1
    return [f"{prefix}-{value:03d}" for value in range(start, int(last_value) + 1)]


def assign_identifier(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
    *,
    prefix: str | None = None,
) -> StorageLocation:
    household_hierarchy_lock(db, household_id)
    location = get_location(db, household_id, location.id, for_update=True)
    if location.identifier is not None:
        raise ApiError(409, "identifier_exists", "This place already has a permanent identifier.")
    identifier = allocate_identifiers(
        db,
        household_id,
        prefix or prefix_for_location_kind(location.kind),
        1,
    )[0]
    location.identifier = identifier
    db.flush()
    return location


def validate_container_parent(
    db: Session,
    household_id: uuid.UUID,
    *,
    room_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    moving_id: uuid.UUID | None = None,
) -> StorageLocation | None:
    get_room(db, household_id, room_id)
    if parent_id is None:
        return None
    parent = get_location(db, household_id, parent_id)
    if parent.room_id != room_id:
        raise ApiError(
            422,
            "container_room_mismatch",
            "A container must belong to the same room as its parent place.",
        )
    if moving_id is not None:
        if parent.id == moving_id:
            raise ApiError(422, "container_cycle", "A container cannot contain itself.")
        rows = location_rows(db, household_id)
        if parent.id in descendant_ids(rows, moving_id):
            raise ApiError(
                422,
                "container_cycle",
                "A container cannot be moved inside one of its descendants.",
            )
    return parent


def create_containers(
    db: Session,
    household_id: uuid.UUID,
    *,
    room_id: uuid.UUID,
    container_type: str,
    quantity: int = 1,
    parent_id: uuid.UUID | None = None,
    name: str | None = None,
    description: str | None = None,
    sort_order: int = 0,
) -> list[StorageLocation]:
    household_hierarchy_lock(db, household_id)
    try:
        container_type = ContainerType(container_type).value
    except ValueError:
        raise ApiError(422, "invalid_container_type", "Choose a valid container type.") from None
    if quantity < 1 or quantity > 100:
        raise ApiError(422, "invalid_quantity", "Create between 1 and 100 containers at a time.")
    validate_container_parent(db, household_id, room_id=room_id, parent_id=parent_id)
    identifiers = allocate_identifiers(
        db, household_id, prefix_for_container_type(container_type), quantity
    )
    created: list[StorageLocation] = []
    for index, identifier in enumerate(identifiers):
        resolved_name = (name or "").strip()
        if resolved_name:
            resolved_name = resolved_name[:120]
            if quantity > 1:
                resolved_name = f"{resolved_name} {index + 1}"[:120]
        else:
            resolved_name = identifier
        location = StorageLocation(
            household_id=household_id,
            room_id=room_id,
            parent_id=parent_id,
            name=resolved_name,
            description=description,
            kind=container_type,
            is_container=True,
            container_type=container_type,
            identifier=identifier,
            sort_order=sort_order + index,
        )
        db.add(location)
        created.append(location)
    db.flush()
    return created


def convert_location(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    *,
    container_type: str,
) -> StorageLocation:
    household_hierarchy_lock(db, household_id)
    try:
        container_type = ContainerType(container_type).value
    except ValueError:
        raise ApiError(422, "invalid_container_type", "Choose a valid container type.") from None
    location = get_location(db, household_id, location_id, for_update=True)
    if location.is_container:
        location.container_type = container_type
        location.kind = container_type
        db.flush()
        return location
    if location.identifier is None:
        location.identifier = allocate_identifiers(
            db, household_id, prefix_for_container_type(container_type), 1
        )[0]
    location.is_container = True
    location.container_type = container_type
    location.kind = container_type
    db.flush()
    return location


def load_container_items(
    db: Session, household_id: uuid.UUID, location_id: uuid.UUID
) -> list[Item]:
    subtree = descendant_ids(location_rows(db, household_id), location_id)
    return list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                Item.storage_location_id.in_(subtree),
            )
            .order_by(func.lower(Item.name))
        ).all()
    )


def _item_line(item: Item) -> str:
    name = re.sub(r"\s+", " ", item.name).strip()[:80]
    return f"{item.quantity} × {name}" if item.quantity > 1 else name


def deterministic_summary(items: list[Item]) -> LocationSummary:
    if not items:
        return LocationSummary(
            short="Empty container",
            detailed="No items are assigned to this container yet.",
            headline=None,
            lines=[],
            detailed_lines=[],
            item_count=0,
            total_quantity=0,
            empty=True,
            contents_hash=_contents_hash(items),
        )

    by_name: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        category = item.category.name if item.category else "Uncategorised"
        key = (item.name.strip().lower(), category)
        if key not in by_name:
            by_name[key] = {
                "name": re.sub(r"\s+", " ", item.name).strip()[:80],
                "category": category,
                "quantity": 0,
            }
        by_name[key]["quantity"] += item.quantity

    ordered = sorted(
        by_name.values(),
        key=lambda entry: (-entry["quantity"], entry["name"].lower()),
    )
    short_lines = [
        f"{entry['quantity']} × {entry['name']}" if entry["quantity"] > 1 else entry["name"]
        for entry in ordered
    ]
    if len(short_lines) > 4:
        hidden = len(short_lines) - 4
        short_lines = short_lines[:4] + [f"and {hidden} more"]

    detailed_lines: list[str] = []
    categories: dict[str, list[dict[str, Any]]] = {}
    for entry in ordered:
        categories.setdefault(entry["category"], []).append(entry)
    for category in sorted(categories, key=lambda value: value.lower()):
        if category != "Uncategorised":
            detailed_lines.append(category)
        for entry in sorted(categories[category], key=lambda value: value["name"].lower()):
            line = (
                f"{entry['quantity']} × {entry['name']}" if entry["quantity"] > 1 else entry["name"]
            )
            detailed_lines.append(("  " if category != "Uncategorised" else "") + line)
    if len(detailed_lines) > 12:
        hidden = len(detailed_lines) - 12
        detailed_lines = detailed_lines[:12] + [f"and {hidden} more"]

    total_quantity = sum(item.quantity for item in items)
    return LocationSummary(
        short="\n".join(short_lines)[:600],
        detailed="\n".join(detailed_lines)[:1600],
        headline=None,
        lines=short_lines,
        detailed_lines=detailed_lines,
        item_count=len(items),
        total_quantity=total_quantity,
        empty=False,
        contents_hash=_contents_hash(items),
    )


def _contents_hash(items: list[Item]) -> str:
    payload = [
        {
            "id": str(item.id),
            "name": item.name,
            "quantity": item.quantity,
            "category": item.category.name if item.category else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }
        for item in sorted(items, key=lambda entry: str(entry.id))
    ]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def summary_for_location(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
    *,
    live_items: list[Item] | None = None,
    include_stored: bool = True,
) -> LocationSummary:
    items = (
        live_items
        if live_items is not None
        else load_container_items(db, household_id, location.id)
    )
    live = deterministic_summary(items)
    if not include_stored:
        return live
    stored = bool(location.summary_generated_at)
    return LocationSummary(
        short=location.summary_short if location.summary_short else live.short,
        detailed=location.summary_detailed if location.summary_detailed else live.detailed,
        headline=location.summary_headline,
        lines=live.lines,
        detailed_lines=live.detailed_lines,
        item_count=live.item_count,
        total_quantity=live.total_quantity,
        empty=live.empty,
        contents_hash=live.contents_hash,
        generated_at=location.summary_generated_at,
        source=location.summary_source,
        stored=stored,
    )


def summary_is_stale(location: StorageLocation, live: LocationSummary) -> bool:
    return bool(
        location.summary_generated_at
        and location.summary_contents_hash
        and location.summary_contents_hash != live.contents_hash
    )


def refresh_summary(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
    *,
    source: str = "deterministic",
    headline: str | None = None,
    short: str | None = None,
    detailed: str | None = None,
) -> LocationSummary:
    items = load_container_items(db, household_id, location.id)
    live = deterministic_summary(items)
    location.summary_short = (short if short is not None else live.short)[:4000] or None
    location.summary_detailed = (detailed if detailed is not None else live.detailed)[:4000] or None
    if source == "deterministic":
        location.summary_headline = None
    else:
        location.summary_headline = headline if headline is not None else location.summary_headline
    if location.summary_headline is not None:
        location.summary_headline = location.summary_headline.strip()[:240] or None
    location.summary_source = source
    location.summary_generated_at = datetime.now(UTC)
    location.summary_contents_hash = live.contents_hash
    db.flush()
    return summary_for_location(db, household_id, location, live_items=items)


def contents_updated_at(items: list[Item], location: StorageLocation) -> datetime | None:
    timestamps = [item.updated_at for item in items if item.updated_at is not None]
    if location.updated_at is not None:
        timestamps.append(location.updated_at)
    return max(timestamps) if timestamps else None


def label_is_stale(location: StorageLocation, items: list[Item]) -> bool:
    if location.label_generated_at is None:
        return False
    latest = contents_updated_at(items, location)
    return bool(latest and latest > location.label_generated_at)


def move_container(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    *,
    destination_room_id: uuid.UUID,
    destination_parent_id: uuid.UUID | None,
) -> StorageLocation:
    household_hierarchy_lock(db, household_id)
    # Lock the household's location rows in a deterministic order. This makes
    # concurrent moves serialize after the advisory lock and keeps validation
    # and updates consistent.
    locations = list(
        db.scalars(
            select(StorageLocation)
            .where(StorageLocation.household_id == household_id)
            .order_by(StorageLocation.id)
            .with_for_update()
        ).all()
    )
    by_id = {location.id: location for location in locations}
    moving = by_id.get(location_id)
    if moving is None:
        raise ApiError(404, "location_not_found", "Storage location not found.")
    if not moving.is_container:
        raise ApiError(
            422,
            "not_a_container",
            "Only movable containers can be moved. Convert this fixed place first.",
        )
    get_room(db, household_id, destination_room_id)
    if destination_parent_id is not None:
        parent = by_id.get(destination_parent_id)
        if parent is None:
            raise ApiError(404, "location_not_found", "Destination parent place not found.")
        if parent.room_id != destination_room_id:
            raise ApiError(
                422,
                "container_room_mismatch",
                "The destination parent belongs to a different room.",
            )
        if parent.id == moving.id:
            raise ApiError(422, "container_cycle", "A container cannot contain itself.")
        rows = [(location.id, location.parent_id) for location in locations]
        if parent.id in descendant_ids(rows, moving.id):
            raise ApiError(
                422,
                "container_cycle",
                "A container cannot be moved inside one of its descendants.",
            )

    subtree = descendant_ids(
        [(location.id, location.parent_id) for location in locations], moving.id
    )
    subtree_ids = list(subtree)
    now = datetime.now(UTC)
    db.execute(
        update(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.id.in_(subtree_ids),
        )
        .values(room_id=destination_room_id, updated_at=now)
    )
    db.execute(
        update(StorageLocation)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.id == moving.id,
        )
        .values(parent_id=destination_parent_id, updated_at=now)
    )
    db.execute(
        update(Item)
        .where(
            Item.household_id == household_id,
            Item.storage_location_id.in_(subtree_ids),
        )
        .values(room_id=destination_room_id, updated_at=now)
    )
    db.flush()
    db.expire_all()
    return get_location(db, household_id, location_id)


def container_children(
    db: Session, household_id: uuid.UUID, location_id: uuid.UUID
) -> list[StorageLocation]:
    return list(
        db.scalars(
            select(StorageLocation)
            .where(
                StorageLocation.household_id == household_id,
                StorageLocation.parent_id == location_id,
            )
            .order_by(StorageLocation.sort_order, func.lower(StorageLocation.name))
        ).all()
    )


def related_documents(
    db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID], *, limit: int = 20
) -> list[Document]:
    if not item_ids:
        return []
    return list(
        db.scalars(
            select(Document)
            .where(
                Document.household_id == household_id,
                Document.items.any(Item.id.in_(item_ids)),
            )
            .order_by(Document.created_at.desc())
            .limit(limit)
        ).all()
    )


def delete_location_safely(db: Session, household_id: uuid.UUID, location: StorageLocation) -> None:
    household_hierarchy_lock(db, household_id)
    location = get_location(db, household_id, location.id, for_update=True)
    has_children = db.scalar(
        select(StorageLocation.id).where(StorageLocation.parent_id == location.id).limit(1)
    )
    has_items = db.scalar(select(Item.id).where(Item.storage_location_id == location.id).limit(1))
    if has_children or has_items:
        raise ApiError(
            409,
            "location_not_empty",
            "This location still has nested locations or items.",
        )
    db.delete(location)
    db.flush()
