"""Bounded stocktakes, field observations and reviewed last-verified state.

The central rule is that an observation is evidence, not an inventory edit.
Moves and quantity corrections are proposed in a review and only applied by a
separate, explicit request. Completion records exact coverage; it never turns
unchecked items into verified ones.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import ActivityAction, StocktakeObservationStatus, StocktakeStatus
from ..models import (
    Item,
    Room,
    StocktakeApplication,
    StocktakeCorrection,
    StocktakeItemState,
    StocktakeObservation,
    StocktakeSession,
    StocktakeSnapshotItem,
    StorageLocation,
    User,
)
from ..schemas.stocktake import (
    StocktakeAbandonIn,
    StocktakeApplyIn,
    StocktakeApplyOut,
    StocktakeCompleteIn,
    StocktakeCurrentItemOut,
    StocktakeItemOut,
    StocktakeObservationIn,
    StocktakeObservationOut,
    StocktakeProposalOut,
    StocktakeReviewOut,
    StocktakeScopeSummaryOut,
    StocktakeSessionDetail,
    StocktakeSessionList,
    StocktakeSessionOut,
    StocktakeStartIn,
)
from . import history, lending
from .serializers import item_load_options, photo_url

CHECKED_STATUSES = {
    StocktakeObservationStatus.PRESENT.value,
    StocktakeObservationStatus.MISSING.value,
    StocktakeObservationStatus.MOVED.value,
    StocktakeObservationStatus.QUANTITY_DISCREPANCY.value,
}
FOUND_STATUSES = {
    StocktakeObservationStatus.PRESENT.value,
    StocktakeObservationStatus.MOVED.value,
    StocktakeObservationStatus.QUANTITY_DISCREPANCY.value,
}
APPLY_STATUSES = {
    StocktakeObservationStatus.MOVED.value,
    StocktakeObservationStatus.QUANTITY_DISCREPANCY.value,
}


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
            select(StorageLocation).where(StorageLocation.household_id == household_id)
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


def get_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> StocktakeSession:
    query = select(StocktakeSession).where(
        StocktakeSession.id == session_id,
        StocktakeSession.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update().execution_options(populate_existing=True)
    session = db.scalar(query)
    if session is None:
        raise ApiError(404, "stocktake_not_found", "Stocktake not found.")
    return session


def _session_out(session: StocktakeSession) -> StocktakeSessionOut:
    coverage = session.coverage or {}
    if session.status == StocktakeStatus.COMPLETED.value:
        partial = bool(coverage.get("partial"))
    else:
        partial = True
    return StocktakeSessionOut(
        id=session.id,
        status=session.status,  # type: ignore[arg-type]
        scope_label=session.scope_label,
        scope=session.scope or {},
        snapshot_fingerprint=session.snapshot_fingerprint,
        expected_item_count=session.expected_item_count,
        expected_unit_count=session.expected_unit_count,
        expected_at_home_unit_count=session.expected_at_home_unit_count,
        expected_on_loan_unit_count=session.expected_on_loan_unit_count,
        checked_item_count=session.checked_item_count,
        checked_unit_count=session.checked_unit_count,
        verified_item_count=session.verified_item_count,
        missing_item_count=session.missing_item_count,
        quantity_discrepancy_count=session.quantity_discrepancy_count,
        unknown_item_count=session.unknown_item_count,
        unexpected_count=session.unexpected_count,
        coverage=coverage,
        partial=partial,
        created_by_name=session.created_by_name_snapshot,
        completed_by_name=session.completed_by_name_snapshot,
        started_at=session.started_at,
        completed_at=session.completed_at,
        abandoned_at=session.abandoned_at,
        last_refreshed_at=session.last_refreshed_at,
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


def _latest_observations(
    db: Session, session_id: uuid.UUID
) -> tuple[dict[uuid.UUID, StocktakeObservation], list[StocktakeObservation]]:
    observations = list(
        db.scalars(
            select(StocktakeObservation)
            .where(StocktakeObservation.session_id == session_id)
            .order_by(StocktakeObservation.created_at, StocktakeObservation.id)
        ).all()
    )
    latest: dict[uuid.UUID, StocktakeObservation] = {}
    unexpected: list[StocktakeObservation] = []
    for observation in observations:
        if observation.status == StocktakeObservationStatus.UNEXPECTED.value:
            unexpected.append(observation)
        elif observation.snapshot_item_id is not None:
            latest[observation.snapshot_item_id] = observation
    return latest, unexpected


def _progress(
    session: StocktakeSession,
    latest: dict[uuid.UUID, StocktakeObservation],
    unexpected: list[StocktakeObservation],
) -> dict[str, int]:
    checked = 0
    checked_units = 0
    verified = 0
    missing = 0
    quantity = 0
    unknown = 0
    for observation in latest.values():
        if observation.status in CHECKED_STATUSES:
            checked += 1
            checked_units += max(0, observation.counted_quantity or 0)
        if observation.status in FOUND_STATUSES:
            verified += 1
        if observation.status == StocktakeObservationStatus.MISSING.value:
            missing += 1
        if observation.status == StocktakeObservationStatus.UNKNOWN.value:
            unknown += 1
        if observation.status in {
            StocktakeObservationStatus.QUANTITY_DISCREPANCY.value,
            StocktakeObservationStatus.MOVED.value,
        }:
            expected = (
                observation.at_home_quantity_at_observation
                if observation.status == StocktakeObservationStatus.MOVED.value
                else observation.owned_quantity_at_observation
            )
            if observation.status == StocktakeObservationStatus.MOVED.value:
                expected = observation.at_home_quantity_at_observation
            if (
                observation.counted_quantity is not None
                and observation.counted_quantity != expected
            ):
                quantity += 1
    session.checked_item_count = checked
    session.checked_unit_count = checked_units
    session.verified_item_count = verified
    session.missing_item_count = missing
    session.quantity_discrepancy_count = quantity
    session.unknown_item_count = unknown
    session.unexpected_count = len(unexpected)
    return {
        "checked": checked,
        "checked_units": checked_units,
        "verified": verified,
        "missing": missing,
        "quantity": quantity,
        "unknown": unknown,
        "unexpected": len(unexpected),
    }


def _refresh_progress(db: Session, session: StocktakeSession) -> dict[str, int]:
    latest, unexpected = _latest_observations(db, session.id)
    progress = _progress(session, latest, unexpected)
    db.flush()
    return progress


def start_session(
    db: Session,
    household_id: uuid.UUID,
    *,
    user: User,
    payload: StocktakeStartIn,
) -> StocktakeSession:
    existing = db.scalar(
        select(StocktakeSession).where(
            StocktakeSession.household_id == household_id,
            StocktakeSession.request_id == payload.request_id,
        )
    )
    if existing is not None:
        expected_scope = {
            "room_ids": [str(value) for value in payload.room_ids],
            "container_ids": [str(value) for value in payload.container_ids],
            "include_descendants": payload.include_descendants,
        }
        if (existing.scope or {}) != expected_scope:
            raise ApiError(
                409,
                "stocktake_request_conflict",
                "This request id was already used for a different stocktake scope.",
            )
        return existing
    settings = get_settings()
    active_count = int(
        db.scalar(
            select(func.count(StocktakeSession.id)).where(
                StocktakeSession.household_id == household_id,
                StocktakeSession.status == StocktakeStatus.IN_PROGRESS.value,
            )
        )
        or 0
    )
    if active_count >= settings.stocktake_max_active_sessions:
        raise ApiError(
            409,
            "too_many_active_stocktakes",
            "Too many stocktakes are unfinished. Complete or abandon one before starting another.",
        )
    rows, scope_label, _, _ = _scope_snapshot_rows(db, household_id, payload)
    if not rows:
        raise ApiError(
            422,
            "stocktake_empty_scope",
            "No active items are in this room or container. Add or restore items first.",
        )
    session = StocktakeSession(
        household_id=household_id,
        created_by_user_id=user.id,
        created_by_name_snapshot=user.name[:120],
        request_id=payload.request_id,
        status=StocktakeStatus.IN_PROGRESS.value,
        scope={
            "room_ids": [str(value) for value in payload.room_ids],
            "container_ids": [str(value) for value in payload.container_ids],
            "include_descendants": payload.include_descendants,
        },
        scope_label=scope_label,
        snapshot_fingerprint=_snapshot_fingerprint(rows, payload),
        coverage={},
    )
    _update_expected_counts(session, rows)
    db.add(session)
    db.flush()
    _add_snapshot_rows(db, session, rows)
    db.commit()
    db.refresh(session)
    return session


def list_sessions(
    db: Session,
    household_id: uuid.UUID,
    *,
    room_id: uuid.UUID | None = None,
    container_id: uuid.UUID | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> StocktakeSessionList:
    conditions = [StocktakeSession.household_id == household_id]
    if status:
        conditions.append(StocktakeSession.status == status)
    sessions = list(
        db.scalars(
            select(StocktakeSession)
            .where(*conditions)
            .order_by(StocktakeSession.updated_at.desc())
            .limit(500)
        ).all()
    )
    if room_id is not None:
        sessions = [
            session
            for session in sessions
            if str(room_id) in (session.scope or {}).get("room_ids", [])
        ]
    if container_id is not None:
        sessions = [
            session
            for session in sessions
            if str(container_id) in (session.scope or {}).get("container_ids", [])
        ]
    total = len(sessions)
    page = sessions[offset : offset + limit]
    return StocktakeSessionList(
        items=[_session_out(session) for session in page],
        total=total,
        limit=limit,
        offset=offset,
    )


def _observation_out(
    observation: StocktakeObservation, *, applied: bool = False
) -> StocktakeObservationOut:
    return StocktakeObservationOut(
        id=observation.id,
        status=observation.status,  # type: ignore[arg-type]
        snapshot_item_id=observation.snapshot_item_id,
        item_id=observation.item_id,
        linked_item_id=observation.linked_item_id,
        counted_quantity=observation.counted_quantity,
        observed_room_id=observation.observed_room_id,
        observed_location_id=observation.observed_location_id,
        observed_room_name=observation.observed_room_name,
        observed_location_name=observation.observed_location_name,
        observed_location_identifier=observation.observed_location_identifier,
        observed_location_path=observation.observed_location_path,
        unexpected_name=observation.unexpected_name,
        notes=observation.notes,
        owned_quantity_at_observation=observation.owned_quantity_at_observation,
        on_loan_quantity_at_observation=observation.on_loan_quantity_at_observation,
        at_home_quantity_at_observation=observation.at_home_quantity_at_observation,
        verifier_name=observation.verifier_name_snapshot,
        observed_at=observation.observed_at,
        applied=applied,
    )


def session_detail(
    db: Session, household_id: uuid.UUID, session_id: uuid.UUID
) -> StocktakeSessionDetail:
    session = get_session(db, household_id, session_id)
    snapshots = list(
        db.scalars(
            select(StocktakeSnapshotItem)
            .where(StocktakeSnapshotItem.session_id == session.id)
            .order_by(StocktakeSnapshotItem.position, StocktakeSnapshotItem.id)
        ).all()
    )
    item_ids = [row.item_id for row in snapshots if row.item_id is not None]
    current_items: dict[uuid.UUID, Item] = {}
    if item_ids:
        current_items = {
            item.id: item
            for item in db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(Item.household_id == household_id, Item.id.in_(item_ids))
            ).all()
        }
    loan_quantities = lending.loan_quantities_for_items(db, household_id, list(current_items))
    rooms = list(
        db.scalars(
            select(Room).options(joinedload(Room.property)).where(Room.household_id == household_id)
        ).all()
    )
    locations = list(
        db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    )
    room_paths = _room_path_map(rooms)
    location_paths = _location_path_map(locations)
    latest, unexpected = _latest_observations(db, session.id)
    applied_ids = set(
        db.scalars(
            select(StocktakeCorrection.observation_id).where(
                StocktakeCorrection.session_id == session.id
            )
        ).all()
    )
    items: list[StocktakeItemOut] = []
    for snapshot in snapshots:
        item = current_items.get(snapshot.item_id) if snapshot.item_id else None
        on_loan = loan_quantities.get(item.id, 0) if item else 0
        at_home = max(0, item.quantity - on_loan) if item else 0
        photo = None
        if item is not None:
            photos = sorted(item.photos, key=lambda entry: (entry.sort_order, entry.created_at))
            photo = photo_url(photos[0].id, thumbnail=True) if photos else None
        current = StocktakeCurrentItemOut(
            exists=item is not None,
            name=item.name if item else None,
            quantity=item.quantity if item else None,
            on_loan_quantity=on_loan,
            at_home_quantity=at_home,
            room_id=item.room_id if item else None,
            location_id=item.storage_location_id if item else None,
            location_path=(
                _full_path(
                    item.room_id,
                    item.storage_location_id,
                    room_paths,
                    location_paths,
                )
                if item
                else ""
            ),
            is_archived=item.is_archived if item else False,
            updated_at=item.updated_at if item else None,
            photo_thumbnail_url=photo,
        )
        observation = latest.get(snapshot.id)
        changed = (
            item is None
            or item.updated_at != snapshot.item_updated_at
            or item.quantity != snapshot.quantity
            or item.room_id != snapshot.room_id
            or item.storage_location_id != snapshot.location_id
        )
        items.append(
            StocktakeItemOut(
                snapshot_item_id=snapshot.id,
                item_id=snapshot.item_id,
                item_name=snapshot.item_name,
                expected_quantity=snapshot.quantity,
                expected_at_home_quantity=snapshot.at_home_quantity,
                expected_on_loan_quantity=snapshot.on_loan_quantity,
                expected_location_path=snapshot.location_path,
                item_updated_at=snapshot.item_updated_at,
                changed_since_snapshot=changed,
                deleted=item is None,
                latest_observation=(
                    _observation_out(observation, applied=observation.id in applied_ids)
                    if observation is not None
                    else None
                ),
                correction_applied=bool(observation is not None and observation.id in applied_ids),
                current=current,
            )
        )
    base = _session_out(session)
    return StocktakeSessionDetail(
        **base.model_dump(),
        items=items,
        unexpected_findings=[_observation_out(observation) for observation in unexpected],
    )


def _destination(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    container_id: uuid.UUID | None,
) -> tuple[Room | None, StorageLocation | None, str]:
    room = None
    location = None
    if room_id is not None:
        room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(422, "room_not_found", "The selected room does not exist.")
    if container_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == container_id,
                StorageLocation.household_id == household_id,
            )
        )
        if location is None:
            raise ApiError(422, "container_not_found", "The selected container does not exist.")
        if room is not None and location.room_id != room.id:
            raise ApiError(
                422,
                "container_room_mismatch",
                "The selected container belongs to a different room.",
            )
        if room is None:
            room = db.scalar(
                select(Room).where(
                    Room.id == location.room_id,
                    Room.household_id == household_id,
                )
            )
    if room is None:
        raise ApiError(422, "room_required", "Choose an existing room for the observed item.")
    rooms = list(db.scalars(select(Room).where(Room.household_id == household_id)).all())
    locations = list(
        db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    )
    path = _full_path(
        room.id,
        location.id if location else None,
        _room_path_map(rooms),
        _location_path_map(locations),
    )
    return room, location, path


def _observation_payload(payload: StocktakeObservationIn) -> dict[str, Any]:
    return payload.model_dump(mode="json", exclude={"request_id"})


def _check_idempotent_observation(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    payload: StocktakeObservationIn,
) -> StocktakeObservation | None:
    existing = db.scalar(
        select(StocktakeObservation).where(
            StocktakeObservation.household_id == household_id,
            StocktakeObservation.request_id == payload.request_id,
        )
    )
    if existing is None:
        return None
    if existing.session_id != session_id or existing.payload_hash != _hash(
        _observation_payload(payload)
    ):
        raise ApiError(
            409,
            "observation_request_conflict",
            "This request id was already used for a different observation.",
        )
    return existing


def create_observation(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    user: User,
    payload: StocktakeObservationIn,
) -> StocktakeObservation:
    session = get_session(db, household_id, session_id, for_update=True)
    if session.status != StocktakeStatus.IN_PROGRESS.value:
        raise ApiError(
            409,
            "stocktake_closed",
            "This stocktake is already "
            f"{session.status.replace('_', ' ')}. Start a new stocktake to record more checks.",
        )
    existing = _check_idempotent_observation(db, household_id, session_id, payload)
    if existing is not None:
        return existing
    settings = get_settings()
    observation_count = int(
        db.scalar(
            select(func.count(StocktakeObservation.id)).where(
                StocktakeObservation.session_id == session.id
            )
        )
        or 0
    )
    if observation_count >= settings.stocktake_max_observations_per_session:
        raise ApiError(
            422,
            "stocktake_observation_limit",
            "This stocktake has reached its observation limit. Complete or abandon it "
            "and start a new check.",
        )
    notes = _trim(payload.notes, settings.stocktake_max_notes_chars)
    snapshot: StocktakeSnapshotItem | None = None
    item: Item | None = None
    on_loan = 0
    owned = 0
    at_home = 0
    observed_room: Room | None = None
    observed_location: StorageLocation | None = None
    observed_path: str | None = None
    counted = payload.counted_quantity
    if payload.status == StocktakeObservationStatus.UNEXPECTED.value:
        if payload.linked_item_id is not None:
            item = db.scalar(
                select(Item).where(
                    Item.id == payload.linked_item_id,
                    Item.household_id == household_id,
                )
            )
            if item is None:
                raise ApiError(422, "linked_item_not_found", "The linked item does not exist.")
            on_loan = lending.outstanding_quantity(db, household_id, item.id)
            owned = item.quantity
            at_home = max(0, owned - on_loan)
        if payload.room_id is not None or payload.container_id is not None:
            observed_room, observed_location, observed_path = _destination(
                db, household_id, payload.room_id, payload.container_id
            )
    else:
        snapshot = db.scalar(
            select(StocktakeSnapshotItem).where(
                StocktakeSnapshotItem.id == payload.snapshot_item_id,
                StocktakeSnapshotItem.session_id == session.id,
                StocktakeSnapshotItem.household_id == household_id,
            )
        )
        if snapshot is None:
            raise ApiError(404, "snapshot_item_not_found", "Expected item not found.")
        if snapshot.item_id is None:
            raise ApiError(
                409,
                "item_deleted",
                "This item was deleted during the stocktake. Refresh the stocktake and "
                "review the remaining items.",
            )
        item = db.scalar(
            select(Item).where(
                Item.id == snapshot.item_id,
                Item.household_id == household_id,
            )
        )
        if item is None:
            raise ApiError(
                409,
                "item_deleted",
                "This item was deleted during the stocktake. Refresh the stocktake and "
                "review the remaining items.",
            )
        if payload.expected_item_updated_at != item.updated_at:
            raise ApiError(
                409,
                "item_changed",
                "This item changed after the stocktake snapshot. Reload the item, review "
                "its current values and record the observation again.",
            )
        if payload.expected_on_loan_quantity is None:
            raise ApiError(
                422,
                "loan_context_required",
                "Reload the item's current loan context before recording this check.",
            )
        on_loan = lending.outstanding_quantity(db, household_id, item.id)
        if payload.expected_on_loan_quantity != on_loan:
            raise ApiError(
                409,
                "loans_changed",
                "Loan quantities changed while you were checking this item. Reload the "
                "stocktake so loaned units are not treated as missing.",
            )
        owned = item.quantity
        at_home = max(0, owned - on_loan)
        if payload.status == StocktakeObservationStatus.PRESENT.value:
            if counted != at_home:
                raise ApiError(
                    422,
                    "quantity_mismatch",
                    f"{at_home} unit(s) are expected at home and {on_loan} are on loan. "
                    "Use Quantity discrepancy if the counted at-home quantity is different.",
                )
        elif payload.status == StocktakeObservationStatus.QUANTITY_DISCREPANCY.value:
            if counted == at_home:
                raise ApiError(
                    422,
                    "no_quantity_discrepancy",
                    "The counted quantity matches the expected at-home quantity. Use "
                    "Present instead.",
                )
        elif payload.status == StocktakeObservationStatus.MISSING.value:
            counted = 0
        elif payload.status == StocktakeObservationStatus.UNKNOWN.value:
            counted = None
        if payload.status == StocktakeObservationStatus.MOVED.value:
            observed_room, observed_location, observed_path = _destination(
                db, household_id, payload.room_id, payload.container_id
            )
        elif payload.room_id is not None or payload.container_id is not None:
            raise ApiError(
                422,
                "destination_not_allowed",
                "A destination can only be recorded for a moved item.",
            )
    observation = StocktakeObservation(
        household_id=household_id,
        session_id=session.id,
        request_id=payload.request_id,
        snapshot_item_id=snapshot.id if snapshot else None,
        item_id=item.id if item else None,
        status=payload.status,
        counted_quantity=counted,
        observed_room_id=observed_room.id if observed_room else None,
        observed_location_id=observed_location.id if observed_location else None,
        observed_room_name=observed_room.name if observed_room else None,
        observed_location_name=observed_location.name if observed_location else None,
        observed_location_identifier=(observed_location.identifier if observed_location else None),
        observed_location_path=observed_path,
        unexpected_name=payload.unexpected_name if snapshot is None else None,
        linked_item_id=payload.linked_item_id if snapshot is None else None,
        notes=notes,
        owned_quantity_at_observation=owned if snapshot is not None else None,
        on_loan_quantity_at_observation=on_loan,
        at_home_quantity_at_observation=at_home,
        item_updated_at_at_observation=item.updated_at if item else None,
        payload_hash=_hash(_observation_payload(payload)),
        created_by_user_id=user.id,
        verifier_name_snapshot=user.name[:120],
        observed_at=datetime.now(UTC),
    )
    db.add(observation)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        replay = _check_idempotent_observation(db, household_id, session_id, payload)
        if replay is not None:
            return replay
        raise
    _refresh_progress(db, session)
    db.commit()
    db.refresh(observation)
    return observation


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


def refresh_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
) -> StocktakeSessionDetail:
    session = get_session(db, household_id, session_id, for_update=True)
    if session.status != StocktakeStatus.IN_PROGRESS.value:
        raise ApiError(
            409,
            "stocktake_closed",
            "Only an in-progress stocktake can be refreshed.",
        )
    scope = _scope_payload(session)
    rows, scope_label, _, _ = _scope_snapshot_rows(db, household_id, scope)
    existing = list(
        db.scalars(
            select(StocktakeSnapshotItem)
            .where(StocktakeSnapshotItem.session_id == session.id)
            .order_by(StocktakeSnapshotItem.position, StocktakeSnapshotItem.id)
        ).all()
    )
    existing_item_ids = {row.item_id for row in existing if row.item_id is not None}
    new_rows = [row for row in rows if row["item_id"] not in existing_item_ids]
    settings = get_settings()
    if len(existing) + len(new_rows) > settings.stocktake_max_items:
        raise ApiError(
            422,
            "stocktake_too_many_items",
            f"Refreshing would exceed the {settings.stocktake_max_items}-item limit. "
            "Choose a smaller scope.",
        )
    next_position = max((row.position for row in existing), default=-1) + 1
    if new_rows:
        _add_snapshot_rows(db, session, new_rows, start_position=next_position)
    all_snapshots = list(
        db.scalars(
            select(StocktakeSnapshotItem)
            .where(StocktakeSnapshotItem.session_id == session.id)
            .order_by(StocktakeSnapshotItem.position, StocktakeSnapshotItem.id)
        ).all()
    )
    _update_expected_counts(session, _snapshot_rows_from_db(all_snapshots))
    session.scope_label = scope_label
    session.snapshot_fingerprint = _snapshot_fingerprint(
        _snapshot_rows_from_db(all_snapshots), scope
    )
    session.last_refreshed_at = datetime.now(UTC)
    if session.expected_item_count == 0:
        raise ApiError(
            422,
            "stocktake_empty_scope",
            "No active items are currently in this stocktake scope.",
        )
    _refresh_progress(db, session)
    db.commit()
    db.refresh(session)
    return session_detail(db, household_id, session.id)


def _review_session(
    db: Session,
    household_id: uuid.UUID,
    session: StocktakeSession,
    observation_ids: list[uuid.UUID] | None = None,
) -> StocktakeReviewOut:
    snapshots = {
        row.id: row
        for row in db.scalars(
            select(StocktakeSnapshotItem).where(StocktakeSnapshotItem.session_id == session.id)
        ).all()
    }
    latest, _unexpected = _latest_observations(db, session.id)
    applied_ids = set(
        db.scalars(
            select(StocktakeCorrection.observation_id).where(
                StocktakeCorrection.session_id == session.id
            )
        ).all()
    )
    selected_ids = set(observation_ids or [])
    item_ids = [snapshot.item_id for snapshot in snapshots.values() if snapshot.item_id is not None]
    items = (
        {
            item.id: item
            for item in db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(Item.household_id == household_id, Item.id.in_(item_ids))
            ).all()
        }
        if item_ids
        else {}
    )
    loan_quantities = lending.loan_quantities_for_items(db, household_id, list(items))
    rooms = {
        room.id: room
        for room in db.scalars(select(Room).where(Room.household_id == household_id)).all()
    }
    locations = {
        location.id: location
        for location in db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    }
    room_paths = _room_path_map(list(rooms.values()))
    location_paths = _location_path_map(list(locations.values()))
    proposals: list[StocktakeProposalOut] = []
    for snapshot_id, observation in latest.items():
        if observation.id in applied_ids:
            continue
        if selected_ids and observation.id not in selected_ids:
            continue
        if observation.status not in APPLY_STATUSES:
            continue
        snapshot = snapshots.get(snapshot_id)
        if snapshot is None:
            continue
        item = items.get(snapshot.item_id) if snapshot.item_id else None
        on_loan = loan_quantities.get(item.id, 0) if item else 0
        current_path = (
            _full_path(
                item.room_id,
                item.storage_location_id,
                room_paths,
                location_paths,
            )
            if item
            else snapshot.location_path
        )
        proposed_room = None
        proposed_location = None
        proposed_path = current_path
        if observation.status == StocktakeObservationStatus.MOVED.value:
            if observation.observed_room_id is not None:
                proposed_room = rooms.get(observation.observed_room_id)
            if observation.observed_location_id is not None:
                proposed_location = locations.get(observation.observed_location_id)
            if proposed_room is not None:
                proposed_path = observation.observed_location_path or _full_path(
                    proposed_room.id,
                    proposed_location.id if proposed_location else None,
                    room_paths,
                    location_paths,
                )
        proposed_quantity = None
        if observation.status in APPLY_STATUSES:
            proposed_quantity = max(0, observation.counted_quantity or 0) + on_loan
        conflict: str | None = None
        if item is None:
            conflict = "This item was deleted after the observation. It cannot be corrected."
        elif observation.item_updated_at_at_observation != item.updated_at:
            conflict = (
                "This item changed after the observation. Record the observation again "
                "against the current values."
            )
        elif observation.on_loan_quantity_at_observation != on_loan:
            conflict = (
                "Loan quantities changed after the observation. Record the observation "
                "again so loaned units are not treated as missing."
            )
        elif observation.status == StocktakeObservationStatus.MOVED.value:
            if proposed_room is None:
                conflict = "The observed room no longer exists. Choose an existing room again."
            elif observation.observed_location_id is not None and proposed_location is None:
                conflict = (
                    "The observed container no longer exists. Choose an existing place again."
                )
            elif proposed_location is not None and proposed_location.room_id != proposed_room.id:
                conflict = "The observed container now belongs to another room."
        move_needed = bool(
            item
            and observation.status == StocktakeObservationStatus.MOVED.value
            and proposed_room is not None
            and (
                item.room_id != proposed_room.id
                or item.storage_location_id != (proposed_location.id if proposed_location else None)
            )
        )
        quantity_needed = bool(
            item is not None
            and observation.status in APPLY_STATUSES
            and proposed_quantity is not None
            and proposed_quantity != item.quantity
        )
        action: str = "none"
        if move_needed and quantity_needed:
            action = "move_and_quantity"
        elif move_needed:
            action = "move"
        elif quantity_needed:
            action = "set_quantity"
        warnings: list[str] = []
        if on_loan > 0:
            warnings.append(
                f"{on_loan} unit(s) are on loan and remain owned; only at-home stock was counted."
            )
        if item is not None and proposed_quantity is not None:
            if proposed_quantity < item.quantity:
                warnings.append(
                    f"Reduces recorded owned quantity from {item.quantity} to "
                    f"{proposed_quantity}. Loaned units are never written off as missing."
                )
            elif proposed_quantity > item.quantity:
                warnings.append(
                    f"Increases recorded owned quantity from {item.quantity} to "
                    f"{proposed_quantity}. Review that this is not a duplicate count."
                )
        if move_needed and proposed_room is not None:
            warnings.append(
                f"Recorded location will change from {current_path} to {proposed_path}."
            )
        proposals.append(
            StocktakeProposalOut(
                observation_id=observation.id,
                snapshot_item_id=snapshot.id,
                item_id=snapshot.item_id,
                item_name=snapshot.item_name,
                status=observation.status,  # type: ignore[arg-type]
                action=action,  # type: ignore[arg-type]
                current_quantity=item.quantity if item else None,
                proposed_quantity=proposed_quantity,
                current_room_id=item.room_id if item else None,
                current_room_name=(
                    rooms[item.room_id].name
                    if item and item.room_id in rooms
                    else snapshot.room_name
                ),
                current_location_id=item.storage_location_id if item else None,
                current_location_name=(
                    locations[item.storage_location_id].name
                    if item and item.storage_location_id in locations
                    else None
                ),
                current_location_path=current_path,
                proposed_room_id=proposed_room.id if proposed_room else None,
                proposed_room_name=proposed_room.name if proposed_room else None,
                proposed_location_id=proposed_location.id if proposed_location else None,
                proposed_location_name=(proposed_location.name if proposed_location else None),
                proposed_location_path=proposed_path,
                on_loan_quantity=on_loan,
                counted_quantity=observation.counted_quantity,
                conflict=conflict,
                warnings=warnings,
            )
        )
    proposals.sort(key=lambda proposal: str(proposal.observation_id))
    fingerprint = _hash(
        {
            "session_id": str(session.id),
            "proposals": [
                {
                    "observation_id": str(proposal.observation_id),
                    "item_id": str(proposal.item_id) if proposal.item_id else None,
                    "action": proposal.action,
                    "current_quantity": proposal.current_quantity,
                    "proposed_quantity": proposal.proposed_quantity,
                    "current_room_id": (
                        str(proposal.current_room_id) if proposal.current_room_id else None
                    ),
                    "current_location_id": (
                        str(proposal.current_location_id) if proposal.current_location_id else None
                    ),
                    "proposed_room_id": (
                        str(proposal.proposed_room_id) if proposal.proposed_room_id else None
                    ),
                    "proposed_location_id": (
                        str(proposal.proposed_location_id)
                        if proposal.proposed_location_id
                        else None
                    ),
                    "on_loan_quantity": proposal.on_loan_quantity,
                    "conflict": proposal.conflict,
                }
                for proposal in proposals
            ],
        }
    )
    return StocktakeReviewOut(
        session_id=session.id,
        fingerprint=fingerprint,
        proposals=proposals,
        actionable_count=sum(
            1 for proposal in proposals if proposal.action != "none" and not proposal.conflict
        ),
        conflict_count=sum(1 for proposal in proposals if proposal.conflict),
        can_apply=any(proposal.action != "none" and not proposal.conflict for proposal in proposals)
        and not any(proposal.conflict for proposal in proposals),
        checked_item_count=session.checked_item_count,
        expected_item_count=session.expected_item_count,
    )


def review_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    observation_ids: list[uuid.UUID] | None = None,
) -> StocktakeReviewOut:
    session = get_session(db, household_id, session_id)
    if session.status != StocktakeStatus.IN_PROGRESS.value:
        raise ApiError(409, "stocktake_closed", "Only an in-progress stocktake can be reviewed.")
    return _review_session(db, household_id, session, observation_ids)


def _application_result(application: StocktakeApplication) -> StocktakeApplyOut:
    result = application.result or {}
    session = result.get("session")
    if session is None:  # pragma: no cover - stored result always includes it
        raise ApiError(409, "application_result_missing", "Application result is unavailable.")
    return StocktakeApplyOut(
        application_id=application.id,
        session=StocktakeSessionOut.model_validate(session),
        applied_count=application.applied_count,
        skipped_count=application.skipped_count,
        proposals=[
            StocktakeProposalOut.model_validate(proposal)
            for proposal in result.get("proposals", [])
        ],
        message=result.get("message", "Corrections applied."),
    )


def apply_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    user: User,
    payload: StocktakeApplyIn,
) -> StocktakeApplyOut:
    session = get_session(db, household_id, session_id, for_update=True)
    payload_hash = _hash(
        {
            "session_id": str(session.id),
            "review_fingerprint": payload.review_fingerprint,
            "observation_ids": sorted(str(value) for value in payload.observation_ids),
        }
    )
    existing = db.scalar(
        select(StocktakeApplication).where(
            StocktakeApplication.household_id == household_id,
            StocktakeApplication.request_id == payload.request_id,
        )
    )
    if existing is not None:
        if existing.payload_hash != payload_hash:
            raise ApiError(
                409,
                "application_request_conflict",
                "This request id was already used for a different correction review.",
            )
        return _application_result(existing)
    if session.status != StocktakeStatus.IN_PROGRESS.value:
        raise ApiError(
            409, "stocktake_closed", "Only an in-progress stocktake can apply corrections."
        )
    settings = get_settings()
    first_review = _review_session(db, household_id, session, payload.observation_ids or None)
    if first_review.fingerprint != payload.review_fingerprint:
        raise ApiError(
            409,
            "stocktake_review_stale",
            "Inventory changed after the corrections were reviewed. Review the current "
            "old/current/new values again.",
        )
    if first_review.conflict_count:
        conflict = next(
            (proposal.conflict for proposal in first_review.proposals if proposal.conflict),
            "The corrections conflict with current inventory.",
        )
        raise ApiError(409, "stocktake_conflict", conflict or "Stocktake conflict.")
    actionable = [
        proposal
        for proposal in first_review.proposals
        if proposal.action != "none" and not proposal.conflict
    ]
    if not actionable:
        raise ApiError(
            422,
            "stocktake_no_corrections",
            "There are no changes to apply. Verification-only observations are already recorded.",
        )
    if len(actionable) > settings.stocktake_max_apply_batch:
        raise ApiError(
            422,
            "stocktake_apply_too_large",
            f"Apply at most {settings.stocktake_max_apply_batch} corrections at a time.",
        )
    item_ids = sorted({proposal.item_id for proposal in actionable if proposal.item_id})
    locked_items = {
        item.id: item
        for item in db.scalars(
            select(Item)
            .where(Item.household_id == household_id, Item.id.in_(item_ids))
            .order_by(Item.id)
            .with_for_update()
        ).all()
    }
    second_review = _review_session(db, household_id, session, payload.observation_ids or None)
    if second_review.fingerprint != payload.review_fingerprint:
        raise ApiError(
            409,
            "stocktake_review_stale",
            "Inventory changed while corrections were being applied. Nothing was "
            "changed. Review and apply again.",
        )
    if second_review.conflict_count:
        raise ApiError(
            409,
            "stocktake_conflict",
            "A correction conflicts with current inventory. Nothing was changed.",
        )
    actionable = [
        proposal
        for proposal in second_review.proposals
        if proposal.action != "none" and not proposal.conflict
    ]
    from ..schemas.items import ItemUpdate
    from . import items as items_service

    application = StocktakeApplication(
        household_id=household_id,
        session_id=session.id,
        created_by_user_id=user.id,
        request_id=payload.request_id,
        review_fingerprint=payload.review_fingerprint,
        payload_hash=payload_hash,
        applied_count=0,
        skipped_count=len(second_review.proposals) - len(actionable),
        result={},
    )
    db.add(application)
    db.flush()
    applied_proposals: list[StocktakeProposalOut] = []
    for proposal in actionable:
        item = locked_items.get(proposal.item_id)
        if item is None:
            raise ApiError(
                409,
                "stocktake_conflict",
                "An item disappeared while corrections were being applied. Nothing was changed.",
            )
        previous = {
            "quantity": item.quantity,
            "room_id": str(item.room_id) if item.room_id else None,
            "location_id": (str(item.storage_location_id) if item.storage_location_id else None),
            "location_path": proposal.current_location_path,
        }
        fields: dict[str, Any] = {}
        if proposal.action in {"move", "move_and_quantity"}:
            fields["room_id"] = proposal.proposed_room_id
            fields["storage_location_id"] = proposal.proposed_location_id
        if proposal.action in {"set_quantity", "move_and_quantity"}:
            fields["quantity"] = proposal.proposed_quantity
        updated = items_service.update_item_record(
            db,
            household_id,
            item,
            ItemUpdate(**fields),
            actor_user_id=user.id,
            actor_name=user.name,
            history_context={
                "stocktake_session_id": str(session.id),
                "stocktake_observation_id": str(proposal.observation_id),
            },
        )
        quantity_event_id = None
        if proposal.action in {"set_quantity", "move_and_quantity"}:
            event = history.record_event(
                db,
                household_id,
                actor_user_id=user.id,
                actor_name=user.name,
                action=ActivityAction.STOCKTAKE_QUANTITY_CORRECTED.value,
                entity_type="item",
                entity_id=updated.id,
                item_id=updated.id,
                summary=(
                    f"Stocktake corrected {updated.name} from {previous['quantity']} "
                    f"to {updated.quantity} owned"
                ),
                details={
                    "stocktake_session_id": str(session.id),
                    "observation_id": str(proposal.observation_id),
                    "previous_quantity": previous["quantity"],
                    "new_quantity": updated.quantity,
                    "on_loan_quantity": proposal.on_loan_quantity,
                    "counted_at_home_quantity": proposal.counted_quantity,
                },
            )
            quantity_event_id = event.id
        applied = {
            "quantity": updated.quantity,
            "room_id": str(updated.room_id) if updated.room_id else None,
            "location_id": (
                str(updated.storage_location_id) if updated.storage_location_id else None
            ),
            "location_path": proposal.proposed_location_path,
        }
        db.add(
            StocktakeCorrection(
                household_id=household_id,
                session_id=session.id,
                application_id=application.id,
                observation_id=proposal.observation_id,
                item_id=updated.id,
                action=proposal.action,
                previous=previous,
                applied=applied,
                activity_event_id=quantity_event_id,
            )
        )
        applied_proposals.append(
            proposal.model_copy(
                update={
                    "current_quantity": updated.quantity,
                    "current_room_id": updated.room_id,
                    "current_location_id": updated.storage_location_id,
                    "current_location_path": proposal.proposed_location_path,
                }
            )
        )
    application.applied_count = len(applied_proposals)
    _refresh_progress(db, session)
    message = (
        f"Applied {len(applied_proposals)} reviewed correction"
        + ("s" if len(applied_proposals) != 1 else "")
        + "."
    )
    application.result = _json_safe(
        {
            "session": _session_out(session).model_dump(mode="json"),
            "proposals": [proposal.model_dump(mode="json") for proposal in applied_proposals],
            "message": message,
        }
    )
    db.commit()
    db.refresh(application)
    return _application_result(application)


def _completion_coverage(
    db: Session,
    session: StocktakeSession,
    latest: dict[uuid.UUID, StocktakeObservation],
    unexpected: list[StocktakeObservation],
    snapshots: dict[uuid.UUID, StocktakeSnapshotItem],
) -> dict[str, Any]:
    progress = _progress(session, latest, unexpected)
    missing_units = sum(
        snapshots[snapshot_id].at_home_quantity
        for snapshot_id, observation in latest.items()
        if observation.status == StocktakeObservationStatus.MISSING.value
        and snapshot_id in snapshots
    )
    applied_corrections = int(
        db.scalar(
            select(func.count(StocktakeCorrection.id)).where(
                StocktakeCorrection.session_id == session.id
            )
        )
        or 0
    )
    expected_items = session.expected_item_count
    checked_items = progress["checked"]
    unchecked = max(0, expected_items - checked_items)
    partial = checked_items < expected_items or progress["unknown"] > 0
    return {
        "partial": partial,
        "expected_items": expected_items,
        "checked_items": checked_items,
        "unchecked_items": unchecked,
        "unknown_items": progress["unknown"],
        "verified_items": progress["verified"],
        "missing_items": progress["missing"],
        "quantity_discrepancy_items": progress["quantity"],
        "unexpected_findings": progress["unexpected"],
        "expected_units": session.expected_unit_count,
        "expected_at_home_units": session.expected_at_home_unit_count,
        "checked_at_home_units": progress["checked_units"],
        "expected_on_loan_units": session.expected_on_loan_unit_count,
        "missing_units": missing_units,
        "applied_corrections": applied_corrections,
        "scope": session.scope,
        "scope_label": session.scope_label,
        "note": (
            "Partial stocktake. Only the checked items and units are verified; "
            "unchecked items were not marked present."
            if partial
            else "All expected items were explicitly checked in this stocktake."
        ),
    }


def _ensure_close_request_available(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    request_id: uuid.UUID,
) -> None:
    conflict = db.scalar(
        select(StocktakeSession.id).where(
            StocktakeSession.household_id == household_id,
            StocktakeSession.close_request_id == request_id,
            StocktakeSession.id != session_id,
        )
    )
    if conflict is not None:
        raise ApiError(
            409,
            "stocktake_request_conflict",
            "This request id was already used to close another stocktake.",
        )


def complete_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    user: User,
    payload: StocktakeCompleteIn,
) -> StocktakeSessionOut:
    session = get_session(db, household_id, session_id, for_update=True)
    if session.status == StocktakeStatus.COMPLETED.value:
        if session.close_request_id == payload.request_id:
            return _session_out(session)
        raise ApiError(409, "stocktake_closed", "This stocktake is already completed.")
    if session.status == StocktakeStatus.ABANDONED.value:
        raise ApiError(409, "stocktake_closed", "This stocktake was abandoned.")
    _ensure_close_request_available(db, household_id, session.id, payload.request_id)
    snapshots = {
        row.id: row
        for row in db.scalars(
            select(StocktakeSnapshotItem).where(StocktakeSnapshotItem.session_id == session.id)
        ).all()
    }
    latest, unexpected = _latest_observations(db, session.id)
    if not latest and not unexpected:
        raise ApiError(
            422,
            "stocktake_no_observations",
            "Record at least one observation before completing the stocktake.",
        )
    coverage = _completion_coverage(db, session, latest, unexpected, snapshots)
    if coverage["partial"] and not payload.acknowledge_partial:
        raise ApiError(
            409,
            "stocktake_partial_completion",
            f"{coverage['checked_items']} of {coverage['expected_items']} expected items "
            "were checked. Review the coverage and explicitly confirm a partial finish, "
            "or continue the stocktake.",
        )
    item_ids = [snapshot.item_id for snapshot in snapshots.values() if snapshot.item_id is not None]
    current_items = (
        {
            item.id: item
            for item in db.scalars(
                select(Item)
                .where(Item.household_id == household_id, Item.id.in_(item_ids))
                .order_by(Item.id)
                .with_for_update()
            ).all()
        }
        if item_ids
        else {}
    )
    loan_quantities = lending.loan_quantities_for_items(db, household_id, list(current_items))
    rooms = list(
        db.scalars(
            select(Room).options(joinedload(Room.property)).where(Room.household_id == household_id)
        ).all()
    )
    locations = list(
        db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    )
    room_paths = _room_path_map(rooms)
    location_paths = _location_path_map(locations)
    completed_at = datetime.now(UTC)
    for snapshot_id, observation in latest.items():
        if observation.status not in CHECKED_STATUSES:
            continue
        snapshot = snapshots.get(snapshot_id)
        if snapshot is None or snapshot.item_id is None:
            continue
        item = current_items.get(snapshot.item_id)
        if item is None:
            continue
        observed_room_id = None
        observed_location_id = None
        observed_path = ""
        if (
            observation.status == StocktakeObservationStatus.MOVED.value
            and observation.observed_room_id in room_paths
        ):
            observed_room_id = observation.observed_room_id
            observed_location_id = (
                observation.observed_location_id
                if observation.observed_location_id in location_paths
                else None
            )
            observed_path = observation.observed_location_path or _full_path(
                observed_room_id,
                observed_location_id,
                room_paths,
                location_paths,
            )
        else:
            observed_room_id = item.room_id
            observed_location_id = item.storage_location_id
            observed_path = _full_path(
                item.room_id,
                item.storage_location_id,
                room_paths,
                location_paths,
            )
        state = db.scalar(
            select(StocktakeItemState)
            .where(
                StocktakeItemState.item_id == item.id,
                StocktakeItemState.household_id == household_id,
            )
            .with_for_update()
        )
        if state is None:
            state = StocktakeItemState(
                household_id=household_id,
                item_id=item.id,
                session_id=session.id,
                observation_id=observation.id,
                status=observation.status,
                verified_at=completed_at,
                counted_quantity=max(0, observation.counted_quantity or 0),
                owned_quantity=item.quantity,
                on_loan_quantity=loan_quantities.get(item.id, 0),
                room_id=observed_room_id,
                location_id=observed_location_id,
                location_path=observed_path,
                item_updated_at=item.updated_at,
            )
            db.add(state)
        else:
            state.session_id = session.id
            state.observation_id = observation.id
            state.status = observation.status
            state.verified_at = completed_at
            state.counted_quantity = max(0, observation.counted_quantity or 0)
            state.owned_quantity = item.quantity
            state.on_loan_quantity = loan_quantities.get(item.id, 0)
            state.room_id = observed_room_id
            state.location_id = observed_location_id
            state.location_path = observed_path
            state.item_updated_at = item.updated_at
    session.status = StocktakeStatus.COMPLETED.value
    session.close_request_id = payload.request_id
    session.completed_by_user_id = user.id
    session.completed_by_name_snapshot = user.name[:120]
    session.completed_at = completed_at
    session.coverage = coverage
    _refresh_progress(db, session)
    db.commit()
    db.refresh(session)
    return _session_out(session)


def abandon_session(
    db: Session,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    user: User,
    payload: StocktakeAbandonIn,
) -> StocktakeSessionOut:
    session = get_session(db, household_id, session_id, for_update=True)
    if session.status == StocktakeStatus.ABANDONED.value:
        if session.close_request_id == payload.request_id:
            return _session_out(session)
        raise ApiError(409, "stocktake_closed", "This stocktake was already abandoned.")
    if session.status == StocktakeStatus.COMPLETED.value:
        raise ApiError(409, "stocktake_closed", "A completed stocktake cannot be abandoned.")
    session.status = StocktakeStatus.ABANDONED.value
    session.close_request_id = payload.request_id
    session.abandoned_at = datetime.now(UTC)
    session.completed_by_user_id = user.id
    session.completed_by_name_snapshot = user.name[:120]
    db.commit()
    db.refresh(session)
    return _session_out(session)


def scope_summary(
    db: Session,
    household_id: uuid.UUID,
    *,
    room_id: uuid.UUID | None = None,
    container_id: uuid.UUID | None = None,
) -> StocktakeScopeSummaryOut:
    if (room_id is None) == (container_id is None):
        raise ApiError(
            422,
            "scope_required",
            "Choose exactly one room or container for the stocktake summary.",
        )
    if room_id is not None:
        room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(404, "room_not_found", "Room not found.")
        scope_label = f"Room: {room.name}"
        sessions = [
            session
            for session in db.scalars(
                select(StocktakeSession)
                .where(StocktakeSession.household_id == household_id)
                .order_by(StocktakeSession.updated_at.desc())
                .limit(500)
            ).all()
            if str(room_id) in (session.scope or {}).get("room_ids", [])
        ]
    else:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == container_id,
                StorageLocation.household_id == household_id,
            )
        )
        if location is None:
            raise ApiError(404, "container_not_found", "Container not found.")
        scope_label = f"Container: {location.identifier or location.name}"
        sessions = [
            session
            for session in db.scalars(
                select(StocktakeSession)
                .where(StocktakeSession.household_id == household_id)
                .order_by(StocktakeSession.updated_at.desc())
                .limit(500)
            ).all()
            if str(container_id) in (session.scope or {}).get("container_ids", [])
        ]
    active = next(
        (session for session in sessions if session.status == StocktakeStatus.IN_PROGRESS.value),
        None,
    )
    completed = next(
        (session for session in sessions if session.status == StocktakeStatus.COMPLETED.value),
        None,
    )
    return StocktakeScopeSummaryOut(
        scope_label=scope_label,
        room_id=room_id,
        container_id=container_id,
        active_session=_session_out(active) if active else None,
        last_completed_session=_session_out(completed) if completed else None,
        last_checked_at=completed.completed_at if completed else None,
    )
