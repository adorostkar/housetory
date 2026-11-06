from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .common import trimmed

OnlineSearchSource = Literal["household", "environment", "none"]
OnlineSearchProviderName = Literal["brave"]
DomainInput = trimmed(1, 253)


class OnlineSearchChannelOut(BaseModel):
    enabled: bool = False
    configured: bool = False
    source: OnlineSearchSource = "none"
    provider: str | None = None
    provider_label: str | None = None
    reason: str | None = None


class OnlineSearchReferenceChannelOut(OnlineSearchChannelOut):
    permitted_source_domains: list[str] = Field(default_factory=list)
    policy_configured: bool = False


class OnlineSearchSettingsOut(BaseModel):
    provider: OnlineSearchProviderName = "brave"
    supported_providers: list[OnlineSearchProviderName] = Field(default_factory=lambda: ["brave"])
    manual_enabled: bool = False
    reference_enabled: bool = False
    has_api_key: bool = False
    environment_api_key_available: bool = False
    credential_source: OnlineSearchSource = "none"
    api_key_version: int = 0
    credential_storage_ready: bool = False
    permitted_source_domains: list[str] = Field(default_factory=list)
    max_permitted_domains: int = 50
    manual: OnlineSearchChannelOut = Field(default_factory=OnlineSearchChannelOut)
    reference: OnlineSearchReferenceChannelOut = Field(
        default_factory=OnlineSearchReferenceChannelOut
    )
    environment_manual_available: bool = False
    environment_reference_available: bool = False
    updated_at: datetime | None = None
    warning: str | None = None


class OnlineSearchSettingsUpdate(BaseModel):
    manual_enabled: bool | None = None
    reference_enabled: bool | None = None
    # A blank submitted key means "keep the saved credential"; omit it entirely
    # from clients that do not want to touch the credential.
    api_key: trimmed(0, 4000) | None = None
    clear_api_key: bool = False
    permitted_source_domains: list[DomainInput] | None = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def _key_actions_are_exclusive(self) -> "OnlineSearchSettingsUpdate":
        if self.api_key and self.clear_api_key:
            raise ValueError("Enter a replacement key or remove the saved key, not both.")
        return self


class OnlineSearchTestRequest(BaseModel):
    confirm: bool = False


class OnlineSearchTestOut(BaseModel):
    ok: bool
    message: str
    manual_ok: bool | None = None
    reference_ok: bool | None = None
    source: OnlineSearchSource = "none"
    provider_label: str | None = None
    tested_at: datetime


__all__ = [
    "OnlineSearchChannelOut",
    "OnlineSearchProviderName",
    "OnlineSearchReferenceChannelOut",
    "OnlineSearchSettingsOut",
    "OnlineSearchSettingsUpdate",
    "OnlineSearchSource",
    "OnlineSearchTestOut",
    "OnlineSearchTestRequest",
]
