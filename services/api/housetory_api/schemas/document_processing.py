from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ProcessingTimings(BaseModel):
    upload_ms: int | None = Field(
        default=None, description="Server-side storage and normalization; excludes network upload."
    )
    local_preprocess_ms: int | None = Field(
        default=None, description="Post-storage hashing, duplicate lookup and page counting."
    )
    local_queue_ms: int | None = None
    local_processing_ms: int | None = None
    ai_queue_ms: int | None = None
    provider_ms: int | None = None
    validation_ms: int | None = Field(
        default=None,
        description=(
            "Measured refinement schema, evidence and financial validation; null if unmeasured."
        ),
    )


class ProcessingRetryRequest(BaseModel):
    operation: Literal["interpret", "matches"] = "interpret"


class DocumentProcessingSnapshot(BaseModel):
    correlation_id: str
    stage: Literal[
        "waiting",
        "reading",
        "interpreting",
        "ready",
        "needs_attention",
        "failed",
        "cancelled",
    ]
    started_at: datetime
    updated_at: datetime
    elapsed_ms: int
    local_available: bool
    can_cancel: bool
    can_retry: bool
    worker_available: bool | None
    reason: str | None
    timings: ProcessingTimings
    mode: Literal["interactive", "background"] = "interactive"
    background_reason: str | None = None
    page_count: int | None = None
    page_limit: int | None = None


__all__ = ["DocumentProcessingSnapshot", "ProcessingRetryRequest", "ProcessingTimings"]
