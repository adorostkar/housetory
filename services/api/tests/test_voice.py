import uuid

import pytest

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.security import hash_password
from housetory_api.services import voice as voice_service
from housetory_api.services.ai_runtime import AiRuntimeConfig
from housetory_api.services.auth import create_session


def household_id(client) -> uuid.UUID:
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def runtime_config(
    task: str,
    *,
    provider: str = "openai",
    model: str = "whisper-1",
    mode: str = "cloud",
) -> AiRuntimeConfig:
    return AiRuntimeConfig(
        provider=provider,
        base_url="https://api.openai.com/v1",
        api_key="test-key",
        model=model,
        task=task,
        provider_id=uuid.uuid4(),
        display_name="Test provider",
        mode=mode,
        source="database",
        enabled=True,
        cloud_consent=True,
        configured=True,
    )


def patch_voice_config(monkeypatch):
    monkeypatch.setattr(
        voice_service.ai,
        "config_for",
        lambda _db, _household_id, _task: runtime_config("transcription"),
    )


def upload_voice(client, monkeypatch, *, transcript="voice note", duration=12):
    patch_voice_config(monkeypatch)
    response = client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
        data={"duration_seconds": str(duration)},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_upload_and_transcription_keep_only_the_transcript(owner_client, monkeypatch, imports_root):
    note = upload_voice(owner_client, monkeypatch)
    note_id = note["id"]
    assert note["status"] == "queued"
    assert note["audio_retained"] is True
    assert len(list(imports_root.rglob("*.webm"))) == 1

    calls = []
    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: calls.append(1) or "Box two has three ethernet cables.",
    )
    voice_service.process_transcription(note_id)
    transcribed = owner_client.get(f"/api/v1/voice/{note_id}").json()
    assert transcribed["status"] == "transcribed"
    assert transcribed["transcript"] == "Box two has three ethernet cables."
    assert transcribed["audio_retained"] is False
    assert list(imports_root.rglob("*.webm")) == []
    # Transcription never writes inventory, and a repeated job does not run again.
    assert owner_client.get("/api/v1/items").json()["total"] == 0
    assert voice_service.process_transcription(note_id)["skipped"] is True
    assert len(calls) == 1


def test_failed_transcription_deletes_audio_and_does_not_block_new_notes(
    owner_client, monkeypatch, imports_root
):
    monkeypatch.setattr(get_settings(), "voice_max_active_notes", 1)

    def fail(*_args, **_kwargs):
        raise voice_service.ai.AiUnavailable("The transcription provider is unreachable.")

    monkeypatch.setattr(voice_service.transcription, "transcribe_audio", fail)
    note = upload_voice(owner_client, monkeypatch)
    blocked = owner_client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
    )
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "too_many_voice_notes"

    voice_service.process_transcription(note["id"])
    failed = owner_client.get(f"/api/v1/voice/{note['id']}").json()
    assert failed["status"] == "failed"
    assert failed["transcript_error"] == "The transcription provider is unreachable."
    # Nothing can retry a failed note, so its audio is gone and it holds no slot.
    assert failed["audio_retained"] is False
    assert list(imports_root.rglob("*.webm")) == []
    upload_voice(owner_client, monkeypatch)


@pytest.mark.parametrize("transcription_fails", [False, True])
def test_audio_cleanup_failure_does_not_change_the_transcription_outcome(
    owner_client, monkeypatch, transcription_fails
):
    note = upload_voice(owner_client, monkeypatch)
    calls = []

    def transcribe(*_args, **_kwargs):
        calls.append(1)
        if transcription_fails:
            raise voice_service.ai.AiUnavailable("The transcription provider is unreachable.")
        return "Box two has three ethernet cables."

    def broken_delete(_key):
        raise OSError("read-only file system")

    monkeypatch.setattr(voice_service.transcription, "transcribe_audio", transcribe)
    monkeypatch.setattr(voice_service.storage, "delete_import_key", broken_delete)

    # The job returns normally, so the worker records success and does not retry it.
    result = voice_service.process_transcription(note["id"])
    assert result == {
        "voice_note_id": note["id"],
        ("failed" if transcription_fails else "transcribed"): True,
    }
    stored = owner_client.get(f"/api/v1/voice/{note['id']}").json()
    if transcription_fails:
        assert stored["status"] == "failed"
        assert stored["transcript_error"] == "The transcription provider is unreachable."
        assert stored["transcript"] is None
    else:
        assert stored["status"] == "transcribed"
        assert stored["transcript"] == "Box two has three ethernet cables."
        assert stored["transcript_error"] is None
    # The file is still there, and the note says so instead of losing track of it.
    assert stored["audio_retained"] is True

    # A repeated job neither transcribes again nor changes the outcome.
    assert voice_service.process_transcription(note["id"])["skipped"] is True
    assert len(calls) == 1
    again = owner_client.get(f"/api/v1/voice/{note['id']}").json()
    assert (again["status"], again["transcript"]) == (stored["status"], stored["transcript"])


def test_interpretation_and_confirmation_routes_are_gone(owner_client, monkeypatch):
    note = upload_voice(owner_client, monkeypatch)
    for path in ("interpret", "confirm", "cancel", "transcription/retry"):
        response = owner_client.post(f"/api/v1/voice/{note['id']}/{path}", json={})
        assert response.status_code in {404, 405}, path
    assert owner_client.get(f"/api/v1/voice/{note['id']}").json()["status"] == "queued"


def test_voice_upload_rejects_non_audio_and_small_audio(owner_client, monkeypatch):
    patch_voice_config(monkeypatch)
    text = owner_client.post(
        "/api/v1/voice",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert text.status_code == 422
    assert text.json()["detail"]["code"] == "unsupported_audio_type"
    tiny = owner_client.post(
        "/api/v1/voice",
        files={"file": ("empty.webm", b"\x1aE\xdf\xa3", "audio/webm")},
    )
    assert tiny.status_code == 422
    assert tiny.json()["detail"]["code"] == "empty_audio"


def _add_member(owner_client, *, email: str, role: str) -> tuple[str, uuid.UUID]:
    household = household_id(owner_client)
    with SessionLocal() as db:
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password("member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household, user_id=user.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="voice-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def test_viewer_cannot_create_voice_notes(owner_client, anon_client):
    viewer_token, _ = _add_member(owner_client, email="voice-viewer@example.com", role="viewer")
    response = anon_client.post(
        "/api/v1/voice",
        headers=_headers(viewer_token),
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "read_only_role"


def test_voice_note_is_scoped_to_household(owner_client, anon_client, monkeypatch):
    note = upload_voice(owner_client, monkeypatch)
    with SessionLocal() as db:
        other = Household(name="Other Home")
        user = User(
            name="Other Owner",
            email="other-voice@example.com",
            password_hash=hash_password("other-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="voice-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
    headers = _headers(token)
    assert anon_client.get(f"/api/v1/voice/{note['id']}", headers=headers).status_code == 404


def test_upload_requires_configured_transcription_and_duration_limit(owner_client, monkeypatch):
    unconfigured = owner_client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
    )
    assert unconfigured.status_code == 422
    assert unconfigured.json()["detail"]["code"] == "transcription_not_configured"

    patch_voice_config(monkeypatch)
    too_long = owner_client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
        data={"duration_seconds": "9999"},
    )
    assert too_long.status_code == 422
    assert too_long.json()["detail"]["code"] == "audio_too_long"


def test_transcription_adapters_call_only_configured_provider(tmp_path, monkeypatch):
    from housetory_api.services import transcription

    path = tmp_path / "note.webm"
    path.write_bytes(b"\x1aE\xdf\xa3" + b"\x00" * 512)
    openai_config = runtime_config("transcription")
    captured: dict[str, object] = {}

    def openai_request(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return {"text": "  a drill in the office  "}

    monkeypatch.setattr(transcription.ai, "request_multipart_json", openai_request)
    text = transcription.transcribe_audio(
        openai_config,
        path=path,
        content_type="audio/webm",
        filename="note.webm",
    )
    assert text == "a drill in the office"
    assert str(captured["url"]).endswith("/audio/transcriptions")
    assert captured["fields"] == {"model": "whisper-1", "response_format": "json"}

    gemini_config = runtime_config("transcription", provider="gemini", model="gemini-2.5-flash")

    def gemini_request(url, payload, **kwargs):
        captured["gemini_url"] = url
        captured["gemini_payload"] = payload
        return {"candidates": [{"content": {"parts": [{"text": "a drill"}]}}]}

    monkeypatch.setattr(transcription.ai, "_request_json", gemini_request)
    assert (
        transcription.transcribe_audio(
            gemini_config,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a drill"
    )
    assert "generateContent" in str(captured["gemini_url"])
    inline = captured["gemini_payload"]["contents"][0]["parts"][1]["inline_data"]
    assert inline["mime_type"] == "audio/webm"

    unsupported = runtime_config("transcription", provider="anthropic", model="claude-sonnet")
    try:
        transcription.transcribe_audio(
            unsupported,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiUnavailable as exc:
        assert "does not support audio transcription" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("Unsupported transcription provider was accepted.")


def test_openrouter_transcription_uses_stt_and_chat_audio_contracts(tmp_path, monkeypatch):
    import base64
    from dataclasses import replace

    from housetory_api.services import transcription
    from housetory_api.services.ai import DiscoveredModel

    path = tmp_path / "note.webm"
    path.write_bytes(b"\x1aE\xdf\xa3" + b"\x00" * 512)
    config = replace(
        runtime_config(
            "transcription",
            provider="openrouter",
            model="openai/whisper-test",
        ),
        base_url="https://openrouter.ai/api/v1",
    )

    stt_metadata = DiscoveredModel(
        id="openai/whisper-test",
        display_name="Whisper Test",
        kind="speech",
        capabilities=("audio",),
        capability_source="provider_metadata",
        endpoints=("/api/v1/audio/transcriptions",),
        input_modalities=("audio",),
        output_modalities=("transcription",),
    )
    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: stt_metadata,
    )
    captured: dict[str, object] = {}

    def stt_request(url, payload, **kwargs):
        captured["url"] = url
        captured["payload"] = payload
        return {"text": "  a drill in the office  ", "usage": {"seconds": 2.1}}

    monkeypatch.setattr(transcription.ai, "_request_json", stt_request)
    assert (
        transcription.transcribe_audio(
            config,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a drill in the office"
    )
    assert str(captured["url"]).endswith("/audio/transcriptions")
    stt_payload = captured["payload"]
    assert isinstance(stt_payload, dict)
    assert stt_payload["model"] == "openai/whisper-test"
    assert stt_payload["response_format"] == "json"
    input_audio = stt_payload["input_audio"]
    assert input_audio["format"] == "webm"
    assert not input_audio["data"].startswith("data:")
    assert base64.b64decode(input_audio["data"]) == path.read_bytes()

    chat_metadata = DiscoveredModel(
        id="openai/audio-chat",
        display_name="Audio Chat",
        kind="chat",
        capabilities=("text", "audio"),
        capability_source="provider_metadata",
        endpoints=("/api/v1/chat/completions",),
        input_modalities=("text", "audio"),
        output_modalities=("text",),
    )
    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: chat_metadata,
    )

    def chat_request(url, payload, **kwargs):
        captured["chat_url"] = url
        captured["chat_payload"] = payload
        return {
            "choices": [
                {
                    "message": {"content": "a saw in the garage"},
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(transcription.ai, "_request_json", chat_request)
    assert (
        transcription.transcribe_audio(
            replace(config, model="openai/audio-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a saw in the garage"
    )
    assert str(captured["chat_url"]).endswith("/chat/completions")
    chat_payload = captured["chat_payload"]
    assert isinstance(chat_payload, dict)
    parts = chat_payload["messages"][1]["content"]
    assert parts[0]["type"] == "text"
    assert parts[1]["type"] == "input_audio"
    assert parts[1]["input_audio"]["format"] == "webm"
    assert not parts[1]["input_audio"]["data"].startswith("data:")

    monkeypatch.setattr(
        transcription.ai,
        "_request_json",
        lambda *_args, **_kwargs: {
            "choices": [
                {
                    "message": {"content": None, "refusal": "cannot transcribe"},
                    "finish_reason": "stop",
                }
            ]
        },
    )
    try:
        transcription.transcribe_audio(
            replace(config, model="openai/audio-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiInvalidOutput as exc:
        assert "refused" in str(exc).lower()
    else:  # pragma: no cover - defensive
        raise AssertionError("A refusal was accepted as a transcript.")

    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: DiscoveredModel(
            id="openai/text-chat",
            display_name="Text Chat",
            kind="chat",
            capabilities=("text",),
            capability_source="provider_metadata",
            endpoints=("/api/v1/chat/completions",),
            input_modalities=("text",),
            output_modalities=("text",),
        ),
    )
    monkeypatch.setattr(
        transcription.ai,
        "_request_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Unsupported audio model must not receive household audio.")
        ),
    )
    try:
        transcription.transcribe_audio(
            replace(config, model="openai/text-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiUnavailable as exc:
        assert "does not advertise" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("Text-only OpenRouter model was accepted for transcription.")
