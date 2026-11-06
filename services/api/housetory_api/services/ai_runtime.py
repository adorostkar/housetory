"""Database-backed AI provider configuration and capability helpers."""

import ipaddress
import uuid
from dataclasses import dataclass, replace
from typing import Literal
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..domain import AiProviderType, AiTask
from ..models import AiProvider, AiTaskSetting
from ..schemas.ai import AiStatus
from .ai_credentials import CredentialError, decrypt_secret
from .task_capabilities import adapter_gap_message, provider_adapter_supported

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
    mode: Literal["disabled", "local", "private", "cloud"]
    source: Literal["database", "environment"]
    enabled: bool
    cloud_consent: bool
    configured: bool
    error: str | None = None

    @property
    def is_local(self) -> bool:
        return self.mode == "local"

    @property
    def endpoint_scope(self) -> Literal["local", "private", "remote"]:
        return endpoint_scope(self.provider, self.base_url)

    @property
    def endpoint_host(self) -> str:
        return (urlparse(self.base_url).hostname or self.base_url).lower()

    @property
    def capabilities(self) -> list[str]:
        return model_capabilities(self.provider, self.model)


LOCAL_ENDPOINT_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "host.docker.internal",
    "host.containers.internal",
    "gateway.docker.internal",
}


def endpoint_scope(provider: str, base_url: str) -> Literal["local", "private", "remote"]:
    """Classify where inference data is sent.

    Ollama is a runtime, not a privacy guarantee. Loopback and container-host
    endpoints stay on the Housetory host; RFC1918/link-local/Tailscale/private
    DNS endpoints are private-network destinations; everything else is remote.
    """
    if provider != AiProviderType.OLLAMA.value:
        return "remote"
    host = (urlparse(base_url).hostname or "").strip().lower()
    if not host or host in LOCAL_ENDPOINT_HOSTS or host.endswith(".localhost"):
        return "local"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if address.is_loopback:
            return "local"
        if (
            address.is_private
            or address.is_link_local
            or address in ipaddress.ip_network("100.64.0.0/10")
        ):
            return "private"
        return "remote"
    if "." not in host:
        # Docker/Kubernetes service name such as http://ollama:11434.
        return "local"
    if host.endswith((".local", ".internal", ".lan", ".home", ".ts.net")):
        return "private"
    return "remote"


def _mode_for(provider: str, base_url: str) -> Literal["disabled", "local", "private", "cloud"]:
    if provider == AiProviderType.OLLAMA.value:
        scope = endpoint_scope(provider, base_url)
        if scope == "local":
            return "local"
        if scope == "private":
            return "private"
        return "cloud"
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
    mode = _mode_for(mapped, base_url)
    consent = settings.ai_cloud_allowed
    configured = bool(mapped != "disabled" and model and base_url and (mode == "local" or consent))
    error = None
    if mapped != "disabled" and not configured:
        error = (
            "No AI model is selected."
            if not model
            else "Remote inference requires AI_CLOUD_ENABLED=true and AI_CLOUD_CONSENT=true."
        )
    return AiRuntimeConfig(
        provider=mapped,
        base_url=base_url,
        api_key=settings.ai_cloud_api_key or None,
        model=model,
        task=task,
        provider_id=None,
        display_name=mapped if mapped != "disabled" else None,
        mode=mode,
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
    base_url = (provider.base_url or DEFAULT_BASE_URLS.get(provider.provider) or "").rstrip("/")
    mode = _mode_for(provider.provider, base_url)
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
    if mode in {"private", "cloud"} and require_consent and not provider.cloud_consent:
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
                "Remote inference consent is not enabled for this provider. Household "
                "content will not be sent to a private-network or external endpoint "
                "until the owner explicitly enables consent."
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
        config = _env_config(task)
        if task == AiTask.TRANSCRIPTION.value and not provider_supports_transcription(
            config.provider
        ):
            return replace(
                config,
                configured=False,
                error=(
                    "No transcription task is configured. Choose OpenAI, OpenRouter "
                    "(STT/audio input) or Google Gemini (audio input) under Settings → "
                    "AI providers → Task defaults."
                ),
            )
        return config
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
            return replace(
                _provider_config(provider or providers[0], task, setting.model),
                configured=False,
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
        config = _provider_config(provider, task, setting.model or provider.default_model)
        if config.enabled and not provider_adapter_supported(provider.provider, task):
            return replace(
                config,
                configured=False,
                error=adapter_gap_message(task),
            )
        return config
    if task == AiTask.VISION.value:
        # An assistant/default model is not proof that image recognition is configured.
        # Vision must be assigned explicitly so a text-only model is never called blindly.
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
            error=(
                "No vision task is configured. Choose a vision-capable provider and "
                "model under Settings → AI providers → Task defaults."
            ),
        )
    if task == AiTask.ITEM_IMAGES.value:
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
            error=(
                "No item illustration task is configured. Choose an OpenAI Images or "
                "OpenRouter image-output model under Settings → AI providers → "
                "Task defaults."
            ),
        )
    if task == AiTask.TRANSCRIPTION.value:
        # Audio transcription is opt-in and provider-specific. Never reuse a chat
        # or vision default silently.
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
            error=(
                "No transcription task is configured. Choose OpenAI, OpenRouter "
                "(STT/audio input) or Google Gemini (audio input) under Settings → "
                "AI providers → Task defaults."
            ),
        )
    # A single configured provider is a convenient default for text tasks.
    enabled = [provider for provider in providers if provider.enabled]
    if len(enabled) == 1:
        provider = enabled[0]
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


def provider_supports_transcription(provider: str) -> bool:
    return provider in {
        AiProviderType.OPENAI.value,
        AiProviderType.GEMINI.value,
        AiProviderType.OPENROUTER.value,
    }


def model_supports_transcription(provider: str, model: str | None) -> bool:
    if not provider_supports_transcription(provider) or not model:
        return False
    if provider in {AiProviderType.GEMINI.value, AiProviderType.OPENROUTER.value}:
        # Gemini accepts audio inline. OpenRouter audio models vary, so the
        # transcription adapter revalidates discovered modalities/endpoints
        # before sending any household audio.
        return True
    lowered = model.lower()
    return "whisper" in lowered or "transcribe" in lowered


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
    if provider == AiProviderType.GEMINI.value or any(
        token in lowered for token in ("whisper", "transcribe", "speech-to-text", "stt-", "-stt")
    ):
        capabilities.append("audio")
    if any(
        token in lowered
        for token in (
            "dall-e",
            "gpt-image",
            "image-generation",
            "stable-diffusion",
            "flux-",
            "imagen",
            "gemini-2.5-flash-image",
            "gemini-3-pro-image",
            "seedream",
            "recraft",
            "ideogram",
            "qwen-image",
            "hunyuan-image",
            "kolors",
            "sdxl",
            "sd3",
        )
    ):
        capabilities.append("image")
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
    catalog_checked: bool = False,
) -> AiStatus:
    model = config.model or None
    error = config.error or probe_error
    if config.mode == "local":
        privacy_note = (
            "Local inference is used. The configured endpoint is on this Housetory "
            "host or its Docker host; household content stays local."
        )
    elif config.mode == "private":
        privacy_note = (
            f"Private-network inference sends household content to {config.endpoint_host}. "
            "This is not the Housetory server; explicit consent is required."
        )
    elif config.mode == "cloud":
        privacy_note = (
            f"Remote inference sends household prompts and excerpts to "
            f"{config.endpoint_host}. Explicit consent is required."
        )
    else:
        privacy_note = (
            "AI is disabled. Housetory's deterministic import, search and assistance still work."
        )
    return AiStatus(
        provider=config.provider,
        mode=config.mode,
        model=model,
        configured=config.configured,
        available=available,
        catalog_checked=catalog_checked,
        catalog_count=len(models or []),
        models=models or [],
        cloud_enabled=config.mode in {"private", "cloud"},
        cloud_consent=config.cloud_consent,
        data_leaves_server=bool(config.mode in {"private", "cloud"} and config.configured),
        error=error,
        privacy_note=privacy_note,
        source=config.source,
        task=config.task,
        provider_id=config.provider_id,
        provider_label=config.display_name,
        capabilities=config.capabilities,
    )
