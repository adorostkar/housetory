"""Partial lending, returns and owned/at-home/on-loan quantity rules."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import ActivityAction, LoanStatus
from ..models import BorrowedRecord, Item, Loan, LoanReturn, User
from ..schemas.lending import (
    ItemLoanSummaryOut,
    LoanContentsExcludedOut,
    LoanContentsItemOut,
    LoanCorrect,
    LoanCreate,
    LoanDetailOut,
    LoanListOut,
    LoanOptionsOut,
    LoanOut,
    LoanReturnCreate,
    LoanReturnOut,
)
from . import history, loan_people
from .loan_status import OPEN_STATUSES, status_for


def lock_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    item = db.scalar(
        select(Item).where(Item.id == item_id, Item.household_id == household_id).with_for_update()
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    return item


def get_loan(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Loan:
    query = select(Loan).where(Loan.id == loan_id, Loan.household_id == household_id)
    if for_update:
        query = query.with_for_update().execution_options(populate_existing=True)
    loan = db.scalar(query)
    if loan is None:
        raise ApiError(404, "loan_not_found", "Loan not found.")
    return loan


def outstanding_quantity(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> int:
    return int(
        db.scalar(
            select(
                func.coalesce(
                    func.sum(Loan.quantity - Loan.returned_quantity),
                    0,
                )
            ).where(
                Loan.household_id == household_id,
                Loan.item_id == item_id,
                Loan.status.in_(OPEN_STATUSES),
            )
        )
        or 0
    )


def loan_quantities_for_items(
    db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    if not item_ids:
        return {}
    rows = db.execute(
        select(
            Loan.item_id,
            func.coalesce(func.sum(Loan.quantity - Loan.returned_quantity), 0),
        )
        .where(
            Loan.household_id == household_id,
            Loan.item_id.in_(item_ids),
            Loan.status.in_(OPEN_STATUSES),
        )
        .group_by(Loan.item_id)
    ).all()
    return {row[0]: int(row[1]) for row in rows if row[0] is not None}


def loan_overview_for_items(
    db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[str, Any]]:
    """Borrower names and the earliest recorded due date for result cards.

    This is deliberately limited to open loans in the current household. Due
    dates are recorded facts, not promises that the item will return on time.
    """
    if not item_ids:
        return {}
    loans = db.scalars(
        select(Loan)
        .where(
            Loan.household_id == household_id,
            Loan.item_id.in_(item_ids),
            Loan.status.in_(OPEN_STATUSES),
        )
        .order_by(Loan.due_on.asc().nullslast(), Loan.created_at.asc())
    ).all()
    overview: dict[uuid.UUID, dict[str, Any]] = {}
    for loan in loans:
        if loan.item_id is None:
            continue
        entry = overview.setdefault(
            loan.item_id,
            {
                "on_loan_quantity": 0,
                "borrower_names": [],
                "next_due_on": None,
            },
        )
        entry["on_loan_quantity"] += max(0, loan.quantity - loan.returned_quantity)
        if loan.borrower_name not in entry["borrower_names"]:
            entry["borrower_names"].append(loan.borrower_name)
        if entry["next_due_on"] is None and loan.due_on is not None:
            entry["next_due_on"] = loan.due_on
    return overview


def ensure_quantity_allowed(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    *,
    new_quantity: int | None = None,
    new_archived: bool | None = None,
) -> None:
    outstanding = outstanding_quantity(db, household_id, item.id)
    if new_quantity is not None and new_quantity < outstanding:
        raise ApiError(
            409,
            "quantity_below_loans",
            f"{outstanding} unit(s) are currently on loan. Record returns or correct "
            "the loans before reducing the owned quantity below that number.",
        )
    if new_archived is True and outstanding > 0:
        raise ApiError(
            409,
            "item_has_open_loans",
            f"{outstanding} unit(s) are currently on loan. Record returns before archiving.",
        )


def ensure_item_deletable(db: Session, household_id: uuid.UUID, item: Item) -> None:
    outstanding = outstanding_quantity(db, household_id, item.id)
    if outstanding > 0:
        raise ApiError(
            409,
            "item_has_open_loans",
            f"{outstanding} unit(s) are currently on loan. Record returns before deleting.",
        )


def _loan_event_details(loan: Loan) -> dict[str, Any]:
    return {
        "borrower_name": loan.borrower_name,
        "quantity": loan.quantity,
        "returned_quantity": loan.returned_quantity,
        "outstanding_quantity": max(0, loan.quantity - loan.returned_quantity),
        "parent_loan_id": str(loan.parent_loan_id) if loan.parent_loan_id else None,
        "includes_contents": loan.includes_contents,
        "lent_on": loan.lent_on.isoformat(),
        "due_on": loan.due_on.isoformat() if loan.due_on else None,
        "item_name": loan.item_name_snapshot,
        "home_room_name": loan.home_room_name_snapshot,
        "home_location_name": loan.home_location_name_snapshot,
        "home_location_identifier": loan.home_location_identifier_snapshot,
    }


def _loan_maps(
    db: Session, household_id: uuid.UUID, loans: list[Loan]
) -> tuple[dict[uuid.UUID, str], dict[uuid.UUID, str], dict[uuid.UUID, date]]:
    user_ids = {loan.created_by_user_id for loan in loans if loan.created_by_user_id}
    item_ids = {loan.item_id for loan in loans if loan.item_id}
    loan_ids = [loan.id for loan in loans]
    users = (
        dict(
            db.execute(
                select(User.id, User.name).where(
                    User.id.in_(user_ids)  # type: ignore[arg-type]
                )
            ).all()
        )
        if user_ids
        else {}
    )
    item_names = (
        dict(
            db.execute(
                select(Item.id, Item.name).where(
                    Item.household_id == household_id,
                    Item.id.in_(item_ids),  # type: ignore[arg-type]
                )
            ).all()
        )
        if item_ids
        else {}
    )
    latest_returns: dict[uuid.UUID, date] = {}
    if loan_ids:
        rows = db.execute(
            select(LoanReturn.loan_id, func.max(LoanReturn.returned_on))
            .where(
                LoanReturn.household_id == household_id,
                LoanReturn.loan_id.in_(loan_ids),
                LoanReturn.reversed_at.is_(None),
            )
            .group_by(LoanReturn.loan_id)
        ).all()
        latest_returns = {row[0]: row[1] for row in rows}
    return users, item_names, latest_returns


def _loan_out(
    loan: Loan,
    *,
    on_date: date,
    created_by_name: str | None,
    current_item_name: str | None,
    latest_returned_on: date | None,
) -> LoanOut:
    outstanding = (
        0
        if loan.status == LoanStatus.CANCELLED.value
        else max(0, loan.quantity - loan.returned_quantity)
    )
    overdue = bool(
        loan.status in OPEN_STATUSES and loan.due_on is not None and loan.due_on < on_date
    )
    return LoanOut(
        id=loan.id,
        item_id=loan.item_id,
        parent_loan_id=loan.parent_loan_id,
        includes_contents=loan.includes_contents,
        item_name=current_item_name or loan.item_name_snapshot,
        item_name_snapshot=loan.item_name_snapshot,
        home_room_id=loan.home_room_id,
        home_room_name_snapshot=loan.home_room_name_snapshot,
        home_location_id=loan.home_location_id,
        home_location_name_snapshot=loan.home_location_name_snapshot,
        home_location_identifier_snapshot=loan.home_location_identifier_snapshot,
        borrower_name=loan.borrower_name,
        quantity=loan.quantity,
        returned_quantity=loan.returned_quantity,
        outstanding_quantity=outstanding,
        status=loan.status,  # type: ignore[arg-type]
        lent_on=loan.lent_on,
        due_on=loan.due_on,
        notes=loan.notes,
        overdue=overdue,
        days_past_due=(on_date - loan.due_on).days if overdue and loan.due_on else None,
        latest_returned_on=latest_returned_on,
        created_by_user_id=loan.created_by_user_id,
        created_by_name=created_by_name,
        cancelled_at=loan.cancelled_at,
        created_at=loan.created_at,
        updated_at=loan.updated_at,
    )


def serialize_loans(
    db: Session,
    household_id: uuid.UUID,
    loans: list[Loan],
    *,
    on_date: date,
) -> list[LoanOut]:
    users, item_names, latest_returns = _loan_maps(db, household_id, loans)
    return [
        _loan_out(
            loan,
            on_date=on_date,
            created_by_name=users.get(loan.created_by_user_id) if loan.created_by_user_id else None,
            current_item_name=item_names.get(loan.item_id) if loan.item_id else None,
            latest_returned_on=latest_returns.get(loan.id),
        )
        for loan in loans
    ]


def _loan_conditions(
    household_id: uuid.UUID,
    *,
    status: str,
    item_id: uuid.UUID | None,
    q: str | None,
    person_names: list[str] | None = None,
) -> list[Any]:
    conditions: list[Any] = [Loan.household_id == household_id]
    if status == "open":
        conditions.append(Loan.status.in_(OPEN_STATUSES))
    elif status != "all":
        conditions.append(Loan.status == status)
    if item_id is not None:
        conditions.append(Loan.item_id == item_id)
    if person_names is not None:
        conditions.append(Loan.borrower_name.in_(person_names))
    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        matching_item_ids = select(Item.id).where(
            Item.household_id == household_id,
            Item.name.ilike(search),
        )
        conditions.append(
            or_(
                Loan.borrower_name.ilike(search),
                Loan.item_name_snapshot.ilike(search),
                Loan.item_id.in_(matching_item_ids),
            )
        )
    return conditions


def list_loans(
    db: Session,
    household_id: uuid.UUID,
    *,
    status: str = "open",
    item_id: uuid.UUID | None = None,
    q: str | None = None,
    person: str | None = None,
    overdue: bool = False,
    on_date: date | None = None,
    limit: int = 50,
    offset: int = 0,
) -> LoanListOut:
    today = on_date or date.today()
    person_names = (
        loan_people.matching_person_names(db, household_id, person)
        if (person or "").strip()
        else None
    )
    conditions = _loan_conditions(
        household_id,
        status=status,
        item_id=item_id,
        q=q,
        person_names=person_names,
    )
    if overdue:
        conditions.append(Loan.status.in_(OPEN_STATUSES))
        conditions.append(Loan.due_on.is_not(None))
        conditions.append(Loan.due_on < today)
    total = int(db.scalar(select(func.count(Loan.id)).where(*conditions)) or 0)
    loans = list(
        db.scalars(
            select(Loan)
            .where(*conditions)
            .order_by(
                Loan.due_on.asc().nullslast(),
                Loan.lent_on.desc(),
                Loan.created_at.desc(),
            )
            .limit(limit)
            .offset(offset)
        ).all()
    )
    open_conditions = [
        Loan.household_id == household_id,
        Loan.status.in_(OPEN_STATUSES),
        *([Loan.item_id == item_id] if item_id is not None else []),
    ]
    outstanding_count = int(db.scalar(select(func.count(Loan.id)).where(*open_conditions)) or 0)
    overdue_count = int(
        db.scalar(
            select(func.count(Loan.id)).where(
                *open_conditions,
                Loan.due_on.is_not(None),
                Loan.due_on < today,
            )
        )
        or 0
    )
    on_loan_quantity = int(
        db.scalar(
            select(func.coalesce(func.sum(Loan.quantity - Loan.returned_quantity), 0)).where(
                *open_conditions
            )
        )
        or 0
    )
    return LoanListOut(
        items=serialize_loans(db, household_id, loans, on_date=today),
        total=total,
        limit=limit,
        offset=offset,
        outstanding_count=outstanding_count,
        overdue_count=overdue_count,
        on_loan_quantity=on_loan_quantity,
    )


def item_loan_summary(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    on_date: date | None = None,
) -> ItemLoanSummaryOut:
    today = on_date or date.today()
    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == household_id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    loans = list(
        db.scalars(
            select(Loan)
            .where(
                Loan.household_id == household_id,
                Loan.item_id == item_id,
                Loan.status.in_(OPEN_STATUSES),
            )
            .order_by(Loan.due_on.asc().nullslast(), Loan.created_at.asc())
        ).all()
    )
    on_loan = sum(max(0, loan.quantity - loan.returned_quantity) for loan in loans)
    overdue_count = sum(1 for loan in loans if loan.due_on is not None and loan.due_on < today)
    return ItemLoanSummaryOut(
        item_id=item.id,
        item_name=item.name,
        owned_quantity=item.quantity,
        on_loan_quantity=on_loan,
        available_quantity=max(0, item.quantity - on_loan),
        outstanding_loan_count=len(loans),
        overdue_count=overdue_count,
        loans=serialize_loans(db, household_id, loans, on_date=today),
    )


def loan_options(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    on_date: date | None = None,
) -> LoanOptionsOut:
    """Preview parent-only versus contents-included lending."""
    from . import storage_items
    from .containers import location_rows
    from .hierarchy import descendant_ids

    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == household_id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    on_loan = outstanding_quantity(db, household_id, item.id)
    available = max(0, item.quantity - on_loan)
    location = storage_items.active_owned_location(db, household_id, item.id)
    if location is None:
        return LoanOptionsOut(
            item_id=item.id,
            item_name=item.name,
            owned_quantity=item.quantity,
            on_loan_quantity=on_loan,
            available_quantity=available,
        )
    rows = location_rows(db, household_id)
    subtree_ids = list(descendant_ids(rows, location.id))
    children = list(
        db.scalars(
            select(Item)
            .where(
                Item.household_id == household_id,
                Item.storage_location_id.in_(subtree_ids),
                Item.id != item.id,
            )
            .order_by(func.lower(Item.name))
        ).all()
    )
    loan_quantities = loan_quantities_for_items(db, household_id, [child.id for child in children])
    contents_items: list[LoanContentsItemOut] = []
    excluded: list[LoanContentsExcludedOut] = []
    for child in children:
        child_on_loan = loan_quantities.get(child.id, 0)
        child_available = max(0, child.quantity - child_on_loan) if not child.is_archived else 0
        if child.is_archived:
            excluded.append(
                LoanContentsExcludedOut(
                    item_name=child.name,
                    reason="Archived; restore it before lending.",
                    quantity=child.quantity,
                )
            )
        elif child_available <= 0:
            excluded.append(
                LoanContentsExcludedOut(
                    item_name=child.name,
                    reason="Already fully on loan.",
                    quantity=child.quantity,
                )
            )
        else:
            contents_items.append(
                LoanContentsItemOut(
                    item_id=child.id,
                    item_name=child.name,
                    owned_quantity=child.quantity,
                    on_loan_quantity=child_on_loan,
                    available_quantity=child_available,
                )
            )
    borrowed = list(
        db.scalars(
            select(BorrowedRecord)
            .where(
                BorrowedRecord.household_id == household_id,
                BorrowedRecord.status.in_(OPEN_STATUSES),
                BorrowedRecord.storage_location_id.in_(subtree_ids),
            )
            .order_by(func.lower(BorrowedRecord.item_name))
        ).all()
    )
    for record in borrowed:
        outstanding = max(0, record.quantity - record.returned_quantity)
        if outstanding <= 0:
            continue
        excluded.append(
            LoanContentsExcludedOut(
                item_name=record.item_name,
                reason="Borrowed from another owner; it is not household stock.",
                quantity=outstanding,
                owner_name=record.owner_name,
            )
        )
    return LoanOptionsOut(
        item_id=item.id,
        item_name=item.name,
        owned_quantity=item.quantity,
        on_loan_quantity=on_loan,
        available_quantity=available,
        has_contents=bool(contents_items or excluded),
        storage_location_id=location.id,
        storage_identifier=location.identifier,
        contents_available_quantity=sum(entry.available_quantity for entry in contents_items),
        contents_items=contents_items,
        excluded_items=excluded,
    )


def loan_detail(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    *,
    on_date: date | None = None,
) -> LoanDetailOut:
    today = on_date or date.today()
    loan = get_loan(db, household_id, loan_id)
    [loan_out] = serialize_loans(db, household_id, [loan], on_date=today)
    returns = list(
        db.scalars(
            select(LoanReturn)
            .where(
                LoanReturn.household_id == household_id,
                LoanReturn.loan_id == loan.id,
            )
            .order_by(LoanReturn.created_at.desc())
        ).all()
    )
    user_ids = {
        loan_return.created_by_user_id for loan_return in returns if loan_return.created_by_user_id
    }
    users = (
        dict(
            db.execute(
                select(User.id, User.name).where(
                    User.id.in_(user_ids)  # type: ignore[arg-type]
                )
            ).all()
        )
        if user_ids
        else {}
    )
    child_loans = list(
        db.scalars(
            select(Loan)
            .where(
                Loan.household_id == household_id,
                Loan.parent_loan_id == loan.id,
            )
            .order_by(func.lower(Loan.item_name_snapshot))
        ).all()
    )
    return LoanDetailOut(
        **loan_out.model_dump(),
        returns=[
            LoanReturnOut(
                id=loan_return.id,
                quantity=loan_return.quantity,
                returned_on=loan_return.returned_on,
                notes=loan_return.notes,
                created_by_name=users.get(loan_return.created_by_user_id)
                if loan_return.created_by_user_id
                else None,
                created_at=loan_return.created_at,
                reversed_at=loan_return.reversed_at,
                reversed_by_event_id=loan_return.reversed_by_event_id,
            )
            for loan_return in returns
        ],
        history=history.history_for_loan(db, household_id, loan.id),
        contents_loans=serialize_loans(db, household_id, child_loans, on_date=today),
    )


def _existing_loan_request(
    db: Session, household_id: uuid.UUID, request_id: uuid.UUID
) -> Loan | None:
    return db.scalar(
        select(Loan).where(
            Loan.household_id == household_id,
            Loan.request_id == request_id,
        )
    )


def _existing_return_request(
    db: Session, household_id: uuid.UUID, request_id: uuid.UUID
) -> LoanReturn | None:
    return db.scalar(
        select(LoanReturn).where(
            LoanReturn.household_id == household_id,
            LoanReturn.request_id == request_id,
        )
    )


def _build_loan(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    payload: LoanCreate,
    *,
    quantity: int,
    request_id: uuid.UUID,
    includes_contents: bool,
    parent_loan_id: uuid.UUID | None,
    actor_user_id: uuid.UUID | None,
) -> Loan:
    snapshot = history.location_snapshot(db, household_id, item.room_id, item.storage_location_id)
    return Loan(
        household_id=household_id,
        item_id=item.id,
        parent_loan_id=parent_loan_id,
        includes_contents=includes_contents,
        item_name_snapshot=item.name,
        home_room_id=item.room_id,
        home_room_name_snapshot=snapshot.get("room_name"),
        home_location_id=item.storage_location_id,
        home_location_name_snapshot=snapshot.get("location_name"),
        home_location_identifier_snapshot=snapshot.get("location_identifier"),
        borrower_name=payload.borrower_name,
        quantity=quantity,
        returned_quantity=0,
        lent_on=payload.lent_on,
        due_on=payload.due_on,
        notes=payload.notes,
        status=LoanStatus.OUTSTANDING.value,
        created_by_user_id=actor_user_id,
        request_id=request_id,
    )


def create_loan(
    db: Session,
    household_id: uuid.UUID,
    payload: LoanCreate,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> LoanDetailOut:
    existing_request = _existing_loan_request(db, household_id, payload.request_id)
    if existing_request is not None:
        return loan_detail(db, household_id, existing_request.id, on_date=on_date)
    if history.find_request_event(db, household_id, payload.request_id) is not None:
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    include_contents = bool(payload.include_contents)
    content_plan: list[tuple[Item, int]] = []
    if include_contents:
        from . import storage_items
        from .containers import household_hierarchy_lock, location_rows
        from .hierarchy import descendant_ids

        household_hierarchy_lock(db, household_id)
        item = lock_item(db, household_id, payload.item_id)
        location = storage_items.active_owned_location(db, household_id, item.id)
        if location is None:
            raise ApiError(
                422,
                "storage_not_enabled",
                "This item does not provide storage. Choose parent-only lending, or enable "
                "and fill its storage first.",
            )
        subtree_ids = list(descendant_ids(location_rows(db, household_id), location.id))
        children = list(
            db.scalars(
                select(Item)
                .where(
                    Item.household_id == household_id,
                    Item.storage_location_id.in_(subtree_ids),
                    Item.id != item.id,
                )
                .order_by(Item.id)
                .with_for_update()
            ).all()
        )
        child_quantities = loan_quantities_for_items(
            db, household_id, [child.id for child in children]
        )
        for child in children:
            if child.is_archived:
                continue
            child_available = child.quantity - child_quantities.get(child.id, 0)
            if child_available > 0:
                content_plan.append((child, child_available))
        if not content_plan:
            raise ApiError(
                409,
                "no_contents_available",
                "No owned contents are available to include. Choose parent-only lending "
                "or record child returns first.",
            )
    else:
        item = lock_item(db, household_id, payload.item_id)
    if item.is_archived:
        raise ApiError(409, "item_archived", "Restore the item before lending it.")
    on_loan = outstanding_quantity(db, household_id, item.id)
    available = item.quantity - on_loan
    if payload.quantity > available:
        raise ApiError(
            409,
            "insufficient_available_stock",
            f"Only {max(0, available)} unit(s) are available at home. "
            f"{on_loan} of {item.quantity} owned unit(s) are already on loan.",
        )
    loan = _build_loan(
        db,
        household_id,
        item,
        payload,
        quantity=payload.quantity,
        request_id=payload.request_id,
        includes_contents=include_contents,
        parent_loan_id=None,
        actor_user_id=actor_user_id,
    )
    db.add(loan)
    db.flush()
    child_loans: list[Loan] = []
    for child, child_quantity in content_plan:
        child_request_id = uuid.uuid5(payload.request_id, f"contents:{child.id}")
        child_loan = _build_loan(
            db,
            household_id,
            child,
            payload,
            quantity=child_quantity,
            request_id=child_request_id,
            includes_contents=False,
            parent_loan_id=loan.id,
            actor_user_id=actor_user_id,
        )
        db.add(child_loan)
        db.flush()
        child_loans.append(child_loan)
        child_details = _loan_event_details(child_loan)
        child_details.update(
            {
                "parent_loan_id": str(loan.id),
                "contents_of_item_id": str(item.id),
                "contents_of_item_name": item.name,
            }
        )
        history.record_event(
            db,
            household_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            action=ActivityAction.LOAN_CREATED.value,
            entity_type="loan",
            entity_id=child_loan.id,
            item_id=child.id,
            loan_id=child_loan.id,
            summary=(
                f"Lent {child_loan.quantity} × {child.name} as contents of {item.name} "
                f"to {child_loan.borrower_name}"
            ),
            details=child_details,
            request_id=child_request_id,
        )
    details = _loan_event_details(loan)
    if child_loans:
        details.update(
            {
                "contents_loan_ids": [str(child.id) for child in child_loans],
                "contents_item_ids": [str(child.item_id) for child in child_loans],
                "contents_loan_count": len(child_loans),
            }
        )
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.LOAN_CREATED.value,
        entity_type="loan",
        entity_id=loan.id,
        item_id=item.id,
        loan_id=loan.id,
        summary=(
            f"Lent {loan.quantity} × {item.name}"
            f"{f' with {len(child_loans)} content item(s)' if child_loans else ''} "
            f"to {loan.borrower_name}"
            f"{' · due ' + loan.due_on.isoformat() if loan.due_on else ''}"
        ),
        details=details,
        request_id=payload.request_id,
    )
    return loan_detail(db, household_id, loan.id, on_date=on_date)


def create_return(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    payload: LoanReturnCreate,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> LoanDetailOut:
    existing_request = _existing_return_request(db, household_id, payload.request_id)
    if existing_request is not None:
        if existing_request.loan_id != loan_id:
            raise ApiError(409, "request_id_reused", "That request id was used for another loan.")
        return loan_detail(db, household_id, existing_request.loan_id, on_date=on_date)
    if history.find_request_event(db, household_id, payload.request_id) is not None:
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    loan_preview = get_loan(db, household_id, loan_id)
    if loan_preview.item_id is None:
        raise ApiError(409, "item_missing", "The item for this loan no longer exists.")
    item = lock_item(db, household_id, loan_preview.item_id)
    loan = get_loan(db, household_id, loan_id, for_update=True)
    if loan.status in {LoanStatus.CANCELLED.value, LoanStatus.RETURNED.value}:
        raise ApiError(409, "loan_not_open", "This loan has no outstanding quantity.")
    if payload.returned_on < loan.lent_on:
        raise ApiError(422, "return_before_lent", "The return date cannot precede the lent date.")
    outstanding = loan.quantity - loan.returned_quantity
    if payload.quantity > outstanding:
        raise ApiError(
            409,
            "return_exceeds_outstanding",
            f"Only {outstanding} unit(s) are still outstanding on this loan.",
        )
    before = loan.returned_quantity
    loan_return = LoanReturn(
        household_id=household_id,
        loan_id=loan.id,
        quantity=payload.quantity,
        returned_on=payload.returned_on,
        notes=payload.notes,
        created_by_user_id=actor_user_id,
        request_id=payload.request_id,
    )
    db.add(loan_return)
    loan.returned_quantity += payload.quantity
    loan.status = status_for(loan.quantity, loan.returned_quantity)
    db.flush()
    details = _loan_event_details(loan)
    details.update(
        {
            "return_id": str(loan_return.id),
            "return_quantity": payload.quantity,
            "returned_on": payload.returned_on.isoformat(),
            "returned_before": before,
        }
    )
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.LOAN_RETURNED.value,
        entity_type="loan",
        entity_id=loan.id,
        item_id=item.id,
        loan_id=loan.id,
        summary=(
            f"Returned {payload.quantity} of {loan.quantity} × "
            f"{loan.item_name_snapshot} from {loan.borrower_name}"
        ),
        details=details,
        request_id=payload.request_id,
    )
    return loan_detail(db, household_id, loan.id, on_date=on_date)


def correct_loan(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    payload: LoanCorrect,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> LoanDetailOut:
    request_event = history.find_request_event(db, household_id, payload.request_id)
    if request_event is not None:
        if (
            request_event.loan_id == loan_id
            and request_event.action == ActivityAction.LOAN_CORRECTED.value
        ):
            return loan_detail(db, household_id, loan_id, on_date=on_date)
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    loan_preview = get_loan(db, household_id, loan_id)
    if loan_preview.item_id is None:
        raise ApiError(409, "item_missing", "The item for this loan no longer exists.")
    item = lock_item(db, household_id, loan_preview.item_id)
    loan = get_loan(db, household_id, loan_id, for_update=True)
    if loan.status == LoanStatus.CANCELLED.value:
        raise ApiError(409, "loan_cancelled", "A cancelled loan cannot be corrected.")
    if db.scalar(select(Loan.id).where(Loan.parent_loan_id == loan.id)) is not None:
        raise ApiError(
            409,
            "loan_has_contents",
            "This loan includes separate child content loans. Correct each child loan "
            "explicitly so parent and child records cannot diverge.",
        )

    fields = payload.model_fields_set
    before = {
        "borrower_name": loan.borrower_name,
        "quantity": loan.quantity,
        "lent_on": loan.lent_on.isoformat(),
        "due_on": loan.due_on.isoformat() if loan.due_on else None,
    }
    new_borrower = payload.borrower_name if "borrower_name" in fields else loan.borrower_name
    new_quantity = payload.quantity if "quantity" in fields else loan.quantity
    new_lent_on = payload.lent_on if "lent_on" in fields else loan.lent_on
    new_due_on = payload.due_on if "due_on" in fields else loan.due_on
    new_notes = payload.notes if "notes" in fields else loan.notes
    assert new_borrower is not None and new_quantity is not None and new_lent_on is not None
    if new_due_on is not None and new_due_on < new_lent_on:
        raise ApiError(422, "invalid_loan_dates", "The due date cannot precede the lent date.")
    if new_quantity < loan.returned_quantity:
        raise ApiError(
            409,
            "quantity_below_returned",
            f"{loan.returned_quantity} unit(s) have already been returned. "
            "The loan quantity cannot be lower than that.",
        )
    if new_quantity > loan.quantity:
        available = item.quantity - outstanding_quantity(db, household_id, item.id)
        if new_quantity - loan.quantity > available:
            raise ApiError(
                409,
                "insufficient_available_stock",
                f"Only {max(0, available)} additional unit(s) are available to add to this loan.",
            )
    loan.borrower_name = new_borrower
    loan.quantity = new_quantity
    loan.lent_on = new_lent_on
    loan.due_on = new_due_on
    loan.notes = new_notes
    loan.status = status_for(loan.quantity, loan.returned_quantity)
    db.flush()
    details = _loan_event_details(loan)
    details["before"] = before
    details["after"] = {
        "borrower_name": loan.borrower_name,
        "quantity": loan.quantity,
        "lent_on": loan.lent_on.isoformat(),
        "due_on": loan.due_on.isoformat() if loan.due_on else None,
    }
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.LOAN_CORRECTED.value,
        entity_type="loan",
        entity_id=loan.id,
        item_id=item.id,
        loan_id=loan.id,
        summary=f"Corrected loan of {loan.item_name_snapshot} to {loan.borrower_name}",
        details=details,
        request_id=payload.request_id,
    )
    return loan_detail(db, household_id, loan.id, on_date=on_date)


def cancel_loan(
    db: Session,
    household_id: uuid.UUID,
    loan_id: uuid.UUID,
    *,
    reason: str | None,
    request_id: uuid.UUID,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> LoanDetailOut:
    request_event = history.find_request_event(db, household_id, request_id)
    if request_event is not None:
        if (
            request_event.loan_id == loan_id
            and request_event.action == ActivityAction.LOAN_CANCELLED.value
        ):
            return loan_detail(db, household_id, loan_id, on_date=on_date)
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    loan_preview = get_loan(db, household_id, loan_id)
    if loan_preview.item_id is None:
        raise ApiError(409, "item_missing", "The item for this loan no longer exists.")
    item = lock_item(db, household_id, loan_preview.item_id)
    loan = get_loan(db, household_id, loan_id, for_update=True)
    if loan.status == LoanStatus.CANCELLED.value:
        return loan_detail(db, household_id, loan.id, on_date=on_date)
    if loan.returned_quantity > 0 or db.scalar(
        select(func.count(LoanReturn.id)).where(LoanReturn.loan_id == loan.id)
    ):
        raise ApiError(
            409,
            "loan_has_returns",
            "A loan with return history cannot be cancelled. Correct the loan or "
            "record the remaining return instead.",
        )
    if db.scalar(select(Loan.id).where(Loan.parent_loan_id == loan.id)) is not None:
        raise ApiError(
            409,
            "loan_has_contents",
            "This loan includes separate child content loans. Cancel or return each "
            "child loan explicitly; they are never cancelled by the parent.",
        )
    details = _loan_event_details(loan)
    details["reason"] = reason
    loan.status = LoanStatus.CANCELLED.value
    loan.cancelled_at = datetime.now(UTC)
    db.flush()
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.LOAN_CANCELLED.value,
        entity_type="loan",
        entity_id=loan.id,
        item_id=item.id,
        loan_id=loan.id,
        summary=(
            f"Cancelled loan of {loan.quantity} × {loan.item_name_snapshot} to {loan.borrower_name}"
        ),
        details=details,
        request_id=request_id,
    )
    return loan_detail(db, household_id, loan.id, on_date=on_date)
