"""Household ownership and financial aggregation.

Currencies are never added together. Purchase totals count a shared purchase
once; category/room/item breakdowns allocate a shared purchase equally across
the active items it covers, with remainder cents distributed deterministically.

Current value is always an estimate supplied by the household. It is reported
separately from purchase value.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, joinedload, load_only, raiseload

from ..domain import PurchaseInfoStatus
from ..models import Item, Purchase, PurchaseAllocation
from ..schemas.ownership import (
    CurrencyOwnership,
    FinancialOverview,
    ValuableItem,
    ValueBreakdownRow,
)
from . import current_value as current_value_service
from .purchase_info import effective_purchase_info_status
from .serializers import item_load_options, item_summary, item_summary_load_options


@dataclass
class PurchaseShare:
    item_id: uuid.UUID
    purchase_id: uuid.UUID
    allocated_cents: int
    currency: str


def _active_items(db: Session, household_id: uuid.UUID) -> list[Item]:
    return list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(Item.household_id == household_id, Item.is_archived.is_(False))
            .order_by(Item.created_at.asc())
        ).all()
    )


def _financial_items(db: Session, household_id: uuid.UUID) -> list[Item]:
    return list(
        db.scalars(
            select(Item)
            .options(
                load_only(
                    Item.id,
                    Item.household_id,
                    Item.name,
                    Item.quantity,
                    Item.purchase_info_status,
                    Item.purchase_id,
                    Item.room_id,
                    Item.category_id,
                    Item.current_value_cents,
                    Item.current_value_currency,
                    Item.current_value_basis,
                    Item.created_at,
                    raiseload=True,
                ),
                joinedload(Item.purchase).load_only(
                    Purchase.id,
                    Purchase.currency,
                    Purchase.price_cents,
                    Purchase.vendor,
                    Purchase.purchase_date,
                    Purchase.order_number,
                    Purchase.notes,
                    Purchase.receipt_document_id,
                ),
                joinedload(Item.room),
                joinedload(Item.category),
                joinedload(Item.purchase)
                .selectinload(Purchase.allocations)
                .load_only(PurchaseAllocation.id, PurchaseAllocation.purchase_id),
                raiseload("*"),
            )
            .where(Item.household_id == household_id, Item.is_archived.is_(False))
            .order_by(Item.created_at.asc(), Item.id.asc())
        ).all()
    )


def _purchase_shares(
    db: Session, household_id: uuid.UUID, items: list[Item]
) -> dict[uuid.UUID, PurchaseShare]:
    """Return only explicitly persisted reviewed allocations.

    Legacy purchases without allocation rows still contribute their total once in
    the purchase totals, but no historical split is invented for category/room
    breakdowns or exports.
    """
    item_ids = [item.id for item in items]
    if not item_ids:
        return {}
    rows = db.scalars(
        select(PurchaseAllocation).where(
            PurchaseAllocation.household_id == household_id,
            PurchaseAllocation.item_id.in_(item_ids),
        )
    ).all()
    totals: dict[tuple[uuid.UUID, uuid.UUID, str], int] = defaultdict(int)
    for allocation in rows:
        if allocation.allocated_cents is None:
            continue
        totals[(allocation.item_id, allocation.purchase_id, allocation.currency)] += (
            allocation.allocated_cents
        )
    shares: dict[uuid.UUID, PurchaseShare] = {}
    item_map = {item.id: item for item in items}
    for (item_id, purchase_id, currency), amount in totals.items():
        item = item_map.get(item_id)
        if item is None or item.purchase_id != purchase_id:
            continue
        shares[item_id] = PurchaseShare(
            item_id=item_id,
            purchase_id=purchase_id,
            allocated_cents=amount,
            currency=currency,
        )
    return shares


def _missing_purchase(item: Item) -> bool:
    return effective_purchase_info_status(item).value in {"unrecorded", "unknown"}


def _add_breakdown(
    rows: dict[tuple[str, str], dict[str, Any]],
    name: str,
    currency: str,
    item_id: uuid.UUID,
    *,
    purchase_cents: int = 0,
    current_cents: int = 0,
) -> None:
    row = rows.setdefault(
        (name, currency),
        {"purchase": 0, "current": 0, "item_ids": set()},
    )
    row["purchase"] += purchase_cents
    row["current"] += current_cents
    row["item_ids"].add(item_id)


def financial_overview(
    db: Session,
    household_id: uuid.UUID,
    *,
    household_reminder_days: int,
    valuable_limit: int = 8,
    missing_limit: int = 20,
) -> FinancialOverview:
    items = _financial_items(db, household_id)
    allocations = _purchase_shares(db, household_id, items)

    active_purchase_ids = select(Item.purchase_id).where(
        Item.household_id == household_id, Item.is_archived.is_(False)
    )
    purchase_totals = {
        currency: int(total)
        for currency, total in db.execute(
            select(Purchase.currency, func.sum(Purchase.price_cents))
            .where(
                Purchase.household_id == household_id,
                Purchase.id.in_(active_purchase_ids),
                Purchase.price_cents.is_not(None),
            )
            .group_by(Purchase.currency)
        )
    }
    purchase_item_counts: dict[str, int] = defaultdict(int)
    current_total_expression = case(
        (Item.current_value_basis == "per_unit", Item.current_value_cents * Item.quantity),
        else_=Item.current_value_cents,
    )
    current_rows = db.execute(
        select(
            Item.current_value_currency,
            func.sum(current_total_expression),
            func.count(Item.id),
        )
        .where(
            Item.household_id == household_id,
            Item.is_archived.is_(False),
            Item.current_value_cents.is_not(None),
        )
        .group_by(Item.current_value_currency)
    ).all()
    current_totals = {currency: int(total) for currency, total, count in current_rows}
    current_item_counts = {currency: count for currency, total, count in current_rows}

    category_rows: dict[tuple[str, str], dict[str, Any]] = {}
    room_rows: dict[tuple[str, str], dict[str, Any]] = {}
    valuable: list[tuple[Item, int, str, str, str | None]] = []
    missing: list[Item] = []
    with_purchase_count = 0

    for item in items:
        category_name = item.category.name if item.category else "Uncategorised"
        room_name = item.room.name if item.room else "No room"
        purchase = item.purchase
        allocation = allocations.get(item.id)
        status = effective_purchase_info_status(item)
        if status == PurchaseInfoStatus.RECORDED:
            with_purchase_count += 1

        if purchase is not None:
            purchase_item_counts[purchase.currency] += 1

        current_total = current_value_service.total_value_cents(item)
        current_basis = current_value_service.effective_basis(item)

        if allocation is not None:
            _add_breakdown(
                category_rows,
                category_name,
                allocation.currency,
                item.id,
                purchase_cents=allocation.allocated_cents,
            )
            _add_breakdown(
                room_rows,
                room_name,
                allocation.currency,
                item.id,
                purchase_cents=allocation.allocated_cents,
            )
        if current_total is not None:
            _add_breakdown(
                category_rows,
                category_name,
                item.current_value_currency,
                item.id,
                current_cents=current_total,
            )
            _add_breakdown(
                room_rows,
                room_name,
                item.current_value_currency,
                item.id,
                current_cents=current_total,
            )

        if current_total is not None:
            valuable.append(
                (item, current_total, item.current_value_currency, "current", current_basis)
            )
        elif allocation is not None:
            valuable.append(
                (item, allocation.allocated_cents, allocation.currency, "purchase", None)
            )

        if status in {PurchaseInfoStatus.UNRECORDED, PurchaseInfoStatus.UNKNOWN}:
            missing.append(item)

    currencies = sorted(set(purchase_totals) | set(current_totals))
    currency_totals = [
        CurrencyOwnership(
            currency=currency,
            purchase_total_cents=purchase_totals.get(currency, 0),
            current_value_total_cents=current_totals.get(currency, 0),
            purchase_item_count=purchase_item_counts.get(currency, 0),
            current_value_item_count=current_item_counts.get(currency, 0),
        )
        for currency in currencies
    ]

    def breakdown(rows: dict[tuple[str, str], dict[str, Any]]) -> list[ValueBreakdownRow]:
        result = [
            ValueBreakdownRow(
                name=name,
                currency=currency,
                purchase_total_cents=values["purchase"],
                current_value_total_cents=values["current"],
                item_count=len(values["item_ids"]),
            )
            for (name, currency), values in rows.items()
        ]
        return sorted(
            result,
            key=lambda row: (
                row.name.lower(),
                row.currency,
            ),
        )

    valuable.sort(key=lambda entry: (-entry[1], entry[0].name.lower()))
    missing.sort(key=lambda entry: entry.name.lower())
    missing_count = len(missing)
    valuable = valuable[:valuable_limit]
    missing = missing[:missing_limit]
    preview_ids = {entry[0].id for entry in valuable} | {item.id for item in missing}
    if preview_ids:
        db.scalars(
            select(Item)
            .options(*item_summary_load_options())
            .where(Item.household_id == household_id, Item.id.in_(preview_ids))
        ).all()
    return FinancialOverview(
        item_count=len(items),
        items_with_purchase_count=with_purchase_count,
        items_missing_purchase_count=missing_count,
        currency_totals=currency_totals,
        value_by_category=breakdown(category_rows),
        value_by_room=breakdown(room_rows),
        most_valuable_items=[
            ValuableItem(
                item=item_summary(item, household_reminder_days=household_reminder_days),
                value_cents=value,
                currency=currency,
                value_kind=kind,
                value_basis=basis,
            )
            for item, value, currency, kind, basis in valuable
        ],
        missing_purchase_items=[
            item_summary(item, household_reminder_days=household_reminder_days) for item in missing
        ],
    )


def financial_rows_for_export(db: Session, household_id: uuid.UUID) -> list[dict[str, Any]]:
    """Flat rows used by the inventory CSV export."""
    items = _active_items(db, household_id)
    allocations = _purchase_shares(db, household_id, items)
    rows: list[dict[str, Any]] = []
    for item in items:
        allocation = allocations.get(item.id)
        purchase = item.purchase
        purchase_total_scope = ""
        if purchase is not None:
            if purchase.price_cents is None:
                purchase_total_scope = "purchase total not recorded"
            elif len(purchase.items) > 1:
                purchase_total_scope = (
                    "purchase transaction total; includes all linked items and units"
                )
            else:
                purchase_total_scope = "purchase transaction total"
        rows.append(
            {
                "item": item.name,
                "quantity": item.quantity,
                "category": item.category.name if item.category else "",
                "room": item.room.name if item.room else "",
                "container": (
                    item.storage_location.identifier
                    if item.storage_location and item.storage_location.identifier
                    else (item.storage_location.name if item.storage_location else "")
                ),
                "storage_location": (item.storage_location.name if item.storage_location else ""),
                "purchase_date": purchase.purchase_date.isoformat()
                if purchase and purchase.purchase_date
                else "",
                "merchant": (purchase.vendor or "") if purchase else "",
                "purchase_currency": purchase.currency if purchase else "",
                "purchase_total_cents": purchase.price_cents
                if purchase and purchase.price_cents is not None
                else "",
                "purchase_total_scope": purchase_total_scope,
                "purchase_allocated_cents": allocation.allocated_cents if allocation else "",
                "current_value_unit_cents": (
                    current_value_service.unit_value_cents(item)
                    if current_value_service.unit_value_cents(item) is not None
                    else ""
                ),
                "current_value_quantity": item.quantity
                if item.current_value_cents is not None
                else "",
                "current_value_total_cents": (
                    current_value_service.total_value_cents(item)
                    if current_value_service.total_value_cents(item) is not None
                    else ""
                ),
                "current_value_currency": item.current_value_currency,
                "current_value_basis": current_value_service.effective_basis(item) or "",
                "current_value_estimated_at": (
                    item.current_value_estimated_at.isoformat()
                    if item.current_value_estimated_at is not None
                    else ""
                ),
                "purchase_info_status": effective_purchase_info_status(item).value,
                "missing_purchase_information": "yes" if _missing_purchase(item) else "no",
            }
        )
    return rows
