"""Single task-capability contract for discovery, saving and runtime status.

Only the capability a task actually needs is required. A missing Housetory
adapter is reported separately from a model/provider that is confirmed unable to
perform the task; unknown metadata remains selectable as unverified.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ..domain import AiProviderType, AiTask

TaskState = Literal["compatible", "unverified", "incompatible", "adapter_unavailable"]
MinimumCapability = Literal["text", "vision", "audio", "image"]

TEXT_PROVIDERS = frozenset(
    {
        AiProviderType.OPENAI.value,
        AiProviderType.ANTHROPIC.value,
        AiProviderType.GEMINI.value,
        AiProviderType.XAI.value,
        AiProviderType.OPENROUTER.value,
        AiProviderType.OLLAMA.value,
    }
)
VISION_PROVIDERS = TEXT_PROVIDERS
TRANSCRIPTION_PROVIDERS = frozenset(
    {
        AiProviderType.OPENAI.value,
        AiProviderType.GEMINI.value,
        AiProviderType.OPENROUTER.value,
    }
)
IMAGE_PROVIDERS = frozenset(
    {
        AiProviderType.OPENAI.value,
        AiProviderType.OPENROUTER.value,
    }
)


@dataclass(frozen=True)
class TaskProfile:
    minimum: MinimumCapability
    providers: frozenset[str]
    allowed_kinds: frozenset[str]


TASK_PROFILES: dict[str, TaskProfile] = {
    AiTask.ASSISTANT.value: TaskProfile("text", TEXT_PROVIDERS, frozenset({"chat"})),
    AiTask.IMPORTS.value: TaskProfile("text", TEXT_PROVIDERS, frozenset({"chat"})),
    AiTask.DOCUMENTS.value: TaskProfile("text", TEXT_PROVIDERS, frozenset({"chat"})),
    AiTask.SEARCH.value: TaskProfile("text", TEXT_PROVIDERS, frozenset({"chat"})),
    AiTask.LABELS.value: TaskProfile("text", TEXT_PROVIDERS, frozenset({"chat"})),
    AiTask.VISION.value: TaskProfile("vision", VISION_PROVIDERS, frozenset({"chat"})),
    AiTask.TRANSCRIPTION.value: TaskProfile(
        "audio", TRANSCRIPTION_PROVIDERS, frozenset({"chat", "speech"})
    ),
    AiTask.ITEM_IMAGES.value: TaskProfile("image", IMAGE_PROVIDERS, frozenset({"image"})),
}

ADAPTER_GAP_MESSAGES = {
    AiTask.TRANSCRIPTION.value: (
        "Voice transcription has adapters for OpenAI, Gemini and OpenRouter only. "
        "This provider is not confirmed incapable; Housetory has no transcription "
        "adapter for it yet."
    ),
    AiTask.ITEM_IMAGES.value: (
        "Item illustrations have adapters for OpenAI Images and OpenRouter Image API "
        "only. This provider is not confirmed incapable; Housetory has no image "
        "adapter for it yet."
    ),
}


def task_profile(task: str) -> TaskProfile:
    return TASK_PROFILES[AiTask(task).value]


def provider_adapter_supported(provider: str, task: str) -> bool:
    profile = TASK_PROFILES.get(task)
    return bool(profile and provider in profile.providers)


def adapter_gap_message(task: str) -> str:
    return ADAPTER_GAP_MESSAGES.get(
        task,
        "Housetory has no implemented adapter for this provider/task combination yet.",
    )


def _modalities(model: Any) -> tuple[set[str], set[str], set[str]]:
    inputs = {str(value).lower() for value in (getattr(model, "input_modalities", ()) or ())}
    outputs = {str(value).lower() for value in (getattr(model, "output_modalities", ()) or ())}
    endpoints = {str(value) for value in (getattr(model, "endpoints", ()) or ())}
    return inputs, outputs, endpoints


def _has_provider_metadata(model: Any) -> bool:
    if getattr(model, "capability_source", "heuristic") == "provider_metadata":
        return True
    inputs, outputs, endpoints = _modalities(model)
    return bool(inputs or outputs or endpoints)


def model_task_state(provider: str, task: str, model: Any | None) -> TaskState:
    profile = TASK_PROFILES.get(task)
    if profile is None:
        return "incompatible"
    if provider not in profile.providers:
        return "adapter_unavailable"
    if model is None:
        return "unverified"

    kind = str(getattr(model, "kind", "chat"))
    capabilities = {str(value) for value in (getattr(model, "capabilities", ()) or ())}
    inputs, outputs, endpoints = _modalities(model)
    metadata = _has_provider_metadata(model)

    if profile.minimum == "text":
        if outputs and "text" not in outputs:
            return "incompatible"
        if kind in {"embedding", "image"}:
            return "incompatible"
        if kind == "speech" and outputs and "transcription" in outputs:
            return "incompatible"
        if kind == "chat":
            return "compatible"
        if "text" in capabilities:
            return "compatible" if metadata else "unverified"
        return "unverified"

    if profile.minimum == "vision":
        if outputs and "text" not in outputs:
            return "incompatible"
        if kind in {"embedding", "image", "speech"}:
            return "incompatible"
        if inputs:
            return "compatible" if "image" in inputs else "incompatible"
        if "vision" in capabilities:
            return "compatible" if metadata else "unverified"
        return "unverified"

    if profile.minimum == "audio":
        if kind in {"embedding", "image"}:
            return "incompatible"
        if outputs or inputs or endpoints:
            if "transcription" in outputs or "/api/v1/audio/transcriptions" in endpoints:
                return "compatible"
            if "audio" in inputs:
                return "compatible"
            return "incompatible"
        if kind == "speech" or "audio" in capabilities:
            return "compatible" if metadata else "unverified"
        return "unverified"

    if profile.minimum == "image":
        if kind in {"embedding", "speech"}:
            return "incompatible"
        if outputs or endpoints:
            if "image" in outputs or "/api/v1/images" in endpoints:
                return "compatible"
            return "incompatible"
        if kind == "image" or "image" in capabilities:
            return "compatible" if metadata else "unverified"
        return "unverified"

    return "unverified"


def model_task_states(provider: str, model: Any) -> dict[str, TaskState]:
    return {task: model_task_state(provider, task, model) for task in TASK_PROFILES}


def is_confirmed_incompatible(state: TaskState) -> bool:
    return state in {"incompatible", "adapter_unavailable"}


def is_suggested(model: Any, state: TaskState) -> bool:
    return state == "compatible" and _has_provider_metadata(model)


__all__ = [
    "ADAPTER_GAP_MESSAGES",
    "TASK_PROFILES",
    "TaskState",
    "adapter_gap_message",
    "is_confirmed_incompatible",
    "is_suggested",
    "model_task_state",
    "model_task_states",
    "provider_adapter_supported",
    "task_profile",
]
