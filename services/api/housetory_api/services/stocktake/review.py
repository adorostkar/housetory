"""Reviewing and applying stocktake corrections."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...domain import ActivityAction, StocktakeObservationStatus, StocktakeStatus
from ...models import (
    Item,
    Room,
    StocktakeApplication,
    StocktakeCorrection,
    StocktakeSession,
    StocktakeSnapshotItem,
    StorageLocation,
    User,
)
from ...schemas.stocktake import (
    StocktakeApplyIn,
    StocktakeApplyOut,
    StocktakeProposalOut,
    StocktakeReviewOut,
    StocktakeSessionOut,
)
from .. import history, lending
from ..serializers import item_load_options
from .progress import _latest_observations, _refresh_progress, _session_out, get_session
from .snapshot import _full_path, _hash, _json_safe, _location_path_map, _room_path_map

APPLY_STATUSES = {
    StocktakeObservationStatus.MOVED.value,
    StocktakeObservationStatus.QUANTITY_DISCREPANCY.value,
}


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
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
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
    from ...schemas.items import ItemUpdate
    from .. import items as items_service

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
