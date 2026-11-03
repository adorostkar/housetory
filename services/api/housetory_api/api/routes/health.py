import logging
import tempfile

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from ... import __version__
from ...config import get_settings
from ...db import get_db
from ...schemas.health import ComponentHealth, HealthOut

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


def live_payload() -> HealthOut:
    return HealthOut(status="ok", service="housetory-api", version=__version__)


@router.get("/health/live", response_model=HealthOut)
def health_live() -> HealthOut:
    return live_payload()


@router.get("/health/ready", response_model=HealthOut)
def health_ready(db: Session = Depends(get_db)) -> HealthOut | JSONResponse:
    components: dict[str, ComponentHealth] = {}
    healthy = True

    try:
        db.execute(text("SELECT 1"))
        components["database"] = ComponentHealth(status="ok")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Readiness database check failed: %s", exc)
        components["database"] = ComponentHealth(
            status="error", detail="Database connection failed."
        )
        healthy = False

    try:
        root = get_settings().resolved_uploads_dir
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=root, prefix=".health-", delete=True):
            pass
        components["storage"] = ComponentHealth(status="ok")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Readiness storage check failed: %s", exc)
        components["storage"] = ComponentHealth(status="error", detail="Storage is not writable.")
        healthy = False

    payload = HealthOut(
        status="ok" if healthy else "degraded",
        service="housetory-api",
        version=__version__,
        components=components,
    )
    if not healthy:
        return JSONResponse(status_code=503, content=payload.model_dump(mode="json"))
    return payload
