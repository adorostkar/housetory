"""Stocktake session loading, serialisation and progress counters."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...domain import StocktakeObservationStatus, StocktakeStatus
from ...models import (
    StocktakeObservation,
    StocktakeSession,
)
from ...schemas.stocktake import (
    StocktakeObservationOut,
    StocktakeSessionOut,
)

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
