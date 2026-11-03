from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
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

    @field_validator("app_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

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
    return Settings()
