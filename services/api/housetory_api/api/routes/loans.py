import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Item, StorageLocation
from ...schemas.lending import (
    ActivityHistoryOut,
    ItemLoanSummaryOut,
    LoanCancelRequest,
    LoanCorrect,
    LoanCreate,
    LoanDetailOut,
    LoanFilterStatus,
    LoanListOut,
    LoanOptionsOut,
    LoanPersonListOut,
    LoanReturnCreate,
    RestoreAssistedUndoOut,
    UndoRequest,
    UndoResult,
)
from ...services import history, lending, loan_people
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["lending"])


def _item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == household_id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    return item


def _container(db: Session, household_id: uuid.UUID, container_id: uuid.UUID) -> StorageLocation:
    container = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == container_id,
            StorageLocation.household_id == household_id,
        )
    )
    if container is None:
        raise ApiError(404, "location_not_found", "Storage location not found.")
    return container


@router.get("/loans", response_model=LoanListOut)
def list_loans(
    status: LoanFilterStatus = "open",
    item_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    person: Annotated[str | None, Query(max_length=120)] = None,
    overdue: bool = False,
    on_date: date | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanListOut:
    if item_id is not None:
        _item(db, auth.household.id, item_id)
    return lending.list_loans(
        db,
        auth.household.id,
        status=status,
        item_id=item_id,
        q=q,
        person=person,
        overdue=overdue,
        on_date=on_date,
        limit=limit,
        offset=offset,
    )


@router.get("/loans/people", response_model=LoanPersonListOut)
def list_loan_people(
    q: Annotated[str | None, Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanPersonListOut:
    return loan_people.suggest_people(
        db,
        auth.household.id,
        query=q,
        limit=limit,
    )


@router.post("/loans", response_model=LoanDetailOut, status_code=201)
def create_loan(
    payload: LoanCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanDetailOut:
    try:
        result = lending.create_loan(
            db,
            auth.household.id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.get("/loans/{loan_id}", response_model=LoanDetailOut)
def read_loan(
    loan_id: uuid.UUID,
    on_date: date | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanDetailOut:
    return lending.loan_detail(db, auth.household.id, loan_id, on_date=on_date)


@router.post("/loans/{loan_id}/returns", response_model=LoanDetailOut)
def create_return(
    loan_id: uuid.UUID,
    payload: LoanReturnCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanDetailOut:
    try:
        result = lending.create_return(
            db,
            auth.household.id,
            loan_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.patch("/loans/{loan_id}", response_model=LoanDetailOut)
def correct_loan(
    loan_id: uuid.UUID,
    payload: LoanCorrect,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanDetailOut:
    try:
        result = lending.correct_loan(
            db,
            auth.household.id,
            loan_id,
            payload,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.post("/loans/{loan_id}/cancel", response_model=LoanDetailOut)
def cancel_loan(
    loan_id: uuid.UUID,
    payload: LoanCancelRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanDetailOut:
    try:
        result = lending.cancel_loan(
            db,
            auth.household.id,
            loan_id,
            reason=payload.reason,
            request_id=payload.request_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


@router.get("/items/{item_id}/loans", response_model=ItemLoanSummaryOut)
def item_loans(
    item_id: uuid.UUID,
    on_date: date | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemLoanSummaryOut:
    _item(db, auth.household.id, item_id)
    return lending.item_loan_summary(db, auth.household.id, item_id, on_date=on_date)


@router.get("/items/{item_id}/loan-options", response_model=LoanOptionsOut)
def item_loan_options(
    item_id: uuid.UUID,
    on_date: date | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> LoanOptionsOut:
    _item(db, auth.household.id, item_id)
    return lending.loan_options(db, auth.household.id, item_id, on_date=on_date)


@router.get("/items/{item_id}/history", response_model=ActivityHistoryOut)
def item_history(
    item_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ActivityHistoryOut:
    _item(db, auth.household.id, item_id)
    return history.history_for_item(db, auth.household.id, item_id, limit=limit, offset=offset)


@router.get("/containers/{container_id}/history", response_model=ActivityHistoryOut)
def container_history(
    container_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ActivityHistoryOut:
    _container(db, auth.household.id, container_id)
    return history.history_for_container(
        db, auth.household.id, container_id, limit=limit, offset=offset
    )


@router.get(
    "/history/{event_id}/restore-preview",
    response_model=RestoreAssistedUndoOut,
)
def preview_restore_assisted_undo(
    event_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> RestoreAssistedUndoOut:
    return history.restore_assisted_preview(db, auth.household.id, event_id)


@router.post("/history/{event_id}/restore-undo", response_model=UndoResult)
def restore_assisted_history_event(
    event_id: uuid.UUID,
    payload: UndoRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> UndoResult:
    try:
        event = history.restore_assisted_undo_event(
            db,
            auth.household.id,
            event_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
            request_id=payload.request_id,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    details = event.details or {}
    restored_container_id = None
    if details.get("restored_container_id"):
        try:
            restored_container_id = uuid.UUID(str(details["restored_container_id"]))
        except (ValueError, TypeError):
            restored_container_id = None
    return UndoResult(
        event=history.serialize_event(db, event),
        undone_event_id=event.undoes_event_id or event_id,
        message=("Container restored and one item move undone with compensating history events."),
        restored_container_id=restored_container_id,
    )


@router.post("/history/{event_id}/undo", response_model=UndoResult)
def undo_history_event(
    event_id: uuid.UUID,
    payload: UndoRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> UndoResult:
    try:
        event = history.undo_event(
            db,
            auth.household.id,
            event_id,
            actor_user_id=auth.user.id,
            actor_name=auth.user.name,
            request_id=payload.request_id,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return UndoResult(
        event=history.serialize_event(db, event),
        undone_event_id=event.undoes_event_id or event_id,
        message="The action was undone with a new compensating history event.",
    )
