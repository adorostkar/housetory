import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    AiTaskSetting,
    HouseholdMember,
    Job,
    User,
    WorkerHeartbeat,
)
from housetory_api.security import hash_password
from housetory_api.services import ai_task_test
from housetory_api.services.task_capabilities import model_task_state, model_task_states


@dataclass
class FakeModel:
    kind: str
    capabilities: tuple[str, ...]
    capability_source: str = "provider_metadata"
    input_modalities: tuple[str, ...] = ()
    output_modalities: tuple[str, ...] = ()
    endpoints: tuple[str, ...] = ()


def test_task_specific_capability_matrix_does_not_require_blanket_tools():
    text_only = FakeModel(
        kind="chat",
        capabilities=("text",),
        input_modalities=("text",),
        output_modalities=("text",),
        endpoints=("/api/v1/chat/completions",),
    )
    states = model_task_states("openrouter", text_only)
    assert states["assistant"] == "compatible"
    assert states["vision"] == "incompatible"
    assert states["transcription"] == "incompatible"
    assert "labels" not in states
    assert "item_images" not in states

    audio_chat = FakeModel(
        kind="chat",
        capabilities=("text", "audio"),
        input_modalities=("text", "audio"),
        output_modalities=("text",),
        endpoints=("/api/v1/chat/completions",),
    )
    assert model_task_state("openrouter", "transcription", audio_chat) == "compatible"
    assert model_task_state("openrouter", "assistant", audio_chat) == "compatible"

    image = FakeModel(
        kind="image",
        capabilities=("image",),
        input_modalities=("text",),
        output_modalities=("image",),
        endpoints=("/api/v1/images",),
    )
    assert model_task_state("openrouter", "assistant", image) == "incompatible"

    assert model_task_state("anthropic", "transcription", text_only) == "adapter_unavailable"
    assert model_task_state("openai", "assistant", None) == "unverified"


def test_explicit_task_test_requires_confirmation_and_records_live_result(
    owner_client, monkeypatch
):
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Task test provider",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-test",
            "api_key": "sk-test-task-secret",
            "enabled": True,
            "cloud_consent": True,
        },
    ).json()
    saved = owner_client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider["id"],
            "model": "gpt-test",
            "enabled": True,
        },
    )
    assert saved.status_code == 200, saved.text

    refused = owner_client.post(
        "/api/v1/ai/tasks/assistant/test",
        json={"confirm": False},
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "test_confirmation_required"

    monkeypatch.setattr(
        ai_task_test.ai,
        "complete_json",
        lambda *_args, **_kwargs: {"ok": True},
    )
    passed = owner_client.post(
        "/api/v1/ai/tasks/assistant/test",
        json={"confirm": True},
    )
    assert passed.status_code == 200, passed.text
    assert passed.json()["status"] == "passed"
    status = owner_client.get("/api/v1/system/status").json()
    assistant = next(task for task in status["tasks"] if task["task"] == "assistant")
    assert assistant["live_tested"] is True
    assert assistant["last_test_status"] == "passed"
    assert assistant["last_test_at"] is not None

    monkeypatch.setattr(
        ai_task_test.ai,
        "complete_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ai_task_test.ai.AiInvalidOutput("malformed test output")
        ),
    )
    failed = owner_client.post(
        "/api/v1/ai/tasks/assistant/test",
        json={"confirm": True},
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["status"] == "failed"
    assert "malformed" in failed.json()["message"].lower()
    status = owner_client.get("/api/v1/system/status").json()
    assistant = next(task for task in status["tasks"] if task["task"] == "assistant")
    assert assistant["live_tested"] is False
    assert assistant["last_test_status"] == "failed"
    assert "malformed" in (assistant["last_test_error"] or "").lower()


def test_inherited_text_task_without_row_matches_settings_status_and_live_test(
    owner_client, monkeypatch
):
    provider = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Inherited task provider",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-inherited",
            "api_key": "sk-test-inherited-secret",
            "enabled": True,
            "cloud_consent": True,
        },
    ).json()
    session = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(session["household"]["id"])
    with SessionLocal() as db:
        setting = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id,
                AiTaskSetting.task == "documents",
            )
        )
        assert setting is not None
        db.delete(setting)
        db.commit()

    settings = owner_client.get("/api/v1/ai/settings").json()
    documents = next(
        task for task in settings["tasks"] if task["task"] == "documents"
    )
    assert documents["inherits_text_default"] is True
    assert documents["enabled"] is True
    assert documents["provider_id"] == provider["id"]
    assert documents["model"] == "gpt-inherited"
    assert "documents" in settings["default_text"]["inherited_tasks"]

    status = owner_client.get("/api/v1/system/status").json()
    status_documents = next(
        task for task in status["tasks"] if task["task"] == "documents"
    )
    assert status_documents["enabled"] is True
    assert status_documents["configured"] is True
    assert status_documents["model"] == "gpt-inherited"

    monkeypatch.setattr(
        ai_task_test.ai,
        "complete_json",
        lambda *_args, **_kwargs: {"ok": True},
    )
    passed = owner_client.post(
        "/api/v1/ai/tasks/documents/test",
        json={"confirm": True},
    )
    assert passed.status_code == 200, passed.text
    assert passed.json()["status"] == "passed"
    assert passed.json()["model"] == "gpt-inherited"

    with SessionLocal() as db:
        recreated = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id,
                AiTaskSetting.task == "documents",
            )
        )
        assert recreated is not None
        assert recreated.inherits_text_default is True
        assert recreated.enabled is True
        assert recreated.provider_id == uuid.UUID(provider["id"])
        assert recreated.model == "gpt-inherited"


def test_bulk_live_task_test_endpoint_remains_owner_only(owner_client):
    from housetory_api.services.auth import create_session

    state = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name="Task Test Member",
            email="task-test-member@example.com",
            password_hash=hash_password("task-test-member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household_id,
                user_id=user.id,
                role="member",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="task-test-boundary",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    denied = owner_client.post(
        "/api/v1/ai/tasks/assistant/test",
        json={"confirm": True},
        headers={"Cookie": f"housetory_session={token}"},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "owner_required"
    assert (
        owner_client.post(
            "/api/v1/ai/tasks/assistant/test",
            json={"confirm": False},
        ).status_code
        == 422
    )


def test_system_status_release_readiness_jobs_retry_and_scoping(
    owner_client, anon_client, monkeypatch
):
    from housetory_api.config import get_settings

    settings = get_settings()
    household_id = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    monkeypatch.setattr(settings, "release_commit", "abc123release")
    monkeypatch.setattr(settings, "release_build_time", "2026-11-06T12:00:00Z")
    monkeypatch.setattr(settings, "release_channel", "local-test")
    monkeypatch.setattr(settings, "server_identity", "fixture-host")

    with SessionLocal() as db:
        db.add(
            WorkerHeartbeat(
                worker_id="fixture-worker",
                version="0.1.0",
                updated_at=datetime.now(UTC),
            )
        )
        db.add(
            Job(
                queue="default",
                task="fixture.failed",
                payload={
                    "household_id": str(household_id),
                    "private_payload": "must-not-leak",
                },
                status="failed",
                attempts=1,
                max_attempts=2,
                last_error="fixture failure",
                created_at=datetime.now(UTC),
                finished_at=datetime.now(UTC),
            )
        )
        other_job = Job(
            queue="default",
            task="fixture.other-household",
            payload={"household_id": str(uuid.uuid4())},
            status="failed",
            attempts=1,
            max_attempts=2,
            last_error="other household failure",
            created_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        db.add(other_job)
        db.commit()
        other_job_id = other_job.id

    response = owner_client.get("/api/v1/system/status")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["release"]["commit"] == "abc123release"
    assert body["release"]["channel"] == "local-test"
    assert body["release"]["identity"] == "fixture-host"
    readiness = {entry["name"]: entry for entry in body["readiness"]}
    assert readiness["Database"]["status"] == "ok"
    assert readiness["Storage"]["status"] == "ok"
    assert readiness["Worker"]["status"] == "ok"
    assert body["jobs"]["counts"].get("failed", 0) >= 1
    assert any(job["task"] == "fixture.failed" for job in body["jobs"]["recent_failed"])
    assert "fixture.other-household" not in response.text
    assert "other household failure" not in response.text
    assert "private_payload" not in response.text
    assert "must-not-leak" not in response.text
    assert "sk-test" not in response.text

    # Viewers cannot read operator job/status details.
    with SessionLocal() as db:
        state = owner_client.get("/api/v1/auth/session").json()
        user = User(
            name="Status Viewer",
            email="status-viewer@example.com",
            password_hash=hash_password("status-viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=uuid.UUID(state["household"]["id"]),
                user_id=user.id,
                role="viewer",
            )
        )
        from housetory_api.services.auth import create_session

        token = create_session(
            db,
            user=user,
            settings=settings,
            user_agent="status-test",
            ip_address="127.0.0.1",
            household_id=uuid.UUID(state["household"]["id"]),
        )
        db.commit()
    viewer = {"Cookie": f"housetory_session={token}"}
    assert anon_client.get("/api/v1/system/status", headers=viewer).status_code == 403

    with SessionLocal() as db:
        job = db.scalar(select(Job).where(Job.task == "fixture.failed"))
        assert job is not None
        job_id = job.id
    assert owner_client.post(f"/api/v1/system/jobs/{other_job_id}/retry").status_code == 404
    assert owner_client.post(f"/api/v1/system/jobs/{job_id}/retry").status_code == 200
    with SessionLocal() as db:
        retried = db.get(Job, job_id)
        assert retried.status == "queued"
        assert retried.attempts == 0
        assert retried.last_error is None
    assert owner_client.post(f"/api/v1/system/jobs/{job_id}/retry").status_code == 409


def _healthy_heartbeat() -> None:
    with SessionLocal() as db:
        db.merge(
            WorkerHeartbeat(
                worker_id="summary-worker",
                version="0.1.0",
                updated_at=datetime.now(UTC),
            )
        )
        db.commit()


def test_system_status_summary_keeps_optional_configuration_out_of_attention(
    owner_client,
):
    _healthy_heartbeat()
    summary = owner_client.get("/api/v1/system/status/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["status"] == "healthy"
    assert body["attention_count"] == 0
    assert body["core_issue_count"] == 0
    assert body["configured_feature_issue_count"] == 0
    assert body["issues"] == []
    assert body["generated_at"]
    optional = set(body["optional_not_configured"])
    assert {
        "Email delivery",
        "Online manual search",
        "Reference-image search",
        "AI tasks",
    } <= optional


def test_system_status_summary_distinguishes_core_and_configured_feature_issues(
    owner_client,
):
    household_id = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    _healthy_heartbeat()
    with SessionLocal() as db:
        db.add(
            Job(
                queue="default",
                task="fixture.summary.failed",
                payload={"household_id": str(household_id)},
                status="failed",
                attempts=2,
                max_attempts=3,
                last_error="fixture summary failure",
                finished_at=datetime.now(UTC),
            )
        )
        db.commit()

    provider = owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Summary fixture",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-test",
            "api_key": "sk-summary-test-secret",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    provider_id = provider.json()["id"]
    saved = owner_client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider_id,
            "model": "gpt-test",
            "enabled": True,
        },
    )
    assert saved.status_code == 200, saved.text
    with SessionLocal() as db:
        setting = db.scalar(
            select(AiTaskSetting).where(
                AiTaskSetting.household_id == household_id,
                AiTaskSetting.task == "assistant",
            )
        )
        assert setting is not None
        setting.last_test_status = "failed"
        setting.last_test_error = "Fixture live test failed."
        db.commit()

    summary = owner_client.get("/api/v1/system/status/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["status"] == "attention"
    assert body["attention_count"] >= 2
    assert body["core_issue_count"] >= 1
    assert body["configured_feature_issue_count"] == 1
    issues = {issue["label"]: issue for issue in body["issues"]}
    assert "Worker jobs" in issues
    assert issues["Worker jobs"]["kind"] == "core"
    assert issues["Worker jobs"]["settings_path"] == "/settings/system-status"
    assert "Assistant" in issues
    assert issues["Assistant"]["kind"] == "configured_feature"
    assert issues["Assistant"]["settings_path"] == "/settings/ai"
    assert "Fixture live test failed." in issues["Assistant"]["detail"]
    assert "AI tasks" not in body["optional_not_configured"]


def test_system_status_summary_reports_missing_worker_as_core_and_is_owner_only(
    owner_client, anon_client, monkeypatch
):
    viewer_token = None
    state = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name="Summary Viewer",
            email="summary-viewer@example.com",
            password_hash=hash_password("summary-viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household_id,
                user_id=user.id,
                role="viewer",
            )
        )
        from housetory_api.services.auth import create_session

        viewer_token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="summary-viewer",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    assert anon_client.get("/api/v1/system/status/summary").status_code == 401
    viewer = {"Cookie": f"housetory_session={viewer_token}"}
    assert owner_client.get("/api/v1/system/status/summary", headers=viewer).status_code == 403

    summary = owner_client.get("/api/v1/system/status/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["status"] == "attention"
    worker = next(issue for issue in body["issues"] if issue["label"] == "Worker readiness")
    assert worker["kind"] == "core"
    assert "No worker heartbeat" in worker["detail"]


def test_system_status_summary_does_not_require_reference_domains(owner_client, monkeypatch):
    from housetory_api.config import get_settings

    _healthy_heartbeat()
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "summary-env-key")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "")
    monkeypatch.setattr(settings, "manual_search_url", "")
    monkeypatch.setattr(settings, "manual_search_provider", "auto")
    monkeypatch.setattr(settings, "item_image_search_provider", "auto")

    summary = owner_client.get("/api/v1/system/status/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["status"] == "healthy"
    assert all(issue["label"] != "Reference-image search" for issue in body["issues"])
    assert "Online manual search" not in body["optional_not_configured"]
    assert "Reference-image search" not in body["optional_not_configured"]
    status = owner_client.get("/api/v1/system/status").json()
    reference = next(
        entry for entry in status["external_services"] if entry["name"] == "Reference-image search"
    )
    assert reference["configured"] is True
    assert "public-web" in reference["detail"]
