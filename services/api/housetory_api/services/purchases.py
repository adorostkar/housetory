import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, selectinload

from ..api.errors import ApiError
from ..models import Document, Item, Purchase, PurchaseAllocation
from ..schemas.purchases import PurchaseCreate, PurchaseIn, PurchaseUpdate


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
    purchase = Purchase(household_id=household_id, currency="USD")
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
