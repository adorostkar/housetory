"""FastAPI application factory."""

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .api.deps import validate_origin
from .api.errors import ApiError, error_body, install_exception_handlers
from .api.router import api_router
from .api.routes.health import live_payload
from .config import get_settings
from .services.storage import ensure_storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("housetory.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    ensure_storage()
    logger.info("Housetory API starting (environment=%s)", settings.environment)
    yield
    logger.info("Housetory API stopping")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Housetory API",
        version=__version__,
        description="Everything has a place.",
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
        lifespan=lifespan,
    )

    install_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_prefix)

    @app.get("/healthz", include_in_schema=False)
    def unversioned_health():
        return live_payload()

    @app.middleware("http")
    async def request_middleware(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        try:
            validate_origin(request)
        except ApiError as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content=error_body(exc.code, exc.message),
                headers={"X-Request-ID": request_id},
            )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    return app


app = create_app()
