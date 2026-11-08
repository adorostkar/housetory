"""Owner-managed AI provider settings, model discovery and credentials."""

import time
import uuid
from urllib.parse import urlparse

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import ACTIVE_AI_TASKS, RETIRED_AI_TASKS, AiProviderType, AiTask
from ..models import (
    AiProvider,
    AiTaskSetting,
    AiTextDefault,
    HouseholdOnlineSearchSettings,
)
from ..schemas.ai_settings import (
    AiDefaultTextOut,
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
    AiTask.TRANSCRIPTION.value: "Voice transcription",
}

TEXT_TASKS = (
    AiTask.ASSISTANT.value,
    AiTask.DOCUMENTS.value,
    AiTask.IMPORTS.value,
    AiTask.SEARCH.value,
)

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
    AiTask.TRANSCRIPTION.value: "audio",
}


def _provider_or_404(
    db: Session,
    household_id: uuid.UUID,
    provider_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> AiProvider:
    query = select(AiProvider).where(
        AiProvider.id == provider_id, AiProvider.household_id == household_id
    )
    if for_update:
        query = query.with_for_update()
    provider = db.scalar(query)
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
    default_row = db.get(AiTextDefault, household_id) if task in TEXT_TASKS else None
    inherits = False
    effective_provider_id: uuid.UUID | None = None
    effective_model: str | None = None
    enabled = setting.enabled if setting is not None else False
    if task in TEXT_TASKS:
        if setting is not None and setting.inherits_text_default:
            inherits = True
            if default_row is not None and default_row.provider_id and default_row.model:
                effective_provider_id = default_row.provider_id
                effective_model = default_row.model
        elif setting is not None:
            effective_provider_id = setting.provider_id
            effective_model = setting.model
        elif default_row is not None and default_row.provider_id and default_row.model:
            inherits = True
            enabled = True
            effective_provider_id = default_row.provider_id
            effective_model = default_row.model
    else:
        effective_provider_id = setting.provider_id if setting is not None else None
        effective_model = setting.model if setting is not None else None
    provider = (
        db.get(AiProvider, effective_provider_id)
        if effective_provider_id
        else None
    )
    if (
        task in TEXT_TASKS
        and setting is not None
        and not inherits
        and provider is not None
        and not effective_model
    ):
        # Runtime falls back to the provider's default model for an explicit
        # text assignment whose stored model is empty. Mirror that here so the
        # settings screen, status screen and runtime agree.
        effective_model = provider.default_model
    if task in TEXT_TASKS and (effective_provider_id is None or not effective_model):
        return AiTaskSettingOut(
            task=task,
            provider_id=None,
            provider_label=None,
            model=None,
            model_label=None,
            model_listed=False,
            compatibility="not_configured",
            inherits_text_default=inherits,
            enabled=enabled,
            capabilities=[],
            last_test_status=setting.last_test_status if setting else None,
            last_test_at=setting.last_test_at if setting else None,
            last_test_error=setting.last_test_error if setting else None,
            updated_at=setting.updated_at if setting else None,
        )
    if setting is None and effective_provider_id is None:
        return AiTaskSettingOut(
            task=task,
            provider_id=None,
            provider_label=None,
            model=None,
            model_label=None,
            model_listed=False,
            compatibility="not_configured",
            inherits_text_default=False,
            enabled=False,
            capabilities=[],
            last_test_status=None,
            last_test_at=None,
            last_test_error=None,
            updated_at=None,
        )
    cached = _cached_model(provider, effective_model) if provider is not None else None
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
        provider_id=effective_provider_id,
        provider_label=provider.display_name if provider else None,
        model=effective_model,
        model_label=cached.display_name if cached is not None else None,
        model_listed=cached is not None,
        compatibility=compatibility,
        inherits_text_default=inherits,
        enabled=enabled,
        capabilities=(
            _capabilities_for(provider, effective_model) if provider else []
        ),
        last_test_status=setting.last_test_status if setting else None,
        last_test_at=setting.last_test_at if setting else None,
        last_test_error=setting.last_test_error if setting else None,
        updated_at=setting.updated_at if setting else None,
    )


def _default_row(db: Session, household_id: uuid.UUID) -> AiTextDefault:
    row = db.get(AiTextDefault, household_id)
    if row is None:
        row = AiTextDefault(household_id=household_id)
        db.add(row)
        db.flush()
    return row


def get_default_text(
    db: Session,
    household_id: uuid.UUID,
    tasks: list[AiTaskSettingOut] | None = None,
) -> AiDefaultTextOut:
    task_list = tasks or [
        serialize_task(db, household_id, task) for task in TASK_LABELS
    ]
    by_name = {task.task: task for task in task_list if task.task in TEXT_TASKS}
    row = db.get(AiTextDefault, household_id)
    inherited = [
        task for task in TEXT_TASKS if by_name.get(task) and by_name[task].inherits_text_default
    ]
    overrides = [
        task
        for task in TEXT_TASKS
        if by_name.get(task)
        and by_name[task].provider_id
        and by_name[task].model
        and not by_name[task].inherits_text_default
    ]
    if row is None or row.provider_id is None or not row.model:
        return AiDefaultTextOut(
            inherited_tasks=inherited,
            override_tasks=overrides,
            derived_from="none",
        )
    provider = db.get(AiProvider, row.provider_id)
    if provider is None:
        return AiDefaultTextOut(
            inherited_tasks=inherited,
            override_tasks=overrides,
            derived_from="none",
        )
    cached = _cached_model(provider, row.model)
    compatibility = (
        model_task_state(provider.provider, AiTask.ASSISTANT.value, cached)
        if cached is not None
        else (
            "unverified"
            if provider_adapter_supported(provider.provider, AiTask.ASSISTANT.value)
            else "adapter_unavailable"
        )
    )
    runtime = config_for_provider(
        provider,
        AiTask.ASSISTANT.value,
        model=row.model,
    )
    configured = bool(
        provider.enabled
        and runtime.configured
        and compatibility
        not in {"incompatible", "adapter_unavailable", "not_configured"}
    )
    representative = next(
        (by_name[task] for task in inherited if by_name.get(task)),
        None,
    )
    return AiDefaultTextOut(
        provider_id=row.provider_id,
        provider_label=provider.display_name,
        model=row.model,
        model_label=(
            cached.display_name
            if cached is not None
            else representative.model_label
            if representative
            else None
        ),
        model_listed=cached is not None,
        compatibility=compatibility,
        configured=configured,
        inherited_tasks=inherited,
        override_tasks=overrides,
        derived_from="saved",
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
    task_outputs = [serialize_task(db, household_id, task) for task in TASK_LABELS]
    return AiSettingsOut(
        providers=[serialize_provider(provider) for provider in providers],
        tasks=task_outputs,
        default_text=get_default_text(db, household_id, task_outputs),
        credential_key_configured=key_configured(),
        environment_provider=get_settings().ai_provider,
        warning=warning,
    )


def _assign_default_tasks(
    db: Session,
    household_id: uuid.UUID,
    provider: AiProvider,
    *,
    seed_default: bool = False,
) -> None:
    if not provider.default_model or not provider.enabled:
        return
    capabilities = model_capabilities(provider.provider, provider.default_model)
    default = _default_row(db, household_id)
    configured_text_rows = db.scalars(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.task.in_(TEXT_TASKS),
            AiTaskSetting.provider_id.is_not(None),
            AiTaskSetting.model.is_not(None),
        )
    ).all()
    if (
        seed_default
        and default.provider_id is None
        and not default.model
        and not configured_text_rows
        and TASK_CAPABILITY[AiTask.ASSISTANT.value] in capabilities
    ):
        default.provider_id = provider.id
        default.model = provider.default_model
    default_provider_id = default.provider_id
    default_model = default.model
    for task in TEXT_TASKS:
        setting = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
            )
        )
        if setting is None:
            if default_provider_id and default_model:
                db.add(
                    AiTaskSetting(
                        household_id=household_id,
                        task=task,
                        provider_id=default_provider_id,
                        model=default_model,
                        enabled=True,
                        inherits_text_default=True,
                    )
                )
            continue
        if setting.inherits_text_default and default_provider_id and default_model:
            setting.provider_id = default_provider_id
            setting.model = default_model
    for task in (entry.value for entry in ACTIVE_AI_TASKS):
        if task in TEXT_TASKS or task == AiTask.TRANSCRIPTION.value:
            continue
        if TASK_CAPABILITY[task] not in capabilities:
            continue
        setting = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
            )
        )
        if setting is None:
            db.add(
                AiTaskSetting(
                    household_id=household_id,
                    task=task,
                    provider_id=provider.id,
                    model=provider.default_model,
                    enabled=True,
                )
            )
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
    _assign_default_tasks(db, household_id, provider, seed_default=True)
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
    provider = _provider_or_404(db, household_id, provider_id, for_update=True)
    default = db.get(AiTextDefault, household_id)
    if default is not None and default.provider_id == provider.id:
        default.provider_id = None
        default.model = None
    text_rows = db.scalars(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.task.in_(TEXT_TASKS),
            AiTaskSetting.provider_id == provider.id,
        )
    ).all()
    for setting in text_rows:
        setting.provider_id = None
        if setting.inherits_text_default:
            setting.model = None
    db.execute(
        delete(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.provider_id == provider.id,
            AiTaskSetting.task.not_in(TEXT_TASKS),
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
    if task in {retired.value for retired in RETIRED_AI_TASKS}:
        raise ApiError(
            410,
            "ai_task_retired",
            "This AI task was retired. Existing results remain readable, but it "
            "cannot be configured or tested anymore.",
        )
    if payload.inherit_default and task not in TEXT_TASKS:
        raise ApiError(
            422,
            "default_inheritance_unavailable",
            "Only the four text tasks can inherit the default text model.",
        )
    default = None
    if payload.inherit_default:
        default = db.scalar(
            select(AiTextDefault)
            .where(AiTextDefault.household_id == household_id)
            .with_for_update()
        )
        if default is None or default.provider_id is None or not default.model:
            raise ApiError(
                422,
                "default_text_not_configured",
                "Save a default text provider and model before resetting a text task to it.",
            )
    setting = db.scalar(
        select(AiTaskSetting)
        .where(
            AiTaskSetting.household_id == household_id, AiTaskSetting.task == task
        )
        .with_for_update()
    )
    if payload.inherit_default:
        assert default is not None
        provider = _provider_or_404(db, household_id, default.provider_id)
        if setting is None:
            setting = AiTaskSetting(household_id=household_id, task=task)
            db.add(setting)
        setting.provider_id = provider.id
        setting.model = default.model
        setting.enabled = payload.enabled
        setting.inherits_text_default = True
        db.commit()
        db.refresh(setting)
        return serialize_task(db, household_id, task)

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
    if setting is None:
        setting = AiTaskSetting(household_id=household_id, task=task)
        db.add(setting)
    setting.provider_id = provider.id if provider else None
    setting.model = payload.model or (provider.default_model if provider else None)
    setting.enabled = payload.enabled and provider is not None
    setting.inherits_text_default = False
    db.commit()
    db.refresh(setting)
    return serialize_task(db, household_id, task)


def update_default_text(
    db: Session,
    household_id: uuid.UUID,
    *,
    provider_id: uuid.UUID,
    model: str | None,
) -> AiSettingsOut:
    provider = db.scalar(
        select(AiProvider)
        .where(
            AiProvider.id == provider_id,
            AiProvider.household_id == household_id,
        )
        .with_for_update()
    )
    if provider is None:
        raise ApiError(404, "ai_provider_not_found", "AI provider not found.")
    if not provider.enabled:
        raise ApiError(
            422,
            "provider_disabled",
            "Enable this provider before making it the text default.",
        )
    selected_model = (model or provider.default_model or "").strip()
    if not selected_model:
        raise ApiError(422, "model_required", "Choose a default text model.")
    cached = _cached_model(provider, selected_model)
    for task in TEXT_TASKS:
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
            raise ApiError(422, "task_adapter_unavailable", adapter_gap_message(task))
        if state == "incompatible":
            raise ApiError(
                422,
                "model_capability_mismatch",
                "The selected model is confirmed incompatible with the text tasks' "
                "implemented API/input/output requirements. Choose a compatible model "
                "or refresh discovery.",
            )
    default = db.scalar(
        select(AiTextDefault)
        .where(AiTextDefault.household_id == household_id)
        .with_for_update()
    )
    if default is None:
        default = AiTextDefault(household_id=household_id)
        db.add(default)
    default.provider_id = provider.id
    default.model = selected_model
    inherited_rows = db.scalars(
        select(AiTaskSetting)
        .where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.task.in_(TEXT_TASKS),
            AiTaskSetting.inherits_text_default.is_(True),
        )
        .with_for_update()
    ).all()
    for setting in inherited_rows:
        setting.provider_id = provider.id
        setting.model = selected_model
    db.commit()
    return ai_settings(db, household_id)


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
    online_search_rows = db.scalars(
        select(HouseholdOnlineSearchSettings).where(
            HouseholdOnlineSearchSettings.household_id == household_id
        )
    ).all()
    for row in online_search_rows:
        if not row.encrypted_api_key:
            continue
        try:
            row.encrypted_api_key = rotate_secret(row.encrypted_api_key)
            row.api_key_version += 1
            rotated += 1
        except CredentialError:
            failed += 1
    _clear_model_cache()
    db.commit()
    return rotated, failed


def resolve_task_config(db: Session, household_id: uuid.UUID, task: str):
    return resolve_config(db, household_id, task)
