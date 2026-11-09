"""Recording stocktake observations."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...domain import StocktakeObservationStatus, StocktakeStatus
from ...models import (
    Item,
    Room,
    StocktakeObservation,
    StocktakeSnapshotItem,
    StorageLocation,
    User,
)
from ...schemas.stocktake import (
    StocktakeObservationIn,
)
from .. import lending
from .progress import _refresh_progress, get_session
from .snapshot import _full_path, _hash, _location_path_map, _room_path_map, _trim


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
                StorageLocation.active(),
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
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
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
