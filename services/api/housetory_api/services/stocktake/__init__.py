"""Bounded stocktakes, field observations and reviewed last-verified state.

The central rule is that an observation is evidence, not an inventory edit.
Moves and quantity corrections are proposed in a review and only applied by a
separate, explicit request. Completion records exact coverage; it never turns
unchecked items into verified ones.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ...api.errors import ApiError
from ...config import get_settings
from ...domain import StocktakeObservationStatus, StocktakeStatus
from ...models import (
    Item,
    Room,
    StocktakeCorrection,
    StocktakeItemState,
    StocktakeObservation,
    StocktakeSession,
    StocktakeSnapshotItem,
    StorageLocation,
    User,
)
from ...schemas.stocktake import (
    StocktakeAbandonIn,
    StocktakeCompleteIn,
    StocktakeCurrentItemOut,
    StocktakeItemOut,
    StocktakeScopeSummaryOut,
    StocktakeSessionDetail,
    StocktakeSessionList,
    StocktakeSessionOut,
    StocktakeStartIn,
)
from .. import lending
from ..serializers import item_load_options, photo_url
from .observations import create_observation as create_observation
from .progress import (
    CHECKED_STATUSES,
    _latest_observations,
    _observation_out,
    _progress,
    _refresh_progress,
    _session_out,
    get_session,
)
from .review import apply_session as apply_session
from .review import review_session as review_session
from .snapshot import (
    _add_snapshot_rows,
    _full_path,
    _location_path_map,
    _room_path_map,
    _scope_payload,
    _scope_snapshot_rows,
    _snapshot_fingerprint,
    _snapshot_rows_from_db,
    _update_expected_counts,
)


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
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
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
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
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
                StorageLocation.active(),
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
