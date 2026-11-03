from typing import Literal

from pydantic import BaseModel


class ComponentHealth(BaseModel):
    status: Literal["ok", "error"]
    detail: str | None = None


class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    service: str
    version: str
    components: dict[str, ComponentHealth] | None = None
