import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from ..schemas.common import Name, ORMModel

Role = Literal["owner", "member", "viewer"]


def _lower_email(value: str) -> str:
    return value.strip().lower()


class AccountUpdate(BaseModel):
    name: Name | None = None


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _valid_password(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("Password must not begin or end with whitespace.")
        return value


class MemberOut(BaseModel):
    user_id: uuid.UUID
    name: str
    email: EmailStr
    role: Role
    joined_at: datetime


class MemberList(BaseModel):
    members: list[MemberOut]
    email_configured: bool


class MemberRoleUpdate(BaseModel):
    role: Role


class InvitationCreate(BaseModel):
    email: EmailStr
    role: Role = "member"

    @field_validator("email")
    @classmethod
    def _lowercase(cls, value: str) -> str:
        return _lower_email(value)


class InvitationOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    role: Role
    status: Literal["pending", "accepted", "revoked", "expired"]
    expires_at: datetime
    last_sent_at: datetime | None = None
    created_at: datetime


class InvitationList(BaseModel):
    items: list[InvitationOut]
    email_configured: bool


class InvitationPublic(BaseModel):
    household_name: str
    email: EmailStr
    role: Role
    expires_at: datetime
    account_exists: bool
    authenticated_email_matches: bool = False


class InvitationAccept(BaseModel):
    name: Name | None = None
    password: str | None = Field(default=None, min_length=12, max_length=128)

    @field_validator("password")
    @classmethod
    def _valid_password(cls, value: str | None) -> str | None:
        if value is not None and value.strip() != value:
            raise ValueError("Password must not begin or end with whitespace.")
        return value


class PasswordResetRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def _lowercase(cls, value: str) -> str:
        return _lower_email(value)


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=20, max_length=300)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("password")
    @classmethod
    def _valid_password(cls, value: str) -> str:
        if value.strip() != value:
            raise ValueError("Password must not begin or end with whitespace.")
        return value


class PasswordResetPublic(BaseModel):
    valid: bool
    expires_at: datetime | None = None


class AccountOut(ORMModel):
    id: uuid.UUID
    name: str
    email: EmailStr
    created_at: datetime


class SimpleMessage(BaseModel):
    message: str


class EmailStatus(BaseModel):
    configured: bool
    from_address: str | None = None
