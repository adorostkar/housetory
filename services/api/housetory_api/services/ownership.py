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

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Item
from ..schemas.items import ItemSummary
from ..schemas.ownership import (
    CurrencyOwnership,
    FinancialOverview,
    ValuableItem,
    ValueBreakdownRow,
)
from .serializers import item_load_options, item_summary


@dataclass
class PurchaseAllocation:
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


def _allocate_purchases(items: list[Item]) -> dict[uuid.UUID, PurchaseAllocation]:
    by_purchase: dict[uuid.UUID, list[Item]] = defaultdict(list)
    for item in items:
        if item.purchase_id is not None and item.purchase is not None:
            by_purchase[item.purchase_id].append(item)

    allocations: dict[uuid.UUID, PurchaseAllocation] = {}
    for purchase_id, linked in by_purchase.items():
        purchase = linked[0].purchase
        if purchase is None or purchase.price_cents is None:
            continue
        ordered = sorted(linked, key=lambda entry: str(entry.id))
        base, remainder = divmod(purchase.price_cents, len(ordered))
        for index, item in enumerate(ordered):
            allocations[item.id] = PurchaseAllocation(
                item_id=item.id,
                purchase_id=purchase_id,
                allocated_cents=base + (1 if index < remainder else 0),
                currency=purchase.currency,
            )
    return allocations


def _missing_purchase(item: Item) -> bool:
    purchase = item.purchase
    if purchase is None:
        return True
    return purchase.purchase_date is None and purchase.price_cents is None


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
    items = _active_items(db, household_id)
    allocations = _allocate_purchases(items)

    purchase_totals: dict[str, int] = defaultdict(int)
    purchase_item_counts: dict[str, int] = defaultdict(int)
    current_totals: dict[str, int] = defaultdict(int)
    current_item_counts: dict[str, int] = defaultdict(int)
    seen_purchases: set[uuid.UUID] = set()

    category_rows: dict[tuple[str, str], dict[str, Any]] = {}
    room_rows: dict[tuple[str, str], dict[str, Any]] = {}
    valuable: list[ValuableItem] = []
    missing: list[ItemSummary] = []

    for item in items:
        category_name = item.category.name if item.category else "Uncategorised"
        room_name = item.room.name if item.room else "No room"
        purchase = item.purchase
        allocation = allocations.get(item.id)

        if purchase is not None:
            purchase_item_counts[purchase.currency] += 1
            if purchase.id not in seen_purchases and purchase.price_cents is not None:
                purchase_totals[purchase.currency] += purchase.price_cents
                seen_purchases.add(purchase.id)

        if item.current_value_cents is not None:
            current_totals[item.current_value_currency] += item.current_value_cents
            current_item_counts[item.current_value_currency] += 1

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
        if item.current_value_cents is not None:
            _add_breakdown(
                category_rows,
                category_name,
                item.current_value_currency,
                item.id,
                current_cents=item.current_value_cents,
            )
            _add_breakdown(
                room_rows,
                room_name,
                item.current_value_currency,
                item.id,
                current_cents=item.current_value_cents,
            )

        if item.current_value_cents is not None:
            valuable.append(
                ValuableItem(
                    item=item_summary(item, household_reminder_days=household_reminder_days),
                    value_cents=item.current_value_cents,
                    currency=item.current_value_currency,
                    value_kind="current",
                )
            )
        elif allocation is not None:
            valuable.append(
                ValuableItem(
                    item=item_summary(item, household_reminder_days=household_reminder_days),
                    value_cents=allocation.allocated_cents,
                    currency=allocation.currency,
                    value_kind="purchase",
                )
            )

        if _missing_purchase(item):
            missing.append(item_summary(item, household_reminder_days=household_reminder_days))

    currencies = sorted(set(purchase_totals) | set(current_totals))
    currency_totals = [
        CurrencyOwnership(
            currency=currency,
            purchase_total_cents=purchase_totals.get(currency, 0),
            current_value_cents=current_totals.get(currency, 0),
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
                current_value_cents=values["current"],
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

    valuable.sort(key=lambda entry: (-entry.value_cents, entry.item.name.lower()))
    missing.sort(key=lambda entry: entry.name.lower())
    return FinancialOverview(
        item_count=len(items),
        items_with_purchase_count=len(items) - len(missing),
        items_missing_purchase_count=len(missing),
        currency_totals=currency_totals,
        value_by_category=breakdown(category_rows),
        value_by_room=breakdown(room_rows),
        most_valuable_items=valuable[:valuable_limit],
        missing_purchase_items=missing[:missing_limit],
    )


def financial_rows_for_export(db: Session, household_id: uuid.UUID) -> list[dict[str, Any]]:
    """Flat rows used by the inventory CSV export."""
    items = _active_items(db, household_id)
    allocations = _allocate_purchases(items)
    rows: list[dict[str, Any]] = []
    for item in items:
        allocation = allocations.get(item.id)
        purchase = item.purchase
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
                "purchase_allocated_cents": allocation.allocated_cents if allocation else "",
                "current_value_cents": item.current_value_cents
                if item.current_value_cents is not None
                else "",
                "current_value_currency": item.current_value_currency,
                "missing_purchase_information": "yes" if _missing_purchase(item) else "no",
            }
        )
    return rows
