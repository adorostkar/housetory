import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ReleaseStatus(BaseModel):
    version: str
    commit: str
    build_time: str
    channel: str
    environment: str
    identity: str


class ReadinessComponent(BaseModel):
    name: str
    status: Literal["ok", "degraded", "unknown"]
    detail: str | None = None


class FailedJobOut(BaseModel):
    id: uuid.UUID
    task: str
    attempts: int
    max_attempts: int
    error: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class JobStatusOut(BaseModel):
    counts: dict[str, int] = Field(default_factory=dict)
    recent_failed: list[FailedJobOut] = Field(default_factory=list)


class TaskStatusOut(BaseModel):
    task: str
    label: str
    provider_label: str | None = None
    model: str | None = None
    model_label: str | None = None
    model_listed: bool = False
    enabled: bool = False
    configured: bool = False
    compatibility: str = "not_configured"
    capabilities: list[str] = Field(default_factory=list)
    live_tested: bool = False
    last_test_status: str | None = None
    last_test_at: datetime | None = None
    last_test_error: str | None = None
    error: str | None = None


class ExternalServiceStatus(BaseModel):
    name: str
    configured: bool
    status: Literal["configured", "partial", "not_configured", "unknown"]
    detail: str


class SystemStatusOut(BaseModel):
    release: ReleaseStatus
    readiness: list[ReadinessComponent]
    jobs: JobStatusOut
    tasks: list[TaskStatusOut]
    external_services: list[ExternalServiceStatus]
    generated_at: datetime


class JobRetryOut(BaseModel):
    id: uuid.UUID
    task: str
    status: str


__all__ = [
    "ExternalServiceStatus",
    "FailedJobOut",
    "JobRetryOut",
    "JobStatusOut",
    "ReadinessComponent",
    "ReleaseStatus",
    "SystemStatusOut",
    "TaskStatusOut",
]
