"""Audio transcription adapters for explicitly configured providers."""

from __future__ import annotations

import base64
from pathlib import Path

from ..domain import AiProviderType
from . import ai
from .ai_runtime import AiRuntimeConfig, provider_supports_transcription

TRANSCRIPTION_PROVIDERS = {
    AiProviderType.OPENAI.value,
    AiProviderType.GEMINI.value,
}


def _provider_error() -> ai.AiUnavailable:
    return ai.AiUnavailable(
        "This provider does not support audio transcription. Choose OpenAI "
        "(audio transcriptions) or Google Gemini (audio input)."
    )


def transcribe_audio(
    config: AiRuntimeConfig,
    *,
    path: Path,
    content_type: str,
    filename: str,
) -> str:
    if not config.configured:
        raise ai.AiUnavailable(config.error or "Transcription is not configured.")
    if not config.model:
        raise ai.AiUnavailable("Choose a transcription model in AI settings.")
    if not provider_supports_transcription(config.provider):
        raise _provider_error()
    if not ai._semaphore.acquire(timeout=5):
        raise ai.AiUnavailable("Audio transcription is busy; try again shortly.")
    try:
        if config.provider == AiProviderType.OPENAI.value:
            response = ai.request_multipart_json(
                ai._url(config, "/audio/transcriptions"),
                fields={"model": config.model, "response_format": "json"},
                file_field="file",
                filename=filename,
                content_type=content_type,
                data=path.read_bytes(),
                headers=ai._headers(config),
                timeout=max(30, ai._settings().ai_timeout_seconds),
            )
            text = response.get("text")
        elif config.provider == AiProviderType.GEMINI.value:
            model = config.model.removeprefix("models/")
            response = ai._request_json(
                ai._url(
                    config,
                    f"/models/{model}:generateContent?key={config.api_key or ''}",
                ),
                {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": (
                                        "Transcribe this spoken household inventory note "
                                        "exactly. Preserve the speaker's wording and "
                                        "self-corrections. Return only the transcript, with "
                                        "no commentary or markdown."
                                    )
                                },
                                {
                                    "inline_data": {
                                        "mime_type": content_type,
                                        "data": base64.b64encode(path.read_bytes()).decode(
                                            "ascii"
                                        ),
                                    }
                                },
                            ],
                        }
                    ],
                    "generationConfig": {"temperature": 0.0},
                },
                headers={"Content-Type": "application/json"},
                timeout=max(30, ai._settings().ai_timeout_seconds),
            )
            candidates = response.get("candidates") or []
            content = candidates[0].get("content", {}) if candidates else {}
            text = "".join(
                str(part.get("text") or "")
                for part in content.get("parts") or []
                if isinstance(part, dict)
            )
        else:  # pragma: no cover - guarded above
            raise _provider_error()
    finally:
        ai._semaphore.release()
    if not isinstance(text, str) or not text.strip():
        raise ai.AiInvalidOutput("Transcription returned no text.")
    return text.strip()[:12000]
