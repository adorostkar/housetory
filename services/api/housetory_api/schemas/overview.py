from pydantic import BaseModel

from ..schemas.items import ItemSummary


class CurrencyTotal(BaseModel):
    currency: str
    total_cents: int


class OverviewOut(BaseModel):
    room_count: int
    location_count: int
    item_count: int
    total_quantity: int
    value_by_currency: list[CurrencyTotal]
    document_count: int
    warranties_expiring_soon: int
    photo_bytes: int
    document_bytes: int
    recent_items: list[ItemSummary]
