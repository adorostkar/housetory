from dataclasses import replace

import pytest
from sqlalchemy import select

from housetory_api.db import SessionLocal
from housetory_api.models import AiProvider, AiTaskSetting
from housetory_api.services import ai
from housetory_api.services.ai import DiscoveredModel
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
    assert len(body["tasks"]) == 8
    assert {task["task"] for task in body["tasks"]} == {
        "assistant",
        "imports",
        "documents",
        "search",
        "vision",
        "labels",
        "transcription",
        "item_images",
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
        "discover_models",
        lambda config: [
            DiscoveredModel(
                id="gpt-4o",
                display_name="GPT-4o",
                kind="chat",
                capabilities=("text", "vision", "structured", "tools"),
                capability_source="heuristic",
            ),
            DiscoveredModel(
                id="gpt-4o-mini",
                display_name="GPT-4o mini",
                kind="chat",
                capabilities=("text", "vision", "structured", "tools"),
                capability_source="heuristic",
            ),
            DiscoveredModel(
                id="text-embedding-3-small",
                display_name="Text embedding 3 small",
                kind="embedding",
                capabilities=(),
                capability_source="heuristic",
            ),
        ],
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
    model_rows = {entry["id"]: entry for entry in models.json()["models"]}
    assert set(model_rows) >= {"gpt-4o", "gpt-4o-mini", "text-embedding-3-small"}
    assert model_rows["gpt-4o"]["display_name"] == "GPT-4o"
    assert model_rows["gpt-4o"]["kind"] == "chat"
    assert model_rows["gpt-4o"]["capability_source"] == "heuristic"
    assert "vision" in model_rows["gpt-4o"]["capabilities"]
    assert model_rows["text-embedding-3-small"]["kind"] == "embedding"
    assert models.json()["cached"] is False
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


def test_model_discovery_metadata_is_cached_and_invalidated(owner_client, monkeypatch):
    from tests.test_cross_household import _other_household_headers

    calls: list[str] = []

    def catalog(config):
        calls.append(config.base_url)
        return [
            DiscoveredModel(
                id="catalog-chat",
                display_name="Catalog Chat",
                kind="chat",
                capabilities=("text", "vision"),
                capability_source="provider_metadata",
            ),
            DiscoveredModel(
                id="catalog-embedding",
                display_name="Catalog Embedding",
                kind="embedding",
                capabilities=(),
                capability_source="provider_metadata",
            ),
        ]

    monkeypatch.setattr(ai, "discover_models", catalog)
    provider = owner_client.post(
        "/api/v1/ai/providers", json=provider_payload(cloud_consent=False)
    ).json()
    endpoint = f"/api/v1/ai/providers/{provider['id']}/models"
    first = owner_client.get(endpoint)
    assert first.status_code == 200, first.text
    assert first.json()["cached"] is False
    assert len(first.json()["models"]) == 2
    assert calls == ["https://api.openai.com/v1"]

    cached = owner_client.get(endpoint)
    assert cached.status_code == 200
    assert cached.json()["cached"] is True
    assert calls == ["https://api.openai.com/v1"]

    refreshed = owner_client.get(endpoint, params={"refresh": "true"})
    assert refreshed.status_code == 200
    assert refreshed.json()["cached"] is False
    assert len(calls) == 2

    patched = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"base_url": "https://example.test/v1"},
    )
    assert patched.status_code == 200, patched.text
    after_update = owner_client.get(endpoint)
    assert after_update.status_code == 200
    assert len(calls) == 3
    assert calls[-1] == "https://example.test/v1"

    other = _other_household_headers()
    denied = owner_client.get(endpoint, headers=other["headers"])
    assert denied.status_code == 404


def test_discovery_uses_provider_catalog_metadata_without_inference(monkeypatch):
    def config(provider: str) -> AiRuntimeConfig:
        return AiRuntimeConfig(
            provider=provider,
            base_url="https://provider.test/v1",
            api_key="secret",
            model=None,
            task="assistant",
            provider_id=None,
            display_name="Test",
            mode="cloud",
            source="database",
            enabled=True,
            cloud_consent=False,
            configured=True,
        )

    responses = {
        "openai": {
            "data": [
                {
                    "id": "openrouter/vision",
                    "name": "Vision Router",
                    "architecture": {
                        "input_modalities": ["text", "image"],
                        "output_modalities": ["text"],
                    },
                    "supported_parameters": ["tools", "structured_outputs"],
                }
            ]
        },
        "anthropic": {
            "data": [
                {
                    "id": "claude-test",
                    "display_name": "Claude Test",
                    "type": "model",
                }
            ],
            "has_more": False,
        },
        "gemini": {
            "models": [
                {
                    "name": "models/gemini-test",
                    "displayName": "Gemini Test",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/embedding-test",
                    "displayName": "Embedding Test",
                    "supportedGenerationMethods": ["embedContent"],
                },
            ]
        },
        "ollama": {
            "models": [
                {"name": "llava:latest", "details": {"family": "llava"}},
            ]
        },
    }

    # Use explicit URL markers instead of relying on provider type inside the fake.
    def routed(url, payload, **kwargs):
        if "/api/tags" in url:
            return responses["ollama"]
        return responses["openai"]

    monkeypatch.setattr(ai, "_request_json", routed)
    openrouter = ai.discover_models(config("openrouter"))
    assert {model.id for model in openrouter} == {"openrouter/vision"}
    model = openrouter[0]
    assert model.display_name == "Vision Router"
    assert model.kind == "chat"
    assert set(model.capabilities) == {"text", "vision", "structured", "tools"}
    assert model.capability_source == "provider_metadata"

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda url, payload, **kwargs: (
            responses["ollama"] if "/api/tags" in url else responses["anthropic"]
        ),
    )
    anthropic = ai.discover_models(config("anthropic"))
    assert anthropic[0].display_name == "Claude Test"
    assert anthropic[0].kind == "chat"

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda url, payload, **kwargs: responses["gemini"],
    )
    gemini = {model.id: model for model in ai.discover_models(config("gemini"))}
    assert gemini["gemini-test"].display_name == "Gemini Test"
    assert gemini["gemini-test"].kind == "chat"
    assert gemini["embedding-test"].kind == "embedding"
    assert "text" not in gemini["embedding-test"].capabilities

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda url, payload, **kwargs: responses["ollama"],
    )
    ollama = ai.discover_models(config("ollama"))
    assert ollama[0].id == "llava:latest"
    assert "vision" in ollama[0].capabilities
    assert ollama[0].capability_source == "heuristic"


def test_new_provider_can_discover_before_choosing_a_default(owner_client, monkeypatch):
    monkeypatch.setattr(
        ai,
        "discover_models",
        lambda config: [
            DiscoveredModel(
                id="discovered-chat",
                display_name="Discovered Chat",
                kind="chat",
                capabilities=("text", "vision"),
                capability_source="provider_metadata",
            )
        ],
    )
    created = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(default_model=None),
    )
    assert created.status_code == 201, created.text
    provider = created.json()
    assert provider["default_model"] is None
    models = owner_client.get(f"/api/v1/ai/providers/{provider['id']}/models")
    assert models.status_code == 200, models.text
    assert models.json()["models"][0]["display_name"] == "Discovered Chat"
    updated = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"default_model": "discovered-chat"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["default_model"] == "discovered-chat"


def test_editing_provider_with_blank_key_preserves_encrypted_credential(owner_client, monkeypatch):
    monkeypatch.setattr(ai, "discover_models", lambda config: [])
    provider = owner_client.post(
        "/api/v1/ai/providers", json=provider_payload(default_model=None)
    ).json()
    updated = owner_client.patch(
        f"/api/v1/ai/providers/{provider['id']}",
        json={"default_model": "gpt-4o-mini"},
    )
    assert updated.status_code == 200, updated.text
    with SessionLocal() as db:
        stored = db.get(AiProvider, provider["id"])
        assert stored is not None
        assert decrypt_secret(stored.encrypted_api_key) == "sk-test-secret-never-returned"
        assert stored.api_key_version == 1


def test_cached_catalog_metadata_controls_task_capability_validation(owner_client, monkeypatch):
    monkeypatch.setattr(
        ai,
        "discover_models",
        lambda config: [
            DiscoveredModel(
                id="text-chat",
                display_name="Text Chat",
                kind="chat",
                capabilities=("text",),
                capability_source="provider_metadata",
            ),
            DiscoveredModel(
                id="embedding-chat",
                display_name="Embedding",
                kind="embedding",
                capabilities=(),
                capability_source="provider_metadata",
            ),
        ],
    )
    provider = owner_client.post(
        "/api/v1/ai/providers", json=provider_payload(default_model=None)
    ).json()
    discovered = owner_client.get(f"/api/v1/ai/providers/{provider['id']}/models")
    assert discovered.status_code == 200
    vision = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={"provider_id": provider["id"], "model": "text-chat", "enabled": True},
    )
    assert vision.status_code == 422
    assert vision.json()["detail"]["code"] == "model_capability_mismatch"
    embedding = owner_client.put(
        "/api/v1/ai/tasks/assistant",
        json={"provider_id": provider["id"], "model": "embedding-chat", "enabled": True},
    )
    assert embedding.status_code == 422
    assert embedding.json()["detail"]["code"] == "model_not_chat_capable"


def test_status_catalog_check_is_compact_and_never_serializes_models(owner_client, monkeypatch):
    catalog = [f"model-{index:03d}" for index in range(500)]
    monkeypatch.setattr(ai, "available_models", lambda config: catalog)
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(default_model="model-250"),
    ).json()

    status = owner_client.get("/api/v1/ai/status?task=assistant")
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["configured"] is True
    assert body["catalog_checked"] is True
    assert body["catalog_count"] == 500
    assert body["available"] is True
    assert "models" not in body
    assert "model-499" not in status.text

    saved_label = owner_client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider["id"],
            "model": "GPT-6 Luna",
            "enabled": True,
        },
    )
    assert saved_label.status_code == 200, saved_label.text
    mismatch = owner_client.get("/api/v1/ai/status?task=assistant")
    assert mismatch.status_code == 200, mismatch.text
    mismatch_body = mismatch.json()
    assert mismatch_body["catalog_checked"] is True
    assert mismatch_body["catalog_count"] == 500
    assert mismatch_body["available"] is False
    assert "was not listed" in mismatch_body["error"]
    assert "GPT-6 Luna" in mismatch_body["error"]
    assert "models" not in mismatch_body

    monkeypatch.setattr(ai, "available_models", lambda config: [])
    empty = owner_client.get("/api/v1/ai/status?task=assistant").json()
    assert empty["catalog_checked"] is True
    assert empty["catalog_count"] == 0
    assert empty["available"] is False
    assert "empty model catalog" in empty["error"]
    assert "models" not in empty


def test_status_catalog_failure_is_not_reported_as_model_mismatch(owner_client, monkeypatch):
    owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(default_model="gpt-4o"),
    )

    def unavailable(config):
        raise ai.AiUnavailable("Provider returned HTTP 503: upstream unavailable")

    monkeypatch.setattr(ai, "available_models", unavailable)
    status = owner_client.get("/api/v1/ai/status?task=assistant")
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["configured"] is True
    assert body["catalog_checked"] is False
    assert body["catalog_count"] == 0
    assert body["available"] is False
    assert "503" in body["error"]
    assert "models" not in body


def test_vision_task_must_be_explicitly_configured(owner_client, monkeypatch):
    monkeypatch.setattr(ai, "available_models", lambda config: ["plain-text-model", "gpt-4o"])
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(default_model="plain-text-model", cloud_consent=True),
    ).json()

    unset = owner_client.get("/api/v1/ai/status?task=vision").json()
    assert unset["configured"] is False
    assert unset["available"] is False
    assert "No vision task is configured" in unset["error"]

    configured = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={"provider_id": provider["id"], "model": "gpt-4o", "enabled": True},
    )
    assert configured.status_code == 200, configured.text
    status = owner_client.get("/api/v1/ai/status?task=vision").json()
    assert status["configured"] is True
    assert status["model"] == "gpt-4o"
    assert status["task"] == "vision"
    assert status["provider"] == "openai"
    assert status["available"] is True

    disabled = owner_client.put(
        "/api/v1/ai/tasks/vision",
        json={"provider_id": provider["id"], "model": "gpt-4o", "enabled": False},
    )
    assert disabled.status_code == 200, disabled.text
    disabled_status = owner_client.get("/api/v1/ai/status?task=vision").json()
    assert disabled_status["configured"] is False
    assert "disabled" in (disabled_status["error"] or "").lower()


def test_transcription_task_status_is_explicit_and_accepts_audio_capability(owner_client):
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(
            provider="openai",
            display_name="OpenAI transcription",
            default_model="whisper-1",
        ),
    ).json()
    status = owner_client.get("/api/v1/ai/status?task=transcription")
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["task"] == "transcription"
    assert body["configured"] is False
    assert "No transcription task is configured" in body["error"]

    saved = owner_client.put(
        "/api/v1/ai/tasks/transcription",
        json={
            "provider_id": provider["id"],
            "model": "whisper-1",
            "enabled": True,
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["task"] == "transcription"
    assert saved.json()["model"] == "whisper-1"

    rejected = owner_client.put(
        "/api/v1/ai/tasks/transcription",
        json={
            "provider_id": provider["id"],
            "model": "gpt-4o",
            "enabled": True,
        },
    )
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "transcription_model_unsupported"


def test_openrouter_discovery_reads_audio_and_image_modalities(monkeypatch):
    config = AiRuntimeConfig(
        provider="openrouter",
        base_url="https://openrouter.ai/api/v1",
        api_key="test-key",
        model=None,
        task="assistant",
        provider_id=None,
        display_name="OpenRouter",
        mode="cloud",
        source="database",
        enabled=True,
        cloud_consent=True,
        configured=True,
    )

    def routed(url, payload, **kwargs):
        if "output_modalities=text" in url:
            return {
                "data": [
                    {
                        "id": "openai/audio-chat",
                        "name": "Audio Chat",
                        "architecture": {
                            "input_modalities": ["text", "audio"],
                            "output_modalities": ["text"],
                        },
                        "endpoints": ["/api/v1/chat/completions"],
                        "supported_parameters": ["temperature"],
                    },
                    {
                        "id": "openai/text-chat",
                        "name": "Text Chat",
                        "architecture": {
                            "input_modalities": ["text"],
                            "output_modalities": ["text"],
                        },
                        "endpoints": ["/api/v1/chat/completions"],
                        "supported_parameters": ["temperature"],
                    },
                ]
            }
        if "output_modalities=image" in url:
            return {
                "data": [
                    {
                        "id": "openai/gpt-image-test",
                        "name": "Image Test",
                        "architecture": {
                            "input_modalities": ["text"],
                            "output_modalities": ["image"],
                        },
                        "endpoints": ["/api/v1/images"],
                        "supported_parameters": {},
                    }
                ]
            }
        if "output_modalities=transcription" in url:
            return {
                "data": [
                    {
                        "id": "openai/whisper-test",
                        "name": "Whisper Test",
                        "architecture": {
                            "input_modalities": ["audio"],
                            "output_modalities": ["transcription"],
                        },
                        "endpoints": ["/api/v1/audio/transcriptions"],
                        "supported_parameters": ["temperature"],
                    }
                ]
            }
        return {"data": []}

    monkeypatch.setattr(ai, "_request_json", routed)
    models = {model.id: model for model in ai.discover_models(config)}
    audio_chat = models["openai/audio-chat"]
    assert audio_chat.kind == "chat"
    assert "audio" in audio_chat.capabilities
    assert audio_chat.input_modalities == ("text", "audio")

    image = models["openai/gpt-image-test"]
    assert image.kind == "image"
    assert "image" in image.capabilities
    assert image.output_modalities == ("image",)
    assert "/api/v1/images" in image.endpoints

    stt = models["openai/whisper-test"]
    assert stt.kind == "speech"
    assert "audio" in stt.capabilities
    assert "/api/v1/audio/transcriptions" in stt.endpoints
    assert stt.output_modalities == ("transcription",)


def test_openrouter_task_saves_require_compatible_discovered_media_models(
    owner_client, monkeypatch
):
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json=provider_payload(
            provider="openrouter",
            display_name="OpenRouter media",
            base_url="https://openrouter.ai/api/v1",
            default_model="openai/audio-chat",
            api_key="sk-or-test-never-returned",
        ),
    ).json()

    monkeypatch.setattr(
        ai,
        "discover_models",
        lambda config: [
            DiscoveredModel(
                id="openai/whisper-test",
                display_name="Whisper Test",
                kind="speech",
                capabilities=("audio",),
                capability_source="provider_metadata",
                endpoints=("/api/v1/audio/transcriptions",),
                input_modalities=("audio",),
                output_modalities=("transcription",),
            ),
            DiscoveredModel(
                id="openai/audio-chat",
                display_name="Audio Chat",
                kind="chat",
                capabilities=("text", "audio"),
                capability_source="provider_metadata",
                endpoints=("/api/v1/chat/completions",),
                input_modalities=("text", "audio"),
                output_modalities=("text",),
            ),
            DiscoveredModel(
                id="openai/gpt-image-test",
                display_name="Image Test",
                kind="image",
                capabilities=("image",),
                capability_source="provider_metadata",
                endpoints=("/api/v1/images",),
                input_modalities=("text",),
                output_modalities=("image",),
            ),
            DiscoveredModel(
                id="openai/text-chat",
                display_name="Text Chat",
                kind="chat",
                capabilities=("text",),
                capability_source="provider_metadata",
                endpoints=("/api/v1/chat/completions",),
                input_modalities=("text",),
                output_modalities=("text",),
            ),
        ],
    )
    discovered = owner_client.get(f"/api/v1/ai/providers/{provider['id']}/models")
    assert discovered.status_code == 200, discovered.text
    assert discovered.json()["models"][0]["input_modalities"] is not None

    transcription = owner_client.put(
        "/api/v1/ai/tasks/transcription",
        json={
            "provider_id": provider["id"],
            "model": "openai/whisper-test",
            "enabled": True,
        },
    )
    assert transcription.status_code == 200, transcription.text

    images = owner_client.put(
        "/api/v1/ai/tasks/item_images",
        json={
            "provider_id": provider["id"],
            "model": "openai/gpt-image-test",
            "enabled": True,
        },
    )
    assert images.status_code == 200, images.text

    audio_as_image = owner_client.put(
        "/api/v1/ai/tasks/item_images",
        json={
            "provider_id": provider["id"],
            "model": "openai/whisper-test",
            "enabled": True,
        },
    )
    assert audio_as_image.status_code == 422
    assert audio_as_image.json()["detail"]["code"] == "model_capability_mismatch"

    image_as_transcription = owner_client.put(
        "/api/v1/ai/tasks/transcription",
        json={
            "provider_id": provider["id"],
            "model": "openai/gpt-image-test",
            "enabled": True,
        },
    )
    assert image_as_transcription.status_code == 422
    assert image_as_transcription.json()["detail"]["code"] == "transcription_model_unsupported"

    text_as_transcription = owner_client.put(
        "/api/v1/ai/tasks/transcription",
        json={
            "provider_id": provider["id"],
            "model": "openai/text-chat",
            "enabled": True,
        },
    )
    assert text_as_transcription.status_code == 422
    assert text_as_transcription.json()["detail"]["code"] == "transcription_model_unsupported"
