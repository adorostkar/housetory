"""Explicit, bounded, user-invoked AI task tests.

Discovery never runs inference. These tests only run after an owner explicitly
confirms, use minimal synthetic data, and record the outcome for the status
screen. Failure messages are bounded and never include credentials.
"""

from __future__ import annotations

import math
import struct
import tempfile
import uuid
import wave
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..domain import RETIRED_AI_TASKS, AiTask
from ..models import AiTaskSetting
from ..schemas.ai_settings import AiTaskTestOut
from . import ai, transcription
from .ai_runtime import resolve_config
from .task_capabilities import (
    adapter_gap_message,
    provider_adapter_supported,
    task_profile,
)


def _status_for_error(exc: Exception) -> tuple[str, str]:
    message = str(exc).strip() or "The provider test failed."
    lowered = message.lower()
    if "http 401" in lowered or "http 403" in lowered:
        return "failed", "Provider rejected the credentials or model access."
    if "http 402" in lowered:
        return "failed", "Provider reports insufficient credit or billing access."
    if "http 429" in lowered:
        return "failed", "Provider rate limit or quota was reached."
    if "no adapter" in lowered or "not supported" in lowered:
        return "unsupported", message[:400]
    if "consent" in lowered or "disabled" in lowered or "not configured" in lowered:
        return "unsupported", message[:400]
    return "failed", message[:400]


def _text_test(config) -> str:
    result = ai.complete_json(
        "You are a minimal Housetory connection tester. Return only compact JSON.",
        'Return exactly {"ok": true}.',
        config=config,
    )
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ai.AiInvalidOutput("The model did not return the expected test JSON.")
    return "The model returned the expected structured test response."


def _vision_test(config) -> str:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
        path = Path(handle.name)
    try:
        Image.new("RGB", (64, 64), (120, 140, 160)).save(path, format="PNG")
        result = ai.complete_json(
            "You are a minimal Housetory vision tester. Return only compact JSON.",
            'An image is attached. Return exactly {"ok": true}.',
            image_path=path,
            image_mime="image/png",
            config=config,
        )
    finally:
        path.unlink(missing_ok=True)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ai.AiInvalidOutput("The model did not return the expected vision test JSON.")
    return "The model accepted a local synthetic image and returned JSON."


def _transcription_test(config) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        path = Path(handle.name)
    try:
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16_000)
            frames = bytearray()
            for index in range(int(16_000 * 0.6)):
                sample = int(8_000 * math.sin(2 * math.pi * 440 * index / 16_000))
                frames.extend(struct.pack("<h", sample))
            output.writeframes(bytes(frames))
        try:
            text = transcription.transcribe_audio(
                config,
                path=path,
                content_type="audio/wav",
                filename="housetory-tone-test.wav",
            )
        except ai.AiInvalidOutput as exc:
            if "no text" in str(exc).lower() or "no transcript" in str(exc).lower():
                return (
                    "The provider accepted the bounded synthetic audio test; it "
                    "returned no speech for the tone, which is expected."
                )
            raise
        return (
            "The provider accepted the synthetic audio test."
            if not text
            else "The provider transcribed the synthetic audio test."
        )
    finally:
        path.unlink(missing_ok=True)


def run_task_test(
    db: Session,
    household_id: uuid.UUID,
    task: str,
    *,
    confirm: bool,
) -> AiTaskTestOut:
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
    if not confirm:
        raise ApiError(
            422,
            "test_confirmation_required",
            "An explicit live test sends a minimal synthetic request to the selected "
            "provider and may incur usage or cost. Confirm before running it.",
        )
    setting = db.scalar(
        select(AiTaskSetting).where(
            AiTaskSetting.household_id == household_id,
            AiTaskSetting.task == task,
        )
    )
    tested_at = datetime.now(UTC)
    if setting is None or not setting.enabled or setting.provider_id is None:
        return AiTaskTestOut(
            task=task,
            status="unsupported",
            message="Configure and enable this task before running a live test.",
            tested_at=tested_at,
        )
    config = resolve_config(db, household_id, task)
    if not config.configured:
        message = config.error or "The task is not configured."
        setting.last_test_status = "unsupported"
        setting.last_test_at = tested_at
        setting.last_test_error = message[:400]
        db.commit()
        return AiTaskTestOut(
            task=task,
            status="unsupported",
            message=message,
            tested_at=tested_at,
            model=config.model,
            provider_label=config.display_name,
        )
    if not provider_adapter_supported(config.provider, task):
        message = adapter_gap_message(task)
        setting.last_test_status = "unsupported"
        setting.last_test_at = tested_at
        setting.last_test_error = message[:400]
        db.commit()
        return AiTaskTestOut(
            task=task,
            status="unsupported",
            message=message,
            tested_at=tested_at,
            model=config.model,
            provider_label=config.display_name,
        )

    profile = task_profile(task)
    try:
        if profile.minimum == "text":
            message = _text_test(config)
        elif profile.minimum == "vision":
            message = _vision_test(config)
        else:
            message = _transcription_test(config)
        status = "passed"
    except ai.AiError as exc:
        status, message = _status_for_error(exc)
    except Exception as exc:  # noqa: BLE001 - persisted for the owner status screen
        status, message = _status_for_error(exc)

    setting.last_test_status = status
    setting.last_test_at = tested_at
    setting.last_test_error = None if status == "passed" else message[:400]
    db.commit()
    return AiTaskTestOut(
        task=task,
        status=status,
        message=message,
        tested_at=tested_at,
        model=config.model,
        provider_label=config.display_name,
    )


__all__ = ["run_task_test"]
