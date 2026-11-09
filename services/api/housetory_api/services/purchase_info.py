"""Shared purchase-information semantics for inventory, search and reporting.

The stored ``items.purchase_info_status`` column is only an explicit override:
``unknown`` or ``not_applicable``. Recorded versus unrecorded is derived from
whether the linked purchase actually carries any information. This prevents a
magic date or zero price from pretending that purchase details are known.

Explicit ``not_applicable`` always wins. When purchase data exists it is never
deleted or hidden by a status change; it is reported as recorded unless the item
is explicitly marked not applicable. ``unknown`` is an unresolved state and is
included in missing-information searches, while ``not_applicable`` is excluded.
"""


from sqlalchemy import and_, func, or_

from ..domain import PurchaseInfoFilter, PurchaseInfoStatus
from ..models import Item, Purchase


def purchase_has_data_clause():
    return Item.purchase.has(
        or_(
            Purchase.vendor.is_not(None),
            Purchase.purchase_date.is_not(None),
            Purchase.price_cents.is_not(None),
            Purchase.order_number.is_not(None),
            Purchase.notes.is_not(None),
            Purchase.receipt_document_id.is_not(None),
            Purchase.allocations.any(),
        )
    )


def _not_not_applicable():
    return func.coalesce(Item.purchase_info_status, "") != PurchaseInfoStatus.NOT_APPLICABLE.value


def missing_purchase_info_clause():
    """Items whose purchase information is unrecorded, or explicitly unknown."""
    return and_(_not_not_applicable(), ~purchase_has_data_clause())


def purchase_info_filter_clause(value: PurchaseInfoFilter | str):
    if value == PurchaseInfoFilter.MISSING.value:
        return missing_purchase_info_clause()
    if value == PurchaseInfoFilter.UNKNOWN.value:
        return and_(
            Item.purchase_info_status == PurchaseInfoStatus.UNKNOWN.value,
            ~purchase_has_data_clause(),
        )
    if value == PurchaseInfoFilter.NOT_APPLICABLE.value:
        return Item.purchase_info_status == PurchaseInfoStatus.NOT_APPLICABLE.value
    if value == PurchaseInfoFilter.RECORDED.value:
        return and_(_not_not_applicable(), purchase_has_data_clause())
    if value == PurchaseInfoFilter.MISSING_DATE.value:
        return and_(
            _not_not_applicable(),
            Item.purchase.has(Purchase.purchase_date.is_(None)),
        )
    if value == PurchaseInfoFilter.MISSING_PRICE.value:
        return and_(
            _not_not_applicable(),
            Item.purchase.has(Purchase.price_cents.is_(None)),
        )
    raise ValueError("Unsupported purchase information filter.")


def purchase_has_data(item: Item) -> bool:
    purchase = item.purchase
    if purchase is None:
        return False
    return bool(
        purchase.vendor
        or purchase.purchase_date is not None
        or purchase.price_cents is not None
        or purchase.order_number
        or purchase.notes
        or purchase.receipt_document_id is not None
        or purchase.allocations
    )


def effective_purchase_info_status(item: Item) -> PurchaseInfoStatus:
    if item.purchase_info_status == PurchaseInfoStatus.NOT_APPLICABLE.value:
        return PurchaseInfoStatus.NOT_APPLICABLE
    if purchase_has_data(item):
        return PurchaseInfoStatus.RECORDED
    if item.purchase_info_status == PurchaseInfoStatus.UNKNOWN.value:
        return PurchaseInfoStatus.UNKNOWN
    return PurchaseInfoStatus.UNRECORDED


def missing_purchase_info_fields(item: Item) -> list[str]:
    """Fields still absent after at least one purchase detail was recorded."""
    if effective_purchase_info_status(item) != PurchaseInfoStatus.RECORDED:
        return []
    purchase = item.purchase
    if purchase is None:
        return []
    fields: list[str] = []
    if purchase.purchase_date is None:
        fields.append("date")
    if purchase.price_cents is None:
        fields.append("price")
    return fields


def explicit_status_value(value: str | None) -> str | None:
    """Map an API status choice to the stored override (None means automatic)."""
    if value in {
        None,
        "auto",
        PurchaseInfoStatus.RECORDED.value,
        PurchaseInfoStatus.UNRECORDED.value,
    }:
        return None
    if value == PurchaseInfoStatus.UNKNOWN.value:
        return PurchaseInfoStatus.UNKNOWN.value
    if value == PurchaseInfoStatus.NOT_APPLICABLE.value:
        return PurchaseInfoStatus.NOT_APPLICABLE.value
    raise ValueError("Unsupported purchase information status.")
