import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from ..schemas.common import Name, ORMModel
from ..schemas.households import HouseholdMembershipOut


class SetupRequest(BaseModel):
    name: Name
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    household_name: Name = Field(default="My Home")

    @field_validator("email")
    @classmethod
    def _lowercase_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("password")
    @classmethod
    def _password_not_bland(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("Password must not begin or end with whitespace.")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _lowercase_email(cls, value: str) -> str:
        return value.strip().lower()


OfflineCopyPolicy = Literal["nobody", "members", "everyone"]


class UserOut(ORMModel):
    id: uuid.UUID
    name: str
    email: EmailStr
    created_at: datetime


class HouseholdOut(ORMModel):
    id: uuid.UUID
    name: str
    default_currency: str = "USD"
    warranty_reminder_days: int = 30
    item_image_auto_reference: bool = False
    offline_copy_policy: OfflineCopyPolicy = "members"


class HouseholdUpdate(BaseModel):
    name: Name | None = None
    default_currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    warranty_reminder_days: int | None = Field(default=None, ge=1, le=3650)
    item_image_auto_reference: bool | None = None
    offline_copy_policy: OfflineCopyPolicy | None = None


class SessionState(BaseModel):
    authenticated: bool
    setup_required: bool
    user: UserOut | None = None
    household: HouseholdOut | None = None
    role: str | None = None
    # Whether this account may keep an offline copy of the selected household.
    offline_copy_allowed: bool = False
    households: list[HouseholdMembershipOut] = Field(default_factory=list)


class SetupStatus(BaseModel):
    setup_required: bool
