import uuid

from pydantic import BaseModel, Field

from .common import Name, ORMModel


class HouseholdBrief(ORMModel):
    id: uuid.UUID
    name: str


class HouseholdMembershipOut(HouseholdBrief):
    role: str
    default_currency: str = "USD"
    warranty_reminder_days: int = 30
    property_count: int = 0
    is_current: bool = False


class HouseholdList(BaseModel):
    items: list[HouseholdMembershipOut] = Field(default_factory=list)


class HouseholdCreate(BaseModel):
    name: Name
    property_name: Name = "Home"


class HouseholdSelect(BaseModel):
    household_id: uuid.UUID


__all__ = [
    "HouseholdBrief",
    "HouseholdCreate",
    "HouseholdList",
    "HouseholdMembershipOut",
    "HouseholdSelect",
]
