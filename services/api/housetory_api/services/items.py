"""Shared item creation and update rules.

The HTTP item routes and the approved-import workflow both use these functions
so validation, purchase/warranty handling and relationship rules cannot drift.
"""

import uuid
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..models import Category, Item, Purchase, Room, StorageLocation, Tag, Warranty
from ..schemas.items import ItemCreate, ItemUpdate, PurchaseIn, WarrantyIn
from . import current_value as current_value_service
from . import history, lending, storage_items
from .purchase_info import explicit_status_value
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
            StorageLocation.active(),
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


def _current_value_total(value_cents: int | None, basis: str | None, quantity: int) -> int | None:
    if value_cents is None or basis is None:
        return None
    if basis == current_value_service.PER_UNIT:
        return value_cents * max(quantity, 0)
    return value_cents


def _apply_current_value_update(
    item: Item, payload: ItemUpdate, fields: set[str]
) -> dict[str, Any] | None:
    previous = {
        "value_cents": item.current_value_cents,
        "basis": current_value_service.effective_basis(item),
        "currency": item.current_value_currency,
        "quantity": item.quantity,
    }
    previous_total = _current_value_total(
        previous["value_cents"], previous["basis"], previous["quantity"]
    )
    new_value = (
        payload.current_value_cents if "current_value_cents" in fields else item.current_value_cents
    )
    new_currency = (
        payload.current_value_currency
        if "current_value_currency" in fields and payload.current_value_currency is not None
        else item.current_value_currency
    )
    existing_basis = current_value_service.effective_basis(item)
    requested_basis = payload.current_value_basis if "current_value_basis" in fields else None

    if new_value is None:
        new_basis: str | None = None
    elif requested_basis == current_value_service.LEGACY_RECORD_TOTAL:
        if existing_basis != current_value_service.LEGACY_RECORD_TOTAL:
            raise ApiError(
                422,
                "current_value_basis_conflict",
                "Only a value already recorded as a legacy record total can keep "
                "that basis. Enter a per-unit estimate for a current value.",
            )
        new_basis = current_value_service.LEGACY_RECORD_TOTAL
    elif requested_basis == current_value_service.PER_UNIT:
        if (
            existing_basis == current_value_service.LEGACY_RECORD_TOTAL
            and "current_value_cents" not in fields
        ):
            raise ApiError(
                422,
                "current_value_unit_required",
                "Enter a per-unit value when converting a legacy record total.",
            )
        new_basis = current_value_service.PER_UNIT
    elif "current_value_cents" in fields:
        # Editing a legacy amount keeps its truthful record-total basis. Any new
        # value, or a per-unit value being corrected, remains per unit.
        new_basis = (
            current_value_service.LEGACY_RECORD_TOTAL
            if existing_basis == current_value_service.LEGACY_RECORD_TOTAL
            else current_value_service.PER_UNIT
        )
    else:
        new_basis = existing_basis

    new_quantity = payload.quantity if payload.quantity is not None else item.quantity
    current_value_service.validate_current_value(new_value, new_quantity, new_basis)

    changed = (
        previous["value_cents"],
        previous["basis"],
        previous["currency"],
    ) != (new_value, new_basis, new_currency)
    item.current_value_cents = new_value
    item.current_value_basis = new_basis
    item.current_value_currency = new_currency
    if new_value is None:
        item.current_value_estimated_at = None
    elif changed:
        item.current_value_estimated_at = datetime.now(UTC)
    if not changed:
        return None
    return {
        "from": {
            "basis": previous["basis"],
            "value_cents": previous["value_cents"],
            "currency": previous["currency"],
            "quantity": previous["quantity"],
            "total_cents": previous_total,
        },
        "to": {
            "basis": new_basis,
            "value_cents": new_value,
            "currency": new_currency,
            "quantity": new_quantity,
            "total_cents": _current_value_total(new_value, new_basis, new_quantity),
        },
    }


def create_item_record(db: Session, household_id: uuid.UUID, payload: ItemCreate) -> Item:
    room_id, location_record = resolve_location(
        db, household_id, payload.room_id, payload.storage_location_id
    )
    category_record = (
        category(db, household_id, payload.category_id) if payload.category_id else None
    )
    tag_records = tags(db, household_id, payload.tag_ids)
    current_value_service.validate_current_value(
        payload.current_value_cents,
        payload.quantity,
        current_value_service.PER_UNIT if payload.current_value_cents is not None else None,
    )

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
        current_value_basis=(
            current_value_service.PER_UNIT if payload.current_value_cents is not None else None
        ),
        current_value_estimated_at=(
            datetime.now(UTC) if payload.current_value_cents is not None else None
        ),
        purchase_info_status=explicit_status_value(payload.purchase_info_status),
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
    # Auto image lookup/generation is strictly opt-in per household and only
    # runs after the item is saved. The default is off.
    from .item_image_generation import maybe_enqueue_new_item_image

    maybe_enqueue_new_item_image(db, item)
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
    history_context: dict[str, Any] | None = None,
) -> Item:
    fields = payload.model_fields_set
    owned = storage_items.active_owned_location(db, household_id, item.id)
    if owned is not None:
        if "quantity" in fields and payload.quantity is not None and payload.quantity != 1:
            raise ApiError(
                422,
                "storage_item_quantity_required",
                "This item provides storage and must stay at quantity 1. Create a separate "
                "item for each physical box or piece of furniture.",
            )
        if "is_archived" in fields and payload.is_archived is True:
            raise ApiError(
                409,
                "item_provides_storage",
                "Move out the contents and remove this item's storage capability before "
                "archiving it. Nothing was archived.",
            )

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
            if current_location is not None and (
                current_location.deleted_at is not None or current_location.room_id != new_room_id
            ):
                new_location_id = None
        resolved_room_id, location_record = resolve_location(
            db, household_id, new_room_id, new_location_id
        )
        if owned is not None:
            if resolved_room_id is None:
                raise ApiError(
                    422,
                    "storage_room_required",
                    "A storage-bearing item must stay in a room while its storage place is active.",
                )
            destination_location_id = location_record.id if location_record else None
            if owned.room_id != resolved_room_id or owned.parent_id != destination_location_id:
                storage_items.move_owned_storage(
                    db,
                    household_id,
                    item,
                    destination_room_id=resolved_room_id,
                    destination_location_id=destination_location_id,
                    actor_user_id=actor_user_id,
                    actor_name=actor_name,
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
        if owned is not None and len(payload.name.strip()) > 120:
            raise ApiError(
                422,
                "storage_name_too_long",
                "This item provides storage, whose place name supports up to 120 "
                "characters. Shorten the item name.",
            )
        item.name = payload.name
        if owned is not None:
            owned.name = payload.name
            owned.updated_at = datetime.now(UTC)
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

    value_change: dict[str, Any] | None = None
    if fields & {"current_value_cents", "current_value_currency", "current_value_basis"}:
        value_change = _apply_current_value_update(item, payload, fields)
    # A quantity-only change can still make a per-unit estimate exceed the safe
    # extended total (for example, a large quantity on an expensive unit).
    current_value_service.validate_current_value(
        item.current_value_cents,
        item.quantity,
        current_value_service.effective_basis(item),
    )

    if "purchase_info_status" in fields:
        item.purchase_info_status = explicit_status_value(payload.purchase_info_status)

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

    if value_change is not None:
        converted = (
            value_change["from"]["basis"] == current_value_service.LEGACY_RECORD_TOTAL
            and value_change["to"]["basis"] == current_value_service.PER_UNIT
        )
        history.record_event(
            db,
            household_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            action="item.value_updated",
            entity_type="item",
            entity_id=item.id,
            item_id=item.id,
            summary=(
                "Legacy current value converted to per-unit estimate"
                if converted
                else "Current value updated"
            ),
            details=value_change,
        )

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
        details = {
            "from": moved_from,
            "to": moved_to,
            "from_room_id": moved_from.get("room_id"),
            "from_location_id": moved_from.get("location_id"),
            "to_room_id": moved_to.get("room_id"),
            "to_location_id": moved_to.get("location_id"),
        }
        if history_context:
            details["batch"] = history_context
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
            details=details,
        )
    return item
