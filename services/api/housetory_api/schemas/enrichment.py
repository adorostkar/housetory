import uuid
from typing import Literal

from pydantic import BaseModel


class EnhancementState(BaseModel):
    status: Literal["off", "queued", "running", "ready", "failed", "skipped", "accepted"]
    job_id: uuid.UUID | None = None
    version: str | None = None
    reason: str | None = None
    error: str | None = None
    provider: str | None = None
    model: str | None = None
    ai_attempted: bool = False
    ai_succeeded: bool = False
