import json
import uuid

from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    ActivityEvent,
    Category,
    HouseholdMember,
    InventoryReviewSuggestion,
    Tag,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import inventory_review
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


def run_review(
    client,
    *,
    scope_type="household",
    scope_id=None,
    item_ids=None,
    include_ai=False,
    request_id=None,
):
    return client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": scope_type,
            "scope_id": scope_id,
            "item_ids": item_ids,
            "include_ai": include_ai,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def suggestions(client, status="pending"):
    response = client.get(
        "/api/v1/inventory-review/suggestions",
        params={"status": status, "limit": 100},
    )
    assert response.status_code == 200, response.text
    return response.json()


def item_state(client, item_id):
    response = client.get(f"/api/v1/items/{item_id}")
    assert response.status_code == 200, response.text
    return response.json()["item"]


def add_member(client, role="member", email=None):
    state = client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"Review {role.title()}",
            email=email or f"review-{role}@example.com",
            password_hash=hash_password("review-member-password-2026"),
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
            user_agent="inventory-review-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def create_tag(client, name):
    response = client.post("/api/v1/tags", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def configure_review_assistant(client):
    provider = client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Organisation fixture AI",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-organisation-test",
            "api_key": "sk-organisation-fixture",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    task = client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider.json()["id"],
            "model": "gpt-organisation-test",
            "enabled": True,
        },
    )
    assert task.status_code == 200, task.text


def organisation_suggestions(client):
    return [entry for entry in suggestions(client)["items"] if entry["type"] == "organisation"]


def test_offline_review_persists_scoped_suggestions_without_mutating_items(owner_client):
    client = owner_client
    room = create_room(client)
    create_room(client, "Garage")
    create_room(client, "Attic")
    tools = create_category(client, "Tools")
    flashlight = create_category(client, "Lighting")

    drill = create_item(
        client,
        "Cordless drill",
        room["id"],
        category_id=tools["id"],
        brand="DeWalt",
        model="DCD791",
    )
    uncategorised_drill = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="DeWalt",
        model="DCD791",
    )
    create_item(
        client,
        "Camp lamp",
        room["id"],
        category_id=flashlight["id"],
    )
    casing = create_item(client, "camp lamp", room["id"])
    duplicate_a = create_item(
        client,
        "Camera charger",
        room["id"],
        brand="Sony",
        model="AC-UUD12",
    )
    duplicate_b = create_item(
        client,
        "camera charger",
        room["id"],
        brand="sony",
        model="ac-uud12",
    )
    create_item(
        client,
        "Old kettle",
        room["id"],
        description="Kept in the Attic according to the note.",
        purchase={"merchant": "Fixture store"},
    )
    before_updated = {
        entry["id"]: entry["updated_at"]
        for entry in [
            drill,
            uncategorised_drill,
            casing,
            duplicate_a,
            duplicate_b,
        ]
    }
    item_count = int((client.get("/api/v1/items?limit=1").json())["total"])

    response = run_review(client)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] in {"completed", "partial"}
    assert run["item_count_scanned"] >= 6
    assert run["created_suggestion_count"] > 0

    body = suggestions(client)
    types = {entry["type"] for entry in body["items"]}
    assert "category" in types
    assert "name" in types
    assert "possible_duplicate" in types
    assert "missing_detail" in types
    assert "location_conflict" in types
    assert body["pending_count"] == len(body["items"])
    category = next(
        entry
        for entry in body["items"]
        if entry["type"] == "category" and entry["item_id"] == uncategorised_drill["id"]
    )
    assert category["category_id"] == tools["id"]
    assert category["item"]["category"] is None
    name = next(
        entry
        for entry in body["items"]
        if entry["type"] == "name" and entry["item_id"] == casing["id"]
    )
    assert name["after"]["name"] == "Camp lamp"
    duplicate = next(
        entry
        for entry in body["items"]
        if entry["type"] == "possible_duplicate"
        and {entry["item_id"], entry["secondary_item_id"]} == {duplicate_a["id"], duplicate_b["id"]}
    )
    assert duplicate["action_kind"] == "advisory"
    location = next(entry for entry in body["items"] if entry["type"] == "location_conflict")
    assert "Attic" in location["evidence"]["mentioned_room"]
    missing = next(entry for entry in body["items"] if entry["type"] == "missing_detail")
    assert missing["action_kind"] == "advisory"

    # Analysis itself never changes inventory fields or timestamps.
    for item_id, updated_at in before_updated.items():
        assert item_state(client, item_id)["updated_at"] == updated_at
    assert int((client.get("/api/v1/items?limit=1").json())["total"]) == item_count

    # Re-running the same unchanged data does not flood the queue.
    second = run_review(client)
    assert second.status_code == 200, second.text
    second_body = suggestions(client)
    assert len(second_body["items"]) == len(body["items"])
    assert second.json()["created_suggestion_count"] == 0
    assert second.json()["existing_suggestion_count"] > 0

    # Dismissing one unchanged suggestion suppresses it on the next run.
    dismissed = client.post(f"/api/v1/inventory-review/suggestions/{duplicate['id']}/dismiss")
    assert dismissed.status_code == 200, dismissed.text
    third = run_review(client)
    assert third.status_code == 200, third.text
    pending_ids = {entry["id"] for entry in suggestions(client)["items"]}
    assert duplicate["id"] not in pending_ids
    assert third.json()["created_suggestion_count"] == 0


def test_category_and_name_apply_undo_stale_and_bulk(owner_client):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    already = create_item(client, "Bench plane", room["id"], category_id=category["id"])
    target = create_item(client, "Bench plane", room["id"])
    variant = create_item(client, "Bench Plane", room["id"], category_id=category["id"])

    response = run_review(client)
    assert response.status_code == 200, response.text
    body = suggestions(client)
    category_suggestion = next(
        entry
        for entry in body["items"]
        if entry["type"] == "category" and entry["item_id"] == target["id"]
    )
    accepted = client.post(
        f"/api/v1/inventory-review/suggestions/{category_suggestion['id']}/accept",
        json={},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "applied"
    assert accepted.json()["suggestion"]["can_undo"] is True
    assert item_state(client, target["id"])["category"]["id"] == category["id"]

    undone = client.post(f"/api/v1/inventory-review/suggestions/{category_suggestion['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    assert item_state(client, target["id"])["category"] is None
    assert undone.json()["suggestion"]["status"] == "reverted"

    # A changed item makes the pending suggestion stale and protects its edits.
    run_review(client)
    name_suggestion = next(
        entry
        for entry in suggestions(client)["items"]
        if entry["type"] == "name" and entry["item_id"] == variant["id"]
    )
    edited = client.patch(
        f"/api/v1/items/{variant['id']}", json={"description": "Changed after analysis"}
    )
    assert edited.status_code == 200, edited.text
    stale = client.post(
        f"/api/v1/inventory-review/suggestions/{name_suggestion['id']}/accept",
        json={},
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["status"] == "stale"
    assert item_state(client, variant["id"])["name"] == "Bench Plane"

    # Bulk accept applies only compatible pending actionable suggestions.
    run_review(client)
    pending = [
        entry
        for entry in suggestions(client)["items"]
        if entry["action_kind"] in {"apply_category", "apply_name"}
    ][:2]
    if pending:
        bulk = client.post(
            "/api/v1/inventory-review/suggestions/bulk-accept",
            json={"suggestion_ids": [entry["id"] for entry in pending]},
        )
        assert bulk.status_code == 200, bulk.text
        assert bulk.json()["applied_count"] + bulk.json()["stale_count"] >= 1
    assert already


def test_duplicates_are_advisory_and_loan_quantities_are_untouched(owner_client):
    client = owner_client
    room = create_room(client)
    first = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="Makita",
        model="XFD12",
        serial_number="SN-REVIEW-1",
        quantity=3,
    )
    second = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="Makita",
        model="XFD12",
        serial_number="SN-REVIEW-2",
        quantity=2,
    )
    loan = client.post(
        "/api/v1/loans",
        json={
            "item_id": first["id"],
            "borrower_name": "Fixture borrower",
            "quantity": 1,
            "lent_on": "2026-10-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert loan.status_code == 201, loan.text
    run_review(client)
    duplicate = next(
        entry for entry in suggestions(client)["items"] if entry["type"] == "possible_duplicate"
    )
    assert duplicate["action_kind"] == "advisory"
    accepted = client.post(
        f"/api/v1/inventory-review/suggestions/{duplicate['id']}/accept",
        json={},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "unsupported"
    assert item_state(client, first["id"])["quantity"] == 3
    assert item_state(client, second["id"])["quantity"] == 2
    loans = client.get(f"/api/v1/loans?item_id={first['id']}").json()
    assert loans["items"][0]["outstanding_quantity"] == 1


def test_review_permissions_cross_household_and_idempotency(owner_client):
    client = owner_client
    room = create_room(client, "Scope room")
    item = create_item(client, "Scope item", room["id"])

    viewer = add_member(client, "viewer", email="review-viewer@example.com")
    member = add_member(client, "member", email="review-member@example.com")
    assert client.get("/api/v1/inventory-review/suggestions", headers=viewer).status_code == 200
    denied = client.post(
        "/api/v1/inventory-review/runs",
        headers=viewer,
        json={
            "scope_type": "household",
            "include_ai": False,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert denied.status_code == 403
    allowed = client.post(
        "/api/v1/inventory-review/runs",
        headers=member,
        json={
            "scope_type": "household",
            "include_ai": False,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert allowed.status_code == 200, allowed.text
    owner_only_ai = client.post(
        "/api/v1/inventory-review/runs",
        headers=member,
        json={
            "scope_type": "household",
            "include_ai": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert owner_only_ai.status_code == 403
    assert owner_only_ai.json()["detail"]["code"] == "owner_required"

    first_household = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    request_id = str(uuid.uuid4())
    first = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "items",
            "item_ids": [item["id"]],
            "request_id": request_id,
        },
    )
    assert first.status_code == 200, first.text
    replay = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "items",
            "item_ids": [item["id"]],
            "request_id": request_id,
        },
    )
    assert replay.status_code == 200
    assert replay.json()["id"] == first.json()["id"]
    mismatch = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "household",
            "request_id": request_id,
        },
    )
    assert mismatch.status_code == 409

    second = client.post(
        "/api/v1/households",
        json={"name": "Review other household", "property_name": "Other"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    second_room = client.post(
        "/api/v1/rooms",
        headers=second_headers,
        json={"name": "Other room"},
    ).json()
    selected = client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200
    headers = {"X-Household-Id": str(first_household)}

    cross_room = client.post(
        "/api/v1/inventory-review/runs",
        headers=headers,
        json={
            "scope_type": "room",
            "scope_id": second_room["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_room.status_code == 404
    cross_items = client.post(
        "/api/v1/inventory-review/runs",
        headers=headers,
        json={
            "scope_type": "items",
            "item_ids": [str(uuid.uuid4())],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_items.status_code == 404


def test_ai_organisation_output_is_validated_and_offline_runs_never_call_ai(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Garden")
    create_item(client, "Pruning shears", room["id"], description="Garden hand tool")
    create_item(client, "Garden hose", room["id"])

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Offline review must not call AI.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)
    offline = run_review(client, include_ai=False)
    assert offline.status_code == 200, offline.text
    assert offline.json()["ai_used"] is False

    provider = client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Review fixture AI",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-test",
            "api_key": "sk-review-fixture",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    task = client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider.json()["id"],
            "model": "gpt-test",
            "enabled": True,
        },
    )
    assert task.status_code == 200, task.text

    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(category["id"])},
                    "tags": [],
                    "confidence": "high",
                    "reason": "Explicit garden tool description.",
                }
            ]
        },
    )
    valid = run_review(client, include_ai=True)
    assert valid.status_code == 200, valid.text
    assert valid.json()["ai_used"] is True
    assert valid.json()["ai_error"] is None
    ai_suggestions = [entry for entry in suggestions(client)["items"] if entry["source"] == "ai"]
    assert ai_suggestions
    assert ai_suggestions[0]["type"] == "organisation"
    assert ai_suggestions[0]["category_id"] == category["id"]
    assert valid.json()["ai_item_count"] == 2

    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": "not-a-category"},
                    "tags": [],
                    "confidence": "high",
                    "reason": "bad",
                }
            ]
        },
    )
    invalid = run_review(client, include_ai=True)
    assert invalid.status_code == 200, invalid.text
    assert invalid.json()["status"] == "partial"
    assert invalid.json()["ai_error"]
    assert invalid.json()["status"] != "failed"


def test_scope_items_and_viewer_reads_are_household_scoped(owner_client):
    client = owner_client
    room = create_room(client)
    item = create_item(client, "Scoped item", room["id"])
    response = client.get(
        "/api/v1/inventory-review/scope-items",
        params=[("item_ids", item["id"])],
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["id"] == item["id"]

    viewer = add_member(client, "viewer", email="review-scope-viewer@example.com")
    assert (
        client.get(
            "/api/v1/inventory-review/scope-items",
            params=[("item_ids", item["id"])],
            headers=viewer,
        ).status_code
        == 200
    )
    assert (
        client.get(
            "/api/v1/inventory-review/scope-items",
            params=[("item_ids", str(uuid.uuid4()))],
        ).status_code
        == 404
    )


def test_room_container_property_and_item_scopes_stay_inside_scope(owner_client):
    client = owner_client
    room_a = create_room(client, "Scope A")
    room_b = create_room(client, "Scope B")
    category = create_category(client, "Scoped category")
    container = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_a["id"], "name": "Scope box", "kind": "box"},
    )
    assert container.status_code == 201, container.text
    container_id = container.json()["id"]

    container_category = create_item(
        client,
        "Container tool",
        room_a["id"],
        category_id=category["id"],
        storage_location_id=container_id,
    )
    container_uncategorised = create_item(
        client,
        "Container tool",
        room_a["id"],
        storage_location_id=container_id,
    )
    create_item(
        client,
        "Room tool",
        room_a["id"],
        category_id=category["id"],
    )
    room_uncategorised = create_item(client, "Room tool", room_a["id"])
    other_category = create_item(
        client,
        "Other room tool",
        room_b["id"],
        category_id=category["id"],
    )
    other_uncategorised = create_item(client, "Other room tool", room_b["id"])
    selected_category = create_item(
        client,
        "Selected tool",
        room_b["id"],
        category_id=category["id"],
    )
    selected_uncategorised = create_item(client, "Selected tool", room_b["id"])

    def run_and_ids(**kwargs):
        response = run_review(client, **kwargs)
        assert response.status_code == 200, response.text
        with SessionLocal() as db:
            rows = db.scalars(
                select(InventoryReviewSuggestion).where(
                    InventoryReviewSuggestion.run_id == uuid.UUID(response.json()["id"])
                )
            ).all()
            return {row.item_id for row in rows if row.item_id is not None}

    container_ids = run_and_ids(scope_type="container", scope_id=container_id)
    assert container_ids == {uuid.UUID(container_uncategorised["id"])}
    assert uuid.UUID(container_category["id"]) not in container_ids

    room_ids = run_and_ids(scope_type="room", scope_id=room_a["id"])
    assert room_ids == {uuid.UUID(room_uncategorised["id"])}
    assert uuid.UUID(other_uncategorised["id"]) not in room_ids

    selected_ids = run_and_ids(
        scope_type="items",
        item_ids=[selected_category["id"], selected_uncategorised["id"]],
    )
    assert selected_ids == {uuid.UUID(selected_uncategorised["id"])}

    property_ids = run_and_ids(scope_type="property", scope_id=room_a["property_id"])
    assert uuid.UUID(other_uncategorised["id"]) in property_ids
    assert uuid.UUID(other_category["id"]) not in property_ids


def test_ai_camping_organisation_creates_taxonomy_on_accept_and_undo_restores_exactly(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client, "Private gear locker")
    cooking = create_category(client, "Cooking")
    outdoors = create_tag(client, "outdoors")
    stove = create_item(
        client,
        "Camp stove",
        room["id"],
        category_id=cooking["id"],
        description="Compact stove for weekend camping and outdoor cooking.",
        serial_number="PRIVATE-SERIAL-NOT-FOR-AI",
    )
    organised = create_item(
        client,
        "Already organised lantern",
        room["id"],
        category_id=cooking["id"],
        tag_ids=[outdoors["id"]],
    )
    configure_review_assistant(client)
    prompts = []

    def fake_complete_json(_system, prompt, *, config):
        prompts.append(prompt)
        return {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"name": "Camping equipment"},
                    "tags": [
                        {"id": outdoors["id"]},
                        {"name": "camping"},
                        {"name": "cooking"},
                    ],
                    "confidence": "high",
                    "reason": "The description explicitly supports camping and outdoor cooking.",
                }
            ]
        }

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    before = item_state(client, stove["id"])
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert run["ai_used"] is True
    assert run["ai_item_count"] == 1
    assert len(prompts) == 1
    assert "Camp stove" in prompts[0]
    assert "Already organised lantern" not in prompts[0]
    assert "Private gear locker" not in prompts[0]
    assert "PRIVATE-SERIAL-NOT-FOR-AI" not in prompts[0]
    assert "current_tags" in prompts[0]
    assert item_state(client, stove["id"])["updated_at"] == before["updated_at"]
    assert item_state(client, organised["id"])["tags"][0]["name"] == "outdoors"

    entries = organisation_suggestions(client)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["action_kind"] == "apply_organisation"
    assert entry["before"]["category_id"] == cooking["id"]
    assert entry["before"]["tag_ids"] == []
    assert entry["after"]["category_name"] == "Camping equipment"
    assert entry["after"]["category_is_new"] is True
    assert {tag["name"] for tag in entry["after"]["tags"]} == {
        "outdoors",
        "camping",
        "cooking",
    }
    with SessionLocal() as db:
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is None
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is None

    accepted = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "applied"
    assert accepted.json()["suggestion"]["can_undo"] is True
    applied = item_state(client, stove["id"])
    assert applied["category"]["name"] == "Camping equipment"
    assert {tag["name"] for tag in applied["tags"]} == {"outdoors", "camping", "cooking"}
    with SessionLocal() as db:
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is not None
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is not None
        event = db.scalar(
            select(ActivityEvent).where(
                ActivityEvent.item_id == uuid.UUID(stove["id"]),
                ActivityEvent.action == "inventory_review.organisation_applied",
            )
        )
        assert event is not None

    undone = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    restored = item_state(client, stove["id"])
    assert restored["category"]["id"] == cooking["id"]
    assert restored["tags"] == []
    with SessionLocal() as db:
        # Undo restores item links, not approved taxonomy vocabulary records.
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is not None


def test_organisation_bulk_accept_and_duplicate_ai_indexes(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    outdoors = create_tag(client, "outdoors")
    family = create_tag(client, "family")
    tent = create_item(client, "Family tent", room["id"], tag_ids=[family["id"]])
    kettle = create_item(client, "Camp kettle", room["id"])
    configure_review_assistant(client)

    def fake_complete_json(_system, prompt, *, config):
        prompt_items = json.loads(
            next(
                line.removeprefix("Items: ")
                for line in prompt.splitlines()
                if line.startswith("Items: ")
            )
        )
        entries = []
        for prompt_item in prompt_items:
            entries.append(
                {
                    "index": prompt_item["index"],
                    "tags": [{"id": outdoors["id"]}, {"name": "camping"}],
                    "confidence": "high",
                    "reason": "Camping activity is explicit in the item name.",
                }
            )
        # A repeated index is ignored rather than creating a second suggestion.
        entries.append(dict(entries[0], category={"name": "Ignored duplicate"}))
        return {"suggestions": entries}

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    assert response.json()["ai_item_count"] == 2
    entries = organisation_suggestions(client)
    assert len(entries) == 2
    assert all(entry["after"]["category_name"] is None for entry in entries)
    bulk = client.post(
        "/api/v1/inventory-review/suggestions/bulk-accept",
        json={"suggestion_ids": [entry["id"] for entry in entries]},
    )
    assert bulk.status_code == 200, bulk.text
    assert bulk.json()["applied_count"] == 2
    assert {tag["name"] for tag in item_state(client, tent["id"])["tags"]} == {
        "family",
        "outdoors",
        "camping",
    }
    assert {tag["name"] for tag in item_state(client, kettle["id"])["tags"]} == {
        "outdoors",
        "camping",
    }
    tent_entry = next(entry for entry in entries if entry["item_id"] == tent["id"])
    undone = client.post(f"/api/v1/inventory-review/suggestions/{tent_entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    assert {tag["name"] for tag in item_state(client, tent["id"])["tags"]} == {"family"}


def test_ai_organisation_skips_when_no_eligible_items(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Workshop hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Workshop hammer", room["id"])
    create_item(
        client,
        "Organised screwdriver",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    configure_review_assistant(client)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("AI must not run without eligible organisation items.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert run["ai_used"] is False
    assert run["ai_item_count"] == 0
    assert run["ai_error"] is None
    offline = [
        entry
        for entry in suggestions(client)["items"]
        if entry["type"] == "category" and entry["item_id"] == target["id"]
    ]
    assert len(offline) == 1
    assert organisation_suggestions(client) == []


def test_ai_organisation_validation_rejects_bad_taxonomy_and_keeps_offline(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Validation hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Validation hammer", room["id"])
    create_item(client, "Validation camp chair", room["id"], category_id=category["id"])
    configure_review_assistant(client)
    invalid_outputs = [
        {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(uuid.uuid4())},
                    "confidence": "high",
                    "reason": "Unknown category id.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"id": str(uuid.uuid4())}],
                    "confidence": "high",
                    "reason": "Unknown tag id.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": str(index)} for index in range(4)],
                    "confidence": "high",
                    "reason": "Too many tags.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"name": "x" * 81},
                    "confidence": "high",
                    "reason": "Category name is too long.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "camping", "invented": "specification"}],
                    "confidence": "high",
                    "reason": "Extra fields are forbidden.",
                }
            ]
        },
    ]
    for output in invalid_outputs:
        monkeypatch.setattr(
            inventory_review.ai, "complete_json", lambda *_args, _output=output, **_kwargs: _output
        )
        response = run_review(client, include_ai=True)
        assert response.status_code == 200, response.text
        run = response.json()
        assert run["status"] == "partial"
        assert run["ai_used"] is True
        assert run["ai_item_count"] == 1
        assert run["ai_error"]
        assert organisation_suggestions(client) == []
        offline = [
            entry
            for entry in suggestions(client)["items"]
            if entry["type"] == "category" and entry["item_id"] == target["id"]
        ]
        assert len(offline) == 1


def test_ai_provider_failure_is_honest_and_preserves_offline_suggestions(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Provider hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Provider hammer", room["id"])
    create_item(client, "Provider camp chair", room["id"], category_id=category["id"])
    configure_review_assistant(client)

    def provider_failure(*_args, **_kwargs):
        raise inventory_review.ai.AiError("provider unavailable for fixture")

    monkeypatch.setattr(inventory_review.ai, "complete_json", provider_failure)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "partial"
    assert run["ai_used"] is True
    assert run["ai_item_count"] == 1
    assert run["ai_provider_label"] == "Organisation fixture AI"
    assert run["ai_model"] == "gpt-organisation-test"
    assert "provider unavailable for fixture" in run["ai_error"]
    assert organisation_suggestions(client) == []
    assert any(
        entry["type"] == "category" and entry["item_id"] == target["id"]
        for entry in suggestions(client)["items"]
    )


def test_organisation_undo_detects_tag_changes_even_without_item_timestamp_change(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    camping = create_tag(client, "camping")
    extra = create_tag(client, "weekend")
    item = create_item(client, "Camping wash kit", room["id"])
    configure_review_assistant(client)
    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"id": camping["id"]}],
                    "confidence": "high",
                    "reason": "The item name explicitly describes camping use.",
                }
            ]
        },
    )
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    entry = organisation_suggestions(client)[0]
    accepted = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    applied_updated_at = item_state(client, item["id"])["updated_at"]
    changed = client.post(
        "/api/v1/items/bulk/tags",
        json={
            "item_ids": [item["id"]],
            "tag_ids": [extra["id"]],
            "mode": "add",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert changed.status_code == 200, changed.text
    # The association-only bulk operation need not touch items.updated_at; the exact
    # tag snapshot still prevents an unsafe undo.
    assert item_state(client, item["id"])["updated_at"] == applied_updated_at
    undone = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "skipped"
    assert "tags changed" in undone.json()["message"]
    assert {tag["name"] for tag in item_state(client, item["id"])["tags"]} == {
        "camping",
        "weekend",
    }


def test_organisation_accept_enforces_permissions_and_household_taxonomy(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Household")
    proposed_category = create_category(client, "Cooking equipment")
    tag = create_tag(client, "cooking")
    item = create_item(client, "organisation safety stove", room["id"], category_id=category["id"])
    configure_review_assistant(client)
    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": proposed_category["id"]},
                    "tags": [{"id": tag["id"]}],
                    "confidence": "high",
                    "reason": "The item name supports cooking organisation.",
                }
            ]
        },
    )
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    entry = organisation_suggestions(client)[0]
    viewer = add_member(client, "viewer", email="organisation-viewer@example.com")
    denied = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=viewer,
        json={},
    )
    assert denied.status_code == 403

    first_household = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    second = client.post(
        "/api/v1/households",
        json={"name": "Organisation other household", "property_name": "Other"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    other_category = client.post(
        "/api/v1/categories", headers=second_headers, json={"name": "Other category"}
    ).json()
    other_tag = client.post(
        "/api/v1/tags", headers=second_headers, json={"name": "other-tag"}
    ).json()
    selected = client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200

    with SessionLocal() as db:
        row = db.get(InventoryReviewSuggestion, uuid.UUID(entry["id"]))
        assert row is not None
        after = dict(row.after_json)
        after["category_id"] = other_category["id"]
        after["tags"] = [{**after["tags"][0], "id": other_tag["id"]}]
        row.after_json = after
        db.commit()
    first_headers = {"X-Household-Id": str(first_household)}
    cross_category = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=first_headers,
        json={},
    )
    assert cross_category.status_code == 200, cross_category.text
    assert cross_category.json()["status"] == "unsupported"
    assert "category" in cross_category.json()["message"]

    with SessionLocal() as db:
        row = db.get(InventoryReviewSuggestion, uuid.UUID(entry["id"]))
        assert row is not None
        after = dict(row.after_json)
        after["category_id"] = proposed_category["id"]
        row.after_json = after
        db.commit()
    cross_tag = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=first_headers,
        json={},
    )
    assert cross_tag.status_code == 200, cross_tag.text
    assert cross_tag.json()["status"] == "unsupported"
    assert "tag" in cross_tag.json()["message"]
    item_response = client.get(f"/api/v1/items/{item['id']}", headers=first_headers)
    assert item_response.status_code == 200, item_response.text
    state = item_response.json()["item"]
    assert state["category"]["id"] == category["id"]
    assert state["tags"] == []
