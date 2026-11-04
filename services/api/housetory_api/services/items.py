"""Shared item creation and update rules.

The HTTP item routes and the approved-import workflow both use these functions
so validation, purchase/warranty handling and relationship rules cannot drift.
"""

import uuid
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..models import Category, Item, Purchase, Room, StorageLocation, Tag, Warranty
from ..schemas.items import ItemCreate, ItemUpdate, PurchaseIn, WarrantyIn
from . import history, lending
from .purchases import get_purchase, prune_orphan_purchases, validate_receipt
from .serializers import item_load_options
from .warranties import resolve_end_date


def get_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    item = db.scalar(
        select(Item)
        .options(*item_load_options())
        .where(Item.id == item_id, Item.household_id == household_id)
    )
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    return item


def room(db: Session, household_id: uuid.UUID, room_id: uuid.UUID) -> Room:
    record = db.scalar(select(Room).where(Room.id == room_id, Room.household_id == household_id))
    if record is None:
        raise ApiError(422, "room_not_found", "The selected room does not exist.")
    return record


def location(db: Session, household_id: uuid.UUID, location_id: uuid.UUID) -> StorageLocation:
    record = db.scalar(
        select(StorageLocation).where(
            StorageLocation.id == location_id,
            StorageLocation.household_id == household_id,
        )
    )
    if record is None:
        raise ApiError(422, "location_not_found", "The selected storage location does not exist.")
    return record


def category(db: Session, household_id: uuid.UUID, category_id: uuid.UUID) -> Category:
    record = db.scalar(
        select(Category).where(Category.id == category_id, Category.household_id == household_id)
    )
    if record is None:
        raise ApiError(422, "category_not_found", "The selected category does not exist.")
    return record


def tags(db: Session, household_id: uuid.UUID, tag_ids: list[uuid.UUID]) -> list[Tag]:
    unique_ids = list(dict.fromkeys(tag_ids))
    if not unique_ids:
        return []
    records = db.scalars(
        select(Tag).where(Tag.household_id == household_id, Tag.id.in_(unique_ids))
    ).all()
    if len(records) != len(unique_ids):
        raise ApiError(422, "tag_not_found", "One or more selected tags do not exist.")
    return list(records)


def resolve_location(
    db: Session,
    household_id: uuid.UUID,
    room_id: uuid.UUID | None,
    location_id: uuid.UUID | None,
) -> tuple[uuid.UUID | None, StorageLocation | None]:
    location_record = location(db, household_id, location_id) if location_id else None
    if room_id is not None:
        room(db, household_id, room_id)
    if location_record is not None:
        if room_id is None:
            room_id = location_record.room_id
        elif location_record.room_id != room_id:
            raise ApiError(
                422,
                "location_room_mismatch",
                "That storage location belongs to a different room.",
            )
    return room_id, location_record


def apply_purchase(db: Session, item: Item, payload: PurchaseIn, *, replace: bool) -> None:
    if replace or item.purchase is None:
        item.purchase = Purchase(household_id=item.household_id, currency="USD")
    purchase = cast(Purchase, item.purchase)
    fields = payload.model_fields_set
    if "merchant" in fields or "vendor" in fields:
        purchase.vendor = payload.merchant_name
    if "purchase_date" in fields:
        purchase.purchase_date = payload.purchase_date
    if "price_cents" in fields:
        purchase.price_cents = payload.price_cents
    if "currency" in fields:
        purchase.currency = payload.currency
    if "order_number" in fields:
        purchase.order_number = payload.order_number
    if "notes" in fields:
        purchase.notes = payload.notes
    if "receipt_document_id" in fields:
        validate_receipt(db, item.household_id, payload.receipt_document_id)
        purchase.receipt_document_id = payload.receipt_document_id


def apply_warranty(db: Session, item: Item, payload: WarrantyIn, *, replace: bool) -> None:
    if replace or item.warranty is None:
        item.warranty = Warranty()
    warranty = cast(Warranty, item.warranty)
    fields = payload.model_fields_set
    if "provider" in fields:
        warranty.provider = payload.provider
    if "start_date" in fields:
        warranty.start_date = payload.start_date
    if "duration_months" in fields:
        warranty.duration_months = payload.duration_months
    if "reminder_days" in fields:
        warranty.reminder_days = payload.reminder_days
    if "notes" in fields:
        warranty.notes = payload.notes
    if "document_id" in fields:
        document = validate_receipt(db, item.household_id, payload.document_id)
        warranty.document_id = document.id if document is not None else None
    if "end_date" in fields:
        warranty.end_date = payload.end_date
    warranty.end_date = resolve_end_date(
        start_date=warranty.start_date,
        duration_months=warranty.duration_months,
        end_date=warranty.end_date,
    )
    if (
        warranty.start_date is not None
        and warranty.end_date is not None
        and warranty.end_date < warranty.start_date
    ):
        raise ApiError(
            422, "invalid_warranty_dates", "Warranty end date must not precede its start date."
        )
    if warranty.duration_months is not None and warranty.start_date is None:
        raise ApiError(
            422,
            "warranty_start_required",
            "A warranty duration requires a start date.",
        )


def create_item_record(db: Session, household_id: uuid.UUID, payload: ItemCreate) -> Item:
    room_id, location_record = resolve_location(
        db, household_id, payload.room_id, payload.storage_location_id
    )
    category_record = (
        category(db, household_id, payload.category_id) if payload.category_id else None
    )
    tag_records = tags(db, household_id, payload.tag_ids)

    item = Item(
        household_id=household_id,
        name=payload.name,
        description=payload.description,
        brand=payload.brand,
        model=payload.model,
        serial_number=payload.serial_number,
        quantity=payload.quantity,
        condition=payload.condition.value,
        room_id=room_id,
        storage_location_id=location_record.id if location_record else None,
        category_id=category_record.id if category_record else None,
        current_value_cents=payload.current_value_cents,
        current_value_currency=payload.current_value_currency,
    )
    item.tags = tag_records
    if payload.purchase_id is not None:
        item.purchase_id = get_purchase(db, household_id, payload.purchase_id).id
    elif payload.purchase is not None:
        apply_purchase(db, item, payload.purchase, replace=True)
    if payload.warranty is not None:
        apply_warranty(db, item, payload.warranty, replace=True)
    db.add(item)
    db.flush()
    return item


def update_item_record(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    payload: ItemUpdate,
    *,
    actor_user_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    record_history: bool = True,
) -> Item:
    fields = payload.model_fields_set

    if "quantity" in fields or "is_archived" in fields:
        db.scalar(
            select(Item)
            .where(Item.id == item.id, Item.household_id == household_id)
            .with_for_update()
        )
        db.refresh(item)
        lending.ensure_quantity_allowed(
            db,
            household_id,
            item,
            new_quantity=payload.quantity if "quantity" in fields else None,
            new_archived=payload.is_archived if "is_archived" in fields else None,
        )

    moved_from = None
    if "room_id" in fields or "storage_location_id" in fields:
        moved_from = history.location_snapshot(
            db, household_id, item.room_id, item.storage_location_id
        )
        new_room_id = payload.room_id if "room_id" in fields else item.room_id
        new_location_id = (
            payload.storage_location_id
            if "storage_location_id" in fields
            else item.storage_location_id
        )
        if new_room_id is None and "storage_location_id" not in fields:
            new_location_id = None
        if "room_id" in fields and "storage_location_id" not in fields and new_location_id:
            current_location = db.get(StorageLocation, new_location_id)
            if current_location is not None and current_location.room_id != new_room_id:
                new_location_id = None
        resolved_room_id, location_record = resolve_location(
            db, household_id, new_room_id, new_location_id
        )
        item.room_id = resolved_room_id
        item.storage_location_id = location_record.id if location_record else None

    if "category_id" in fields:
        if payload.category_id is None:
            item.category_id = None
        else:
            item.category_id = category(db, household_id, payload.category_id).id

    if "tag_ids" in fields and payload.tag_ids is not None:
        item.tags = tags(db, household_id, payload.tag_ids)

    if payload.name is not None:
        item.name = payload.name
    if "description" in fields:
        item.description = payload.description
    if "brand" in fields:
        item.brand = payload.brand
    if "model" in fields:
        item.model = payload.model
    if "serial_number" in fields:
        item.serial_number = payload.serial_number
    if payload.quantity is not None:
        item.quantity = payload.quantity
    if payload.condition is not None:
        item.condition = payload.condition.value
    if payload.is_archived is not None:
        item.is_archived = payload.is_archived

    if "current_value_cents" in fields:
        item.current_value_cents = payload.current_value_cents
    if "current_value_currency" in fields and payload.current_value_currency is not None:
        item.current_value_currency = payload.current_value_currency

    if "purchase_id" in fields:
        previous_purchase_id = item.purchase_id
        if payload.purchase_id is None:
            item.purchase_id = None
        else:
            item.purchase_id = get_purchase(db, household_id, payload.purchase_id).id
        if previous_purchase_id is not None:
            db.flush()
            prune_orphan_purchases(db, household_id)
    elif "purchase" in fields:
        previous_purchase_id = item.purchase_id
        if payload.purchase is None:
            item.purchase_id = None
        else:
            apply_purchase(db, item, payload.purchase, replace=item.purchase is None)
        if previous_purchase_id is not None and item.purchase_id != previous_purchase_id:
            db.flush()
            prune_orphan_purchases(db, household_id)
    if "warranty" in fields:
        if payload.warranty is None:
            item.warranty = None
        else:
            apply_warranty(db, item, payload.warranty, replace=item.warranty is None)

    db.flush()
    current_room = str(item.room_id) if item.room_id else None
    current_location = str(item.storage_location_id) if item.storage_location_id else None
    moved = moved_from is not None and (
        moved_from.get("room_id") != current_room
        or moved_from.get("location_id") != current_location
    )
    if record_history and moved:
        moved_to = history.location_snapshot(
            db, household_id, item.room_id, item.storage_location_id
        )
        from_label = moved_from.get("location_name") or moved_from.get("room_name") or "no place"
        to_label = moved_to.get("location_name") or moved_to.get("room_name") or "no place"
        history.record_event(
            db,
            household_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            action="item.moved",
            entity_type="item",
            entity_id=item.id,
            item_id=item.id,
            summary=f"Moved {item.name} from {from_label} to {to_label}",
            details={
                "from": moved_from,
                "to": moved_to,
                "from_room_id": moved_from.get("room_id"),
                "from_location_id": moved_from.get("location_id"),
                "to_room_id": moved_to.get("room_id"),
                "to_location_id": moved_to.get("location_id"),
            },
        )
    return item
