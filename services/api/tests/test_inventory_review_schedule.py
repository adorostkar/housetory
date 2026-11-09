import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.domain import JobStatus
from housetory_api.jobs import claim_job, mark_succeeded
from housetory_api.models import (
    HouseholdMember,
    InventoryReviewRun,
    InventoryReviewSchedule,
    InventoryReviewSuggestion,
    Item,
    Job,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import inventory_review, inventory_review_schedule
from housetory_api.services.auth import create_session


def create_room(client, name="Workshop"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_category(client, name):
    response = client.post("/api/v1/categories", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, **extra):
    response = client.post(
        "/api/v1/items",
        json={"name": name, "room_id": room_id, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def add_member(client, role="member", email=None):
    state = client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"Schedule {role.title()}",
            email=email or f"schedule-{role}@example.com",
            password_hash=hash_password("schedule-member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household_id,
                user_id=user.id,
                role=role,
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="inventory-review-schedule-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def schedule_payload(**overrides):
    payload = {
        "enabled": True,
        "scope_type": "household",
        "scope_id": None,
        "frequency": "weekly",
        "timezone": "Europe/London",
        "weekday": 0,
        "monthly_day": 1,
        "local_hour": 9,
        "max_items": 200,
        "max_runs_per_day": 1,
        "include_ai": False,
        "ai_consent": False,
    }
    payload.update(overrides)
    return payload


def put_schedule(client, headers=None, **overrides):
    return client.put(
        "/api/v1/inventory-review/schedule",
        json=schedule_payload(**overrides),
        headers=headers,
    )


def configure_assistant(client, *, model="gpt-schedule"):
    provider = client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Schedule fixture AI",
            "base_url": "https://api.openai.com/v1",
            "default_model": model,
            "api_key": "sk-schedule-fixture",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    provider_body = provider.json()
    task = client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider_body["id"],
            "model": model,
            "enabled": True,
        },
    )
    assert task.status_code == 200, task.text
    return provider_body, task.json()


def set_due(household_id, when):
    with SessionLocal() as db:
        schedule = db.scalar(
            select(InventoryReviewSchedule).where(
                InventoryReviewSchedule.household_id == household_id
            )
        )
        assert schedule is not None
        schedule.next_due_at = when
        db.commit()


def dispatch(now=None):
    with SessionLocal() as db:
        return inventory_review_schedule.dispatch_due_reviews(db, now=now)


def claim_schedule_job(worker_id="schedule-test-worker"):
    with SessionLocal() as db:
        job = claim_job(db, worker_id=worker_id)
        if job is None:
            return None, None
        assert job.task == inventory_review_schedule.SCHEDULED_REVIEW_TASK
        return job.id, dict(job.payload)


def run_schedule_job(payload):
    return inventory_review_schedule.run_scheduled_review_job(payload)


def finish_job(job_id, result):
    with SessionLocal() as db:
        mark_succeeded(db, job_id, result=result if isinstance(result, dict) else {})


def schedule_row(household_id):
    with SessionLocal() as db:
        return db.scalar(
            select(InventoryReviewSchedule).where(
                InventoryReviewSchedule.household_id == household_id
            )
        )


def current_household_id(client):
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def item_state(client, item_id):
    response = client.get(f"/api/v1/items/{item_id}")
    assert response.status_code == 200, response.text
    return response.json()["item"]


def test_schedule_is_off_by_default_and_owner_only(owner_client):
    client = owner_client
    state = client.get("/api/v1/inventory-review/schedule")
    assert state.status_code == 200, state.text
    assert state.json() is None

    summary = client.get("/api/v1/inventory-review/summary").json()
    assert summary["schedule"]["configured"] is False
    assert summary["schedule"]["enabled"] is False
    assert summary["schedule"]["state"] == "not_configured"

    member = add_member(client, "member", email="schedule-read-member@example.com")
    viewer = add_member(client, "viewer", email="schedule-read-viewer@example.com")
    for headers in (member, viewer):
        denied = client.get("/api/v1/inventory-review/schedule", headers=headers)
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "owner_required"
        denied_write = client.put(
            "/api/v1/inventory-review/schedule",
            headers=headers,
            json=schedule_payload(),
        )
        assert denied_write.status_code == 403

    assert dispatch() == 0
    with SessionLocal() as db:
        assert db.scalar(select(InventoryReviewSchedule.id)) is None


def test_offline_schedule_dispatches_once_and_reuses_review_idempotently(owner_client, monkeypatch):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client)
    category = create_category(client, "Tools")
    create_item(client, "Scheduled drill", room["id"], category_id=category["id"])
    target = create_item(client, "Scheduled drill", room["id"])
    before_updated = item_state(client, target["id"])["updated_at"]

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Offline scheduled review must not call AI.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)

    saved = put_schedule(
        client,
        timezone="UTC",
        weekday=0,
        local_hour=9,
        max_items=200,
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["enabled"] is True
    assert body["include_ai"] is False
    assert body["ai_consent"] is False
    assert body["next_due_at"] is not None
    assert body["state"] == "scheduled"

    old_due = datetime.now(UTC) - timedelta(days=30)
    set_due(household_id, old_due)
    assert dispatch() == 1
    row = schedule_row(household_id)
    assert row.last_run_status == "queued"
    assert row.next_due_at is not None and row.next_due_at > datetime.now(UTC)

    # The due schedule is not dispatched again while its job is active.
    assert dispatch() == 0

    job_id, payload = claim_schedule_job()
    assert job_id is not None and payload is not None
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["status"] in {"completed", "partial"}
    assert result["scanned"] >= 2
    assert result["ai_used"] is False

    with SessionLocal() as db:
        runs = list(
            db.scalars(
                select(InventoryReviewRun).where(InventoryReviewRun.household_id == household_id)
            ).all()
        )
        assert len(runs) == 1
        run = runs[0]
        assert run.trigger_type == "scheduled"
        assert run.schedule_id is not None
        suggestions = list(
            db.scalars(
                select(InventoryReviewSuggestion).where(InventoryReviewSuggestion.run_id == run.id)
            ).all()
        )
        assert suggestions
        first_suggestion_ids = {row.id for row in suggestions}
        assert all(row.source == "rules" for row in suggestions)

    assert item_state(client, target["id"])["updated_at"] == before_updated

    # A retried job with the same request id is idempotent: same run, no flood.
    replay = run_schedule_job(payload)
    assert replay["run_id"] == result["run_id"]
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(InventoryReviewRun.id).where(InventoryReviewRun.household_id == household_id)
            )
            is not None
        )
        assert (
            len(
                list(
                    db.scalars(
                        select(InventoryReviewRun).where(
                            InventoryReviewRun.household_id == household_id
                        )
                    ).all()
                )
            )
            == 1
        )
        assert {
            row.id
            for row in db.scalars(
                select(InventoryReviewSuggestion).where(
                    InventoryReviewSuggestion.run_id == uuid.UUID(result["run_id"])
                )
            ).all()
        } <= first_suggestion_ids

    # The next due time is strictly in the future; a restart cannot catch up in a burst.
    assert dispatch() == 0

    disabled = put_schedule(client, enabled=False, timezone="UTC")
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["enabled"] is False
    assert disabled.json()["next_due_at"] is None
    assert disabled.json()["state"] == "disabled"
    assert dispatch() == 0


def test_scheduled_ai_needs_separate_consent_and_route_changes_skip_ai(owner_client, monkeypatch):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client)
    category = create_category(client, "Garden")
    create_item(client, "Scheduled shears", room["id"])
    create_item(client, "Scheduled hose", room["id"])
    provider, _task = configure_assistant(client)

    missing_consent = put_schedule(client, include_ai=True, ai_consent=False)
    assert missing_consent.status_code == 422
    assert missing_consent.json()["detail"]["code"] == "ai_consent_required"

    saved = put_schedule(client, include_ai=True, ai_consent=True, max_runs_per_day=4)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["include_ai"] is True
    assert body["ai_consent"] is True
    assert body["ai_consent_valid"] is True
    assert body["assistant_provider_label"] == "Schedule fixture AI"
    assert body["provider_request_cap"] == 1

    calls = []

    def fake_complete_json(_system, _prompt, *, config):
        calls.append(config.provider_id)
        return {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(category["id"])},
                    "tags": [],
                    "confidence": "high",
                    "reason": "Fixture garden evidence.",
                }
            ]
        }

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["ai_used"] is True
    assert len(calls) == 1
    assert result["status"] == "completed"

    # Changing the Assistant model is a material route change. Consent is
    # invalidated; the next due run skips AI but still performs offline rules.
    changed = client.put(
        "/api/v1/ai/tasks/assistant",
        json={"provider_id": provider["id"], "model": "gpt-schedule-v2", "enabled": True},
    )
    assert changed.status_code == 200, changed.text
    invalidated = client.get("/api/v1/inventory-review/schedule").json()
    assert invalidated["ai_consent_valid"] is False
    assert invalidated["state"] == "consent_needed"
    assert "changed" in (invalidated["ai_consent_reason"] or "").lower()

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Scheduled AI must not run after a route change.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    skipped = run_schedule_job(payload)
    finish_job(job_id, skipped)
    assert skipped["ai_used"] is False
    assert skipped["status"] == "partial"
    assert skipped["ai_skipped_reason"]
    with SessionLocal() as db:
        run = db.get(InventoryReviewRun, uuid.UUID(skipped["run_id"]))
        assert run is not None
        assert run.include_ai is True
        assert run.ai_error
        assert "consent" in run.ai_error.lower()
        assert run.created_suggestion_count >= 0
    row = schedule_row(household_id)
    assert row.last_run_status == "partial"
    assert "AI was skipped" in (row.last_run_detail or "")

    reconfirmed = put_schedule(client, include_ai=True, ai_consent=True, max_runs_per_day=4)
    assert reconfirmed.status_code == 200, reconfirmed.text
    assert reconfirmed.json()["ai_consent_valid"] is True
    assert reconfirmed.json()["state"] == "scheduled"

    # An explicit withdrawal is not silently ignored while AI stays enabled.
    withdrawn = put_schedule(client, include_ai=True, ai_consent=False, max_runs_per_day=4)
    assert withdrawn.status_code == 422
    assert withdrawn.json()["detail"]["code"] == "ai_consent_required"

    offline = put_schedule(client, include_ai=False)
    assert offline.status_code == 200, offline.text
    assert offline.json()["ai_consent"] is False
    assert offline.json()["ai_consent_valid"] is False


def test_scheduled_ai_uses_one_bounded_provider_request(owner_client, monkeypatch):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client)
    category = create_category(client, "Bounded")
    for index in range(45):
        create_item(client, f"Bounded item {index:02d}", room["id"])
    configure_assistant(client)
    saved = put_schedule(
        client,
        include_ai=True,
        ai_consent=True,
        max_items=500,
        max_runs_per_day=4,
    )
    assert saved.status_code == 200, saved.text
    calls = []

    def fake_complete_json(_system, prompt, *, config):
        calls.append((prompt, config.provider_id))
        return {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(category["id"])},
                    "tags": [],
                    "confidence": "high",
                    "reason": "Bounded fixture.",
                }
            ]
        }

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["ai_used"] is True
    assert len(calls) == 1
    with SessionLocal() as db:
        run = db.get(InventoryReviewRun, uuid.UUID(result["run_id"]))
        assert run is not None
        assert run.item_count_scanned == 45
        assert run.total_item_count == 45
        assert "first 40" in (run.partial_reason or "")
        assert run.ai_item_count == 40


def test_schedule_caps_rotation_and_cross_household_scope_are_enforced(owner_client):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client, "Cap room")
    for index in range(6):
        create_item(client, f"Cap item {index}", room["id"])

    too_many = put_schedule(client, max_items=501)
    assert too_many.status_code == 422
    too_frequent = put_schedule(client, max_runs_per_day=5)
    assert too_frequent.status_code == 422

    saved = put_schedule(
        client,
        scope_type="room",
        scope_id=room["id"],
        max_items=2,
        max_runs_per_day=1,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["scope_label"] == "Room: Cap room"

    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["status"] == "partial"
    assert result["scanned"] == 2
    assert result["total"] == 6
    with SessionLocal() as db:
        run = db.get(InventoryReviewRun, uuid.UUID(result["run_id"]))
        assert run is not None
        assert "Reviewed 2 of 6" in (run.partial_reason or "")

    # A second due dispatch on the same local day is skipped by the hard run cap.
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 0
    row = schedule_row(household_id)
    assert row.last_run_status == "skipped"
    assert "cap" in (row.last_run_detail or "").lower()
    assert row.next_due_at is not None and row.next_due_at > datetime.now(UTC)

    # Cross-household scope ids are rejected before a schedule can be saved.
    second = client.post(
        "/api/v1/households",
        json={"name": "Schedule other household", "property_name": "Other"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    second_room = client.post(
        "/api/v1/rooms", headers=second_headers, json={"name": "Other room"}
    ).json()
    selected = client.post(f"/api/v1/households/{household_id}/select")
    assert selected.status_code == 200, selected.text
    cross_scope = put_schedule(
        client,
        headers={"X-Household-Id": str(household_id)},
        scope_type="room",
        scope_id=second_room["id"],
    )
    assert cross_scope.status_code == 404

    # Rotation and changed-item priority keep older inventory in the scan.
    with SessionLocal() as db:
        payload = inventory_review.ReviewRunRequest(
            scope_type="room",
            scope_id=uuid.UUID(room["id"]),
            include_ai=False,
            request_id=uuid.uuid4(),
        )
        first = inventory_review._load_scope(db, household_id, payload, max_items=2, scan_offset=0)
        second_scope = inventory_review._load_scope(
            db, household_id, payload, max_items=2, scan_offset=2
        )
        assert {item.id for item in first.items}.isdisjoint(
            {item.id for item in second_scope.items}
        )
        changed_item = db.scalar(
            select(Item).where(Item.room_id == uuid.UUID(room["id"])).order_by(Item.name.desc())
        )
        assert changed_item is not None
        changed_item.updated_at = datetime.now(UTC) + timedelta(minutes=1)
        db.commit()
        prioritized = inventory_review._load_scope(
            db,
            household_id,
            payload,
            max_items=2,
            prioritize_since=datetime.now(UTC) - timedelta(minutes=1),
            scan_offset=2,
        )
        assert changed_item.id in {item.id for item in prioritized.items}


def test_disable_cancels_queued_work_and_an_inflight_claim_skips_honestly(owner_client):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client)
    create_item(client, "Disable drill", room["id"])
    saved = put_schedule(client, timezone="UTC")
    assert saved.status_code == 200, saved.text
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    queued = schedule_row(household_id)
    queued_job_id = queued.last_run_job_id
    assert queued_job_id is not None

    disabled = put_schedule(client, enabled=False, timezone="UTC")
    assert disabled.status_code == 200, disabled.text
    with SessionLocal() as db:
        job = db.get(Job, queued_job_id)
        assert job is not None
        assert job.status == JobStatus.CANCELLED.value
    assert claim_schedule_job() == (None, None)
    assert client.get("/api/v1/inventory-review/summary").json()["schedule"]["enabled"] is False

    # A job claimed just before the disable decision is honest: it performs no
    # review when it sees the schedule disabled.
    reenabled = put_schedule(client, timezone="UTC")
    assert reenabled.status_code == 200, reenabled.text
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    put_schedule(client, enabled=False, timezone="UTC")
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["skipped"] is True
    row = schedule_row(household_id)
    assert row.last_run_status == "skipped"
    assert "disabled" in (row.last_run_detail or "").lower()
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(InventoryReviewRun.id).where(
                    InventoryReviewRun.household_id == household_id,
                    InventoryReviewRun.trigger_type == "scheduled",
                )
            )
            is None
        )


def test_scope_failure_and_retry_state_are_actionable(owner_client):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client, "Soon deleted")
    saved = put_schedule(client, scope_type="room", scope_id=room["id"])
    assert saved.status_code == 200, saved.text
    deleted = client.delete(f"/api/v1/rooms/{room['id']}")
    assert deleted.status_code == 204, deleted.text

    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    failed = None
    try:
        run_schedule_job(payload)
    except Exception as exc:  # expected invalid scope
        failed = exc
    assert failed is not None
    row = schedule_row(household_id)
    assert row.last_run_status == "failed"
    assert "Room not found" in (row.last_run_detail or "")

    # Re-save a valid scope, then retry the same scheduled request successfully.
    fixed = put_schedule(client)
    assert fixed.status_code == 200, fixed.text
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["status"] in {"completed", "partial"}
    row = schedule_row(household_id)
    assert row.last_run_status in {"completed", "partial"}


def test_schedule_requires_the_approving_owner_to_still_be_an_owner(owner_client):
    client = owner_client
    household_id = current_household_id(client)
    owner_user_id = uuid.UUID(client.get("/api/v1/auth/session").json()["user"]["id"])
    room = create_room(client)
    create_item(client, "Role check drill", room["id"])
    saved = put_schedule(client)
    assert saved.status_code == 200, saved.text

    with SessionLocal() as db:
        membership = db.scalar(
            select(HouseholdMember).where(
                HouseholdMember.household_id == household_id,
                HouseholdMember.user_id == owner_user_id,
            )
        )
        assert membership is not None
        membership.role = "member"
        db.commit()

    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    result = run_schedule_job(payload)
    finish_job(job_id, result)
    assert result["skipped"] is True
    row = schedule_row(household_id)
    assert row.last_run_status == "failed"
    assert "no longer an owner" in (row.last_run_detail or "")
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(InventoryReviewRun.id).where(
                    InventoryReviewRun.household_id == household_id,
                    InventoryReviewRun.trigger_type == "scheduled",
                )
            )
            is None
        )


def test_timezone_and_dst_next_due_are_computed_in_local_time(owner_client):
    weekly = inventory_review_schedule.next_occurrence(
        frequency="weekly",
        timezone="America/New_York",
        weekday=0,
        monthly_day=1,
        local_hour=9,
        after=datetime(2026, 3, 2, 14, 0, tzinfo=UTC),
    )
    assert weekly == datetime(2026, 3, 9, 13, 0, tzinfo=UTC)
    monthly = inventory_review_schedule.next_occurrence(
        frequency="monthly",
        timezone="America/New_York",
        weekday=0,
        monthly_day=1,
        local_hour=9,
        after=datetime(2026, 3, 15, 12, 0, tzinfo=UTC),
    )
    assert monthly == datetime(2026, 4, 1, 13, 0, tzinfo=UTC)

    client = owner_client
    invalid = put_schedule(client, timezone="Mars/Olympus_Mons")
    assert invalid.status_code == 422
    valid = put_schedule(
        client,
        timezone="America/New_York",
        frequency="weekly",
        weekday=0,
        local_hour=9,
    )
    assert valid.status_code == 200, valid.text
    next_due = datetime.fromisoformat(valid.json()["next_due_at"].replace("Z", "+00:00"))
    assert next_due.tzinfo is not None
    assert next_due > datetime.now(UTC)
    local = next_due.astimezone(ZoneInfo("America/New_York"))
    assert local.hour == 9


def test_scheduled_dismissal_suppression_and_no_inventory_mutation(owner_client):
    client = owner_client
    household_id = current_household_id(client)
    room = create_room(client)
    create_item(client, "Suppressed camera", room["id"], brand="Sony", model="SUP-1")
    create_item(client, "suppressed camera", room["id"], brand="sony", model="sup-1")
    create_item(client, "Suppressed lamp", room["id"])
    create_item(client, "suppressed lamp", room["id"])
    with SessionLocal() as db:
        before = {
            item.id: item.updated_at
            for item in db.scalars(select(Item).where(Item.household_id == household_id)).all()
        }

    saved = put_schedule(client, timezone="UTC", max_runs_per_day=4)
    assert saved.status_code == 200, saved.text
    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    first = run_schedule_job(payload)
    finish_job(job_id, first)

    pending = client.get(
        "/api/v1/inventory-review/suggestions",
        params={"status": "pending", "limit": 100},
    ).json()["items"]
    duplicate = next(row for row in pending if row["type"] == "possible_duplicate")
    dismissed = client.post(f"/api/v1/inventory-review/suggestions/{duplicate['id']}/dismiss")
    assert dismissed.status_code == 200, dismissed.text

    set_due(household_id, datetime.now(UTC) - timedelta(minutes=1))
    assert dispatch() == 1
    job_id, payload = claim_schedule_job()
    assert job_id is not None
    second = run_schedule_job(payload)
    finish_job(job_id, second)
    with SessionLocal() as db:
        run = db.get(InventoryReviewRun, uuid.UUID(second["run_id"]))
        assert run is not None
        assert run.suppressed_suggestion_count >= 1
        after = {
            item.id: item.updated_at
            for item in db.scalars(select(Item).where(Item.household_id == household_id)).all()
        }
    assert after == before
    pending_after = client.get(
        "/api/v1/inventory-review/suggestions",
        params={"status": "pending", "limit": 100},
    ).json()["items"]
    assert duplicate["id"] not in {row["id"] for row in pending_after}
