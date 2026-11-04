from pydantic import BaseModel

from ..schemas.items import ItemSummary


class CurrencyOwnership(BaseModel):
    currency: str
    purchase_total_cents: int
    current_value_cents: int
    purchase_item_count: int
    current_value_item_count: int


class ValueBreakdownRow(BaseModel):
    name: str
    currency: str
    purchase_total_cents: int
    current_value_cents: int
    item_count: int


class ValuableItem(BaseModel):
    item: ItemSummary
    value_cents: int
    currency: str
    value_kind: str


class FinancialOverview(BaseModel):
    item_count: int
    items_with_purchase_count: int
    items_missing_purchase_count: int
    currency_totals: list[CurrencyOwnership]
    value_by_category: list[ValueBreakdownRow]
    value_by_room: list[ValueBreakdownRow]
    most_valuable_items: list[ValuableItem]
    missing_purchase_items: list[ItemSummary]
    exchange_rates_configured: bool = False
    conversion_note: str = (
        "Currencies are reported separately. Housetory does not combine them "
        "without operator-configured exchange rates."
    )
