from dataclasses import replace

import pytest
from sqlalchemy import select

from housetory_api.db import SessionLocal
from housetory_api.models import AiProvider, AiTaskSetting
from housetory_api.services import ai
from housetory_api.services.ai_credentials import decrypt_secret
from housetory_api.services.ai_runtime import AiRuntimeConfig


def provider_payload(**overrides):
    return {
        "provider": "openai",
        "display_name": "OpenAI household",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o",
        "api_key": "sk-test-secret-never-returned",
        "enabled": True,
        "cloud_consent": True,
        **overrides,
    }


def test_ai_provider_settings_encrypt_secrets_and_assign_tasks(owner_client):
    settings = owner_client.get("/api/v1/ai/settings")
    assert settings.status_code == 200, settings.text
    body = settings.json()
    assert body["credential_key_configured"] is True
    assert body["providers"] == []
    assert len(body["tasks"]) == 6
    assert {task["task"] for task in body["tasks"]} == {
        "assistant",
        "imports",
        "documents",
        "search",
        "vision",
        "labels",
    }

    response = owner_client.post("/api/v1/ai/providers", json=provider_payload())
    assert response.status_code == 201, response.text
    provider = response.json()
    assert provider["has_api_key"] is True
    assert "sk-test-secret-never-returned" not in response.text
    assert "api_key" not in provider
    assert "vision" in provider["capabilities"]

    with SessionLocal() as db:
        stored = db.scalar(select(AiProvider))
        assert stored is not None
        assert stored.encrypted_api_key != "sk-test-secret-never-returned"
        assert decrypt_secret(stored.encrypted_api_key) == "sk-test-secret-never-returned"
        tasks = db.scalars(select(AiTaskSetting)).all()
        assert {task.task for task in tasks} >= {"assistant", "imports", "vision"}

    full = owner_client.get("/api/v1/ai/settings").json()
    assert full["providers"][0]["has_api_key"] is True
    assert all("api_key" not in provider for provider in full["providers"])
    assert full["tasks"][0]["provider_id"] == provider["id"]


def test_provider_models_test_and_consent_gate(owner_client, monkeypatch):
    monkeypatch.setattr(
        ai,
        "available_models",
        lambda config: ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"],
    )
    response = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(cloud_consent=False),
    )
    assert response.status_code == 201, response.text
    provider = response.json()
    assert provider["cloud_consent"] is False

    status = owner_client.get("/api/v1/ai/status?task=assistant").json()
    assert status["source"] == "database"
    assert status["configured"] is False
    assert "consent" in (status["error"] or "").lower()

    models = owner_client.get(f"/api/v1/ai/providers/{provider['id']}/models")
    assert models.status_code == 200, models.text
    assert {entry["id"] for entry in models.json()["models"]} >= {
        "gpt-4o",
        "gpt-4o-mini",
    }
    tested = owner_client.post(f"/api/v1/ai/providers/{provider['id']}/test?model=gpt-4o")
    assert tested.status_code == 200
    assert tested.json()["ok"] is True
    assert tested.json()["selected_model_available"] is True

    consented = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"cloud_consent": True, "api_key": "replacement-key"},
    )
    assert consented.status_code == 200, consented.text
    assert consented.json()["cloud_consent"] is True
    status = owner_client.get("/api/v1/ai/status?task=assistant").json()
    assert status["configured"] is True
    assert status["data_leaves_server"] is True
    assert status["mode"] == "cloud"

    cleared = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"clear_api_key": True},
    )
    assert cleared.status_code == 422
    assert cleared.json()["detail"]["code"] == "api_key_required"


def test_task_model_capability_validation(owner_client, monkeypatch):
    monkeypatch.setattr(ai, "available_models", lambda config: ["gpt-4o", "text-embedding-3-small"])
    provider = owner_client.post("/api/v1/ai/providers", json=provider_payload()).json()
    mismatch = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={
            "provider_id": provider["id"],
            "model": "text-embedding-3-small",
            "enabled": True,
        },
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "model_capability_mismatch"

    valid = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={"provider_id": provider["id"], "model": "gpt-4o", "enabled": True},
    )
    assert valid.status_code == 200, valid.text
    assert valid.json()["capabilities"].count("vision") == 1
    disabled = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={"provider_id": provider["id"], "model": "gpt-4o", "enabled": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False


def test_provider_update_delete_and_owner_requirement(owner_client, anon_client):
    provider = owner_client.post("/api/v1/ai/providers", json=provider_payload()).json()
    updated = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"display_name": "Renamed", "base_url": "https://example.com/v1"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["display_name"] == "Renamed"
    deleted = owner_client.delete(f"/api/v1/ai/providers/{provider['id']}")
    assert deleted.status_code == 204
    assert owner_client.get("/api/v1/ai/settings").json()["providers"] == []
    assert anon_client.get("/api/v1/ai/settings").status_code == 401


def test_provider_adapters_use_official_request_shapes(monkeypatch, tmp_path):
    image = tmp_path / "image.jpg"
    image.write_bytes(b"fake-jpeg")

    def make_config(provider):
        return AiRuntimeConfig(
            provider=provider,
            base_url="https://provider.test/v1",
            api_key="secret",
            model="test-model",
            task="vision",
            provider_id=None,
            display_name="Test",
            mode="cloud",
            source="database",
            enabled=True,
            cloud_consent=True,
            configured=True,
        )

    captured = []

    def fake_request(url, payload, **kwargs):
        captured.append((url, payload, kwargs.get("headers")))
        if url.endswith("/messages"):
            return {"content": [{"type": "text", "text": '{"ok": true}'}]}
        if "generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}}]}
        if url.endswith("/api/chat"):
            return {"message": {"content": '{"ok": true}'}}
        return {"choices": [{"message": {"content": '{"ok": true}'}}]}

    monkeypatch.setattr(ai, "_request_json", fake_request)
    for provider in ["openai", "anthropic", "gemini", "ollama"]:
        captured.clear()
        result = ai.complete_json(
            "Return JSON",
            "Identify this",
            image_path=image,
            image_mime="image/jpeg",
            config=make_config(provider),
        )
        assert result == {"ok": True}
        assert captured
        url, payload, headers = captured[0]
        if provider == "anthropic":
            assert url.endswith("/messages")
            assert headers and headers["x-api-key"] == "secret"
            assert any(part.get("type") == "image" for part in payload["messages"][0]["content"])
        elif provider == "gemini":
            assert "generateContent" in url
            assert payload["contents"][0]["parts"][1]["inline_data"]["mime_type"] == "image/jpeg"
        elif provider == "ollama":
            assert url.endswith("/api/chat")
            assert payload["messages"][1]["images"]
        else:
            assert url.endswith("/chat/completions")
            assert payload["messages"][1]["content"][1]["image_url"]["url"].startswith(
                "data:image/jpeg;base64,"
            )

    missing_consent = replace(make_config("openai"), configured=False, error="No consent")
    with pytest.raises(ai.AiUnavailable):
        ai.complete_json("system", "private", config=missing_consent)


def test_credential_rotation_reencrypts_saved_keys(owner_client):
    from housetory_api.config import get_settings
    from housetory_api.services.ai_credentials import decrypt_secret, generate_key

    provider = owner_client.post("/api/v1/ai/providers", json=provider_payload()).json()
    settings = get_settings()
    old_key = settings.ai_credential_key
    new_key = generate_key()
    try:
        settings.ai_credential_key = new_key
        settings.ai_credential_key_previous = old_key
        rotated = owner_client.post("/api/v1/ai/credentials/rotate")
        assert rotated.status_code == 200, rotated.text
        assert rotated.json() == {"rotated": 1, "failed": 0}
        with SessionLocal() as db:
            stored = db.get(AiProvider, provider["id"])
            assert stored is not None
            assert decrypt_secret(stored.encrypted_api_key) == "sk-test-secret-never-returned"
            assert stored.api_key_version == 2
    finally:
        settings.ai_credential_key = old_key
        settings.ai_credential_key_previous = ""


def test_provider_fails_closed_when_credential_key_is_unavailable(owner_client, monkeypatch):
    from housetory_api.services import ai_runtime
    from housetory_api.services.ai_credentials import CredentialUnavailable

    provider = owner_client.post("/api/v1/ai/providers", json=provider_payload()).json()

    def unavailable(_value):
        raise CredentialUnavailable("AI_CREDENTIAL_KEY is unavailable.")

    monkeypatch.setattr(ai_runtime, "decrypt_secret", unavailable)
    status = owner_client.get("/api/v1/ai/status?task=assistant")
    assert status.status_code == 200, status.text
    assert status.json()["configured"] is False
    assert "credential" in (status.json()["error"] or "").lower()
    tested = owner_client.post(f"/api/v1/ai/providers/{provider['id']}/test")
    assert tested.status_code == 200
    assert tested.json()["ok"] is False


def test_ollama_endpoint_scope_and_remote_consent(owner_client, monkeypatch):
    from housetory_api.services import ai
    from housetory_api.services.ai_runtime import endpoint_scope

    assert endpoint_scope("ollama", "http://127.0.0.1:11434") == "local"
    assert endpoint_scope("ollama", "http://host.docker.internal:11434") == "local"
    assert endpoint_scope("ollama", "http://ollama:11434") == "local"
    assert endpoint_scope("ollama", "http://192.168.1.20:11434") == "private"
    assert endpoint_scope("ollama", "https://external.example.invalid") == "remote"
    assert endpoint_scope("openai", "https://api.openai.com/v1") == "remote"

    monkeypatch.setattr(ai, "available_models", lambda config: ["llava:latest"])
    external = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "ollama",
            "display_name": "External Ollama",
            "base_url": "https://external.example.invalid",
            "default_model": "llava:latest",
            "enabled": True,
            "cloud_consent": False,
        },
    )
    assert external.status_code == 201, external.text
    external_body = external.json()
    assert external_body["endpoint_scope"] == "remote"
    assert external_body["is_local"] is False
    assert external_body["cloud_consent"] is False
    status = owner_client.get("/api/v1/ai/status?task=assistant").json()
    assert status["mode"] == "cloud"
    assert status["configured"] is False
    assert "consent" in (status["error"] or "").lower()

    owner_client.delete(f"/api/v1/ai/providers/{external_body['id']}")
    private = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "ollama",
            "display_name": "LAN Ollama",
            "base_url": "http://192.168.1.20:11434",
            "default_model": "llava:latest",
            "enabled": True,
            "cloud_consent": False,
        },
    )
    assert private.status_code == 201, private.text
    assert private.json()["endpoint_scope"] == "private"
    assert owner_client.get("/api/v1/ai/status?task=assistant").json()["mode"] == "private"

    owner_client.delete(f"/api/v1/ai/providers/{private.json()['id']}")
    local = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "ollama",
            "display_name": "Local Ollama",
            "base_url": "http://host.docker.internal:11434",
            "default_model": "llava:latest",
            "enabled": True,
        },
    )
    assert local.status_code == 201, local.text
    assert local.json()["endpoint_scope"] == "local"
    local_status = owner_client.get("/api/v1/ai/status?task=assistant").json()
    assert local_status["mode"] == "local"
    assert local_status["configured"] is True


def test_provider_requests_do_not_follow_redirects(monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from housetory_api.services import ai

    target_hits: list[str] = []

    class TargetHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            target_hits.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):  # noqa: ANN002
            return

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{target_port}/steal")
            self.end_headers()

        def log_message(self, *args):  # noqa: ANN002
            return

    target = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
    target_port = target.server_address[1]
    redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirect_port = redirect.server_address[1]
    threads = [
        threading.Thread(target=target.serve_forever, daemon=True),
        threading.Thread(target=redirect.serve_forever, daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        with pytest.raises(ai.AiUnavailable, match="redirect"):
            ai._request_json(
                f"http://127.0.0.1:{redirect_port}/start", None, method="GET", timeout=3
            )
        assert target_hits == []
    finally:
        redirect.shutdown()
        target.shutdown()
        redirect.server_close()
        target.server_close()
