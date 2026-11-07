"""Owned items that provide a storage place for other inventory items.

The storage place remains a normal ``StorageLocation`` with its existing
identifier, QR code and hierarchy. ``StorageLocation.owner_item_id`` is the
one-to-one link to the owned item. The owner item's own ``storage_location_id``
stays outside that place, so every item keeps exactly one current location and
the owner/contents relationship never creates a second inventory record.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import (
    ActivityAction,
    ContainerType,
    ItemCondition,
    LoanStatus,
    prefix_for_container_type,
)
from ..models import BorrowedRecord, Item, StorageLocation
from ..schemas.items import ItemStorageOut, StorageCategoryCount
from . import history
from .container_serializers import qr_urls
from .containers import (
    allocate_identifiers,
    get_location,
    household_hierarchy_lock,
    live_summary,
    load_container_items,
    location_breadcrumb,
    move_container,
    tombstone_location,
)
from .hierarchy import descendant_ids

ACTIVE_BORROWED_STATUSES = (
    LoanStatus.OUTSTANDING.value,
    LoanStatus.PARTIALLY_RETURNED.value,
)


def owned_location(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    active_only: bool = False,
    for_update: bool = False,
) -> StorageLocation | None:
    query = select(StorageLocation).where(
        StorageLocation.household_id == household_id,
        StorageLocation.owner_item_id == item_id,
    )
    if active_only:
        query = query.where(StorageLocation.active())
    if for_update:
        query = query.with_for_update()
    return db.scalar(query)


def _item_location_path(db: Session, household_id: uuid.UUID, location: StorageLocation) -> list:
    if location.deleted_at is None:
        return location_breadcrumb(db, household_id, location.id)
    # A removed storage capability remains visible on the item page so it can be
    # restored with the same identifier. Its parent chain is still safe to show.
    breadcrumb = []
    seen: set[uuid.UUID] = set()
    cursor: StorageLocation | None = location
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        breadcrumb.append(cursor)
        cursor = db.get(StorageLocation, cursor.parent_id) if cursor.parent_id else None
    breadcrumb.reverse()
    from .containers import location_brief

    return [location_brief(entry) for entry in breadcrumb]


def storage_out(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
) -> ItemStorageOut | None:
    location = owned_location(db, household_id, item_id)
    if location is None:
        return None
    path = _item_location_path(db, household_id, location)
    active = location.deleted_at is None
    if active:
        items = load_container_items(db, household_id, location.id)
        live = live_summary(db, household_id, location, items=items)
        payload, qr_endpoint, warning = qr_urls(location)
    else:
        items = []
        live = None
        payload = None
        qr_endpoint = None
        warning = None
    categories = (
        [StorageCategoryCount.model_validate(entry) for entry in live.categories]
        if live is not None
        else []
    )
    return ItemStorageOut(
        location_id=location.id,
        identifier=location.identifier,
        name=location.name,
        active=active,
        room_id=location.room_id,
        parent_id=location.parent_id,
        path=path,
        item_count=live.item_count if live is not None else 0,
        total_quantity=live.total_quantity if live is not None else 0,
        direct_item_count=live.direct_item_count if live is not None else 0,
        direct_total_quantity=live.direct_total_quantity if live is not None else 0,
        empty=not items,
        categories=categories,
        qr_url=qr_endpoint,
        qr_payload=payload,
        qr_warning=warning,
    )


def _event_details(
    location: StorageLocation,
    *,
    item: Item,
    restored: bool = False,
) -> dict[str, Any]:
    return {
        "item_id": str(item.id),
        "item_name": item.name,
        "location_id": str(location.id),
        "location_name": location.name,
        "identifier": location.identifier,
        "restored": restored,
    }


def _record_storage_event(
    db: Session,
    household_id: uuid.UUID,
    *,
    item: Item,
    location: StorageLocation,
    action: ActivityAction,
    summary: str,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
    restored: bool = False,
) -> None:
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=action.value,
        entity_type="container" if action is ActivityAction.ITEM_STORAGE_ENABLED else "item",
        entity_id=location.id if action is ActivityAction.ITEM_STORAGE_ENABLED else item.id,
        item_id=item.id,
        container_id=location.id,
        summary=summary,
        details=_event_details(location, item=item, restored=restored),
    )


def _assert_host_ready(item: Item) -> None:
    if item.is_archived:
        raise ApiError(
            409,
            "item_archived",
            "Restore the item before enabling or changing storage.",
        )
    if len(item.name.strip()) > 120:
        raise ApiError(
            422,
            "storage_name_too_long",
            "Storage places support names up to 120 characters. Shorten the item name "
            "before enabling storage.",
        )
    if item.quantity != 1:
        raise ApiError(
            422,
            "storage_item_quantity_required",
            "A storage-bearing item must have quantity 1 so it represents one physical "
            "box, toolbox or piece of furniture. Create a separate item for each physical "
            "unit; quantities are never split automatically.",
        )
    if item.room_id is None:
        raise ApiError(
            422,
            "storage_room_required",
            "Assign the item to a room before enabling storage. The storage place must "
            "have a real location for its identifier and QR code.",
        )


def _assert_location_colocated(item: Item, location: StorageLocation) -> None:
    if item.room_id != location.room_id or item.storage_location_id != location.parent_id:
        raise ApiError(
            422,
            "storage_location_not_colocated",
            "The owned item must be recorded in the same room and directly outside this "
            "storage place. Move the item to that place first, then link it.",
        )


def _assert_not_inside_owned(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    location: StorageLocation,
) -> None:
    rows = [
        (entry.id, entry.parent_id)
        for entry in db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.deleted_at.is_(None),
            )
        ).all()
    ]
    if item.storage_location_id in descendant_ids(rows, location.id):
        raise ApiError(
            422,
            "storage_host_inside_itself",
            "The owned item is currently inside this storage place. Move the item "
            "outside before linking the container; an item cannot contain itself.",
        )


def _link_location_owner(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
    item: Item,
) -> StorageLocation:
    if location.deleted_at is not None:
        raise ApiError(
            410,
            "location_deleted",
            "This storage place was removed. Restore it from the owning item before linking.",
        )
    if location.owner_item_id is not None and location.owner_item_id != item.id:
        raise ApiError(
            409,
            "location_already_owned",
            "This storage place already has ownership details on another item.",
        )
    if location.owner_item_id == item.id:
        return location
    if item.household_id != household_id or location.household_id != household_id:
        raise ApiError(404, "item_not_found", "Item not found.")
    _assert_host_ready(item)
    other = owned_location(db, household_id, item.id, active_only=True)
    if other is not None and other.id != location.id:
        raise ApiError(
            409,
            "item_already_provides_storage",
            "This item already provides another storage place. Open that item to manage "
            "its contents instead of linking a second place.",
        )
    _assert_location_colocated(item, location)
    _assert_not_inside_owned(db, household_id, item, location)
    if location.room_id is None:
        raise ApiError(
            422,
            "storage_room_required",
            "The storage place must belong to a room.",
        )
    location.owner_item_id = item.id
    location.name = item.name
    location.updated_at = datetime.now(UTC)
    db.flush()
    return location


def enable_item_storage(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    existing_location_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> StorageLocation:
    """Create or deliberately link the storage place an owned item provides."""
    household_hierarchy_lock(db, household_id)
    item = db.scalar(
        select(Item).where(Item.id == item_id, Item.household_id == household_id).with_for_update()
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    _assert_host_ready(item)
    current = owned_location(db, household_id, item.id)

    if existing_location_id is not None:
        location = get_location(db, household_id, existing_location_id, for_update=True)
        if current is not None and current.deleted_at is not None and current.id != location.id:
            raise ApiError(
                409,
                "storage_restore_required",
                "This item has a removed storage place with a preserved identifier. Restore "
                "it instead of linking a different container.",
            )
        already = location.owner_item_id == item.id
        location = _link_location_owner(db, household_id, location, item)
        if not already:
            _record_storage_event(
                db,
                household_id,
                item=item,
                location=location,
                action=ActivityAction.ITEM_STORAGE_ENABLED,
                summary=(
                    f"Linked {location.identifier or location.name} as the storage place "
                    f"inside {item.name}"
                ),
                actor_user_id=actor_user_id,
                actor_name=actor_name,
            )
        return location

    if current is not None and current.deleted_at is None:
        return current
    if current is not None:
        _assert_not_inside_owned(db, household_id, item, current)
        current.room_id = item.room_id
        current.parent_id = item.storage_location_id
        current.name = item.name
        current.deleted_at = None
        current.deleted_by_user_id = None
        current.deleted_by_name = None
        current.restored_at = datetime.now(UTC)
        current.restored_by_user_id = actor_user_id
        current.updated_at = datetime.now(UTC)
        db.flush()
        _record_storage_event(
            db,
            household_id,
            item=item,
            location=current,
            action=ActivityAction.ITEM_STORAGE_ENABLED,
            summary=(f"Restored storage {current.identifier or current.name} for {item.name}"),
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            restored=True,
        )
        return current

    identifier = allocate_identifiers(
        db, household_id, prefix_for_container_type(ContainerType.OTHER.value), 1
    )[0]
    location = StorageLocation(
        household_id=household_id,
        room_id=item.room_id,
        parent_id=item.storage_location_id,
        owner_item_id=item.id,
        name=item.name,
        kind=ContainerType.OTHER.value,
        is_container=True,
        container_type=ContainerType.OTHER.value,
        identifier=identifier,
    )
    db.add(location)
    db.flush()
    _record_storage_event(
        db,
        household_id,
        item=item,
        location=location,
        action=ActivityAction.ITEM_STORAGE_ENABLED,
        summary=(f"{item.name} now provides storage inside {location.identifier or location.name}"),
        actor_user_id=actor_user_id,
        actor_name=actor_name,
    )
    return location


def create_item_for_location(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    *,
    name: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> Item:
    """Create the owned item that gives an existing container ownership details."""
    household_hierarchy_lock(db, household_id)
    location = get_location(db, household_id, location_id, for_update=True)
    if location.owner_item_id is not None:
        raise ApiError(
            409,
            "location_already_owned",
            "This storage place already has ownership details.",
        )
    if location.room_id is None:
        raise ApiError(422, "storage_room_required", "Assign the container to a room first.")
    resolved_name = (name or location.name).strip()[:200]
    if not resolved_name:
        raise ApiError(422, "item_name_required", "Enter a name for the owned item.")
    item = Item(
        household_id=household_id,
        room_id=location.room_id,
        storage_location_id=location.parent_id,
        name=resolved_name,
        quantity=1,
        condition=ItemCondition.GOOD.value,
    )
    db.add(item)
    db.flush()
    _link_location_owner(db, household_id, location, item)
    _record_storage_event(
        db,
        household_id,
        item=item,
        location=location,
        action=ActivityAction.ITEM_STORAGE_ENABLED,
        summary=(
            f"Created ownership details for {location.identifier or location.name} as {item.name}"
        ),
        actor_user_id=actor_user_id,
        actor_name=actor_name,
    )
    return item


def link_existing_item_to_location(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> Item:
    household_hierarchy_lock(db, household_id)
    location = get_location(db, household_id, location_id, for_update=True)
    item = db.scalar(
        select(Item).where(Item.id == item_id, Item.household_id == household_id).with_for_update()
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    already = location.owner_item_id == item.id
    _link_location_owner(db, household_id, location, item)
    if not already:
        _record_storage_event(
            db,
            household_id,
            item=item,
            location=location,
            action=ActivityAction.ITEM_STORAGE_ENABLED,
            summary=(f"Linked {location.identifier or location.name} to owned item {item.name}"),
            actor_user_id=actor_user_id,
            actor_name=actor_name,
        )
    return item


def unlink_location_owner(
    db: Session,
    household_id: uuid.UUID,
    location_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> StorageLocation:
    location = get_location(db, household_id, location_id, for_update=True)
    if location.owner_item_id is None:
        return location
    item = db.scalar(
        select(Item).where(Item.id == location.owner_item_id, Item.household_id == household_id)
    )
    if item is not None:
        from . import lending

        if lending.outstanding_quantity(db, household_id, item.id) > 0:
            raise ApiError(
                409,
                "item_has_open_loans",
                "Record returns for the owned item before removing its ownership details.",
            )
    previous = item.name if item is not None else None
    location.owner_item_id = None
    location.updated_at = datetime.now(UTC)
    db.flush()
    if item is not None:
        history.record_event(
            db,
            household_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            action=ActivityAction.CONTAINER_OWNERSHIP_UNLINKED.value,
            entity_type="container",
            entity_id=location.id,
            item_id=item.id,
            container_id=location.id,
            summary=(
                f"Unlinked {location.identifier or location.name} from owned item "
                f"{previous or 'item'}; the container remains a storage place"
            ),
            details={
                "item_id": str(item.id),
                "item_name": previous,
                "location_id": str(location.id),
                "location_name": location.name,
                "identifier": location.identifier,
            },
        )
    return location


def remove_item_storage(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> StorageLocation | None:
    household_hierarchy_lock(db, household_id)
    item = db.scalar(
        select(Item).where(Item.id == item_id, Item.household_id == household_id).with_for_update()
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    location = owned_location(db, household_id, item.id, active_only=True, for_update=True)
    if location is None:
        return None
    from . import lending

    if lending.outstanding_quantity(db, household_id, item.id) > 0:
        raise ApiError(
            409,
            "item_has_open_loans",
            "Record returns for the owned item before removing its storage.",
        )
    subtree = descendant_ids(
        [
            (entry.id, entry.parent_id)
            for entry in db.scalars(
                select(StorageLocation).where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.deleted_at.is_(None),
                )
            ).all()
        ],
        location.id,
    )
    subtree_ids = list(subtree)
    has_items = db.scalar(
        select(Item.id)
        .where(
            Item.household_id == household_id,
            Item.storage_location_id.in_(subtree_ids),
        )
        .limit(1)
    )
    has_children = db.scalar(
        select(StorageLocation.id)
        .where(
            StorageLocation.household_id == household_id,
            StorageLocation.parent_id == location.id,
            StorageLocation.active(),
        )
        .limit(1)
    )
    has_borrowed = db.scalar(
        select(BorrowedRecord.id)
        .where(
            BorrowedRecord.household_id == household_id,
            BorrowedRecord.status.in_(ACTIVE_BORROWED_STATUSES),
            BorrowedRecord.storage_location_id.in_(subtree_ids),
        )
        .limit(1)
    )
    if has_items or has_children or has_borrowed:
        raise ApiError(
            409,
            "storage_not_empty",
            "Move or return the items, nested places and borrowed placements in this "
            "storage before removing it. Nothing was deleted.",
        )
    details = _event_details(location, item=item)
    tombstone_location(
        db,
        household_id,
        location,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        record_event=False,
    )
    history.record_event(
        db,
        household_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        action=ActivityAction.ITEM_STORAGE_DISABLED.value,
        entity_type="item",
        entity_id=item.id,
        item_id=item.id,
        container_id=location.id,
        summary=(
            f"Removed storage {location.identifier or location.name} from {item.name}; "
            "the identifier and recoverable history are retained"
        ),
        details=details,
    )
    return location


def move_owned_storage(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    *,
    destination_room_id: uuid.UUID,
    destination_location_id: uuid.UUID | None,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
) -> StorageLocation | None:
    location = owned_location(db, household_id, item.id, active_only=True)
    if location is None:
        return None
    rows = [
        (entry.id, entry.parent_id)
        for entry in db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.deleted_at.is_(None),
            )
        ).all()
    ]
    if destination_location_id in descendant_ids(rows, location.id):
        raise ApiError(
            422,
            "storage_host_inside_itself",
            "An item that provides storage cannot be moved inside that same storage or "
            "one of its nested places.",
        )
    move_container(
        db,
        household_id,
        location.id,
        destination_room_id=destination_room_id,
        destination_parent_id=destination_location_id,
        actor_user_id=actor_user_id,
        actor_name=actor_name,
        record_history=False,
        allow_owned=True,
    )
    location = get_location(db, household_id, location.id)
    location.name = item.name
    db.flush()
    return location


def active_owned_location(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID
) -> StorageLocation | None:
    return owned_location(db, household_id, item_id, active_only=True)


def assert_item_delete_allowed(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> None:
    location = owned_location(db, household_id, item_id, active_only=True)
    if location is not None:
        raise ApiError(
            409,
            "item_provides_storage",
            "This item still provides storage. Move out its contents and remove the "
            "storage capability before deleting the item. Nothing was deleted.",
        )
