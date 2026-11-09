"""Household-scoped borrowed-from-others records and partial returns.

Borrowed possessions deliberately live outside ``Item``, ``Loan`` and owned
stock counts. Quantities here describe what is physically held from an external
owner, never what the household owns.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import ActivityAction, LoanStatus
from ..models import (
    BorrowedPhoto,
    BorrowedRecord,
    BorrowedReturn,
    Item,
    Property,
    Room,
    StorageLocation,
    User,
)
from ..schemas.borrowed import (
    BorrowedCorrect,
    BorrowedCreate,
    BorrowedDetailOut,
    BorrowedListOut,
    BorrowedOut,
    BorrowedPhotoOut,
    BorrowedReturnCreate,
    BorrowedReturnOut,
)
from . import history, loan_people, storage
from .loan_status import OPEN_STATUSES, status_for
from .query_text import search_term_variants


@dataclass(frozen=True)
class PhotoMutation:
    detail: BorrowedDetailOut
    old_keys: list[str]
    new_keys: list[str]


@dataclass(frozen=True)
class BorrowedTotals:
    open_count: int = 0
    overdue_count: int = 0
    total_borrowed_quantity: int = 0
    outstanding_quantity: int = 0
    returned_quantity: int = 0
    physically_held_quantity: int = 0


def _settings():
    return get_settings()


def _casefold_contains(column, term: str):  # noqa: ANN001
    return func.lower(column).contains(term.lower())


def _fingerprint(payload, *, exclude_unset: bool = False) -> str:  # noqa: ANN001
    data = payload.model_dump(mode="json", exclude={"request_id"}, exclude_unset=exclude_unset)
    encoded = json.dumps(
        data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _request_record(
    db: Session, household_id: uuid.UUID, request_id: uuid.UUID
) -> BorrowedRecord | None:
    return db.scalar(
        select(BorrowedRecord).where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.request_id == request_id,
        )
    )


def _request_return(
    db: Session, household_id: uuid.UUID, request_id: uuid.UUID
) -> BorrowedReturn | None:
    return db.scalar(
        select(BorrowedReturn).where(
            BorrowedReturn.household_id == household_id,
            BorrowedReturn.request_id == request_id,
        )
    )


def get_record(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> BorrowedRecord:
    query = select(BorrowedRecord).where(
        BorrowedRecord.id == record_id,
        BorrowedRecord.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update().execution_options(populate_existing=True)
    record = db.scalar(query)
    if record is None:
        raise ApiError(404, "borrowed_record_not_found", "Borrowed record not found.")
    return record


def _resolve_place(
    db: Session,
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None,
    room_id: uuid.UUID | None,
    storage_location_id: uuid.UUID | None,
) -> tuple[Property | None, Room | None, StorageLocation | None, dict[str, Any]]:
    property_record: Property | None = None
    room: Room | None = None
    location: StorageLocation | None = None

    if property_id is not None:
        property_record = db.scalar(
            select(Property).where(
                Property.id == property_id, Property.household_id == household_id
            )
        )
        if property_record is None:
            raise ApiError(404, "property_not_found", "Property not found.")
    if room_id is not None:
        room = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
        if room is None:
            raise ApiError(404, "room_not_found", "Room not found.")
        if property_record is not None and room.property_id != property_record.id:
            raise ApiError(
                422,
                "room_property_mismatch",
                "The keeping room is not in the selected property.",
            )
    if storage_location_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == storage_location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            raise ApiError(404, "location_not_found", "Storage location not found.")
        if room is not None and location.room_id != room.id:
            raise ApiError(
                422,
                "location_room_mismatch",
                "The keeping container is not in the selected room.",
            )
        if room is None:
            room = db.scalar(
                select(Room).where(Room.id == location.room_id, Room.household_id == household_id)
            )
            if room is None:
                raise ApiError(404, "room_not_found", "Room not found.")
    if room is not None and property_record is None:
        property_record = db.get(Property, room.property_id)
        if property_record is not None and property_record.household_id != household_id:
            property_record = None
    if property_record is not None and room is not None and room.property_id != property_record.id:
        raise ApiError(
            422,
            "room_property_mismatch",
            "The keeping room is not in the selected property.",
        )

    snapshot = history.location_snapshot(
        db,
        household_id,
        room.id if room is not None else None,
        location.id if location is not None else None,
    )
    if property_record is not None:
        snapshot["property_id"] = str(property_record.id)
        snapshot["property_name"] = property_record.name
    return property_record, room, location, snapshot


def _apply_place(record: BorrowedRecord, snapshot: dict[str, Any]) -> None:
    record.property_id = (
        uuid.UUID(str(snapshot["property_id"])) if snapshot.get("property_id") else None
    )
    record.property_name_snapshot = snapshot.get("property_name")
    record.room_id = uuid.UUID(str(snapshot["room_id"])) if snapshot.get("room_id") else None
    record.room_name_snapshot = snapshot.get("room_name")
    record.storage_location_id = (
        uuid.UUID(str(snapshot["location_id"])) if snapshot.get("location_id") else None
    )
    record.location_name_snapshot = snapshot.get("location_name")
    record.location_identifier_snapshot = snapshot.get("location_identifier")


def _place_from_payload(
    db: Session,
    household_id: uuid.UUID,
    payload: BorrowedCreate | BorrowedCorrect,
) -> tuple[Property | None, Room | None, StorageLocation | None, dict[str, Any]]:
    return _resolve_place(
        db,
        household_id,
        property_id=payload.property_id,
        room_id=payload.room_id,
        storage_location_id=payload.storage_location_id,
    )


def _outstanding(record: BorrowedRecord) -> int:
    if record.status == LoanStatus.CANCELLED.value:
        return 0
    return max(0, record.quantity - record.returned_quantity)


def _event_details(record: BorrowedRecord) -> dict[str, Any]:
    return {
        "item_name": record.item_name,
        "brand": record.brand,
        "model": record.model,
        "owner_name": record.owner_name,
        "quantity": record.quantity,
        "returned_quantity": record.returned_quantity,
        "outstanding_quantity": _outstanding(record),
        "physically_held_quantity": _outstanding(record),
        "borrowed_on": record.borrowed_on.isoformat(),
        "due_on": record.due_on.isoformat() if record.due_on else None,
        "property_name": record.property_name_snapshot,
        "room_name": record.room_name_snapshot,
        "location_name": record.location_name_snapshot,
        "location_identifier": record.location_identifier_snapshot,
    }


def _photo_out(record_id: uuid.UUID, photo: BorrowedPhoto | None) -> BorrowedPhotoOut | None:
    if photo is None:
        return None
    prefix = _settings().api_prefix.rstrip("/")
    return BorrowedPhotoOut(
        id=photo.id,
        original_filename=photo.original_filename,
        content_type=photo.content_type,
        byte_size=photo.byte_size,
        width=photo.width,
        height=photo.height,
        created_at=photo.created_at,
        url=f"{prefix}/borrowed/{record_id}/photo/file",
        thumbnail_url=f"{prefix}/borrowed/{record_id}/photo/thumbnail",
    )


def _serialize_records(
    db: Session,
    household_id: uuid.UUID,
    records: list[BorrowedRecord],
    *,
    on_date: date,
) -> list[BorrowedOut]:
    if not records:
        return []
    record_ids = [record.id for record in records]
    user_ids = {record.created_by_user_id for record in records if record.created_by_user_id}
    users = (
        dict(
            db.execute(
                select(User.id, User.name).where(User.id.in_(user_ids))  # type: ignore[arg-type]
            ).all()
        )
        if user_ids
        else {}
    )
    latest_returns = dict(
        db.execute(
            select(
                BorrowedReturn.borrowed_record_id,
                func.max(BorrowedReturn.returned_on),
            )
            .where(
                BorrowedReturn.household_id == household_id,
                BorrowedReturn.borrowed_record_id.in_(record_ids),
            )
            .group_by(BorrowedReturn.borrowed_record_id)
        ).all()
    )
    photos = {
        photo.borrowed_record_id: photo
        for photo in db.scalars(
            select(BorrowedPhoto).where(
                BorrowedPhoto.household_id == household_id,
                BorrowedPhoto.borrowed_record_id.in_(record_ids),
            )
        ).all()
    }
    result: list[BorrowedOut] = []
    for record in records:
        outstanding = _outstanding(record)
        overdue = bool(
            record.status in OPEN_STATUSES and record.due_on is not None and record.due_on < on_date
        )
        result.append(
            BorrowedOut(
                id=record.id,
                household_id=record.household_id,
                item_name=record.item_name,
                brand=record.brand,
                model=record.model,
                owner_name=record.owner_name,
                quantity=record.quantity,
                returned_quantity=record.returned_quantity,
                outstanding_quantity=outstanding,
                physically_held_quantity=outstanding,
                status=record.status,  # type: ignore[arg-type]
                borrowed_on=record.borrowed_on,
                due_on=record.due_on,
                notes=record.notes,
                overdue=overdue,
                days_past_due=(on_date - record.due_on).days
                if overdue and record.due_on is not None
                else None,
                latest_returned_on=latest_returns.get(record.id),
                property_id=record.property_id,
                property_name=record.property_name_snapshot,
                room_id=record.room_id,
                room_name=record.room_name_snapshot,
                storage_location_id=record.storage_location_id,
                storage_location_name=record.location_name_snapshot,
                storage_location_identifier=record.location_identifier_snapshot,
                photo=_photo_out(record.id, photos.get(record.id)),
                created_by_user_id=record.created_by_user_id,
                created_by_name=users.get(record.created_by_user_id)
                if record.created_by_user_id
                else None,
                cancelled_at=record.cancelled_at,
                created_at=record.created_at,
                updated_at=record.updated_at,
            )
        )
    return result


def record_detail(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    *,
    on_date: date | None = None,
) -> BorrowedDetailOut:
    today = on_date or date.today()
    record = get_record(db, household_id, record_id)
    [record_out] = _serialize_records(db, household_id, [record], on_date=today)
    returns = list(
        db.scalars(
            select(BorrowedReturn)
            .where(
                BorrowedReturn.household_id == household_id,
                BorrowedReturn.borrowed_record_id == record.id,
            )
            .order_by(BorrowedReturn.created_at.desc())
        ).all()
    )
    user_ids = {item.created_by_user_id for item in returns if item.created_by_user_id}
    users = (
        dict(
            db.execute(
                select(User.id, User.name).where(User.id.in_(user_ids))  # type: ignore[arg-type]
            ).all()
        )
        if user_ids
        else {}
    )
    return BorrowedDetailOut(
        **record_out.model_dump(),
        returns=[
            BorrowedReturnOut(
                id=item.id,
                quantity=item.quantity,
                returned_on=item.returned_on,
                notes=item.notes,
                created_by_name=users.get(item.created_by_user_id)
                if item.created_by_user_id
                else None,
                created_at=item.created_at,
            )
            for item in returns
        ],
        history=history.history_for_borrowed(db, household_id, record.id),
    )


def _place_conditions(
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None,
    room_id: uuid.UUID | None,
    storage_location_id: uuid.UUID | None,
) -> list[Any]:
    conditions: list[Any] = [BorrowedRecord.household_id == household_id]
    if property_id is not None:
        room_ids = select(Room.id).where(
            Room.household_id == household_id, Room.property_id == property_id
        )
        conditions.append(
            or_(
                BorrowedRecord.property_id == property_id,
                BorrowedRecord.room_id.in_(room_ids),
            )
        )
    if room_id is not None:
        conditions.append(BorrowedRecord.room_id == room_id)
    if storage_location_id is not None:
        conditions.append(BorrowedRecord.storage_location_id == storage_location_id)
    return conditions


def _search_conditions(
    household_id: uuid.UUID,
    *,
    status: str,
    q: str | None,
    overdue: bool,
    today: date,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    storage_location_id: uuid.UUID | None = None,
    include_cancelled: bool = True,
    person_names: list[str] | None = None,
) -> list[Any]:
    conditions = _place_conditions(
        household_id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
    )
    if status == "open":
        conditions.append(BorrowedRecord.status.in_(OPEN_STATUSES))
    elif status != "all":
        conditions.append(BorrowedRecord.status == status)
    elif not include_cancelled:
        conditions.append(BorrowedRecord.status != LoanStatus.CANCELLED.value)
    if person_names is not None:
        conditions.append(BorrowedRecord.owner_name.in_(person_names))
    term = (q or "").strip()
    if term:
        term_conditions = []
        for value in search_term_variants(term):
            term_conditions.append(
                or_(
                    _casefold_contains(BorrowedRecord.item_name, value),
                    _casefold_contains(BorrowedRecord.brand, value),
                    _casefold_contains(BorrowedRecord.model, value),
                    _casefold_contains(BorrowedRecord.owner_name, value),
                    _casefold_contains(BorrowedRecord.location_name_snapshot, value),
                    _casefold_contains(BorrowedRecord.location_identifier_snapshot, value),
                )
            )
        conditions.append(or_(*term_conditions))
    if overdue:
        conditions.append(BorrowedRecord.status.in_(OPEN_STATUSES))
        conditions.append(BorrowedRecord.due_on.is_not(None))
        conditions.append(BorrowedRecord.due_on < today)
    return conditions


def borrowed_totals(
    db: Session,
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    storage_location_id: uuid.UUID | None = None,
    today: date | None = None,
) -> BorrowedTotals:
    day = today or date.today()
    base = _place_conditions(
        household_id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
    )
    active = [*base, BorrowedRecord.status != LoanStatus.CANCELLED.value]
    open_conditions = [*base, BorrowedRecord.status.in_(OPEN_STATUSES)]
    total_borrowed = int(
        db.scalar(select(func.coalesce(func.sum(BorrowedRecord.quantity), 0)).where(*active)) or 0
    )
    returned = int(
        db.scalar(
            select(func.coalesce(func.sum(BorrowedRecord.returned_quantity), 0)).where(*active)
        )
        or 0
    )
    outstanding = int(
        db.scalar(
            select(
                func.coalesce(
                    func.sum(BorrowedRecord.quantity - BorrowedRecord.returned_quantity),
                    0,
                )
            ).where(*open_conditions)
        )
        or 0
    )
    open_count = int(db.scalar(select(func.count(BorrowedRecord.id)).where(*open_conditions)) or 0)
    overdue_count = int(
        db.scalar(
            select(func.count(BorrowedRecord.id)).where(
                *open_conditions,
                BorrowedRecord.due_on.is_not(None),
                BorrowedRecord.due_on < day,
            )
        )
        or 0
    )
    return BorrowedTotals(
        open_count=open_count,
        overdue_count=overdue_count,
        total_borrowed_quantity=total_borrowed,
        outstanding_quantity=outstanding,
        returned_quantity=returned,
        physically_held_quantity=outstanding,
    )


def list_records(
    db: Session,
    household_id: uuid.UUID,
    *,
    status: str = "open",
    q: str | None = None,
    person: str | None = None,
    overdue: bool = False,
    property_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
    storage_location_id: uuid.UUID | None = None,
    include_cancelled: bool = True,
    on_date: date | None = None,
    limit: int = 50,
    offset: int = 0,
) -> BorrowedListOut:
    today = on_date or date.today()
    person_names = (
        loan_people.matching_person_names(db, household_id, person)
        if (person or "").strip()
        else None
    )
    conditions = _search_conditions(
        household_id,
        status=status,
        q=q,
        overdue=overdue,
        today=today,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
        include_cancelled=include_cancelled,
        person_names=person_names,
    )
    total = int(db.scalar(select(func.count(BorrowedRecord.id)).where(*conditions)) or 0)
    records = list(
        db.scalars(
            select(BorrowedRecord)
            .where(*conditions)
            .order_by(
                BorrowedRecord.due_on.asc().nullslast(),
                BorrowedRecord.borrowed_on.desc(),
                BorrowedRecord.created_at.desc(),
            )
            .limit(limit)
            .offset(offset)
        ).all()
    )
    totals = borrowed_totals(
        db,
        household_id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
        today=today,
    )
    return BorrowedListOut(
        items=_serialize_records(db, household_id, records, on_date=today),
        total=total,
        limit=limit,
        offset=offset,
        open_count=totals.open_count,
        overdue_count=totals.overdue_count,
        total_borrowed_quantity=totals.total_borrowed_quantity,
        outstanding_quantity=totals.outstanding_quantity,
        returned_quantity=totals.returned_quantity,
        physically_held_quantity=totals.physically_held_quantity,
    )


def quick_search_records(
    db: Session,
    household_id: uuid.UUID,
    *,
    q: str,
    limit: int,
    property_id: uuid.UUID | None = None,
    on_date: date | None = None,
) -> tuple[list[BorrowedOut], int]:
    result = list_records(
        db,
        household_id,
        status="all",
        include_cancelled=False,
        q=q,
        property_id=property_id,
        on_date=on_date,
        limit=limit,
        offset=0,
    )
    return result.items, result.total


def matching_records(
    db: Session,
    household_id: uuid.UUID,
    *,
    q: str,
    limit: int = 20,
    property_id: uuid.UUID | None = None,
    on_date: date | None = None,
) -> list[BorrowedOut]:
    items, _total = quick_search_records(
        db,
        household_id,
        q=q,
        limit=limit,
        property_id=property_id,
        on_date=on_date,
    )
    return items


def create_record(
    db: Session,
    household_id: uuid.UUID,
    payload: BorrowedCreate,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> BorrowedDetailOut:
    fingerprint = _fingerprint(payload)
    existing_request = _request_record(db, household_id, payload.request_id)
    if existing_request is not None:
        if existing_request.request_fingerprint != fingerprint:
            raise ApiError(
                409,
                "request_id_payload_mismatch",
                "That request id was already used with different borrowed-item details.",
            )
        return record_detail(db, household_id, existing_request.id, on_date=on_date)
    if history.find_request_event(db, household_id, payload.request_id) is not None:
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    property_record, room, location, snapshot = _place_from_payload(db, household_id, payload)
    del property_record, room, location
    record = BorrowedRecord(
        household_id=household_id,
        item_name=payload.item_name,
        brand=payload.brand,
        model=payload.model,
        owner_name=payload.owner_name,
        quantity=payload.quantity,
        returned_quantity=0,
        status=LoanStatus.OUTSTANDING.value,
        borrowed_on=payload.borrowed_on,
        due_on=payload.due_on,
        notes=payload.notes,
        created_by_user_id=actor_user_id,
        request_id=payload.request_id,
        request_fingerprint=fingerprint,
    )
    _apply_place(record, snapshot)
    try:
        with db.begin_nested():
            db.add(record)
            db.flush()
    except IntegrityError:
        # A concurrent create with the same request id won the unique constraint.
        existing = _request_record(db, household_id, payload.request_id)
        if existing is not None:
            if existing.request_fingerprint != fingerprint:
                raise ApiError(
                    409,
                    "request_id_payload_mismatch",
                    "That request id was already used with different borrowed-item details.",
                ) from None
            return record_detail(db, household_id, existing.id, on_date=on_date)
        raise
    details = _event_details(record)
    details["request_fingerprint"] = fingerprint
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.BORROWED_CREATED.value,
        entity_type="borrowed",
        entity_id=record.id,
        borrowed_item_id=record.id,
        summary=(
            f"Recorded {record.quantity} × {record.item_name} borrowed from "
            f"{record.owner_name}"
            f"{' · kept at ' + _place_label(record) if _place_label(record) else ''}"
            f"{' · due ' + record.due_on.isoformat() if record.due_on else ''}"
        ),
        details=details,
        request_id=payload.request_id,
    )
    return record_detail(db, household_id, record.id, on_date=on_date)


def has_held_stock(record) -> bool:  # noqa: ANN001
    if getattr(record, "status", "") not in OPEN_STATUSES:
        return False
    held = getattr(record, "physically_held_quantity", None)
    if held is None:
        held = max(
            0,
            int(getattr(record, "quantity", 0)) - int(getattr(record, "returned_quantity", 0)),
        )
    return int(held) > 0


def location_prefix(record) -> str:  # noqa: ANN001
    if has_held_stock(record):
        return "kept at"
    if getattr(record, "status", "") == LoanStatus.RETURNED.value:
        return "previously kept at"
    return "last recorded location"


def _place_label(record: BorrowedRecord) -> str | None:
    parts = [
        record.property_name_snapshot,
        record.room_name_snapshot,
        (
            f"{record.location_identifier_snapshot} · {record.location_name_snapshot}"
            if record.location_identifier_snapshot
            and record.location_name_snapshot
            and record.location_identifier_snapshot != record.location_name_snapshot
            else record.location_identifier_snapshot or record.location_name_snapshot
        ),
    ]
    filtered = [part for part in parts if part]
    return " / ".join(filtered) if filtered else None


def create_return(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    payload: BorrowedReturnCreate,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> BorrowedDetailOut:
    record = get_record(db, household_id, record_id, for_update=True)
    fingerprint = _fingerprint(payload)
    existing_request = _request_return(db, household_id, payload.request_id)
    if existing_request is not None:
        if (
            existing_request.borrowed_record_id != record.id
            or existing_request.request_fingerprint != fingerprint
        ):
            raise ApiError(
                409,
                "request_id_payload_mismatch",
                "That request id was already used with different return details.",
            )
        return record_detail(db, household_id, record.id, on_date=on_date)
    if history.find_request_event(db, household_id, payload.request_id) is not None:
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")
    if record.status == LoanStatus.CANCELLED.value:
        raise ApiError(409, "borrowed_record_cancelled", "This borrowed record was cancelled.")
    if record.status == LoanStatus.RETURNED.value:
        raise ApiError(409, "borrowed_record_returned", "This borrowed record is fully returned.")
    if payload.returned_on < record.borrowed_on:
        raise ApiError(
            422,
            "return_before_borrowed",
            "The return date cannot precede the borrowed date.",
        )
    outstanding = record.quantity - record.returned_quantity
    if payload.quantity > outstanding:
        raise ApiError(
            409,
            "return_exceeds_outstanding",
            f"Only {outstanding} unit(s) are still held from this owner.",
        )
    before = record.returned_quantity
    borrowed_return = BorrowedReturn(
        household_id=household_id,
        borrowed_record_id=record.id,
        quantity=payload.quantity,
        returned_on=payload.returned_on,
        notes=payload.notes,
        created_by_user_id=actor_user_id,
        request_id=payload.request_id,
        request_fingerprint=fingerprint,
    )
    db.add(borrowed_return)
    record.returned_quantity += payload.quantity
    record.status = status_for(record.quantity, record.returned_quantity)
    db.flush()
    details = _event_details(record)
    details.update(
        {
            "return_id": str(borrowed_return.id),
            "return_quantity": payload.quantity,
            "returned_on": payload.returned_on.isoformat(),
            "returned_before": before,
            "request_fingerprint": fingerprint,
        }
    )
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.BORROWED_RETURNED.value,
        entity_type="borrowed",
        entity_id=record.id,
        borrowed_item_id=record.id,
        summary=(
            f"Returned {payload.quantity} of {record.quantity} × {record.item_name} "
            f"to {record.owner_name}"
        ),
        details=details,
        request_id=payload.request_id,
    )
    return record_detail(db, household_id, record.id, on_date=on_date)


def correct_record(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    payload: BorrowedCorrect,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> BorrowedDetailOut:
    record = get_record(db, household_id, record_id, for_update=True)
    if record.status == LoanStatus.CANCELLED.value:
        raise ApiError(409, "borrowed_record_cancelled", "A cancelled record cannot be corrected.")
    fingerprint = _fingerprint(payload, exclude_unset=True)
    request_event = history.find_request_event(db, household_id, payload.request_id)
    if request_event is not None:
        if (
            request_event.borrowed_item_id == record.id
            and request_event.action == ActivityAction.BORROWED_CORRECTED.value
            and (request_event.details or {}).get("request_fingerprint") == fingerprint
        ):
            return record_detail(db, household_id, record.id, on_date=on_date)
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")

    fields = payload.model_fields_set
    before = _event_details(record)
    new_item_name = payload.item_name if "item_name" in fields else record.item_name
    new_owner = payload.owner_name if "owner_name" in fields else record.owner_name
    new_quantity = payload.quantity if "quantity" in fields else record.quantity
    new_borrowed_on = payload.borrowed_on if "borrowed_on" in fields else record.borrowed_on
    new_due_on = payload.due_on if "due_on" in fields else record.due_on
    if (
        new_item_name is None
        or new_owner is None
        or new_quantity is None
        or new_borrowed_on is None
    ):
        raise ApiError(
            422, "invalid_borrowed_value", "Required borrowed-item fields cannot be empty."
        )
    if new_due_on is not None and new_due_on < new_borrowed_on:
        raise ApiError(
            422,
            "invalid_borrowed_dates",
            "The due date cannot precede the borrowed date.",
        )
    if new_quantity < record.returned_quantity:
        raise ApiError(
            409,
            "quantity_below_returned",
            f"{record.returned_quantity} unit(s) have already been returned to the owner. "
            "The borrowed quantity cannot be lower than that.",
        )
    earliest_return = db.scalar(
        select(func.min(BorrowedReturn.returned_on)).where(
            BorrowedReturn.household_id == household_id,
            BorrowedReturn.borrowed_record_id == record.id,
        )
    )
    if earliest_return is not None and new_borrowed_on > earliest_return:
        raise ApiError(
            422,
            "borrowed_date_after_return",
            "The borrowed date cannot be after an existing return date.",
        )

    record.item_name = new_item_name
    record.owner_name = new_owner
    record.quantity = new_quantity
    record.borrowed_on = new_borrowed_on
    record.due_on = new_due_on
    if "brand" in fields:
        record.brand = payload.brand
    if "model" in fields:
        record.model = payload.model
    if "notes" in fields:
        record.notes = payload.notes
    if {"property_id", "room_id", "storage_location_id"} & fields:
        _, _, _, snapshot = _place_from_payload(db, household_id, payload)
        _apply_place(record, snapshot)
    record.status = status_for(record.quantity, record.returned_quantity)
    db.flush()
    details = _event_details(record)
    details["before"] = before
    details["request_fingerprint"] = fingerprint
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.BORROWED_CORRECTED.value,
        entity_type="borrowed",
        entity_id=record.id,
        borrowed_item_id=record.id,
        summary=(f"Corrected borrowed record for {record.item_name} from {record.owner_name}"),
        details=details,
        request_id=payload.request_id,
    )
    return record_detail(db, household_id, record.id, on_date=on_date)


def cancel_record(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    *,
    reason: str | None,
    request_id: uuid.UUID,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    on_date: date | None = None,
) -> BorrowedDetailOut:
    record = get_record(db, household_id, record_id, for_update=True)
    fingerprint = hashlib.sha256(
        json.dumps({"reason": reason or ""}, sort_keys=True).encode("utf-8")
    ).hexdigest()
    request_event = history.find_request_event(db, household_id, request_id)
    if request_event is not None:
        if (
            request_event.borrowed_item_id == record.id
            and request_event.action == ActivityAction.BORROWED_CANCELLED.value
            and (request_event.details or {}).get("request_fingerprint") == fingerprint
        ):
            return record_detail(db, household_id, record.id, on_date=on_date)
        raise ApiError(409, "request_id_reused", "That request id was used for another action.")
    if record.status == LoanStatus.CANCELLED.value:
        return record_detail(db, household_id, record.id, on_date=on_date)
    if record.returned_quantity > 0 or db.scalar(
        select(func.count(BorrowedReturn.id)).where(
            BorrowedReturn.household_id == household_id,
            BorrowedReturn.borrowed_record_id == record.id,
        )
    ):
        raise ApiError(
            409,
            "borrowed_record_has_returns",
            "A borrowed record with return history cannot be cancelled. Correct it or "
            "record the remaining return instead.",
        )
    details = _event_details(record)
    details["reason"] = reason
    details["request_fingerprint"] = fingerprint
    record.status = LoanStatus.CANCELLED.value
    record.cancelled_at = datetime.now(UTC)
    db.flush()
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.BORROWED_CANCELLED.value,
        entity_type="borrowed",
        entity_id=record.id,
        borrowed_item_id=record.id,
        summary=(
            f"Cancelled borrowed record for {record.quantity} × {record.item_name} "
            f"from {record.owner_name}"
        ),
        details=details,
        request_id=request_id,
    )
    return record_detail(db, household_id, record.id, on_date=on_date)


def _photo_for_record(
    db: Session, household_id: uuid.UUID, record_id: uuid.UUID
) -> BorrowedPhoto | None:
    return db.scalar(
        select(BorrowedPhoto).where(
            BorrowedPhoto.household_id == household_id,
            BorrowedPhoto.borrowed_record_id == record_id,
        )
    )


def get_photo(db: Session, household_id: uuid.UUID, record_id: uuid.UUID) -> BorrowedPhoto:
    get_record(db, household_id, record_id)
    photo = _photo_for_record(db, household_id, record_id)
    if photo is None:
        raise ApiError(404, "borrowed_photo_not_found", "Borrowed-item photo not found.")
    return photo


def set_photo(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    upload,  # noqa: ANN001
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> PhotoMutation:
    record = get_record(db, household_id, record_id, for_update=True)
    if record.status == LoanStatus.CANCELLED.value:
        raise ApiError(409, "borrowed_record_cancelled", "A cancelled record cannot be changed.")
    old = _photo_for_record(db, household_id, record.id)
    old_keys = [old.storage_key, old.thumbnail_key] if old else []
    stored = storage.store_entity_photo("borrowed", record.id, upload)
    try:
        if old is not None:
            db.delete(old)
            db.flush()
        photo = BorrowedPhoto(
            household_id=household_id,
            borrowed_record_id=record.id,
            storage_key=stored.storage_key,
            thumbnail_key=stored.thumbnail_key,
            original_filename=stored.original_filename,
            content_type=stored.content_type,
            byte_size=stored.byte_size,
            width=stored.width,
            height=stored.height,
        )
        db.add(photo)
        db.flush()
        history.record_event(
            db,
            household_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            action=ActivityAction.BORROWED_PHOTO_UPDATED.value,
            entity_type="borrowed",
            entity_id=record.id,
            borrowed_item_id=record.id,
            summary=(
                f"Updated the private photo for {record.item_name} borrowed from "
                f"{record.owner_name}"
            ),
            details=_event_details(record),
        )
        detail = record_detail(db, household_id, record.id)
    except Exception:
        storage.delete_key(stored.storage_key)
        storage.delete_key(stored.thumbnail_key)
        raise
    return PhotoMutation(
        detail=detail,
        old_keys=[key for key in old_keys if key],
        new_keys=[stored.storage_key, stored.thumbnail_key],
    )


def remove_photo(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> PhotoMutation:
    record = get_record(db, household_id, record_id, for_update=True)
    photo = _photo_for_record(db, household_id, record.id)
    if photo is None:
        raise ApiError(404, "borrowed_photo_not_found", "Borrowed-item photo not found.")
    old_keys = [photo.storage_key, photo.thumbnail_key]
    db.delete(photo)
    db.flush()
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.BORROWED_PHOTO_REMOVED.value,
        entity_type="borrowed",
        entity_id=record.id,
        borrowed_item_id=record.id,
        summary=(
            f"Removed the private photo for {record.item_name} borrowed from {record.owner_name}"
        ),
        details=_event_details(record),
    )
    return PhotoMutation(
        detail=record_detail(db, household_id, record.id),
        old_keys=[key for key in old_keys if key],
        new_keys=[],
    )


def validate_place(
    db: Session,
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None,
    room_id: uuid.UUID | None,
    storage_location_id: uuid.UUID | None,
) -> None:
    _resolve_place(
        db,
        household_id,
        property_id=property_id,
        room_id=room_id,
        storage_location_id=storage_location_id,
    )


def borrowed_summary(
    db: Session, household_id: uuid.UUID, *, on_date: date | None = None
) -> BorrowedTotals:
    return borrowed_totals(db, household_id, today=on_date)


def find_owned_items_matching(
    db: Session, household_id: uuid.UUID, q: str, *, limit: int = 5
) -> list[Item]:
    term = q.strip()
    if not term:
        return []
    search = f"%{term}%"
    return list(
        db.scalars(
            select(Item)
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                or_(
                    Item.name.ilike(search),
                    Item.brand.ilike(search),
                    Item.model.ilike(search),
                ),
            )
            .order_by(func.lower(Item.name))
            .limit(limit)
        ).all()
    )


def history_for_record(
    db: Session,
    household_id: uuid.UUID,
    record_id: uuid.UUID,
    *,
    limit: int = 50,
    offset: int = 0,
):
    get_record(db, household_id, record_id)
    events = history.history_for_borrowed(db, household_id, record_id, limit=limit + offset)
    return events[offset:]


__all__ = [
    "BorrowedTotals",
    "PhotoMutation",
    "borrowed_summary",
    "borrowed_totals",
    "cancel_record",
    "correct_record",
    "create_record",
    "create_return",
    "find_owned_items_matching",
    "get_photo",
    "has_held_stock",
    "location_prefix",
    "get_record",
    "history_for_record",
    "list_records",
    "matching_records",
    "quick_search_records",
    "record_detail",
    "remove_photo",
    "set_photo",
    "validate_place",
]
