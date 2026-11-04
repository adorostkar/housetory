"""Database-backed AI provider configuration and capability helpers."""

import uuid
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..domain import AiProviderType, AiTask
from ..models import AiProvider, AiTaskSetting
from ..schemas.ai import AiStatus
from .ai_credentials import CredentialError, decrypt_secret

DEFAULT_BASE_URLS: dict[str, str] = {
    AiProviderType.OPENAI.value: "https://api.openai.com/v1",
    AiProviderType.ANTHROPIC.value: "https://api.anthropic.com/v1",
    AiProviderType.GEMINI.value: "https://generativelanguage.googleapis.com/v1beta",
    AiProviderType.XAI.value: "https://api.x.ai/v1",
    AiProviderType.OPENROUTER.value: "https://openrouter.ai/api/v1",
    AiProviderType.OLLAMA.value: "http://host.docker.internal:11434",
}

CLOUD_PROVIDERS = {
    AiProviderType.OPENAI.value,
    AiProviderType.ANTHROPIC.value,
    AiProviderType.GEMINI.value,
    AiProviderType.XAI.value,
    AiProviderType.OPENROUTER.value,
}

TEXT_TASKS = {
    AiTask.ASSISTANT.value,
    AiTask.IMPORTS.value,
    AiTask.DOCUMENTS.value,
    AiTask.SEARCH.value,
    AiTask.LABELS.value,
}


@dataclass(frozen=True)
class AiRuntimeConfig:
    provider: str
    base_url: str
    api_key: str | None
    model: str | None
    task: str
    provider_id: uuid.UUID | None
    display_name: str | None
    mode: Literal["disabled", "local", "cloud"]
    source: Literal["database", "environment"]
    enabled: bool
    cloud_consent: bool
    configured: bool
    error: str | None = None

    @property
    def is_local(self) -> bool:
        return self.mode == "local"

    @property
    def capabilities(self) -> list[str]:
        return model_capabilities(self.provider, self.model)


def _mode(provider: str) -> Literal["disabled", "local", "cloud"]:
    if provider == AiProviderType.OLLAMA.value:
        return "local"
    if provider in CLOUD_PROVIDERS:
        return "cloud"
    return "disabled"


def _env_config(task: str) -> AiRuntimeConfig:
    settings = get_settings()
    provider = settings.ai_provider
    mapped = (
        AiProviderType.OLLAMA.value
        if provider == "ollama"
        else AiProviderType.OPENAI.value
        if provider == "openai_compatible"
        else "disabled"
    )
    model = settings.ai_effective_model or None
    base_url = settings.ai_effective_base_url if mapped != "disabled" else ""
    consent = settings.ai_cloud_allowed
    configured = bool(
        mapped != "disabled"
        and model
        and base_url
        and (mapped == AiProviderType.OLLAMA.value or consent)
    )
    error = None
    if mapped != "disabled" and not configured:
        error = (
            "No AI model is selected."
            if not model
            else "Cloud inference requires AI_CLOUD_ENABLED=true and AI_CLOUD_CONSENT=true."
        )
    return AiRuntimeConfig(
        provider=mapped,
        base_url=base_url,
        api_key=settings.ai_cloud_api_key or None,
        model=model,
        task=task,
        provider_id=None,
        display_name=mapped if mapped != "disabled" else None,
        mode=_mode(mapped),
        source="environment",
        enabled=mapped != "disabled",
        cloud_consent=consent,
        configured=configured,
        error=error,
    )


def _provider_config(
    provider: AiProvider,
    task: str,
    model: str | None,
    error: str | None = None,
    *,
    require_consent: bool = True,
) -> AiRuntimeConfig:
    mode = _mode(provider.provider)
    base_url = (provider.base_url or DEFAULT_BASE_URLS.get(provider.provider) or "").rstrip("/")
    if base_url and urlparse(base_url).scheme not in {"http", "https"}:
        return AiRuntimeConfig(
            provider=provider.provider,
            base_url="",
            api_key=None,
            model=model,
            task=task,
            provider_id=provider.id,
            display_name=provider.display_name,
            mode=mode,
            source="database",
            enabled=provider.enabled,
            cloud_consent=provider.cloud_consent,
            configured=False,
            error="Provider base URL must be an http(s) URL.",
        )
    api_key = None
    if provider.encrypted_api_key:
        try:
            api_key = decrypt_secret(provider.encrypted_api_key)
        except CredentialError as exc:
            return AiRuntimeConfig(
                provider=provider.provider,
                base_url=base_url,
                api_key=None,
                model=model,
                task=task,
                provider_id=provider.id,
                display_name=provider.display_name,
                mode=mode,
                source="database",
                enabled=provider.enabled,
                cloud_consent=provider.cloud_consent,
                configured=False,
                error=str(exc),
            )
    if not provider.enabled:
        return AiRuntimeConfig(
            provider=provider.provider,
            base_url=base_url,
            api_key=api_key,
            model=model,
            task=task,
            provider_id=provider.id,
            display_name=provider.display_name,
            mode=mode,
            source="database",
            enabled=False,
            cloud_consent=provider.cloud_consent,
            configured=False,
            error="This provider is disabled.",
        )
    if mode == "cloud" and require_consent and not provider.cloud_consent:
        return AiRuntimeConfig(
            provider=provider.provider,
            base_url=base_url,
            api_key=api_key,
            model=model,
            task=task,
            provider_id=provider.id,
            display_name=provider.display_name,
            mode=mode,
            source="database",
            enabled=True,
            cloud_consent=False,
            configured=False,
            error=(
                "Cloud consent is not enabled for this provider. Household content "
                "will not be sent until the owner explicitly enables consent."
            ),
        )
    if not model:
        return AiRuntimeConfig(
            provider=provider.provider,
            base_url=base_url,
            api_key=api_key,
            model=None,
            task=task,
            provider_id=provider.id,
            display_name=provider.display_name,
            mode=mode,
            source="database",
            enabled=True,
            cloud_consent=provider.cloud_consent,
            configured=False,
            error="No model is selected for this task.",
        )
    return AiRuntimeConfig(
        provider=provider.provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
        task=task,
        provider_id=provider.id,
        display_name=provider.display_name,
        mode=mode,
        source="database",
        enabled=True,
        cloud_consent=provider.cloud_consent,
        configured=True,
        error=error,
    )


def config_for_provider(
    provider: AiProvider,
    task: str = AiTask.ASSISTANT.value,
    *,
    model: str | None = None,
    require_consent: bool = True,
) -> AiRuntimeConfig:
    return _provider_config(
        provider,
        AiTask(task).value,
        model or provider.default_model,
        require_consent=require_consent,
    )


def resolve_config(db: Session, household_id: uuid.UUID, task: str) -> AiRuntimeConfig:
    task = AiTask(task).value
    providers = list(
        db.scalars(
            select(AiProvider)
            .where(AiProvider.household_id == household_id)
            .order_by(AiProvider.created_at)
        ).all()
    )
    if not providers:
        return _env_config(task)
    by_id = {provider.id: provider for provider in providers}
    setting = db.scalar(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.task == task,
        )
    )
    if setting is not None:
        if not setting.enabled:
            provider = by_id.get(setting.provider_id) if setting.provider_id else None
            return _provider_config(
                provider or providers[0],
                task,
                setting.model,
                error="AI is disabled for this task.",
            )
        provider = by_id.get(setting.provider_id) if setting.provider_id else None
        if provider is None:
            return AiRuntimeConfig(
                provider="disabled",
                base_url="",
                api_key=None,
                model=None,
                task=task,
                provider_id=None,
                display_name=None,
                mode="disabled",
                source="database",
                enabled=False,
                cloud_consent=False,
                configured=False,
                error="The selected provider no longer exists.",
            )
        return _provider_config(provider, task, setting.model or provider.default_model)
    # A single configured provider is a convenient default for text tasks.
    enabled = [provider for provider in providers if provider.enabled]
    if len(enabled) == 1:
        provider = enabled[0]
        if task == AiTask.VISION.value and "vision" not in model_capabilities(
            provider.provider, provider.default_model
        ):
            return _provider_config(
                provider,
                task,
                provider.default_model,
                error="Configure a vision-capable model for image recognition.",
            )
        return _provider_config(provider, task, provider.default_model)
    return AiRuntimeConfig(
        provider="disabled",
        base_url="",
        api_key=None,
        model=None,
        task=task,
        provider_id=None,
        display_name=None,
        mode="disabled",
        source="database",
        enabled=False,
        cloud_consent=False,
        configured=False,
        error="No provider is assigned to this AI task.",
    )


def model_capabilities(provider: str, model: str | None) -> list[str]:
    if not model:
        return []
    lowered = model.lower()
    capabilities = ["text"]
    if provider in CLOUD_PROVIDERS:
        capabilities.extend(["structured", "tools"])
    elif provider == AiProviderType.OLLAMA.value:
        capabilities.append("structured")
        if any(token in lowered for token in ("llama", "qwen", "mistral", "gemma")):
            capabilities.append("tools")
    elif provider == AiProviderType.GEMINI.value:
        capabilities.extend(["structured", "tools"])
    if any(
        token in lowered
        for token in (
            "vision",
            "gpt-4o",
            "gpt-4.1",
            "gpt-4-turbo",
            "gpt-4-vision",
            "gpt-5",
            "o3",
            "o4",
            "claude-3",
            "claude-4",
            "claude-sonnet",
            "claude-opus",
            "gemini",
            "grok-2-vision",
            "grok-4",
            "llava",
            "bakllava",
            "qwen2.5-vl",
            "qwen3-vl",
            "llama3.2-vision",
            "minicpm-v",
        )
    ):
        capabilities.append("vision")
    return list(dict.fromkeys(capabilities))


def task_requires_vision(task: str) -> bool:
    return task == AiTask.VISION.value


def status_from_config(
    config: AiRuntimeConfig,
    *,
    probe: bool = True,
    models: list[str] | None = None,
    probe_error: str | None = None,
    available: bool = False,
) -> AiStatus:
    model = config.model or None
    error = config.error or probe_error
    privacy_note = (
        "Local inference is used. Household content stays on your server."
        if config.mode == "local"
        else "Cloud inference can send household prompts and excerpts to the selected provider."
        if config.mode == "cloud"
        else "AI is disabled. Housetory's deterministic import, search and assistance still work."
    )
    return AiStatus(
        provider=config.provider,
        mode=config.mode,
        model=model,
        configured=config.configured,
        available=available,
        models=models or [],
        cloud_enabled=config.mode == "cloud",
        cloud_consent=config.cloud_consent,
        data_leaves_server=bool(config.mode == "cloud" and config.configured),
        error=error,
        privacy_note=privacy_note,
        source=config.source,
        task=config.task,
        provider_id=config.provider_id,
        provider_label=config.display_name,
        capabilities=config.capabilities,
    )
