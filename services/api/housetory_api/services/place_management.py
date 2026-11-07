"""Preview and atomically move/empty room and storage-place contents.

These operations only move inventory records. Deleting a source always happens
after every item, nested place, child room and active borrowed placement has been
moved or reparented inside the same transaction.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, joinedload

from ..api.errors import ApiError
from ..domain import ActivityAction, LoanStatus
from ..models import BorrowedRecord, Item, LocationPhoto, Room, RoomPhoto, StorageLocation
from ..schemas.items import ItemUpdate
from ..schemas.place_management import (
    PlaceDestinationOut,
    PlacePreviewItemOut,
    PlacePreviewLocationOut,
    PlacePreviewRoomOut,
    PlaceTransferPreviewOut,
    PlaceTransferRequest,
    PlaceTransferResult,
)
from . import history, lending
from .containers import (
    household_hierarchy_lock,
    location_breadcrumb,
    room_ancestors,
    tombstone_location,
)
from .hierarchy import descendant_ids
from .items import update_item_record

ACTIVE_BORROWED_STATUSES = (
    LoanStatus.OUTSTANDING.value,
    LoanStatus.PARTIALLY_RETURNED.value,
)
PREVIEW_ITEM_LIMIT = 12
PREVIEW_PLACE_LIMIT = 12


@dataclass
class _Destination:
    room: Room
    location: StorageLocation | None
    out: PlaceDestinationOut


@dataclass
class _Scope:
    kind: str
    source_id: uuid.UUID
    source_label: str
    source_path: list[str]
    property_id: uuid.UUID
    property_name: str
    source_room: Room | None
    source_location: StorageLocation | None
    rooms: list[Room]
    locations: list[StorageLocation]
    items: list[Item]
    borrowed: list[BorrowedRecord]
    on_loan: dict[uuid.UUID, int]
    source_photo_count: int

    @property
    def room_ids(self) -> set[uuid.UUID]:
        return {room.id for room in self.rooms}

    @property
    def location_ids(self) -> set[uuid.UUID]:
        return {location.id for location in self.locations}

    @property
    def direct_items(self) -> list[Item]:
        if self.kind == "location":
            return [item for item in self.items if item.storage_location_id == self.source_id]
        return [
            item
            for item in self.items
            if item.room_id == self.source_id and item.storage_location_id is None
        ]

    @property
    def direct_child_rooms(self) -> list[Room]:
        return [room for room in self.rooms if room.parent_id == self.source_id]


def _room_path(rooms: list[Room], room: Room) -> list[str]:
    by_id = {entry.id: entry for entry in rooms}
    labels: list[str] = []
    cursor: Room | None = room
    seen: set[uuid.UUID] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        labels.append(cursor.name)
        cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
    labels.reverse()
    return labels


def _location_path(locations: list[StorageLocation], location_id: uuid.UUID) -> list[str]:
    by_id = {entry.id: entry for entry in locations}
    labels: list[str] = []
    cursor = by_id.get(location_id)
    seen: set[uuid.UUID] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        labels.append(cursor.identifier or cursor.name)
        cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
    labels.reverse()
    return labels


def _item_place_label(scope: _Scope, item: Item) -> str:
    if item.storage_location_id:
        room = next(
            (entry for entry in scope.rooms if entry.id == item.room_id),
            scope.source_room,
        )
        room_labels = _room_path(scope.rooms, room) if room is not None else []
        return " / ".join(
            [
                *room_labels,
                *_location_path(scope.locations, item.storage_location_id),
            ]
        )
    room = next((entry for entry in scope.rooms if entry.id == item.room_id), None)
    return " / ".join(_room_path(scope.rooms, room)) if room is not None else "No room"


def _load_scope(
    db: Session,
    household_id: uuid.UUID,
    kind: str,
    source_id: uuid.UUID,
    *,
    lock_items: bool = False,
) -> _Scope:
    if kind == "location":
        location_rows = list(
            db.execute(
                select(StorageLocation.id, StorageLocation.parent_id).where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.active(),
                )
            ).all()
        )
        subtree = descendant_ids(location_rows, source_id)
        locations = list(
            db.scalars(
                select(StorageLocation)
                .options(joinedload(StorageLocation.room).joinedload(Room.property))
                .where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.active(),
                    StorageLocation.id.in_(subtree),
                )
                .order_by(StorageLocation.id)
            ).all()
        )
        source = next((entry for entry in locations if entry.id == source_id), None)
        if source is None:
            raise ApiError(404, "place_not_found", "Storage place not found.")
        room = source.room
        property_record = room.property
        rooms = [room]
        items_query = select(Item).where(
            Item.household_id == household_id,
            Item.storage_location_id.in_(subtree),
        )
        if lock_items:
            items_query = items_query.with_for_update()
        items = list(db.scalars(items_query.order_by(func.lower(Item.name), Item.id)).all())
        borrowed_query = select(BorrowedRecord).where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.status.in_(ACTIVE_BORROWED_STATUSES),
            BorrowedRecord.storage_location_id.in_(subtree),
        )
        if lock_items:
            borrowed_query = borrowed_query.with_for_update()
        borrowed = list(db.scalars(borrowed_query).all())
        source_photo_count = int(
            db.scalar(
                select(func.count(LocationPhoto.id)).where(LocationPhoto.location_id == source.id)
            )
            or 0
        )
        path = (
            [property_record.name]
            + [entry.name for entry in room_ancestors(db, household_id, room.id)]
            + [
                entry.identifier or entry.name
                for entry in location_breadcrumb(db, household_id, source.id)
            ]
        )
        source_label = source.identifier or source.name
    elif kind == "room":
        room_rows = list(
            db.execute(
                select(Room.id, Room.parent_id).where(Room.household_id == household_id)
            ).all()
        )
        subtree = descendant_ids(room_rows, source_id)
        rooms = list(
            db.scalars(
                select(Room)
                .options(joinedload(Room.property))
                .where(Room.household_id == household_id, Room.id.in_(subtree))
                .order_by(Room.id)
            ).all()
        )
        source = next((entry for entry in rooms if entry.id == source_id), None)
        if source is None:
            raise ApiError(404, "place_not_found", "Room not found.")
        locations = list(
            db.scalars(
                select(StorageLocation)
                .options(joinedload(StorageLocation.room).joinedload(Room.property))
                .where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.active(),
                    StorageLocation.room_id.in_(subtree),
                )
                .order_by(StorageLocation.id)
            ).all()
        )
        items_query = select(Item).where(
            Item.household_id == household_id,
            Item.room_id.in_(subtree),
        )
        if lock_items:
            items_query = items_query.with_for_update()
        items = list(db.scalars(items_query.order_by(func.lower(Item.name), Item.id)).all())
        borrowed_query = select(BorrowedRecord).where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.status.in_(ACTIVE_BORROWED_STATUSES),
            BorrowedRecord.room_id.in_(subtree),
        )
        if lock_items:
            borrowed_query = borrowed_query.with_for_update()
        borrowed = list(db.scalars(borrowed_query).all())
        source_photo_count = int(
            db.scalar(select(func.count(RoomPhoto.id)).where(RoomPhoto.room_id == source.id)) or 0
        )
        property_record = source.property
        path = [
            property_record.name,
            *[entry.name for entry in room_ancestors(db, household_id, source.id)],
        ]
        source_label = source.name
        room = source
    else:
        raise ApiError(422, "invalid_place_kind", "Choose a room or storage place.")
    on_loan = lending.loan_quantities_for_items(db, household_id, [item.id for item in items])
    return _Scope(
        kind=kind,
        source_id=source_id,
        source_label=source_label,
        source_path=path,
        property_id=property_record.id,
        property_name=property_record.name,
        source_room=room,
        source_location=source if kind == "location" else None,
        rooms=rooms,
        locations=locations,
        items=items,
        borrowed=borrowed,
        on_loan=on_loan,
        source_photo_count=source_photo_count,
    )


def _destination_out(
    db: Session, household_id: uuid.UUID, room: Room, location: StorageLocation | None
) -> PlaceDestinationOut:
    return PlaceDestinationOut(
        property_id=room.property_id,
        property_name=room.property.name,
        room_id=room.id,
        room_name=room.name,
        location_id=location.id if location is not None else None,
        location_name=location.name if location is not None else None,
        location_identifier=location.identifier if location is not None else None,
        path=[
            room.property.name,
            *[entry.name for entry in room_ancestors(db, household_id, room.id)],
            *(
                [
                    entry.identifier or entry.name
                    for entry in location_breadcrumb(db, household_id, location.id)
                ]
                if location is not None
                else []
            ),
        ],
    )


def _resolve_destination(
    db: Session,
    household_id: uuid.UUID,
    scope: _Scope,
    destination_room_id: uuid.UUID | None,
    destination_location_id: uuid.UUID | None,
) -> tuple[_Destination | None, list[str]]:
    blockers: list[str] = []
    if destination_room_id is None:
        return None, ["Choose a destination room."]
    room = db.scalar(
        select(Room)
        .options(joinedload(Room.property))
        .where(Room.id == destination_room_id, Room.household_id == household_id)
    )
    if room is None:
        return None, ["The destination room is unavailable. Refresh and choose again."]
    location = None
    if destination_location_id is not None:
        location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == destination_location_id,
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        )
        if location is None:
            blockers.append(
                "The destination storage place is unavailable. Refresh and choose again."
            )
        elif location.room_id != room.id:
            blockers.append("The destination storage place belongs to a different room.")
    if scope.kind == "location":
        if location is not None and location.id in scope.location_ids:
            blockers.append("Choose a destination outside the source place and its nested places.")
    else:
        if room.id in scope.room_ids:
            blockers.append("Choose a destination outside the source room and its sub-rooms.")
        if room.property_id != scope.property_id:
            blockers.append(
                "Choose a destination room in the same property. Child rooms are "
                "reparented without changing property."
            )
    if blockers:
        return None, blockers
    return _Destination(
        room=room, location=location, out=_destination_out(db, household_id, room, location)
    ), []


def _fingerprint(scope: _Scope, destination: _Destination) -> str:
    payload = {
        "kind": scope.kind,
        "source_id": str(scope.source_id),
        "destination_room_id": str(destination.room.id),
        "destination_location_id": (
            str(destination.location.id) if destination.location is not None else None
        ),
        "rooms": [
            {
                "id": str(room.id),
                "parent_id": str(room.parent_id) if room.parent_id else None,
                "property_id": str(room.property_id),
                "updated_at": room.updated_at.isoformat() if room.updated_at else None,
            }
            for room in sorted(scope.rooms, key=lambda entry: str(entry.id))
        ],
        "locations": [
            {
                "id": str(location.id),
                "parent_id": str(location.parent_id) if location.parent_id else None,
                "room_id": str(location.room_id),
                "updated_at": (location.updated_at.isoformat() if location.updated_at else None),
            }
            for location in sorted(scope.locations, key=lambda entry: str(entry.id))
        ],
        "items": [
            {
                "id": str(item.id),
                "room_id": str(item.room_id) if item.room_id else None,
                "storage_location_id": (
                    str(item.storage_location_id) if item.storage_location_id else None
                ),
                "quantity": item.quantity,
                "is_archived": item.is_archived,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            }
            for item in sorted(scope.items, key=lambda entry: str(entry.id))
        ],
        "borrowed": [
            {
                "id": str(record.id),
                "room_id": str(record.room_id) if record.room_id else None,
                "storage_location_id": (
                    str(record.storage_location_id) if record.storage_location_id else None
                ),
                "status": record.status,
                "updated_at": record.updated_at.isoformat() if record.updated_at else None,
            }
            for record in sorted(scope.borrowed, key=lambda entry: str(entry.id))
        ],
        "destination_room_updated_at": (
            destination.room.updated_at.isoformat() if destination.room.updated_at else None
        ),
        "destination_location_updated_at": (
            destination.location.updated_at.isoformat()
            if destination.location is not None and destination.location.updated_at
            else None
        ),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _request_fingerprint(
    kind: str,
    source_id: uuid.UUID,
    payload: PlaceTransferRequest,
) -> str:
    serialized = json.dumps(
        {
            "kind": kind,
            "source_id": str(source_id),
            "destination_room_id": str(payload.destination_room_id),
            "destination_location_id": (
                str(payload.destination_location_id) if payload.destination_location_id else None
            ),
            "delete_source": payload.delete_source,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _replay(
    db: Session,
    household_id: uuid.UUID,
    request_id: uuid.UUID,
    action: str,
    request_fingerprint: str,
) -> PlaceTransferResult | None:
    event = history.find_request_event(db, household_id, request_id)
    if event is None:
        return None
    if (
        event.action != action
        or (event.details or {}).get("request_fingerprint") != request_fingerprint
    ):
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was used for a different place transfer.",
        )
    result = (event.details or {}).get("result")
    if not isinstance(result, dict):
        raise ApiError(409, "request_id_reused", "The prior transfer result is unavailable.")
    return PlaceTransferResult.model_validate(result)


def _preview_counts(scope: _Scope) -> tuple[int, int, int]:
    direct = scope.direct_items
    direct_ids = {item.id for item in direct}
    nested = [item for item in scope.items if item.id not in direct_ids]
    return len(direct), len(nested), sum(item.quantity for item in scope.items)


def _root_locations(scope: _Scope) -> list[StorageLocation]:
    if scope.kind == "location":
        return [location for location in scope.locations if location.parent_id == scope.source_id]
    return [
        location
        for location in scope.locations
        if location.room_id == scope.source_id and location.parent_id is None
    ]


def _location_totals(scope: _Scope) -> dict[uuid.UUID, tuple[int, int]]:
    counts: dict[uuid.UUID, tuple[int, int]] = {}
    rows = [(location.id, location.parent_id) for location in scope.locations]
    by_location: dict[uuid.UUID, list[Item]] = {}
    for item in scope.items:
        if item.storage_location_id:
            by_location.setdefault(item.storage_location_id, []).append(item)
    for location in scope.locations:
        subtree = descendant_ids(rows, location.id)
        items = [item for item in scope.items if item.storage_location_id in subtree]
        counts[location.id] = (len(items), sum(item.quantity for item in items))
    return counts


def _room_totals(scope: _Scope) -> dict[uuid.UUID, int]:
    room_rows = [(room.id, room.parent_id) for room in scope.rooms]
    return {
        room.id: sum(
            1 for item in scope.items if item.room_id in descendant_ids(room_rows, room.id)
        )
        for room in scope.rooms
    }


def _preview_out(
    db: Session,
    household_id: uuid.UUID,
    scope: _Scope,
    destination: _Destination | None,
    blockers: list[str],
) -> PlaceTransferPreviewOut:
    direct_count, nested_count, total_quantity = _preview_counts(scope)
    archived_count = sum(1 for item in scope.items if item.is_archived)
    on_loan = sum(scope.on_loan.values())
    direct_items = scope.direct_items
    direct_ids = {item.id for item in direct_items}
    ordered_items = sorted(
        scope.items,
        key=lambda item: (item.id not in direct_ids, item.name.lower(), str(item.id)),
    )
    location_totals = _location_totals(scope)
    room_totals = _room_totals(scope)
    nested_places = _root_locations(scope)
    child_rooms = scope.direct_child_rooms if scope.kind == "room" else []
    warnings: list[str] = []
    if archived_count:
        warnings.append(f"{archived_count} archived item(s) are included and will move too.")
    if on_loan:
        warnings.append(
            f"{on_loan} unit(s) are on loan. Loan records stay unchanged; only the "
            "home placement moves."
        )
    if scope.borrowed:
        warnings.append(
            f"{len(scope.borrowed)} active borrowed record(s) will follow the contents."
        )
    if scope.kind == "room" and scope.direct_child_rooms:
        warnings.append(
            f"{len(scope.direct_child_rooms)} sub-room(s) will be reparented "
            "under the destination room."
        )
    if scope.kind == "location" and len(scope.locations) > 1:
        warnings.append(
            f"{len(scope.locations) - 1} nested place(s) keep their identifiers and "
            "move with their contents."
        )
    if scope.kind == "room" and scope.locations:
        warnings.append(
            f"{len(scope.locations)} storage place(s) in this room keep their "
            "identifiers and move with their contents."
        )
    if scope.kind == "room":
        recoverable_deleted = int(
            db.scalar(
                select(func.count(StorageLocation.id)).where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.room_id.in_(scope.room_ids),
                    StorageLocation.deleted_at.is_not(None),
                )
            )
            or 0
        )
        if recoverable_deleted:
            warnings.append(
                f"{recoverable_deleted} recoverable-deleted place(s) are retained in "
                "this room. Room deletion stays blocked until they are restored or "
                "explicitly resolved."
            )
    if scope.kind == "location" and scope.source_location is not None:
        recoverable_children = int(
            db.scalar(
                select(func.count(StorageLocation.id)).where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.parent_id == scope.source_location.id,
                    StorageLocation.deleted_at.is_not(None),
                )
            )
            or 0
        )
        if recoverable_children:
            warnings.append(
                f"{recoverable_children} recoverable-deleted nested place(s) are "
                "retained here. Deleting this place would leave them without a live "
                "parent, so their own restore would be blocked."
            )
    if scope.source_photo_count:
        warnings.append(
            f"{scope.source_photo_count} attached photo(s) belong to the source itself "
            "and will be permanently removed if it is deleted."
        )
    return PlaceTransferPreviewOut(
        source_kind=scope.kind,  # type: ignore[arg-type]
        source_id=scope.source_id,
        source_label=scope.source_label,
        source_path=scope.source_path,
        destination=destination.out if destination is not None else None,
        direct_item_count=direct_count,
        nested_item_count=nested_count,
        total_item_count=len(scope.items),
        total_quantity=total_quantity,
        archived_item_count=archived_count,
        on_loan_quantity=on_loan,
        nested_place_count=(
            max(0, len(scope.locations) - 1) if scope.kind == "location" else len(scope.locations)
        ),
        child_room_count=len(scope.direct_child_rooms) if scope.kind == "room" else 0,
        borrowed_record_count=len(scope.borrowed),
        source_photo_count=scope.source_photo_count,
        items_preview=[
            PlacePreviewItemOut(
                id=item.id,
                name=item.name,
                quantity=item.quantity,
                is_archived=item.is_archived,
                place_label=_item_place_label(scope, item),
                on_loan_quantity=scope.on_loan.get(item.id, 0),
            )
            for item in ordered_items[:PREVIEW_ITEM_LIMIT]
        ],
        nested_places_preview=[
            PlacePreviewLocationOut(
                id=location.id,
                name=location.name,
                identifier=location.identifier,
                kind=location.kind,
                is_container=location.is_container,
                total_item_count=location_totals.get(location.id, (0, 0))[0],
                total_quantity=location_totals.get(location.id, (0, 0))[1],
            )
            for location in nested_places[:PREVIEW_PLACE_LIMIT]
        ],
        child_rooms_preview=[
            PlacePreviewRoomOut(
                id=room.id,
                name=room.name,
                total_item_count=room_totals.get(room.id, 0),
            )
            for room in child_rooms[:PREVIEW_PLACE_LIMIT]
        ],
        blockers=blockers,
        warnings=warnings,
        can_proceed=bool(destination is not None and not blockers),
        fingerprint=_fingerprint(scope, destination) if destination is not None else "",
    )


def preview_place_transfer(
    db: Session,
    household_id: uuid.UUID,
    kind: str,
    source_id: uuid.UUID,
    *,
    destination_room_id: uuid.UUID | None,
    destination_location_id: uuid.UUID | None,
) -> PlaceTransferPreviewOut:
    scope = _load_scope(db, household_id, kind, source_id)
    destination, blockers = _resolve_destination(
        db, household_id, scope, destination_room_id, destination_location_id
    )
    return _preview_out(db, household_id, scope, destination, blockers)


def _set_borrowed_destination(
    record: BorrowedRecord,
    destination: _Destination,
) -> None:
    record.property_id = destination.room.property_id
    record.property_name_snapshot = destination.room.property.name
    record.room_id = destination.room.id
    record.room_name_snapshot = destination.room.name
    record.storage_location_id = (
        destination.location.id if destination.location is not None else None
    )
    record.location_name_snapshot = (
        destination.location.name if destination.location is not None else None
    )
    record.location_identifier_snapshot = (
        destination.location.identifier if destination.location is not None else None
    )


def _set_borrowed_room(record: BorrowedRecord, destination: _Destination) -> None:
    record.property_id = destination.room.property_id
    record.property_name_snapshot = destination.room.property.name
    record.room_id = destination.room.id
    record.room_name_snapshot = destination.room.name


def _assert_location_empty(db: Session, household_id: uuid.UUID, source: StorageLocation) -> None:
    has_children = db.scalar(
        select(StorageLocation.id)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.parent_id == source.id,
            StorageLocation.active(),
        )
        .limit(1)
    )
    has_items = db.scalar(
        select(Item.id)
        .where(
            Item.household_id == household_id,
            Item.storage_location_id == source.id,
        )
        .limit(1)
    )
    has_borrowed = db.scalar(
        select(BorrowedRecord.id)
        .where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.status.in_(ACTIVE_BORROWED_STATUSES),
            BorrowedRecord.storage_location_id == source.id,
        )
        .limit(1)
    )
    if has_children or has_items or has_borrowed:
        raise ApiError(
            409,
            "place_not_emptied",
            "The source still has direct contents after the move; nothing was deleted.",
        )


def _assert_room_empty(db: Session, household_id: uuid.UUID, source: Room) -> None:
    has_children = db.scalar(
        select(Room.id)
        .where(Room.household_id == household_id, Room.parent_id == source.id)
        .limit(1)
    )
    has_locations = db.scalar(
        select(StorageLocation.id)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.room_id == source.id,
        )
        .limit(1)
    )
    has_items = db.scalar(
        select(Item.id).where(Item.household_id == household_id, Item.room_id == source.id).limit(1)
    )
    has_borrowed = db.scalar(
        select(BorrowedRecord.id)
        .where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.status.in_(ACTIVE_BORROWED_STATUSES),
            BorrowedRecord.room_id == source.id,
            BorrowedRecord.storage_location_id.is_(None),
        )
        .limit(1)
    )
    if has_children or has_locations or has_items or has_borrowed:
        raise ApiError(
            409,
            "place_not_emptied",
            "The room still has active or recoverable-deleted places/contents; "
            "nothing was deleted. Restore or explicitly resolve recoverable places first.",
        )


def transfer_place_contents(
    db: Session,
    household_id: uuid.UUID,
    kind: str,
    source_id: uuid.UUID,
    payload: PlaceTransferRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> PlaceTransferResult:
    action = (
        ActivityAction.PLACE_CONTENTS_MOVED_AND_DELETED.value
        if kind == "location" and payload.delete_source
        else ActivityAction.PLACE_CONTENTS_MOVED.value
        if kind == "location"
        else ActivityAction.ROOM_CONTENTS_MOVED_AND_DELETED.value
        if payload.delete_source
        else ActivityAction.ROOM_CONTENTS_MOVED.value
    )
    request_fingerprint = _request_fingerprint(kind, source_id, payload)
    household_hierarchy_lock(db, household_id)
    replayed = _replay(db, household_id, payload.request_id, action, request_fingerprint)
    if replayed is not None:
        return replayed

    scope = _load_scope(db, household_id, kind, source_id, lock_items=True)
    destination, blockers = _resolve_destination(
        db,
        household_id,
        scope,
        payload.destination_room_id,
        payload.destination_location_id,
    )
    if blockers or destination is None:
        raise ApiError(
            422,
            "place_destination_invalid",
            " ".join(blockers) or "Choose a valid destination.",
        )
    current_fingerprint = _fingerprint(scope, destination)
    if payload.expected_fingerprint != current_fingerprint:
        raise ApiError(
            409,
            "place_contents_changed",
            "The source contents or destination changed since the preview. "
            "Refresh and review again.",
        )

    direct_items = scope.direct_items
    direct_item_ids = [item.id for item in direct_items]
    nested_items = [item for item in scope.items if item.id not in set(direct_item_ids)]
    now = datetime.now(UTC)
    batch_id = uuid.uuid4()
    history_context = {
        "batch_id": str(batch_id),
        "batch_action": action,
        "batch_item_count": len(scope.items),
        "direct_item_count": len(direct_items),
    }
    borrowed_moved = 0
    nested_places_moved = 0
    child_rooms_moved = 0

    if kind == "location":
        source = scope.source_location
        assert source is not None
        subtree_ids = [location.id for location in scope.locations]
        descendant_location_ids = [
            location_id for location_id in subtree_ids if location_id != source.id
        ]
        nested_places_moved = len(descendant_location_ids)
        db.execute(
            update(Item)
            .where(
                Item.household_id == household_id,
                Item.storage_location_id.in_(subtree_ids),
            )
            .values(room_id=destination.room.id, updated_at=now)
            .execution_options(synchronize_session=False)
        )
        for item in direct_items:
            update_item_record(
                db,
                household_id,
                item,
                ItemUpdate(
                    room_id=destination.room.id,
                    storage_location_id=(
                        destination.location.id if destination.location is not None else None
                    ),
                ),
                actor_user_id=actor_user_id,
                actor_name=actor_name,
                history_context=history_context,
            )
        direct_children = [
            location
            for location in scope.locations
            if location.parent_id == source.id and location.id != source.id
        ]
        for location in scope.locations:
            if location.id == source.id:
                continue
            location.room_id = destination.room.id
            location.updated_at = now
        for child in direct_children:
            child.parent_id = destination.location.id if destination.location is not None else None
        db.flush()
        for record in scope.borrowed:
            if record.storage_location_id == source.id:
                _set_borrowed_destination(record, destination)
                record.updated_at = now
                borrowed_moved += 1
            elif record.storage_location_id in descendant_location_ids:
                _set_borrowed_room(record, destination)
                record.updated_at = now
                borrowed_moved += 1
        db.flush()
        if payload.delete_source:
            db.expire_all()
            source = db.scalar(
                select(StorageLocation).where(
                    StorageLocation.id == source_id,
                    StorageLocation.household_id == household_id,
                    StorageLocation.active(),
                )
            )
            if source is None:
                raise ApiError(404, "place_not_found", "Storage place not found.")
            _assert_location_empty(db, household_id, source)
            tombstone_location(
                db,
                household_id,
                source,
                actor_user_id=actor_user_id,
                actor_name=actor_name,
                record_event=False,
            )
    else:
        source_room = scope.source_room
        assert source_room is not None
        source_locations = [
            location for location in scope.locations if location.room_id == source_room.id
        ]
        source_location_ids = [location.id for location in source_locations]
        root_locations = [location for location in source_locations if location.parent_id is None]
        nested_places_moved = len(scope.locations)
        child_rooms = scope.direct_child_rooms
        child_rooms_moved = len(child_rooms)
        for item in direct_items:
            update_item_record(
                db,
                household_id,
                item,
                ItemUpdate(
                    room_id=destination.room.id,
                    storage_location_id=(
                        destination.location.id if destination.location is not None else None
                    ),
                ),
                actor_user_id=actor_user_id,
                actor_name=actor_name,
                history_context=history_context,
            )
        if source_location_ids:
            db.execute(
                update(Item)
                .where(
                    Item.household_id == household_id,
                    Item.storage_location_id.in_(source_location_ids),
                )
                .values(room_id=destination.room.id, updated_at=now)
                .execution_options(synchronize_session=False)
            )
        for location in source_locations:
            location.room_id = destination.room.id
            location.updated_at = now
        for location in root_locations:
            location.parent_id = (
                destination.location.id if destination.location is not None else None
            )
        for room in child_rooms:
            room.parent_id = destination.room.id
            room.updated_at = now
        db.flush()
        for record in scope.borrowed:
            if record.storage_location_id in source_location_ids:
                _set_borrowed_room(record, destination)
                record.updated_at = now
                borrowed_moved += 1
            elif record.room_id == source_room.id and record.storage_location_id is None:
                _set_borrowed_destination(record, destination)
                record.updated_at = now
                borrowed_moved += 1
        db.flush()
        if payload.delete_source:
            db.expire_all()
            source_room = db.scalar(
                select(Room).where(Room.id == source_id, Room.household_id == household_id)
            )
            if source_room is None:
                raise ApiError(404, "place_not_found", "Room not found.")
            _assert_room_empty(db, household_id, source_room)
            db.delete(source_room)
            db.flush()

    summary_verb = "Moved all contents of"
    summary_tail = (
        f"to {destination.out.path[-1] if destination.out.path else destination.room.name}"
    )
    if payload.delete_source:
        summary_verb = "Emptied and deleted"
        summary_tail = (
            f"; inventory moved to "
            f"{destination.out.path[-1] if destination.out.path else destination.room.name}"
        )
    summary_source = (
        f"{scope.source_label} ({scope.kind})" if scope.kind == "room" else scope.source_label
    )
    event = history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action,
        entity_type="container" if kind == "location" else "room",
        entity_id=source_id,
        container_id=source_id if kind == "location" else None,
        summary=(
            f"{summary_verb} {summary_source} {summary_tail} · "
            f"{len(scope.items)} item(s), {sum(item.quantity for item in scope.items)} unit(s)"
        ),
        details={
            "request_fingerprint": request_fingerprint,
            "source_kind": kind,
            "source_id": str(source_id),
            "source_label": scope.source_label,
            "source_path": scope.source_path,
            "destination": destination.out.model_dump(mode="json"),
            "delete_source": payload.delete_source,
            "direct_item_count": len(direct_items),
            "nested_item_count": len(nested_items),
            "total_item_count": len(scope.items),
            "total_quantity": sum(item.quantity for item in scope.items),
            "archived_item_count": sum(1 for item in scope.items if item.is_archived),
            "on_loan_quantity": sum(scope.on_loan.values()),
            "nested_place_count": nested_places_moved,
            "child_room_count": child_rooms_moved,
            "borrowed_record_count": borrowed_moved,
            "source_photo_count": scope.source_photo_count,
            "direct_item_ids": [str(value) for value in direct_item_ids],
            "scope_location_ids": [str(value) for value in scope.location_ids],
            "scope_room_ids": [str(value) for value in scope.room_ids],
        },
        request_id=payload.request_id,
    )
    result = PlaceTransferResult(
        request_id=payload.request_id,
        history_event_id=event.id,
        source_kind=kind,  # type: ignore[arg-type]
        source_id=source_id,
        source_label=scope.source_label,
        deleted=payload.delete_source,
        direct_items_moved=len(direct_items),
        nested_items_moved=len(nested_items),
        total_items_preserved=len(scope.items),
        total_quantity=sum(item.quantity for item in scope.items),
        nested_places_moved=nested_places_moved,
        child_rooms_moved=child_rooms_moved,
        borrowed_records_moved=borrowed_moved,
        on_loan_quantity=sum(scope.on_loan.values()),
        destination=destination.out,
    )
    event.details = {
        **(event.details or {}),
        "result": result.model_dump(mode="json"),
    }
    db.flush()
    return result


__all__ = ["preview_place_transfer", "transfer_place_contents"]
