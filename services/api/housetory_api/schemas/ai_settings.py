import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..domain import AiProviderType, AiTask
from ..schemas.common import Name, trimmed

AiTaskName = Literal["assistant", "imports", "documents", "search", "vision", "labels"]


class AiProviderCreate(BaseModel):
    provider: AiProviderType
    display_name: Name | None = None
    base_url: trimmed(1, 500) | None = None
    default_model: trimmed(1, 160) | None = None
    api_key: trimmed(1, 4000) | None = None
    enabled: bool = True
    cloud_consent: bool = False


class AiProviderUpdate(BaseModel):
    display_name: Name | None = None
    base_url: trimmed(1, 500) | None = None
    default_model: trimmed(1, 160) | None = None
    api_key: trimmed(1, 4000) | None = None
    clear_api_key: bool = False
    enabled: bool | None = None
    cloud_consent: bool | None = None


class AiProviderOut(BaseModel):
    id: uuid.UUID
    provider: str
    display_name: str
    base_url: str | None
    default_model: str | None
    has_api_key: bool
    api_key_version: int
    enabled: bool
    cloud_consent: bool
    is_local: bool
    endpoint_scope: Literal["local", "private", "remote"]
    capabilities: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class AiModelOut(BaseModel):
    id: str
    capabilities: list[str] = Field(default_factory=list)


class AiProviderModels(BaseModel):
    provider_id: uuid.UUID
    models: list[AiModelOut]
    error: str | None = None


class AiProviderTest(BaseModel):
    ok: bool
    message: str
    models: list[str] = Field(default_factory=list)
    selected_model_available: bool | None = None


class AiTaskSettingOut(BaseModel):
    task: str
    provider_id: uuid.UUID | None
    provider_label: str | None
    model: str | None
    enabled: bool
    capabilities: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None


class AiTaskSettingUpdate(BaseModel):
    provider_id: uuid.UUID | None = None
    model: trimmed(1, 160) | None = None
    enabled: bool = True


class AiSettingsOut(BaseModel):
    providers: list[AiProviderOut]
    tasks: list[AiTaskSettingOut]
    credential_key_configured: bool
    environment_provider: str
    warning: str | None = None


class AiCredentialRotationOut(BaseModel):
    rotated: int
    failed: int


class AiProviderTestRequest(BaseModel):
    model: trimmed(1, 160) | None = None


class AiSettingsModels(BaseModel):
    model_config = ConfigDict(extra="ignore")


TASKS: tuple[str, ...] = tuple(task.value for task in AiTask)
