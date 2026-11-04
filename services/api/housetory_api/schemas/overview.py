from pydantic import BaseModel

from ..schemas.items import ItemSummary
from ..schemas.warranties import WarrantyDashboard


class CurrencyTotal(BaseModel):
    currency: str
    total_cents: int


class OverviewOut(BaseModel):
    room_count: int
    location_count: int
    item_count: int
    total_quantity: int
    value_by_currency: list[CurrencyTotal]
    current_value_by_currency: list[CurrencyTotal]
    document_count: int
    warranties_expiring_soon: int
    warranties: WarrantyDashboard
    items_missing_purchase_count: int
    photo_bytes: int
    document_bytes: int
    outstanding_loan_count: int = 0
    overdue_loan_count: int = 0
    on_loan_quantity: int = 0
    recent_items: list[ItemSummary]
