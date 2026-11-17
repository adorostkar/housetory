import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import (
    AssistantActionProposal,
    Household,
    HouseholdMember,
    Item,
    Property,
    Room,
    StorageLocation,
)
from ...schemas.assistant_actions import (
    AssistantActionApplyOut,
    AssistantActionApplyRequest,
    AssistantActionProposalOut,
    AssistantActionStateOut,
    AssistantActionTarget,
    AssistantMoveDestination,
    AssistantMoveDestinationList,
    AssistantPendingActionList,
    BorrowedReturnProposalRequest,
    BorrowingProposalRequest,
    BorrowingReviewRequest,
    ItemEditChanges,
    ItemEditProposalRequest,
    ItemEditReviewRequest,
    ItemMoveProposalRequest,
    ItemMoveReviewRequest,
    LendingProposalRequest,
    LendingReviewRequest,
    LoanReturnProposalRequest,
    ReturnReviewRequest,
)
from ...schemas.borrowed import BorrowedCreate, BorrowedReturnCreate
from ...schemas.bulk import BulkMoveRequest
from ...schemas.items import ItemUpdate
from ...schemas.lending import LoanCreate, LoanReturnCreate
from ...services import borrowed, bulk, history, items, lending
from ...services.ai_tools.inventory_query import property_item_conditions
from ...services.containers import household_hierarchy_lock
from ..deps import AccountContext, AuthContext, require_account
from ..errors import ApiError

router = APIRouter(prefix="/assistant/actions", tags=["assistant-actions"])


def _writer(db: Session, account: AccountContext, household_id: uuid.UUID | None) -> AuthContext:
    if household_id is None:
        memberships = list(
            db.scalars(
                select(HouseholdMember)
                .where(HouseholdMember.user_id == account.user.id)
                .with_for_update(read=True)
                .execution_options(populate_existing=True)
            ).all()
        )
        if len(memberships) != 1:
            raise ApiError(409, "household_context_required", "Choose a household for this action.")
        membership = memberships[0]
    else:
        membership = db.scalar(
            select(HouseholdMember)
            .where(
                HouseholdMember.user_id == account.user.id,
                HouseholdMember.household_id == household_id,
            )
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
    if membership is None:
        raise ApiError(404, "household_not_found", "Household not found.")
    if membership.role not in {"owner", "member"}:
        raise ApiError(403, "read_only_role", "Viewers have read-only access to this household.")
    household = db.get(Household, membership.household_id)
    if household is None:
        raise ApiError(404, "household_not_found", "Household not found.")
    return AuthContext(
        user=account.user, household=household, role=membership.role, session=account.session
    )


def _check_property(db: Session, auth: AuthContext, property_id: uuid.UUID | None) -> None:
    if (
        property_id is not None
        and db.scalar(
            select(Property.id).where(
                Property.id == property_id,
                Property.household_id == auth.household.id,
                Property.is_archived.is_(False),
            )
        )
        is None
    ):
        raise ApiError(404, "property_not_found", "Property not found in this household.")


def _check_items_scope(
    db: Session, auth: AuthContext, property_id: uuid.UUID | None, item_ids: list[uuid.UUID]
) -> None:
    if property_id is None:
        return
    matching = db.scalars(
        select(Item.id).where(
            Item.household_id == auth.household.id,
            Item.id.in_(item_ids),
            *property_item_conditions(property_id),
        )
    ).all()
    if len(matching) != len(item_ids):
        raise ApiError(404, "item_not_found", "One or more items are outside this property.")


def _scope_label(db: Session, auth: AuthContext, property_id: uuid.UUID | None) -> str:
    if property_id is None:
        return auth.household.name
    property_record = db.get(Property, property_id)
    if property_record is None:
        raise ApiError(404, "property_not_found", "Property not found in this household.")
    return f"{auth.household.name} · {property_record.name}"


def _borrowed_place_versions(
    db: Session,
    household_id: uuid.UUID,
    payload: BorrowingProposalRequest,
    *,
    lock: bool = False,
) -> dict[str, str | None]:
    borrowed.validate_place(
        db,
        household_id,
        property_id=payload.property_id,
        room_id=payload.room_id,
        storage_location_id=payload.storage_location_id,
    )
    location = None
    if payload.storage_location_id is not None:
        query = select(StorageLocation).where(
            StorageLocation.id == payload.storage_location_id,
            StorageLocation.household_id == household_id,
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        location = db.scalar(query)
    room_id = payload.room_id or (location.room_id if location else None)
    room = None
    if room_id is not None:
        query = select(Room).where(Room.id == room_id, Room.household_id == household_id)
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        room = db.scalar(query)
    property_id = payload.property_id or (room.property_id if room else None)
    property_record = None
    if property_id is not None:
        query = select(Property).where(
            Property.id == property_id, Property.household_id == household_id
        )
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        property_record = db.scalar(query)
    return {
        "property_id": str(property_record.id) if property_record else None,
        "property_updated_at": property_record.updated_at.isoformat() if property_record else None,
        "room_id": str(room.id) if room else None,
        "room_updated_at": room.updated_at.isoformat() if room else None,
        "location_id": str(location.id) if location else None,
        "location_updated_at": location.updated_at.isoformat() if location else None,
    }


@router.post("/proposals", response_model=AssistantActionProposalOut, status_code=201)
def create_proposal(
    payload: (
        ItemEditProposalRequest
        | ItemMoveProposalRequest
        | LendingProposalRequest
        | LoanReturnProposalRequest
        | BorrowingProposalRequest
        | BorrowedReturnProposalRequest
    ),
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionProposalOut:
    return _create_proposal(payload, account, db)


def _create_proposal(
    payload: (
        ItemEditProposalRequest
        | ItemMoveProposalRequest
        | LendingProposalRequest
        | LoanReturnProposalRequest
        | BorrowingProposalRequest
        | BorrowedReturnProposalRequest
    ),
    account: AccountContext,
    db: Session,
    refreshed_from: AssistantActionProposal | None = None,
    tool_receipt_id: uuid.UUID | None = None,
) -> AssistantActionProposalOut:
    def finish(result: AssistantActionProposalOut) -> AssistantActionProposalOut:
        if tool_receipt_id is not None:
            proposal.id = tool_receipt_id
            result = result.model_copy(update={"id": tool_receipt_id})
            proposal.snapshots = {
                **proposal.snapshots,
                "tool_payload": payload.model_dump(mode="json"),
            }
        proposal.snapshots = {
            **proposal.snapshots,
            "tool_preview": result.model_dump(mode="json"),
        }
        if refreshed_from is not None:
            refreshed_from.state = "superseded"
            refreshed_from.result = result.model_dump(mode="json")
        db.commit()
        return result

    auth = _writer(db, account, payload.household_id)
    _check_property(db, auth, payload.scope_property_id)
    if tool_receipt_id is not None:
        db.execute(
            sql_text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"assistant-proposal:{tool_receipt_id}"},
        )
        prior = db.get(AssistantActionProposal, tool_receipt_id)
        if prior is not None:
            if (
                prior.actor_user_id != auth.user.id
                or prior.household_id != auth.household.id
                or prior.snapshots.get("tool_payload") != payload.model_dump(mode="json")
            ):
                raise ApiError(
                    409, "tool_receipt_reused", "This tool receipt belongs to a different proposal."
                )
            return tool_proposal_preview(db, prior)
    if isinstance(payload, BorrowedReturnProposalRequest):
        record = borrowed.get_record(db, auth.household.id, payload.record_id)
        if (
            payload.scope_property_id is not None
            and record.property_id != payload.scope_property_id
        ):
            raise ApiError(404, "borrowed_record_not_found", "Record not found in this property.")
        outstanding = record.quantity - record.returned_quantity
        if (
            record.status not in {"outstanding", "partially_returned"}
            or payload.quantity > outstanding
        ):
            raise ApiError(
                409, "return_exceeds_outstanding", f"Only {outstanding} unit(s) are outstanding."
            )
        if payload.returned_on < record.borrowed_on:
            raise ApiError(
                422, "return_before_borrowed", "The return date cannot precede the borrowed date."
            )
        changes = payload.model_dump(
            mode="json", exclude={"kind", "household_id", "scope_property_id"}
        )
        proposal = AssistantActionProposal(
            household_id=auth.household.id,
            actor_user_id=auth.user.id,
            kind=payload.kind,
            scope_property_id=payload.scope_property_id,
            changes=changes,
            snapshots={
                "record_updated_at": record.updated_at.isoformat(),
                "domain_request_id": str(uuid.uuid4()),
            },
        )
        db.add(proposal)
        db.flush()
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[
                AssistantActionTarget(
                    id=record.id, name=f"{record.item_name} · {record.owner_name}"
                )
            ],
            changes=changes,
            before={"outstanding_quantity": outstanding},
        )
        return finish(result)
    if isinstance(payload, BorrowingProposalRequest):
        place_versions = _borrowed_place_versions(db, auth.household.id, payload)
        if payload.scope_property_id is not None and place_versions["property_id"] != str(
            payload.scope_property_id
        ):
            raise ApiError(404, "property_not_found", "Choose a place in this property.")
        changes = payload.model_dump(
            mode="json", exclude={"kind", "household_id", "scope_property_id"}
        )
        proposal = AssistantActionProposal(
            household_id=auth.household.id,
            actor_user_id=auth.user.id,
            kind=payload.kind,
            scope_property_id=payload.scope_property_id,
            changes=changes,
            snapshots={"domain_request_id": str(uuid.uuid4()), "place": place_versions},
        )
        db.add(proposal)
        db.flush()
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[],
            changes=changes,
        )
        return finish(result)
    if isinstance(payload, LoanReturnProposalRequest):
        loan = lending.get_loan(db, auth.household.id, payload.loan_id)
        if loan.item_id is None:
            raise ApiError(409, "item_missing", "The item for this loan no longer exists.")
        item = items.get_item(db, auth.household.id, loan.item_id)
        _check_items_scope(db, auth, payload.scope_property_id, [item.id])
        outstanding = loan.quantity - loan.returned_quantity
        if (
            loan.status not in {"outstanding", "partially_returned"}
            or payload.quantity > outstanding
        ):
            raise ApiError(
                409, "return_exceeds_outstanding", f"Only {outstanding} unit(s) are outstanding."
            )
        if payload.returned_on < loan.lent_on:
            raise ApiError(
                422, "return_before_lent", "The return date cannot precede the lent date."
            )
        changes = payload.model_dump(
            mode="json", exclude={"kind", "household_id", "scope_property_id"}
        )
        proposal = AssistantActionProposal(
            household_id=auth.household.id,
            actor_user_id=auth.user.id,
            kind=payload.kind,
            scope_property_id=payload.scope_property_id,
            item_id=item.id,
            item_updated_at=item.updated_at,
            changes=changes,
            snapshots={
                "loan_updated_at": loan.updated_at.isoformat(),
                "domain_request_id": str(uuid.uuid4()),
            },
        )
        db.add(proposal)
        db.flush()
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[
                AssistantActionTarget(
                    id=loan.id, name=f"{loan.item_name_snapshot} · {loan.borrower_name}"
                )
            ],
            changes=changes,
            before={"outstanding_quantity": outstanding},
        )
        return finish(result)
    if isinstance(payload, LendingProposalRequest):
        item = items.get_item(db, auth.household.id, payload.item_id)
        _check_items_scope(db, auth, payload.scope_property_id, [item.id])
        if item.is_archived:
            raise ApiError(409, "item_archived", "Archived items cannot be lent.")
        available = item.quantity - lending.outstanding_quantity(db, auth.household.id, item.id)
        if payload.quantity > available:
            raise ApiError(
                409, "insufficient_available_stock", f"Only {available} unit(s) are available."
            )
        changes = payload.model_dump(
            mode="json", exclude={"kind", "household_id", "scope_property_id"}
        )
        proposal = AssistantActionProposal(
            household_id=auth.household.id,
            actor_user_id=auth.user.id,
            kind=payload.kind,
            scope_property_id=payload.scope_property_id,
            item_id=item.id,
            item_updated_at=item.updated_at,
            changes=changes,
            snapshots={
                "target_name": item.name,
                "domain_request_id": str(uuid.uuid4()),
                "available_quantity": available,
            },
        )
        db.add(proposal)
        db.flush()
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[AssistantActionTarget(id=item.id, name=item.name)],
            changes=changes,
            before={"available_quantity": available},
        )
        return finish(result)
    if isinstance(payload, ItemMoveProposalRequest):
        _check_items_scope(db, auth, payload.scope_property_id, payload.item_ids)
        selected = list(
            db.scalars(
                select(Item)
                .where(Item.household_id == auth.household.id, Item.id.in_(payload.item_ids))
                .order_by(Item.id)
            ).all()
        )
        if len(selected) != len(payload.item_ids):
            raise ApiError(
                404, "bulk_items_unavailable", "One or more selected items are unavailable."
            )
        if any(item.is_archived for item in selected):
            raise ApiError(409, "bulk_items_archived", "Archived items cannot be moved.")
        room = items.room(db, auth.household.id, payload.room_id)
        if payload.scope_property_id is not None and room.property_id != payload.scope_property_id:
            raise ApiError(404, "room_not_found", "Destination is outside this property.")
        _, location = items.resolve_location(
            db, auth.household.id, payload.room_id, payload.storage_location_id
        )
        changes = payload.model_dump(
            mode="json", exclude={"kind", "household_id", "scope_property_id"}
        )
        snapshots = {
            "items": {str(item.id): item.updated_at.isoformat() for item in selected},
            "room_updated_at": room.updated_at.isoformat(),
            "location_updated_at": location.updated_at.isoformat() if location else None,
        }
        proposal = AssistantActionProposal(
            household_id=auth.household.id,
            actor_user_id=auth.user.id,
            kind=payload.kind,
            scope_property_id=payload.scope_property_id,
            changes=changes,
            snapshots=snapshots,
        )
        db.add(proposal)
        db.flush()
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[AssistantActionTarget(id=item.id, name=item.name) for item in selected],
            changes=changes,
            destination=AssistantActionTarget(
                id=location.id if location else room.id,
                name=f"{room.name} / {location.name}" if location else room.name,
            ),
        )
        return finish(result)
    item = items.get_item(db, auth.household.id, payload.item_id)
    _check_items_scope(db, auth, payload.scope_property_id, [item.id])
    if item.is_archived:
        raise ApiError(409, "item_archived", "Archived items cannot be edited.")
    changes = payload.changes.model_dump(mode="json", exclude_unset=True)
    if not changes:
        raise ApiError(422, "empty_proposal", "Choose at least one change.")
    before = {field: getattr(item, field) for field in ItemEditChanges.model_fields}
    proposal = AssistantActionProposal(
        household_id=auth.household.id,
        actor_user_id=auth.user.id,
        kind=payload.kind,
        scope_property_id=payload.scope_property_id,
        item_id=item.id,
        item_updated_at=item.updated_at,
        changes=changes,
        snapshots={"before": before},
    )
    db.add(proposal)
    db.flush()
    result = AssistantActionProposalOut(
        id=proposal.id,
        scope_label=_scope_label(db, auth, proposal.scope_property_id),
        kind=proposal.kind,
        state=proposal.state,
        targets=[AssistantActionTarget(id=item.id, name=item.name)],
        changes=changes,
        before=before,
    )
    return finish(result)


def tool_proposal_preview(
    db: Session, proposal: AssistantActionProposal
) -> AssistantActionProposalOut:
    for _ in range(32):
        if proposal.state != "superseded" or not (proposal.result or {}).get("id"):
            break
        successor = db.get(AssistantActionProposal, uuid.UUID(proposal.result["id"]))
        if successor is None or (
            successor.actor_user_id != proposal.actor_user_id
            or successor.household_id != proposal.household_id
        ):
            raise ApiError(409, "proposal_stale", "The refreshed proposal is unavailable.")
        proposal = successor
    else:
        raise ApiError(
            409, "proposal_stale", "This proposal has too many revisions. Prepare it again."
        )
    preview = AssistantActionProposalOut.model_validate(proposal.snapshots["tool_preview"])
    destination = preview.destination
    if proposal.kind == "move_items":
        room = items.room(db, proposal.household_id, uuid.UUID(proposal.changes["room_id"]))
        location_id = proposal.changes.get("storage_location_id")
        _, location = items.resolve_location(
            db,
            proposal.household_id,
            room.id,
            uuid.UUID(location_id) if location_id else None,
        )
        destination = AssistantActionTarget(
            id=location.id if location else room.id,
            name=f"{room.name} / {location.name}" if location else room.name,
        )
    return preview.model_copy(
        update={
            "state": proposal.state,
            "changes": proposal.changes,
            "destination": destination,
        }
    )


@router.patch("/proposals/{proposal_id}", response_model=AssistantActionProposalOut)
def edit_proposal(
    proposal_id: uuid.UUID,
    payload: (
        ItemEditReviewRequest
        | ItemMoveReviewRequest
        | LendingReviewRequest
        | BorrowingReviewRequest
        | ReturnReviewRequest
    ),
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionProposalOut:
    proposal = db.scalar(
        select(AssistantActionProposal)
        .where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
        .with_for_update()
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    auth = _writer(db, account, proposal.household_id)
    _check_property(db, auth, proposal.scope_property_id)
    if proposal.state != "ready":
        raise ApiError(409, "proposal_not_editable", "This proposal cannot be edited.")
    if proposal.scope_property_id is not None:
        household_hierarchy_lock(db, auth.household.id)
    if proposal.kind in {"return_loan", "return_borrowed"} and isinstance(
        payload, ReturnReviewRequest
    ):
        if proposal.kind == "return_loan":
            item = db.scalar(
                select(Item)
                .where(Item.household_id == auth.household.id, Item.id == proposal.item_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if item is None or item.is_archived or item.updated_at != proposal.item_updated_at:
                raise ApiError(409, "proposal_stale", "The item changed. Refresh the proposal.")
            _check_items_scope(db, auth, proposal.scope_property_id, [item.id])
            record = lending.get_loan(
                db, auth.household.id, uuid.UUID(proposal.changes["loan_id"]), for_update=True
            )
            if record.updated_at.isoformat() != proposal.snapshots["loan_updated_at"]:
                raise ApiError(409, "proposal_stale", "The loan changed. Refresh the proposal.")
            name, start = f"{record.item_name_snapshot} · {record.borrower_name}", record.lent_on
        else:
            record = borrowed.get_record(
                db, auth.household.id, uuid.UUID(proposal.changes["record_id"]), for_update=True
            )
            if (
                proposal.scope_property_id is not None
                and record.property_id != proposal.scope_property_id
            ):
                raise ApiError(409, "proposal_stale", "The record left this property.")
            if record.updated_at.isoformat() != proposal.snapshots["record_updated_at"]:
                raise ApiError(409, "proposal_stale", "The record changed. Refresh the proposal.")
            name, start = f"{record.item_name} · {record.owner_name}", record.borrowed_on
        outstanding = record.quantity - record.returned_quantity
        if (
            record.status not in {"outstanding", "partially_returned"}
            or payload.quantity > outstanding
        ):
            raise ApiError(
                409, "return_exceeds_outstanding", f"Only {outstanding} unit(s) are outstanding."
            )
        if payload.returned_on < start:
            raise ApiError(422, "invalid_return_date", "The return date cannot precede the loan.")
        proposal.changes = {**proposal.changes, **payload.model_dump(mode="json")}
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[AssistantActionTarget(id=record.id, name=name)],
            changes=proposal.changes,
            before={"outstanding_quantity": outstanding},
        )
        db.commit()
        return result
    if proposal.kind == "borrow" and isinstance(payload, BorrowingReviewRequest):
        household_hierarchy_lock(db, auth.household.id)
        request = BorrowingProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
        if (
            _borrowed_place_versions(db, auth.household.id, request, lock=True)
            != proposal.snapshots["place"]
        ):
            raise ApiError(409, "proposal_stale", "The place changed. Refresh the proposal.")
        proposal.changes = {**proposal.changes, **payload.model_dump(mode="json")}
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[],
            changes=proposal.changes,
        )
        db.commit()
        return result
    if proposal.kind == "lend" and isinstance(payload, LendingReviewRequest):
        item = db.scalar(
            select(Item)
            .where(Item.household_id == auth.household.id, Item.id == proposal.item_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if item is None or item.is_archived or item.updated_at != proposal.item_updated_at:
            raise ApiError(409, "proposal_stale", "The item changed. Refresh the proposal.")
        _check_items_scope(db, auth, proposal.scope_property_id, [item.id])
        available = item.quantity - lending.outstanding_quantity(db, auth.household.id, item.id)
        if available != proposal.snapshots["available_quantity"]:
            raise ApiError(409, "proposal_stale", "Availability changed. Refresh the proposal.")
        if payload.quantity > available:
            raise ApiError(
                409, "insufficient_available_stock", f"Only {available} unit(s) are available."
            )
        proposal.changes = {**proposal.changes, **payload.model_dump(mode="json")}
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[AssistantActionTarget(id=item.id, name=item.name)],
            changes=proposal.changes,
            before={"available_quantity": available},
        )
        db.commit()
        return result
    if proposal.kind == "move_items" and isinstance(payload, ItemMoveReviewRequest):
        household_hierarchy_lock(db, auth.household.id)
        move = ItemMoveProposalRequest.model_validate({"kind": proposal.kind, **proposal.changes})
        selected = list(
            db.scalars(
                select(Item)
                .where(Item.household_id == auth.household.id, Item.id.in_(move.item_ids))
                .order_by(Item.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).all()
        )
        expected = proposal.snapshots["items"]
        if len(selected) != len(move.item_ids) or any(
            item.is_archived or expected.get(str(item.id)) != item.updated_at.isoformat()
            for item in selected
        ):
            raise ApiError(
                409, "proposal_stale", "The selected items changed. Refresh the proposal."
            )
        _check_items_scope(db, auth, proposal.scope_property_id, move.item_ids)
        room = items.room(db, auth.household.id, payload.room_id)
        if (
            proposal.scope_property_id is not None
            and room.property_id != proposal.scope_property_id
        ):
            raise ApiError(404, "room_not_found", "Destination is outside this property.")
        _, location = items.resolve_location(
            db, auth.household.id, payload.room_id, payload.storage_location_id
        )
        proposal.changes = {
            **proposal.changes,
            "room_id": str(room.id),
            "storage_location_id": str(location.id) if location else None,
        }
        proposal.snapshots = {
            **proposal.snapshots,
            "room_updated_at": room.updated_at.isoformat(),
            "location_updated_at": location.updated_at.isoformat() if location else None,
        }
        result = AssistantActionProposalOut(
            id=proposal.id,
            scope_label=_scope_label(db, auth, proposal.scope_property_id),
            kind=proposal.kind,
            state=proposal.state,
            targets=[AssistantActionTarget(id=item.id, name=item.name) for item in selected],
            changes=proposal.changes,
            destination=AssistantActionTarget(
                id=location.id if location else room.id,
                name=f"{room.name} / {location.name}" if location else room.name,
            ),
        )
        db.commit()
        return result
    if proposal.kind != "edit_item" or not isinstance(payload, ItemEditReviewRequest):
        raise ApiError(409, "proposal_not_editable", "This proposal cannot be edited that way.")
    before = proposal.snapshots["before"]
    proposal.changes = payload.changes.model_dump(mode="json", exclude_unset=True)
    result = AssistantActionProposalOut(
        id=proposal.id,
        scope_label=_scope_label(db, auth, proposal.scope_property_id),
        kind=proposal.kind,
        state=proposal.state,
        targets=[AssistantActionTarget(id=proposal.item_id, name=before["name"])],
        changes=proposal.changes,
        before=before,
    )
    db.commit()
    return result


@router.get("/proposals/{proposal_id}/destinations", response_model=AssistantMoveDestinationList)
def proposal_destinations(
    proposal_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantMoveDestinationList:
    proposal = db.scalar(
        select(AssistantActionProposal).where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    auth = _writer(db, account, proposal.household_id)
    _check_property(db, auth, proposal.scope_property_id)
    if proposal.state != "ready" or proposal.kind != "move_items":
        raise ApiError(409, "proposal_not_editable", "This proposal cannot be edited.")
    room_query = select(Room).where(Room.household_id == auth.household.id)
    if proposal.scope_property_id is not None:
        room_query = room_query.where(Room.property_id == proposal.scope_property_id)
    rooms = list(db.scalars(room_query.order_by(Room.name, Room.id)).all())
    room_names = {room.id: room.name for room in rooms}
    locations = db.scalars(
        select(StorageLocation)
        .where(
            StorageLocation.household_id == auth.household.id,
            StorageLocation.room_id.in_(room_names),
            StorageLocation.active(),
        )
        .order_by(StorageLocation.name, StorageLocation.id)
    ).all()
    return AssistantMoveDestinationList(
        items=[
            *[
                AssistantMoveDestination(room_id=room.id, storage_location_id=None, name=room.name)
                for room in rooms
            ],
            *[
                AssistantMoveDestination(
                    room_id=location.room_id,
                    storage_location_id=location.id,
                    name=f"{room_names[location.room_id]} / {location.identifier or location.name}",
                )
                for location in locations
            ],
        ]
    )


@router.post("/proposals/{proposal_id}/apply", response_model=AssistantActionApplyOut)
def apply_proposal(
    proposal_id: uuid.UUID,
    payload: AssistantActionApplyRequest,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionApplyOut:
    proposal = db.scalar(
        select(AssistantActionProposal)
        .where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
        .with_for_update()
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    auth = _writer(db, account, proposal.household_id)
    _check_property(db, auth, proposal.scope_property_id)
    if proposal.state == "applied":
        if proposal.request_id != payload.request_id or proposal.result is None:
            raise ApiError(409, "proposal_already_applied", "This proposal was already applied.")
        return AssistantActionApplyOut.model_validate(proposal.result)
    if proposal.state != "ready":
        raise ApiError(409, "proposal_not_ready", "This proposal is no longer pending.")
    if proposal.scope_property_id is not None:
        household_hierarchy_lock(db, auth.household.id)
    if proposal.kind == "return_borrowed":
        record = borrowed.get_record(
            db, auth.household.id, uuid.UUID(proposal.changes["record_id"]), for_update=True
        )
        if (
            proposal.scope_property_id is not None
            and record.property_id != proposal.scope_property_id
        ):
            raise ApiError(
                409, "proposal_stale", "The record left this property. Refresh the proposal."
            )
        if record.updated_at.isoformat() != proposal.snapshots["record_updated_at"]:
            raise ApiError(
                409, "proposal_stale", "The borrowed record changed. Refresh the proposal."
            )
        changes = {key: value for key, value in proposal.changes.items() if key != "record_id"}
        returned = borrowed.create_return(
            db,
            auth.household.id,
            record.id,
            BorrowedReturnCreate(**changes, request_id=proposal.snapshots["domain_request_id"]),
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        result = AssistantActionApplyOut(
            proposal_id=proposal.id,
            request_id=payload.request_id,
            message=f"Recorded return of {returned.item_name}.",
        )
        proposal.state = "applied"
        proposal.request_id = payload.request_id
        proposal.result = result.model_dump(mode="json")
        db.commit()
        return result
    if proposal.kind == "borrow":
        household_hierarchy_lock(db, auth.household.id)
        request = BorrowingProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
        if (
            _borrowed_place_versions(db, auth.household.id, request, lock=True)
            != proposal.snapshots["place"]
        ):
            raise ApiError(409, "proposal_stale", "The place changed. Refresh the proposal.")
        borrowed_record = borrowed.create_record(
            db,
            auth.household.id,
            BorrowedCreate(**proposal.changes, request_id=proposal.snapshots["domain_request_id"]),
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        result = AssistantActionApplyOut(
            proposal_id=proposal.id,
            request_id=payload.request_id,
            message=(
                f"Recorded borrowing {borrowed_record.item_name} from {borrowed_record.owner_name}."
            ),
        )
        proposal.state = "applied"
        proposal.request_id = payload.request_id
        proposal.result = result.model_dump(mode="json")
        db.commit()
        return result
    if proposal.kind == "move_items":
        move = ItemMoveProposalRequest.model_validate({"kind": proposal.kind, **proposal.changes})
        household_hierarchy_lock(db, auth.household.id)
        _check_items_scope(db, auth, proposal.scope_property_id, move.item_ids)
        selected = list(
            db.scalars(
                select(Item)
                .where(Item.household_id == auth.household.id, Item.id.in_(move.item_ids))
                .order_by(Item.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).all()
        )
        expected = proposal.snapshots["items"]
        if len(selected) != len(move.item_ids) or any(
            item.is_archived or expected.get(str(item.id)) != item.updated_at.isoformat()
            for item in selected
        ):
            raise ApiError(
                409, "proposal_stale", "The selected items changed. Refresh the proposal."
            )
        room = items.room(db, auth.household.id, move.room_id)
        if (
            proposal.scope_property_id is not None
            and room.property_id != proposal.scope_property_id
        ):
            raise ApiError(409, "proposal_stale", "The destination left this property.")
        _, location = items.resolve_location(
            db, auth.household.id, move.room_id, move.storage_location_id
        )
        if (
            room.updated_at.isoformat() != proposal.snapshots["room_updated_at"]
            or (location.updated_at.isoformat() if location else None)
            != proposal.snapshots["location_updated_at"]
        ):
            raise ApiError(409, "proposal_stale", "The destination changed. Refresh the proposal.")
        result = bulk.bulk_move(
            db,
            auth.household.id,
            BulkMoveRequest(**proposal.changes, request_id=payload.request_id),
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        response = AssistantActionApplyOut(
            proposal_id=proposal.id,
            request_id=payload.request_id,
            message=f"Moved {result.moved_count} item(s).",
        )
        proposal.state = "applied"
        proposal.request_id = payload.request_id
        proposal.result = response.model_dump(mode="json")
        db.commit()
        return response
    item = db.scalar(
        select(Item)
        .where(Item.id == proposal.item_id, Item.household_id == auth.household.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if item is None or item.is_archived or item.updated_at != proposal.item_updated_at:
        raise ApiError(
            409, "proposal_stale", "The item changed. Refresh the proposal before applying."
        )
    _check_items_scope(db, auth, proposal.scope_property_id, [item.id])
    if proposal.kind == "return_loan":
        loan = lending.get_loan(
            db, auth.household.id, uuid.UUID(proposal.changes["loan_id"]), for_update=True
        )
        if loan.updated_at.isoformat() != proposal.snapshots["loan_updated_at"]:
            raise ApiError(409, "proposal_stale", "The loan changed. Refresh the proposal.")
        changes = {key: value for key, value in proposal.changes.items() if key != "loan_id"}
        returned = lending.create_return(
            db,
            auth.household.id,
            loan.id,
            LoanReturnCreate(**changes, request_id=proposal.snapshots["domain_request_id"]),
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        result = AssistantActionApplyOut(
            proposal_id=proposal.id,
            request_id=payload.request_id,
            message=f"Recorded return of {returned.item_name}.",
        )
        proposal.state = "applied"
        proposal.request_id = payload.request_id
        proposal.result = result.model_dump(mode="json")
        db.commit()
        return result
    if proposal.kind == "lend":
        available = item.quantity - lending.outstanding_quantity(db, auth.household.id, item.id)
        if available != proposal.snapshots["available_quantity"]:
            raise ApiError(409, "proposal_stale", "Availability changed. Refresh the proposal.")
        loan = lending.create_loan(
            db,
            auth.household.id,
            LoanCreate(**proposal.changes, request_id=proposal.snapshots["domain_request_id"]),
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        result = AssistantActionApplyOut(
            proposal_id=proposal.id,
            request_id=payload.request_id,
            message=f"Recorded loan of {loan.item_name} to {loan.borrower_name}.",
        )
        proposal.state = "applied"
        proposal.request_id = payload.request_id
        proposal.result = result.model_dump(mode="json")
        db.commit()
        return result
    items.update_item_record(
        db,
        auth.household.id,
        item,
        ItemUpdate.model_validate(proposal.changes),
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )
    history.record_event(
        db,
        auth.household.id,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
        action="item.updated",
        entity_type="item",
        entity_id=item.id,
        item_id=item.id,
        summary=f"Updated {item.name}",
        details={"fields": list(proposal.changes)},
    )
    result = AssistantActionApplyOut(
        proposal_id=proposal.id, request_id=payload.request_id, message=f"Updated {item.name}."
    )
    proposal.state = "applied"
    proposal.request_id = payload.request_id
    proposal.result = result.model_dump(mode="json")
    db.commit()
    return result


@router.post(
    "/proposals/{proposal_id}/refresh", response_model=AssistantActionProposalOut, status_code=201
)
def refresh_proposal(
    proposal_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionProposalOut:
    proposal = db.scalar(
        select(AssistantActionProposal)
        .where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
        .with_for_update()
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    auth = _writer(db, account, proposal.household_id)
    _check_property(db, auth, proposal.scope_property_id)
    if proposal.state == "superseded" and proposal.result is not None:
        recovered = AssistantActionProposalOut.model_validate(proposal.result)
        replacement = db.scalar(
            select(AssistantActionProposal)
            .where(
                AssistantActionProposal.id == recovered.id,
                AssistantActionProposal.actor_user_id == account.user.id,
                AssistantActionProposal.household_id == proposal.household_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if (
            replacement is not None
            and replacement.state == "ready"
            and replacement.changes == recovered.changes
        ):
            return recovered
        raise ApiError(
            409,
            "proposal_changed",
            "The refreshed proposal has already changed or is no longer pending.",
        )
    if proposal.state != "ready":
        raise ApiError(409, "proposal_not_ready", "Only pending proposals can be refreshed.")
    if proposal.kind == "move_items":
        payload = ItemMoveProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
    elif proposal.kind == "lend":
        payload = LendingProposalRequest.model_validate({"kind": proposal.kind, **proposal.changes})
    elif proposal.kind == "return_loan":
        payload = LoanReturnProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
    elif proposal.kind == "borrow":
        payload = BorrowingProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
    elif proposal.kind == "return_borrowed":
        payload = BorrowedReturnProposalRequest.model_validate(
            {"kind": proposal.kind, **proposal.changes}
        )
    else:
        payload = ItemEditProposalRequest.model_validate(
            {"kind": proposal.kind, "item_id": proposal.item_id, "changes": proposal.changes}
        )
    payload.household_id = proposal.household_id
    payload.scope_property_id = proposal.scope_property_id
    return _create_proposal(payload, account, db, refreshed_from=proposal)


@router.post("/proposals/{proposal_id}/cancel", response_model=AssistantActionStateOut)
def cancel_proposal(
    proposal_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionStateOut:
    proposal = db.scalar(
        select(AssistantActionProposal)
        .where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
        .with_for_update()
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    _writer(db, account, proposal.household_id)
    if proposal.state == "applied":
        raise ApiError(
            409, "proposal_already_applied", "Cancellation cannot undo an applied action."
        )
    proposal.state = "cancelled"
    result = AssistantActionStateOut(id=proposal.id, state=proposal.state)
    db.commit()
    return result


def _pending_entry(db: Session, proposal: AssistantActionProposal) -> AssistantActionProposalOut:
    try:
        return tool_proposal_preview(db, proposal)
    except (ApiError, KeyError, ValidationError):
        # Still outstanding: it cannot be shown or applied as prepared, so the user
        # is told to cancel it instead of it silently dropping out of the count.
        return AssistantActionProposalOut(
            id=proposal.id,
            kind=proposal.kind,
            state="stale",
            scope_label="",
            targets=[],
            changes=proposal.changes or {},
        )


@router.get("/proposals/pending", response_model=AssistantPendingActionList)
def pending_proposals(
    household_id: uuid.UUID,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantPendingActionList:
    """Every prepared action still waiting for this user's Apply or Cancel.

    Applied, cancelled and superseded proposals are resolved and never listed.
    Nothing expires by age; `total` is the exact count across all pages.
    """
    role = db.scalar(
        select(HouseholdMember.role).where(
            HouseholdMember.user_id == account.user.id,
            HouseholdMember.household_id == household_id,
        )
    )
    if role is None:
        raise ApiError(404, "household_not_found", "Household not found.")
    if role not in {"owner", "member"}:
        # Without write access nothing here can be applied by this user.
        return AssistantPendingActionList(items=[], total=0, limit=limit, offset=offset)
    outstanding = (
        AssistantActionProposal.actor_user_id == account.user.id,
        AssistantActionProposal.household_id == household_id,
        AssistantActionProposal.state == "ready",
    )
    total = db.scalar(select(func.count()).select_from(AssistantActionProposal).where(*outstanding))
    rows = db.scalars(
        select(AssistantActionProposal)
        .where(*outstanding)
        .order_by(AssistantActionProposal.created_at.desc(), AssistantActionProposal.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return AssistantPendingActionList(
        items=[_pending_entry(db, row) for row in rows],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


@router.get("/proposals/{proposal_id}", response_model=AssistantActionProposalOut)
def read_proposal(
    proposal_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AssistantActionProposalOut:
    """One of the user's own proposals in its current state, for reopening its review."""
    proposal = db.scalar(
        select(AssistantActionProposal).where(
            AssistantActionProposal.id == proposal_id,
            AssistantActionProposal.actor_user_id == account.user.id,
        )
    )
    if proposal is None:
        raise ApiError(404, "proposal_not_found", "Proposal not found.")
    auth = _writer(db, account, proposal.household_id)
    _check_property(db, auth, proposal.scope_property_id)
    return _pending_entry(db, proposal)
