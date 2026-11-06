"""Owner-managed AI provider settings, model discovery and credentials."""

import time
import uuid
from urllib.parse import urlparse

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import AiProviderType, AiTask
from ..models import AiProvider, AiTaskSetting
from ..schemas.ai_settings import (
    AiModelOut,
    AiProviderCreate,
    AiProviderModels,
    AiProviderOut,
    AiProviderTest,
    AiProviderUpdate,
    AiSettingsOut,
    AiTaskSettingOut,
    AiTaskSettingUpdate,
)
from . import ai
from .ai_credentials import (
    CredentialError,
    encrypt_secret,
    key_configured,
    rotate_secret,
)
from .ai_runtime import (
    CLOUD_PROVIDERS,
    DEFAULT_BASE_URLS,
    config_for_provider,
    endpoint_scope,
    model_capabilities,
    resolve_config,
)
from .task_capabilities import (
    adapter_gap_message,
    model_task_state,
    model_task_states,
    provider_adapter_supported,
)

PROVIDER_LABELS = {
    AiProviderType.OPENAI.value: "OpenAI",
    AiProviderType.ANTHROPIC.value: "Anthropic Claude",
    AiProviderType.GEMINI.value: "Google Gemini",
    AiProviderType.XAI.value: "xAI Grok",
    AiProviderType.OPENROUTER.value: "OpenRouter",
    AiProviderType.OLLAMA.value: "Ollama",
}

TASK_LABELS = {
    AiTask.ASSISTANT.value: "Assistant",
    AiTask.IMPORTS.value: "Smart imports",
    AiTask.DOCUMENTS.value: "Document interpretation",
    AiTask.SEARCH.value: "Natural-language search",
    AiTask.VISION.value: "Image recognition",
    AiTask.LABELS.value: "Label summary headlines",
    AiTask.TRANSCRIPTION.value: "Voice transcription",
    AiTask.ITEM_IMAGES.value: "Item illustrations",
}

MODEL_CACHE_TTL_SECONDS = 300
_MODEL_CACHE: dict[tuple[uuid.UUID, uuid.UUID, str, int], tuple[float, list[AiModelOut]]] = {}


def _model_cache_key(
    household_id: uuid.UUID, provider: AiProvider
) -> tuple[uuid.UUID, uuid.UUID, str, int]:
    return (
        household_id,
        provider.id,
        provider.base_url or "",
        provider.api_key_version,
    )


def _cached_model(provider: AiProvider, model_id: str | None) -> AiModelOut | None:
    if not model_id:
        return None
    cached = _MODEL_CACHE.get(_model_cache_key(provider.household_id, provider))
    if cached is None:
        return None
    return next((model for model in cached[1] if model.id == model_id), None)


def _capabilities_for(provider: AiProvider, model_id: str | None) -> list[str]:
    model = _cached_model(provider, model_id)
    if model is not None:
        return list(model.capabilities)
    return model_capabilities(provider.provider, model_id)


def _clear_model_cache(provider_id: uuid.UUID | None = None) -> None:
    if provider_id is None:
        _MODEL_CACHE.clear()
        return
    for key in [key for key in _MODEL_CACHE if key[1] == provider_id]:
        _MODEL_CACHE.pop(key, None)


TASK_CAPABILITY = {
    AiTask.ASSISTANT.value: "text",
    AiTask.IMPORTS.value: "text",
    AiTask.DOCUMENTS.value: "text",
    AiTask.SEARCH.value: "text",
    AiTask.VISION.value: "vision",
    AiTask.LABELS.value: "text",
    AiTask.TRANSCRIPTION.value: "audio",
    AiTask.ITEM_IMAGES.value: "image",
}


def _provider_or_404(db: Session, household_id: uuid.UUID, provider_id: uuid.UUID) -> AiProvider:
    provider = db.scalar(
        select(AiProvider).where(
            AiProvider.id == provider_id, AiProvider.household_id == household_id
        )
    )
    if provider is None:
        raise ApiError(404, "ai_provider_not_found", "AI provider not found.")
    return provider


def _validate_base_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ApiError(422, "invalid_base_url", "Provider URL must be an absolute http(s) URL.")
    return value.rstrip("/")


def serialize_provider(provider: AiProvider) -> AiProviderOut:
    base_url = provider.base_url or DEFAULT_BASE_URLS.get(provider.provider) or ""
    scope = endpoint_scope(provider.provider, base_url)
    return AiProviderOut(
        id=provider.id,
        provider=provider.provider,
        display_name=provider.display_name,
        base_url=provider.base_url,
        default_model=provider.default_model,
        has_api_key=bool(provider.encrypted_api_key),
        api_key_version=provider.api_key_version,
        enabled=provider.enabled,
        cloud_consent=provider.cloud_consent,
        is_local=scope == "local",
        endpoint_scope=scope,
        capabilities=_capabilities_for(provider, provider.default_model),
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _task_rows(db: Session, household_id: uuid.UUID) -> list[AiTaskSetting]:
    rows = {
        row.task: row
        for row in db.scalars(
            select(AiTaskSetting).where(AiTaskSetting.household_id == household_id)
        ).all()
    }
    return [rows[task] for task in TASK_LABELS if task in rows]


def serialize_task(db: Session, household_id: uuid.UUID, task: str) -> AiTaskSettingOut:
    setting = db.scalar(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
        )
    )
    if setting is None:
        return AiTaskSettingOut(
            task=task,
            provider_id=None,
            provider_label=None,
            model=None,
            model_label=None,
            model_listed=False,
            compatibility="not_configured",
            enabled=False,
            capabilities=[],
            last_test_status=None,
            last_test_at=None,
            last_test_error=None,
            updated_at=None,
        )
    provider = db.get(AiProvider, setting.provider_id) if setting.provider_id else None
    cached = _cached_model(provider, setting.model) if provider is not None else None
    if provider is None:
        compatibility = "not_configured"
    elif cached is not None:
        compatibility = model_task_state(provider.provider, task, cached)
    elif provider_adapter_supported(provider.provider, task):
        compatibility = "unverified"
    else:
        compatibility = "adapter_unavailable"
    return AiTaskSettingOut(
        task=task,
        provider_id=setting.provider_id,
        provider_label=provider.display_name if provider else None,
        model=setting.model,
        model_label=cached.display_name if cached is not None else None,
        model_listed=cached is not None,
        compatibility=compatibility,
        enabled=setting.enabled,
        capabilities=(_capabilities_for(provider, setting.model) if provider else []),
        last_test_status=setting.last_test_status,
        last_test_at=setting.last_test_at,
        last_test_error=setting.last_test_error,
        updated_at=setting.updated_at,
    )


def ai_settings(db: Session, household_id: uuid.UUID) -> AiSettingsOut:
    providers = list(
        db.scalars(
            select(AiProvider)
            .where(AiProvider.household_id == household_id)
            .order_by(AiProvider.created_at)
        ).all()
    )
    warning = None
    if not key_configured():
        warning = (
            "AI_CREDENTIAL_KEY is not configured. Saving cloud API keys is disabled "
            "until the deployment key is set; existing credentials fail closed."
        )
    return AiSettingsOut(
        providers=[serialize_provider(provider) for provider in providers],
        tasks=[serialize_task(db, household_id, task) for task in TASK_LABELS],
        credential_key_configured=key_configured(),
        environment_provider=get_settings().ai_provider,
        warning=warning,
    )


def _assign_default_tasks(db: Session, household_id: uuid.UUID, provider: AiProvider) -> None:
    if not provider.default_model or not provider.enabled:
        return
    capabilities = model_capabilities(provider.provider, provider.default_model)
    for task in TASK_LABELS:
        # Audio transcription is deliberately opt-in: a chat model is not proof
        # that the account can transcribe audio.
        if task == AiTask.TRANSCRIPTION.value:
            continue
        if TASK_CAPABILITY[task] not in capabilities:
            continue
        setting = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
            )
        )
        if setting is None:
            setting = AiTaskSetting(
                household_id=household_id,
                task=task,
                provider_id=provider.id,
                model=provider.default_model,
                enabled=True,
            )
            db.add(setting)
        elif setting.provider_id is None:
            setting.provider_id = provider.id
            setting.model = provider.default_model
            setting.enabled = True


def create_provider(db: Session, household_id: uuid.UUID, payload: AiProviderCreate) -> AiProvider:
    provider_type = payload.provider.value
    existing = db.scalar(
        select(AiProvider).where(
            AiProvider.household_id == household_id,
            AiProvider.provider == provider_type,
        )
    )
    if existing is not None:
        raise ApiError(
            409,
            "ai_provider_exists",
            "That provider is already configured. Edit the existing entry instead.",
        )
    if provider_type in CLOUD_PROVIDERS and not payload.api_key:
        raise ApiError(422, "api_key_required", "Enter an API key for a cloud provider.")
    encrypted = None
    if payload.api_key:
        try:
            encrypted = encrypt_secret(payload.api_key)
        except CredentialError as exc:
            raise ApiError(422, "credential_key_unavailable", str(exc)) from None
    provider = AiProvider(
        household_id=household_id,
        provider=provider_type,
        display_name=payload.display_name or PROVIDER_LABELS[provider_type],
        base_url=_validate_base_url(payload.base_url) or DEFAULT_BASE_URLS[provider_type],
        default_model=payload.default_model,
        encrypted_api_key=encrypted,
        enabled=payload.enabled,
        cloud_consent=bool(payload.cloud_consent and provider_type in CLOUD_PROVIDERS),
    )
    db.add(provider)
    db.flush()
    _assign_default_tasks(db, household_id, provider)
    _clear_model_cache(provider.id)
    db.commit()
    db.refresh(provider)
    return provider


def update_provider(
    db: Session,
    household_id: uuid.UUID,
    provider_id: uuid.UUID,
    payload: AiProviderUpdate,
) -> AiProvider:
    provider = _provider_or_404(db, household_id, provider_id)
    fields = payload.model_fields_set
    if payload.display_name is not None:
        provider.display_name = payload.display_name
    if "base_url" in fields:
        provider.base_url = (
            _validate_base_url(payload.base_url) or DEFAULT_BASE_URLS[provider.provider]
        )
    if "default_model" in fields:
        provider.default_model = payload.default_model
    if payload.enabled is not None:
        provider.enabled = payload.enabled
    if payload.cloud_consent is not None:
        provider.cloud_consent = payload.cloud_consent
    if endpoint_scope(provider.provider, provider.base_url or "") == "local":
        provider.cloud_consent = False
    if payload.clear_api_key:
        provider.encrypted_api_key = None
        provider.api_key_version += 1
    elif payload.api_key:
        try:
            provider.encrypted_api_key = encrypt_secret(payload.api_key)
        except CredentialError as exc:
            raise ApiError(422, "credential_key_unavailable", str(exc)) from None
        provider.api_key_version += 1
    if provider.enabled and provider.provider in CLOUD_PROVIDERS and not provider.encrypted_api_key:
        raise ApiError(422, "api_key_required", "A cloud provider needs an API key.")
    _assign_default_tasks(db, household_id, provider)
    _clear_model_cache(provider.id)
    db.commit()
    db.refresh(provider)
    return provider


def delete_provider(db: Session, household_id: uuid.UUID, provider_id: uuid.UUID) -> None:
    provider = _provider_or_404(db, household_id, provider_id)
    db.execute(
        delete(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.provider_id == provider.id,
        )
    )
    _clear_model_cache(provider.id)
    db.delete(provider)
    db.commit()


def update_task(
    db: Session,
    household_id: uuid.UUID,
    task: str,
    payload: AiTaskSettingUpdate,
) -> AiTaskSettingOut:
    try:
        task = AiTask(task).value
    except ValueError:
        raise ApiError(422, "invalid_ai_task", "Choose a valid AI task.") from None
    provider = None
    if payload.provider_id is not None:
        provider = _provider_or_404(db, household_id, payload.provider_id)
    if payload.enabled and provider is not None:
        selected_model = payload.model or provider.default_model
        if not selected_model:
            raise ApiError(
                422,
                "model_required",
                "Choose a model for this task.",
            )
        cached = _cached_model(provider, selected_model)
        state = (
            model_task_state(provider.provider, task, cached)
            if cached is not None
            else (
                "unverified"
                if provider_adapter_supported(provider.provider, task)
                else "adapter_unavailable"
            )
        )
        if state == "adapter_unavailable":
            raise ApiError(
                422,
                "task_adapter_unavailable",
                adapter_gap_message(task),
            )
        if state == "incompatible":
            raise ApiError(
                422,
                "model_capability_mismatch",
                "The selected model is confirmed incompatible with this task's "
                "implemented API/input/output requirements. Choose a compatible model "
                "or refresh discovery.",
            )
    setting = db.scalar(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
        )
    )
    if setting is None:
        setting = AiTaskSetting(household_id=household_id, task=task)
        db.add(setting)
    setting.provider_id = provider.id if provider else None
    setting.model = payload.model or (provider.default_model if provider else None)
    setting.enabled = payload.enabled and provider is not None
    db.commit()
    db.refresh(setting)
    return serialize_task(db, household_id, task)


def provider_models(
    db: Session,
    household_id: uuid.UUID,
    provider_id: uuid.UUID,
    *,
    refresh: bool = False,
) -> AiProviderModels:
    provider = _provider_or_404(db, household_id, provider_id)
    cache_key = _model_cache_key(household_id, provider)
    now = time.monotonic()
    cached = _MODEL_CACHE.get(cache_key)
    if not refresh and cached and now - cached[0] < MODEL_CACHE_TTL_SECONDS:
        return AiProviderModels(
            provider_id=provider.id,
            models=[model.model_copy(deep=True) for model in cached[1]],
            cached=True,
        )
    config = config_for_provider(provider, require_consent=False)
    try:
        discovered = ai.discover_models(config)
    except ai.AiError as exc:
        return AiProviderModels(provider_id=provider.id, models=[], error=str(exc))
    models = [
        AiModelOut(
            id=model.id,
            display_name=model.display_name,
            kind=model.kind,
            capabilities=list(model.capabilities),
            capability_source=model.capability_source,
            input_modalities=list(model.input_modalities),
            output_modalities=list(model.output_modalities),
            endpoints=list(model.endpoints),
            task_states=model_task_states(config.provider, model),
        )
        for model in discovered
    ]
    _MODEL_CACHE[cache_key] = (now, models)
    return AiProviderModels(
        provider_id=provider.id,
        models=[model.model_copy(deep=True) for model in models],
        cached=False,
    )


def test_provider(
    db: Session,
    household_id: uuid.UUID,
    provider_id: uuid.UUID,
    model: str | None = None,
) -> AiProviderTest:
    provider = _provider_or_404(db, household_id, provider_id)
    config = config_for_provider(provider, model=model, require_consent=False)
    if not config.enabled:
        return AiProviderTest(ok=False, message=config.error or "Provider is disabled.")
    try:
        models = [item.id for item in ai.discover_models(config)]
    except ai.AiError as exc:
        return AiProviderTest(ok=False, message=str(exc))
    selected = model or provider.default_model
    available = selected is None or any(
        candidate == selected
        or candidate.split(":")[0] == selected.split(":")[0]
        or candidate.endswith(f"/{selected}")
        for candidate in models
    )
    if not available:
        return AiProviderTest(
            ok=False,
            message=f"Connected, but model {selected!r} was not listed by the provider.",
            models=models,
            selected_model_available=False,
        )
    return AiProviderTest(
        ok=True,
        message=f"Connected. {len(models)} model(s) discovered.",
        models=models,
        selected_model_available=True,
    )


def rotate_credentials(db: Session, household_id: uuid.UUID) -> tuple[int, int]:
    rotated = 0
    failed = 0
    providers = db.scalars(select(AiProvider).where(AiProvider.household_id == household_id)).all()
    for provider in providers:
        if not provider.encrypted_api_key:
            continue
        try:
            provider.encrypted_api_key = rotate_secret(provider.encrypted_api_key)
            provider.api_key_version += 1
            rotated += 1
        except CredentialError:
            failed += 1
    _clear_model_cache()
    db.commit()
    return rotated, failed


def resolve_task_config(db: Session, household_id: uuid.UUID, task: str):
    return resolve_config(db, household_id, task)
