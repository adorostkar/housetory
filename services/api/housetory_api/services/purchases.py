import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, selectinload

from ..api.errors import ApiError
from ..models import Document, Household, Item, Purchase, PurchaseAllocation
from ..schemas.purchases import PurchaseCreate, PurchaseIn, PurchaseUpdate

# Marks the one allocation Housetory writes itself: the full price of a purchase
# that was created with exactly one linked item. Every other allocation is a
# reviewed document line. The (purchase, source line) unique constraint keeps it
# to one per purchase.
SINGLE_ITEM_LINE_ID = "single-item"


def sync_single_item_allocation(db: Session, purchase: Purchase, *, created: bool = False) -> None:
    """Keep the single-item allocation true to the purchase's complete link set.

    Call after any change to a purchase's price, currency or linked items.

    * A purchase created in this transaction (``created``) with exactly one
      linked item and no other allocation gets the full price allocated to it.
    * While that item stays the only link and no reviewed allocation exists, the
      allocation follows the purchase's price and currency.
    * Once a second item is linked, the item is unlinked, or a reviewed
      allocation is recorded, the single-item allocation is removed for good:
      nothing is redistributed, and a purchase that has been shared is never
      later assumed to belong to whichever item remains.
    * Reviewed allocations are never created, changed or removed here.
    """
    db.flush()
    item_rows = db.execute(
        select(Item.id, Item.name, Item.quantity).where(
            Item.household_id == purchase.household_id, Item.purchase_id == purchase.id
        )
    ).all()
    allocations = list(
        db.scalars(
            select(PurchaseAllocation).where(
                PurchaseAllocation.household_id == purchase.household_id,
                PurchaseAllocation.purchase_id == purchase.id,
            )
        ).all()
    )
    single = next(
        (entry for entry in allocations if entry.source_line_id == SINGLE_ITEM_LINE_ID), None
    )
    sole = item_rows[0] if len(item_rows) == 1 else None
    if single is None:
        if not created or sole is None or allocations:
            return
        db.add(
            PurchaseAllocation(
                household_id=purchase.household_id,
                purchase_id=purchase.id,
                item_id=sole.id,
                source_line_id=SINGLE_ITEM_LINE_ID,
                description=f"Only item on this purchase: {sole.name}"[:300],
                quantity=max(1, sole.quantity),
                allocated_cents=purchase.price_cents,
                currency=purchase.currency,
            )
        )
    elif sole is None or single.item_id != sole.id or len(allocations) > 1:
        db.delete(single)
    else:
        single.allocated_cents = purchase.price_cents
        single.currency = purchase.currency
    db.flush()
    db.expire(purchase, ["allocations"])


def sync_single_item_allocations(
    db: Session, household_id: uuid.UUID, purchase_ids: set[uuid.UUID]
) -> None:
    """Re-check purchases whose items were just moved to another purchase."""
    if not purchase_ids:
        return
    db.flush()
    for purchase in db.scalars(
        select(Purchase).where(Purchase.household_id == household_id, Purchase.id.in_(purchase_ids))
    ).all():
        sync_single_item_allocation(db, purchase)


def purchase_load_options() -> list:
    return [
        joinedload(Purchase.receipt_document),
        selectinload(Purchase.items),
        selectinload(Purchase.allocations).joinedload(PurchaseAllocation.item),
    ]


def get_purchase(db: Session, household_id: uuid.UUID, purchase_id: uuid.UUID) -> Purchase:
    purchase = db.scalar(
        select(Purchase)
        .options(*purchase_load_options())
        .execution_options(populate_existing=True)
        .where(Purchase.id == purchase_id, Purchase.household_id == household_id)
    )
    if purchase is None:
        raise ApiError(404, "purchase_not_found", "Purchase not found.")
    return purchase


def resolve_items(db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]) -> list[Item]:
    unique_ids = list(dict.fromkeys(item_ids))
    if not unique_ids:
        return []
    items = list(
        db.scalars(
            select(Item).where(Item.household_id == household_id, Item.id.in_(unique_ids))
        ).all()
    )
    if len(items) != len(unique_ids):
        raise ApiError(422, "item_not_found", "One or more selected items do not exist.")
    return items


def validate_receipt(
    db: Session, household_id: uuid.UUID, document_id: uuid.UUID | None
) -> Document | None:
    if document_id is None:
        return None
    document = db.scalar(
        select(Document).where(Document.id == document_id, Document.household_id == household_id)
    )
    if document is None:
        raise ApiError(422, "document_not_found", "The selected receipt document does not exist.")
    return document


def apply_purchase_fields(
    purchase: Purchase,
    payload: PurchaseIn | PurchaseUpdate,
    *,
    fields: set[str],
) -> None:
    if "merchant" in fields or "vendor" in fields:
        purchase.vendor = payload.merchant_name
    if "purchase_date" in fields:
        purchase.purchase_date = payload.purchase_date
    if "price_cents" in fields:
        purchase.price_cents = payload.price_cents
    if "currency" in fields and payload.currency is not None:
        purchase.currency = payload.currency
    if "order_number" in fields:
        purchase.order_number = payload.order_number
    if "notes" in fields:
        purchase.notes = payload.notes
    if "receipt_document_id" in fields:
        purchase.receipt_document_id = payload.receipt_document_id


def create_purchase(
    db: Session,
    household_id: uuid.UUID,
    payload: PurchaseCreate,
) -> Purchase:
    items = resolve_items(db, household_id, payload.item_ids)
    if not items:
        raise ApiError(422, "item_required", "A purchase must be linked to at least one item.")
    receipt = validate_receipt(db, household_id, payload.receipt_document_id)
    household = db.get(Household, household_id)
    purchase = Purchase(
        household_id=household_id,
        currency=household.default_currency if household is not None else "USD",
    )
    apply_purchase_fields(purchase, payload, fields=payload.model_fields_set)
    if receipt is not None:
        purchase.receipt_document = receipt
    previous_purchase_ids = {item.purchase_id for item in items if item.purchase_id is not None}
    db.add(purchase)
    db.flush()
    for item in items:
        item.purchase_id = purchase.id
    db.flush()
    if previous_purchase_ids:
        prune_orphan_purchases(db, household_id)
        sync_single_item_allocations(db, household_id, previous_purchase_ids)
    sync_single_item_allocation(db, purchase, created=True)
    db.commit()
    return get_purchase(db, household_id, purchase.id)


def update_purchase(
    db: Session,
    purchase: Purchase,
    payload: PurchaseUpdate,
) -> Purchase:
    fields = set(payload.model_fields_set)
    if "receipt_document_id" in fields:
        validate_receipt(db, purchase.household_id, payload.receipt_document_id)
    apply_purchase_fields(purchase, payload, fields=fields)
    if "item_ids" in fields and payload.item_ids is not None:
        items = resolve_items(db, purchase.household_id, payload.item_ids)
        if not items:
            raise ApiError(
                422, "item_required", "A purchase must remain linked to at least one item."
            )
        current_ids = {item.id for item in purchase.items}
        selected_ids = {item.id for item in items}
        if current_ids != selected_ids:
            previous_purchase_ids = {
                item.purchase_id
                for item in items
                if item.purchase_id is not None and item.purchase_id != purchase.id
            }
            # Detach items no longer selected without deleting their purchase
            # history when they are moved to another shared purchase later.
            for item in purchase.items:
                if item.id not in selected_ids:
                    item.purchase_id = None
            for item in items:
                item.purchase_id = purchase.id
            db.flush()
            if previous_purchase_ids:
                prune_orphan_purchases(db, purchase.household_id)
                sync_single_item_allocations(db, purchase.household_id, previous_purchase_ids)
    sync_single_item_allocation(db, purchase)
    db.commit()
    return get_purchase(db, purchase.household_id, purchase.id)


def delete_purchase(db: Session, purchase: Purchase) -> None:
    for item in purchase.items:
        item.purchase_id = None
    db.delete(purchase)
    db.commit()


def prune_orphan_purchases(db: Session, household_id: uuid.UUID) -> int:
    """Remove purchase shells left behind after items move to another record."""
    purchases = list(
        db.scalars(
            select(Purchase).where(
                Purchase.household_id == household_id,
                ~Purchase.items.any(),
            )
        ).all()
    )
    for purchase in purchases:
        db.delete(purchase)
    if purchases:
        db.flush()
    return len(purchases)
