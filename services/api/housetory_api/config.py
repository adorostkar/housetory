from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. All values can be supplied through the environment."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Housetory"
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False
    api_prefix: str = "/api/v1"

    database_url: str = "postgresql+psycopg://housetory:housetory@localhost:5432/housetory"
    data_dir: Path = Path("./data")
    uploads_dir: Path | None = None

    app_base_url: str = "http://localhost:8080"
    extra_origins: str = ""
    cookie_secure: bool = False
    session_ttl_days: int = Field(default=30, ge=1, le=365)
    max_upload_mb: int = Field(default=25, ge=1, le=100)
    login_max_failures: int = Field(default=10, ge=1, le=100)
    login_window_seconds: int = Field(default=900, ge=10, le=86_400)
    ocr_language: str = "eng"
    ocr_max_pdf_pages: int = Field(default=5, ge=1, le=20)

    @field_validator("app_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @model_validator(mode="after")
    def _validate_deployment_security(self) -> "Settings":
        parsed = urlparse(self.app_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("APP_BASE_URL must be an absolute http(s) URL.")

        if parsed.scheme == "https" and not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be true when APP_BASE_URL uses HTTPS.")

        if (
            self.environment == "production"
            and parsed.scheme == "http"
            and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("Production must use an HTTPS APP_BASE_URL or a localhost origin.")

        if self.environment == "production" and self.debug:
            raise ValueError("DEBUG must be disabled in production.")

        return self

    @property
    def resolved_uploads_dir(self) -> Path:
        return self.uploads_dir or (self.data_dir / "uploads")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as exc:
        # Pydantic includes the full input mapping (including DATABASE_URL) in
        # validation errors. Never let that reach container logs.
        messages = "; ".join(str(error["msg"]) for error in exc.errors())
        raise RuntimeError(f"Invalid Housetory configuration: {messages}") from None
