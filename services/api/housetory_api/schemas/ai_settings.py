import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..domain import AiProviderType, AiTask
from ..schemas.common import Name, trimmed

AiTaskName = Literal[
    "assistant",
    "imports",
    "documents",
    "search",
    "vision",
    "labels",
    "transcription",
    "item_images",
]


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


TaskCompatibility = Literal[
    "compatible",
    "unverified",
    "incompatible",
    "adapter_unavailable",
    "not_configured",
]


class AiModelOut(BaseModel):
    id: str
    display_name: str | None = None
    kind: Literal["chat", "embedding", "speech", "image", "other"] = "chat"
    capabilities: list[str] = Field(default_factory=list)
    capability_source: Literal["provider_metadata", "heuristic"] = "heuristic"
    input_modalities: list[str] = Field(default_factory=list)
    output_modalities: list[str] = Field(default_factory=list)
    endpoints: list[str] = Field(default_factory=list)
    task_states: dict[str, TaskCompatibility] = Field(default_factory=dict)


class AiProviderModels(BaseModel):
    provider_id: uuid.UUID
    models: list[AiModelOut]
    error: str | None = None
    cached: bool = False


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
    model_label: str | None = None
    model_listed: bool = False
    compatibility: TaskCompatibility = "not_configured"
    enabled: bool
    capabilities: list[str] = Field(default_factory=list)
    last_test_status: Literal["passed", "failed", "unsupported"] | None = None
    last_test_at: datetime | None = None
    last_test_error: str | None = None
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


class AiTaskTestRequest(BaseModel):
    confirm: bool = False


class AiTaskTestOut(BaseModel):
    task: str
    status: Literal["passed", "failed", "unsupported"]
    message: str
    tested_at: datetime
    model: str | None = None
    provider_label: str | None = None


class AiSettingsModels(BaseModel):
    model_config = ConfigDict(extra="ignore")


TASKS: tuple[str, ...] = tuple(task.value for task in AiTask)
