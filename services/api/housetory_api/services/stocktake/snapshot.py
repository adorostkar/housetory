"""Stocktake scope expansion and expected-item snapshots."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...models import (
    Item,
    Room,
    StocktakeSession,
    StocktakeSnapshotItem,
    StorageLocation,
)
from ...schemas.stocktake import (
    StocktakeStartIn,
)
from .. import lending


def _hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _json_safe(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _trim(value: str | None, limit: int) -> str | None:
    text = (value or "").strip()
    return text[:limit] if text else None


def _room_path_map(rooms: list[Room]) -> dict[uuid.UUID, str]:
    by_id = {room.id: room for room in rooms}
    result: dict[uuid.UUID, str] = {}

    def resolve(room_id: uuid.UUID, seen: set[uuid.UUID] | None = None) -> str:
        if room_id in result:
            return result[room_id]
        seen = seen or set()
        if room_id in seen:
            return by_id[room_id].name
        seen.add(room_id)
        room = by_id[room_id]
        if room.parent_id in by_id:
            value = f"{resolve(room.parent_id, seen)} / {room.name}"
        else:
            property_name = room.property.name if room.property is not None else ""
            value = f"{property_name} / {room.name}" if property_name else room.name
        result[room_id] = value
        return value

    for room in rooms:
        resolve(room.id)
    return result


def _location_path_map(locations: list[StorageLocation]) -> dict[uuid.UUID, str]:
    by_id = {location.id: location for location in locations}
    result: dict[uuid.UUID, str] = {}

    def resolve(location_id: uuid.UUID, seen: set[uuid.UUID] | None = None) -> str:
        if location_id in result:
            return result[location_id]
        seen = seen or set()
        if location_id in seen:
            return by_id[location_id].name
        seen.add(location_id)
        location = by_id[location_id]
        label = (
            f"{location.identifier} · {location.name}"
            if location.identifier and location.identifier != location.name
            else location.name
        )
        prefix = resolve(location.parent_id, seen) if location.parent_id in by_id else ""
        value = f"{prefix} / {label}" if prefix else label
        result[location_id] = value
        return value

    for location in locations:
        resolve(location.id)
    return result


def _full_path(
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
    room_paths: dict[uuid.UUID, str],
    location_paths: dict[uuid.UUID, str],
) -> str:
    parts = [
        part
        for part in (
            room_paths.get(room_id) if room_id else None,
            location_paths.get(location_id) if location_id else None,
        )
        if part
    ]
    return " / ".join(parts) or "No location recorded"


def _expand_roots(
    db: Session,
    household_id: uuid.UUID,
    room_ids: list[uuid.UUID],
    container_ids: list[uuid.UUID],
    include_descendants: bool,
) -> tuple[set[uuid.UUID], set[uuid.UUID], list[Room], list[StorageLocation], str]:
    rooms = list(db.scalars(select(Room).where(Room.household_id == household_id)).all())
    locations = list(
        db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        ).all()
    )
    rooms_by_id = {room.id: room for room in rooms}
    locations_by_id = {location.id: location for location in locations}
    if not set(room_ids).issubset(rooms_by_id):
        raise ApiError(404, "room_not_found", "One or more selected rooms do not exist.")
    if not set(container_ids).issubset(locations_by_id):
        raise ApiError(404, "container_not_found", "One or more selected containers do not exist.")

    room_children: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
    for room in rooms:
        room_children[room.parent_id].append(room.id)
    location_children: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
    for location in locations:
        location_children[location.parent_id].append(location.id)

    expanded_rooms: set[uuid.UUID] = set()
    stack = list(room_ids)
    while stack:
        current = stack.pop()
        if current in expanded_rooms:
            continue
        expanded_rooms.add(current)
        if include_descendants:
            stack.extend(room_children.get(current, []))

    expanded_locations: set[uuid.UUID] = set()
    stack = list(container_ids)
    while stack:
        current = stack.pop()
        if current in expanded_locations:
            continue
        expanded_locations.add(current)
        if include_descendants:
            stack.extend(location_children.get(current, []))

    labels: list[str] = []
    for room_id in sorted(room_ids, key=lambda value: rooms_by_id[value].name.lower()):
        room = rooms_by_id[room_id]
        labels.append(
            f"Room: {room.property.name} / {room.name}"
            if room.property is not None
            else f"Room: {room.name}"
        )
    for location_id in sorted(
        container_ids,
        key=lambda value: (
            (locations_by_id[value].identifier or "").lower(),
            locations_by_id[value].name.lower(),
        ),
    ):
        location = locations_by_id[location_id]
        property_name = (
            location.room.property.name
            if location.room is not None and location.room.property is not None
            else None
        )
        labels.append(
            f"Container: {property_name + ' / ' if property_name else ''}"
            f"{location.identifier or location.name}"
            + (f" · {location.name}" if location.identifier and location.name else "")
        )
    scope_label = " · ".join(labels) if labels else "Selected inventory"
    return expanded_rooms, expanded_locations, rooms, locations, scope_label[:300]


def _scope_item_conditions(
    expanded_rooms: set[uuid.UUID],
    expanded_locations: set[uuid.UUID],
    locations: list[StorageLocation],
) -> list[Any]:
    selectors: list[Any] = []
    if expanded_rooms:
        selectors.append(Item.room_id.in_(expanded_rooms))
        locations_in_rooms = {
            location.id for location in locations if location.room_id in expanded_rooms
        }
        if locations_in_rooms:
            selectors.append(Item.storage_location_id.in_(locations_in_rooms))
    if expanded_locations:
        selectors.append(Item.storage_location_id.in_(expanded_locations))
    return selectors


def _scope_snapshot_rows(
    db: Session,
    household_id: uuid.UUID,
    scope: StocktakeStartIn,
) -> tuple[list[dict[str, Any]], str, set[uuid.UUID], set[uuid.UUID]]:
    (
        expanded_rooms,
        expanded_locations,
        rooms,
        locations,
        scope_label,
    ) = _expand_roots(
        db,
        household_id,
        scope.room_ids,
        scope.container_ids,
        scope.include_descendants,
    )
    room_paths = _room_path_map(rooms)
    room_names = {room.id: room.name for room in rooms}
    location_paths = _location_path_map(locations)
    locations_by_id = {location.id: location for location in locations}
    selectors = _scope_item_conditions(expanded_rooms, expanded_locations, locations)
    if not selectors:
        return [], scope_label, expanded_rooms, expanded_locations
    settings = get_settings()
    items = list(
        db.scalars(
            select(Item)
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                or_(*selectors),
            )
            .limit(settings.stocktake_max_items + 1)
        ).all()
    )
    if len(items) > settings.stocktake_max_items:
        raise ApiError(
            422,
            "stocktake_too_many_items",
            f"This stocktake exceeds the {settings.stocktake_max_items}-item limit. "
            "Choose a smaller room or container.",
        )
    loan_quantities = lending.loan_quantities_for_items(
        db, household_id, [item.id for item in items]
    )
    rows: list[dict[str, Any]] = []
    for item in items:
        on_loan = min(item.quantity, max(0, loan_quantities.get(item.id, 0)))
        at_home = max(0, item.quantity - on_loan)
        room_name = room_names.get(item.room_id) if item.room_id else None
        location = (
            locations_by_id.get(item.storage_location_id) if item.storage_location_id else None
        )
        location_path = _full_path(
            item.room_id,
            item.storage_location_id,
            room_paths,
            location_paths,
        )
        rows.append(
            {
                "item_id": item.id,
                "item_name": item.name,
                "quantity": item.quantity,
                "at_home_quantity": at_home,
                "on_loan_quantity": on_loan,
                "room_id": item.room_id,
                "room_name": room_name,
                "location_id": item.storage_location_id,
                "location_name": location.name if location else None,
                "location_identifier": location.identifier if location else None,
                "location_path": location_path,
                "item_updated_at": item.updated_at,
            }
        )
    rows.sort(
        key=lambda row: (
            row["location_path"].lower(),
            row["item_name"].lower(),
            str(row["item_id"]),
        )
    )
    return rows, scope_label, expanded_rooms, expanded_locations


def _snapshot_fingerprint(rows: list[dict[str, Any]], scope: StocktakeStartIn) -> str:
    return _hash(
        {
            "scope": scope.model_dump(mode="json", exclude={"request_id"}),
            "items": [
                {
                    "item_id": str(row["item_id"]),
                    "updated_at": row["item_updated_at"].isoformat(),
                    "quantity": row["quantity"],
                    "room_id": str(row["room_id"]) if row["room_id"] else None,
                    "location_id": (str(row["location_id"]) if row["location_id"] else None),
                }
                for row in rows
            ],
        }
    )


def _add_snapshot_rows(
    db: Session,
    session: StocktakeSession,
    rows: list[dict[str, Any]],
    *,
    start_position: int = 0,
) -> None:
    for index, row in enumerate(rows, start=start_position):
        db.add(
            StocktakeSnapshotItem(
                household_id=session.household_id,
                session_id=session.id,
                item_id=row["item_id"],
                position=index,
                item_name=row["item_name"],
                quantity=row["quantity"],
                at_home_quantity=row["at_home_quantity"],
                on_loan_quantity=row["on_loan_quantity"],
                room_id=row["room_id"],
                room_name=row["room_name"],
                location_id=row["location_id"],
                location_name=row["location_name"],
                location_identifier=row["location_identifier"],
                location_path=row["location_path"],
                item_updated_at=row["item_updated_at"],
            )
        )
    db.flush()


def _update_expected_counts(session: StocktakeSession, rows: list[dict[str, Any]]) -> None:
    session.expected_item_count = len(rows)
    session.expected_unit_count = sum(row["quantity"] for row in rows)
    session.expected_at_home_unit_count = sum(row["at_home_quantity"] for row in rows)
    session.expected_on_loan_unit_count = sum(row["on_loan_quantity"] for row in rows)


def _snapshot_rows_from_db(
    snapshots: list[StocktakeSnapshotItem],
) -> list[dict[str, Any]]:
    return [
        {
            "item_id": snapshot.item_id,
            "item_name": snapshot.item_name,
            "quantity": snapshot.quantity,
            "at_home_quantity": snapshot.at_home_quantity,
            "on_loan_quantity": snapshot.on_loan_quantity,
            "room_id": snapshot.room_id,
            "room_name": snapshot.room_name,
            "location_id": snapshot.location_id,
            "location_name": snapshot.location_name,
            "location_identifier": snapshot.location_identifier,
            "location_path": snapshot.location_path,
            "item_updated_at": snapshot.item_updated_at,
        }
        for snapshot in snapshots
    ]


def _scope_payload(session: StocktakeSession) -> StocktakeStartIn:
    scope = session.scope or {}
    return StocktakeStartIn(
        room_ids=[uuid.UUID(str(value)) for value in scope.get("room_ids", [])],
        container_ids=[uuid.UUID(str(value)) for value in scope.get("container_ids", [])],
        include_descendants=bool(scope.get("include_descendants", True)),
        request_id=session.request_id,
    )
