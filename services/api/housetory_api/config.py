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
    imports_dir: Path | None = None
    exports_dir: Path | None = None

    app_base_url: str = "http://localhost:8080"
    qr_base_url: str = ""
    extra_origins: str = ""
    cookie_secure: bool = False
    session_ttl_days: int = Field(default=30, ge=1, le=365)
    max_upload_mb: int = Field(default=25, ge=1, le=100)
    login_max_failures: int = Field(default=10, ge=1, le=100)
    login_window_seconds: int = Field(default=900, ge=10, le=86_400)
    ocr_language: str = "eng"
    ocr_max_pdf_pages: int = Field(default=5, ge=1, le=20)
    import_max_files: int = Field(default=2000, ge=1, le=10000)
    import_max_total_mb: int = Field(default=50, ge=1, le=500)
    import_max_file_mb: int = Field(default=10, ge=1, le=100)
    voice_max_upload_mb: int = Field(default=15, ge=1, le=50)
    voice_max_duration_seconds: int = Field(default=120, ge=10, le=300)
    voice_max_active_notes: int = Field(default=10, ge=1, le=100)
    voice_max_suggestions: int = Field(default=50, ge=1, le=100)
    voice_max_transcript_chars: int = Field(default=12000, ge=500, le=50000)

    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_tls_mode: Literal["starttls", "ssl", "none"] = "starttls"
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_name: str = "Housetory"
    smtp_from_address: str = ""
    smtp_timeout_seconds: int = Field(default=10, ge=2, le=60)
    invitation_ttl_hours: int = Field(default=168, ge=1, le=720)
    password_reset_ttl_minutes: int = Field(default=60, ge=5, le=1440)

    ai_credential_key: str = ""
    ai_credential_key_previous: str = ""
    ai_provider: Literal["disabled", "ollama", "openai_compatible"] = "disabled"
    ai_model: str = ""
    ai_base_url: str = "http://host.docker.internal:11434"
    ai_timeout_seconds: int = Field(default=90, ge=5, le=600)
    ai_max_concurrency: int = Field(default=1, ge=1, le=8)
    ai_cloud_enabled: bool = False
    ai_cloud_consent: bool = False
    ai_cloud_base_url: str = ""
    ai_cloud_model: str = ""
    ai_cloud_api_key: str = ""
    ai_max_context_chars: int = Field(default=12000, ge=1000, le=100000)
    ai_import_max_chunks: int = Field(default=8, ge=1, le=50)

    manual_search_provider: Literal["auto", "brave", "gateway", "none"] = "auto"
    manual_search_url: str = ""
    manual_search_api_key: str = ""
    manual_search_provider_label: str = "Configured manual search"
    manual_search_timeout_seconds: int = Field(default=20, ge=5, le=120)
    brave_search_api_key: str = ""
    brave_search_base_url: str = "https://api.search.brave.com"
    brave_search_country: str = ""
    brave_search_lang: str = ""
    item_image_search_provider: Literal["auto", "brave", "none"] = "auto"
    item_image_max_download_mb: int = Field(default=15, ge=1, le=50)
    item_image_batch_max: int = Field(default=50, ge=1, le=100)
    item_image_search_count: int = Field(default=12, ge=1, le=30)
    # Automatic reference downloads require an explicit operator policy. An
    # empty list means "no automatic downloads"; built-in illustrations remain
    # available. Values are registrable domains (subdomains included).
    item_image_permitted_source_domains: str = ""
    item_image_permitted_licenses: str = "cc0,cc-by,cc-by-sa,public-domain"
    # Optional extra/override entries: "brand=registrable-domain|another-domain".
    item_image_manufacturer_domains: str = ""
    # Optional extra brand lexicon entries for conservative query-only inference.
    item_image_known_brands: str = ""
    evidence_export_max_items: int = Field(default=300, ge=1, le=2000)
    evidence_export_max_documents: int = Field(default=300, ge=1, le=2000)
    evidence_export_max_photos: int = Field(default=500, ge=1, le=2000)
    evidence_export_max_bundle_mb: int = Field(default=100, ge=1, le=1000)
    evidence_export_max_pdf_photos: int = Field(default=60, ge=0, le=500)
    evidence_export_retention_hours: int = Field(default=168, ge=1, le=720)
    evidence_export_timeout_seconds: int = Field(default=180, ge=10, le=900)
    stocktake_max_items: int = Field(default=500, ge=1, le=5000)
    stocktake_max_apply_batch: int = Field(default=200, ge=1, le=1000)
    stocktake_max_active_sessions: int = Field(default=25, ge=1, le=200)
    stocktake_max_notes_chars: int = Field(default=2000, ge=100, le=10000)
    stocktake_max_observations_per_session: int = Field(default=2000, ge=10, le=10000)

    @property
    def qr_effective_base_url(self) -> str:
        return (self.qr_base_url or self.app_base_url).rstrip("/")

    @property
    def qr_base_url_warning(self) -> str | None:
        parsed = urlparse(self.qr_effective_base_url)
        hostname = (parsed.hostname or "").lower()
        if hostname in {"localhost", "127.0.0.1", "::1"}:
            return (
                "QR codes currently point at a localhost address. A phone camera "
                "cannot reach that address. Set QR_BASE_URL to your Tailscale or "
                "LAN URL before printing labels."
            )
        if parsed.scheme == "http" and self.environment == "production":
            return (
                "QR codes use plain HTTP. Set QR_BASE_URL to an HTTPS address for "
                "trusted phone access outside your private network."
            )
        return None

    @property
    def email_configured(self) -> bool:
        return bool(self.smtp_host.strip() and self.smtp_from_address.strip())

    @property
    def ai_credential_key_configured(self) -> bool:
        return bool(self.ai_credential_key)

    @property
    def ai_effective_model(self) -> str:
        if self.ai_provider == "openai_compatible":
            return self.ai_cloud_model
        return self.ai_model

    @property
    def ai_effective_base_url(self) -> str:
        if self.ai_provider == "openai_compatible":
            return self.ai_cloud_base_url.rstrip("/")
        return self.ai_base_url.rstrip("/")

    @property
    def ai_cloud_allowed(self) -> bool:
        return self.ai_cloud_enabled and self.ai_cloud_consent

    @field_validator("smtp_from_address")
    @classmethod
    def _validate_from_address(cls, value: str) -> str:
        value = value.strip()
        if not value:
            return value
        local, separator, domain = value.partition("@")
        if (
            not separator
            or not local
            or "." not in domain
            or any(character.isspace() for character in value)
        ):
            raise ValueError("SMTP_FROM_ADDRESS must be a valid email address.")
        return value

    @field_validator("app_base_url", "qr_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator(
        "qr_base_url",
        "ai_base_url",
        "ai_cloud_base_url",
        "manual_search_url",
        "brave_search_base_url",
    )
    @classmethod
    def _validate_service_url(cls, value: str) -> str:
        if not value:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Service URLs must be absolute http(s) URLs.")
        return value

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
    def resolved_imports_dir(self) -> Path:
        return self.imports_dir or (self.data_dir / "imports")

    @property
    def resolved_exports_dir(self) -> Path:
        return self.exports_dir or (self.data_dir / "exports")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def voice_max_upload_bytes(self) -> int:
        return self.voice_max_upload_mb * 1024 * 1024

    @property
    def item_image_max_download_bytes(self) -> int:
        return self.item_image_max_download_mb * 1024 * 1024

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
