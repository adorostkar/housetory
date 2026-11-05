import uuid

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import HouseholdMember, User
from housetory_api.security import hash_password
from housetory_api.services.auth import create_session


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name, parent_id=None):
    payload = {
        "room_id": room_id,
        "container_type": "box",
        "name": name,
    }
    if parent_id is not None:
        payload["parent_id"] = parent_id
    response = client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, location_id=None, quantity=1):
    payload = {"name": name, "room_id": room_id, "quantity": quantity}
    if location_id is not None:
        payload["storage_location_id"] = location_id
    response = client.post("/api/v1/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(client, item_id, quantity=1, **overrides):
    payload = {
        "item_id": item_id,
        "borrower_name": "Sam",
        "quantity": quantity,
        "lent_on": "2026-01-01",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    response = client.post("/api/v1/loans", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def start(client, room_ids=None, container_ids=None, *, request_id=None, include_descendants=True):
    response = client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": room_ids or [],
            "container_ids": container_ids or [],
            "include_descendants": include_descendants,
            "request_id": str(request_id or uuid.uuid4()),
        },
    )
    return response


def detail(client, session_id):
    response = client.get(f"/api/v1/stocktake/sessions/{session_id}")
    assert response.status_code == 200, response.text
    return response.json()


def item_row(client, session_id, item_id):
    session = detail(client, session_id)
    return next(row for row in session["items"] if row["item_id"] == item_id)


def observe(client, session_id, row, status, **extra):
    payload = {
        "request_id": str(uuid.uuid4()),
        "status": status,
        "snapshot_item_id": row["snapshot_item_id"],
        "expected_item_updated_at": row["current"]["updated_at"],
        "expected_on_loan_quantity": row["current"]["on_loan_quantity"],
        **extra,
    }
    return client.post(f"/api/v1/stocktake/sessions/{session_id}/observations", json=payload)


def review(client, session_id):
    response = client.get(f"/api/v1/stocktake/sessions/{session_id}/review")
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, session_id, review_data, *, request_id=None):
    return client.post(
        f"/api/v1/stocktake/sessions/{session_id}/apply",
        json={
            "request_id": str(request_id or uuid.uuid4()),
            "review_fingerprint": review_data["fingerprint"],
        },
    )


def complete(client, session_id, *, acknowledge_partial=True, request_id=None):
    return client.post(
        f"/api/v1/stocktake/sessions/{session_id}/complete",
        json={
            "request_id": str(request_id or uuid.uuid4()),
            "acknowledge_partial": acknowledge_partial,
        },
    )


def member_headers(owner_client, *, email: str, role: str = "viewer"):
    household_id = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password("member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household_id, user_id=user.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="stocktake-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def test_scope_snapshot_dedupes_hierarchy_and_excludes_loaned_units(owner_client):
    parent_room = create_room(owner_client, "Parent room")
    child_room = create_room(owner_client, "Child room")
    owner_client.patch(f"/api/v1/rooms/{child_room['id']}", json={"parent_id": parent_room["id"]})
    parent_box = create_container(owner_client, parent_room["id"], "Parent box")
    child_box = create_container(owner_client, child_room["id"], "Child box", parent_id=None)
    parent_item = create_item(owner_client, "Loose lantern", parent_room["id"], quantity=2)
    child_item = create_item(owner_client, "Tent", child_room["id"], child_box["id"], quantity=3)
    create_loan(owner_client, child_item["id"], quantity=1)

    request_id = uuid.uuid4()
    response = start(
        owner_client,
        room_ids=[parent_room["id"]],
        container_ids=[parent_box["id"]],
        request_id=request_id,
    )
    assert response.status_code == 201, response.text
    session = response.json()
    assert session["scope_label"].startswith("Room: Home / Parent room")
    assert "Container: Home / BOX-" in session["scope_label"]
    assert session["expected_item_count"] == 2
    assert session["expected_unit_count"] == 5
    assert session["expected_at_home_unit_count"] == 4
    assert session["expected_on_loan_unit_count"] == 1
    data = detail(owner_client, session["id"])
    assert {row["item_id"] for row in data["items"]} == {
        parent_item["id"],
        child_item["id"],
    }
    tent = next(row for row in data["items"] if row["item_id"] == child_item["id"])
    assert tent["expected_quantity"] == 3
    assert tent["expected_at_home_quantity"] == 2
    assert tent["expected_on_loan_quantity"] == 1
    assert tent["current"]["quantity"] == 3
    assert tent["current"]["on_loan_quantity"] == 1

    replay = start(
        owner_client,
        room_ids=[parent_room["id"]],
        container_ids=[parent_box["id"]],
        request_id=request_id,
    )
    assert replay.status_code == 201
    assert replay.json()["id"] == session["id"]
    conflict = start(
        owner_client,
        room_ids=[parent_room["id"]],
        request_id=request_id,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "stocktake_request_conflict"

    container_only = start(owner_client, container_ids=[child_box["id"]])
    assert container_only.status_code == 201
    container_detail = detail(owner_client, container_only.json()["id"])
    assert [row["item_id"] for row in container_detail["items"]] == [child_item["id"]]


def test_observations_are_evidence_and_quantity_corrections_respect_loans(owner_client):
    room = create_room(owner_client, "Store room")
    box = create_container(owner_client, room["id"], "Gear box")
    drill = create_item(owner_client, "Drill", room["id"], box["id"], quantity=3)
    create_loan(owner_client, drill["id"], quantity=1)
    tent = create_item(owner_client, "Tent", room["id"], box["id"], quantity=1)
    rope = create_item(owner_client, "Rope", room["id"], box["id"], quantity=4)

    session = start(owner_client, room_ids=[room["id"]]).json()
    drill_row = item_row(owner_client, session["id"], drill["id"])
    wrong_present = observe(owner_client, session["id"], drill_row, "present", counted_quantity=3)
    assert wrong_present.status_code == 422
    assert wrong_present.json()["detail"]["code"] == "quantity_mismatch"

    present = observe(owner_client, session["id"], drill_row, "present", counted_quantity=2)
    assert present.status_code == 201, present.text
    assert owner_client.get(f"/api/v1/items/{drill['id']}").json()["item"]["quantity"] == 3
    assert present.json()["counted_quantity"] == 2
    assert present.json()["on_loan_quantity_at_observation"] == 1

    tent_row = item_row(owner_client, session["id"], tent["id"])
    missing = observe(owner_client, session["id"], tent_row, "missing")
    assert missing.status_code == 201, missing.text
    assert missing.json()["counted_quantity"] == 0
    assert owner_client.get(f"/api/v1/items/{tent['id']}").json()["item"]["is_archived"] is False

    rope_row = item_row(owner_client, session["id"], rope["id"])
    discrepancy = observe(
        owner_client, session["id"], rope_row, "quantity_discrepancy", counted_quantity=2
    )
    assert discrepancy.status_code == 201, discrepancy.text

    reviewed = review(owner_client, session["id"])
    assert reviewed["actionable_count"] == 1
    assert reviewed["proposals"][0]["action"] == "set_quantity"
    assert reviewed["proposals"][0]["current_quantity"] == 4
    assert reviewed["proposals"][0]["proposed_quantity"] == 2
    assert reviewed["proposals"][0]["on_loan_quantity"] == 0
    assert "Reduces recorded owned quantity" in reviewed["proposals"][0]["warnings"][0]

    applied = apply(owner_client, session["id"], reviewed)
    assert applied.status_code == 200, applied.text
    assert applied.json()["applied_count"] == 1
    assert owner_client.get(f"/api/v1/items/{rope['id']}").json()["item"]["quantity"] == 2
    assert owner_client.get(f"/api/v1/items/{drill['id']}").json()["item"]["quantity"] == 3
    history = owner_client.get(f"/api/v1/items/{rope['id']}/history").json()
    assert any(event["action"] == "stocktake.quantity_corrected" for event in history["items"])

    # The applied observation is not proposed again, and reusing its request id is safe.
    fresh_review = review(owner_client, session["id"])
    assert fresh_review["proposals"] == []
    still_there = apply(owner_client, session["id"], fresh_review)
    assert still_there.status_code == 422
    assert still_there.json()["detail"]["code"] == "stocktake_no_corrections"

    completed = complete(owner_client, session["id"], acknowledge_partial=True)
    assert completed.status_code == 200, completed.text
    history = owner_client.get("/api/v1/stocktake/sessions").json()
    listed = next(entry for entry in history["items"] if entry["id"] == session["id"])
    assert listed["status"] == "completed"
    assert listed["coverage"]["checked_items"] == 3
    coverage = completed.json()["coverage"]
    assert coverage["partial"] is False
    assert coverage["checked_items"] == 3
    assert coverage["missing_items"] == 1
    assert coverage["quantity_discrepancy_items"] == 1
    drill_after = owner_client.get(f"/api/v1/items/{drill['id']}").json()["item"]
    assert drill_after["last_verified"]["status"] == "present"
    assert drill_after["last_verified"]["quantity"] == 2
    assert drill_after["last_verified"]["on_loan_quantity"] == 1
    assert drill_after["last_verified"]["stale"] is False
    tent_after = owner_client.get(f"/api/v1/items/{tent['id']}").json()["item"]
    assert tent_after["last_verified"]["status"] == "missing"
    assert tent_after["last_verified"]["quantity"] == 0

    owner_client.patch(f"/api/v1/items/{drill['id']}", json={"name": "Drill renamed"})
    stale = owner_client.get(f"/api/v1/items/{drill['id']}").json()["item"]
    assert stale["last_verified"]["stale"] is True
    assert "changed" in stale["last_verified"]["stale_reason"].lower()


def test_moved_observation_requires_existing_places_and_applies_after_review(owner_client):
    room_a = create_room(owner_client, "Room A")
    room_b = create_room(owner_client, "Room B")
    box_a = create_container(owner_client, room_a["id"], "Box A")
    box_b = create_container(owner_client, room_b["id"], "Box B")
    item = create_item(owner_client, "Heater", room_a["id"], box_a["id"], quantity=1)

    session = start(owner_client, room_ids=[room_a["id"]]).json()
    row = item_row(owner_client, session["id"], item["id"])
    invalid_room = observe(
        owner_client,
        session["id"],
        row,
        "moved",
        counted_quantity=1,
        room_id=str(uuid.uuid4()),
    )
    assert invalid_room.status_code == 422
    mismatch = observe(
        owner_client,
        session["id"],
        row,
        "moved",
        counted_quantity=1,
        room_id=room_b["id"],
        container_id=box_a["id"],
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "container_room_mismatch"

    moved = observe(
        owner_client,
        session["id"],
        row,
        "moved",
        counted_quantity=1,
        room_id=room_b["id"],
        container_id=box_b["id"],
        notes="Found in the winter box.",
    )
    assert moved.status_code == 201, moved.text
    unchanged = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert unchanged["room"]["id"] == room_a["id"]
    assert unchanged["location"]["id"] == box_a["id"]

    reviewed = review(owner_client, session["id"])
    assert reviewed["actionable_count"] == 1
    proposal = reviewed["proposals"][0]
    assert proposal["action"] == "move"
    assert proposal["current_room_id"] == room_a["id"]
    assert proposal["proposed_room_id"] == room_b["id"]
    assert proposal["proposed_location_id"] == box_b["id"]
    assert "Recorded location will change" in proposal["warnings"][-1]

    applied = apply(owner_client, session["id"], reviewed)
    assert applied.status_code == 200, applied.text
    after = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert after["room"]["id"] == room_b["id"]
    assert after["location"]["id"] == box_b["id"]
    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    move_event = next(event for event in history["items"] if event["action"] == "item.moved")
    assert move_event["can_undo"] is True
    assert move_event["details"]["batch"]["stocktake_session_id"] == session["id"]

    completed = complete(owner_client, session["id"], acknowledge_partial=False)
    assert completed.status_code == 200, completed.text
    assert completed.json()["coverage"]["partial"] is False
    verified = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["last_verified"]
    assert verified["status"] == "moved"
    assert verified["location_id"] == box_b["id"]

    owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"room_id": room_a["id"], "storage_location_id": box_a["id"]},
    )
    stale_location = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["last_verified"]
    assert stale_location["stale"] is True
    assert "Location changed" in stale_location["stale_reason"]


def test_unexpected_findings_link_without_creating_or_duplicating_items(owner_client):
    room = create_room(owner_client, "Utility room")
    box = create_container(owner_client, room["id"], "Utility box")
    existing = create_item(owner_client, "Torch", room["id"], box["id"])
    before = owner_client.get("/api/v1/items?include_archived=true").json()["total"]
    session = start(owner_client, room_ids=[room["id"]]).json()
    linked = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/observations",
        json={
            "request_id": str(uuid.uuid4()),
            "status": "unexpected",
            "unexpected_name": "Old charger",
            "counted_quantity": 1,
            "linked_item_id": existing["id"],
            "room_id": room["id"],
            "container_id": box["id"],
            "notes": "Probably belongs to the torch.",
        },
    )
    assert linked.status_code == 201, linked.text
    assert linked.json()["linked_item_id"] == existing["id"]
    unlinked = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/observations",
        json={
            "request_id": str(uuid.uuid4()),
            "status": "unexpected",
            "unexpected_name": "Unrecorded cable",
            "counted_quantity": 2,
            "room_id": room["id"],
            "container_id": box["id"],
        },
    )
    assert unlinked.status_code == 201, unlinked.text
    after = owner_client.get("/api/v1/items?include_archived=true").json()["total"]
    assert after == before
    data = detail(owner_client, session["id"])
    assert len(data["unexpected_findings"]) == 2
    assert {entry["unexpected_name"] for entry in data["unexpected_findings"]} == {
        "Old charger",
        "Unrecorded cable",
    }
    assert "borrower" not in str(data["unexpected_findings"]).lower()


def test_conflicts_idempotency_refresh_and_partial_completion(owner_client):
    room = create_room(owner_client, "Conflict room")
    box = create_container(owner_client, room["id"], "Conflict box")
    item = create_item(owner_client, "Radio", room["id"], box["id"], quantity=2)
    session = start(owner_client, room_ids=[room["id"]]).json()
    row = item_row(owner_client, session["id"], item["id"])

    request_id = str(uuid.uuid4())
    first = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/observations",
        json={
            "request_id": request_id,
            "status": "present",
            "snapshot_item_id": row["snapshot_item_id"],
            "counted_quantity": 2,
            "expected_item_updated_at": row["current"]["updated_at"],
            "expected_on_loan_quantity": 0,
        },
    )
    assert first.status_code == 201, first.text
    replay = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/observations",
        json={
            "request_id": request_id,
            "status": "present",
            "snapshot_item_id": row["snapshot_item_id"],
            "counted_quantity": 2,
            "expected_item_updated_at": row["current"]["updated_at"],
            "expected_on_loan_quantity": 0,
        },
    )
    assert replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]
    mismatched = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/observations",
        json={
            "request_id": request_id,
            "status": "missing",
            "snapshot_item_id": row["snapshot_item_id"],
            "expected_item_updated_at": row["current"]["updated_at"],
            "expected_on_loan_quantity": 0,
        },
    )
    assert mismatched.status_code == 409
    assert mismatched.json()["detail"]["code"] == "observation_request_conflict"

    # A new item appears before completion; explicit refresh extends the snapshot once.
    added = create_item(owner_client, "Added later", room["id"], quantity=1)
    stale_row = item_row(owner_client, session["id"], item["id"])
    stale = observe(owner_client, session["id"], stale_row, "present", counted_quantity=2)
    assert stale.status_code == 201
    refreshed = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/refresh",
        json={"request_id": str(uuid.uuid4())},
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["expected_item_count"] == 2
    assert any(entry["item_id"] == added["id"] for entry in refreshed.json()["items"])
    refreshed_again = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/refresh",
        json={"request_id": str(uuid.uuid4())},
    )
    assert refreshed_again.status_code == 200
    assert refreshed_again.json()["expected_item_count"] == 2

    old_row = item_row(owner_client, session["id"], item["id"])
    owner_client.patch(f"/api/v1/items/{item['id']}", json={"name": "Radio edited"})
    changed_observation = observe(
        owner_client, session["id"], old_row, "present", counted_quantity=2
    )
    assert changed_observation.status_code == 409
    assert changed_observation.json()["detail"]["code"] == "item_changed"

    # Current values can be used after a reload, and stale review tokens are rejected.
    changed_row = item_row(owner_client, session["id"], item["id"])
    current_ok = observe(owner_client, session["id"], changed_row, "present", counted_quantity=2)
    assert current_ok.status_code == 201, current_ok.text

    completion_request = str(uuid.uuid4())
    partial = complete(
        owner_client, session["id"], acknowledge_partial=False, request_id=completion_request
    )
    assert partial.status_code == 409
    assert partial.json()["detail"]["code"] == "stocktake_partial_completion"
    completed = complete(
        owner_client, session["id"], acknowledge_partial=True, request_id=completion_request
    )
    assert completed.status_code == 200
    replay_completion = complete(
        owner_client, session["id"], acknowledge_partial=True, request_id=completion_request
    )
    assert replay_completion.status_code == 200
    assert replay_completion.json()["id"] == completed.json()["id"]
    different = complete(owner_client, session["id"], acknowledge_partial=True)
    assert different.status_code == 409
    closed_observation = observe(
        owner_client, session["id"], changed_row, "present", counted_quantity=2
    )
    assert closed_observation.status_code == 409


def test_abandon_preserves_observations_without_last_verified_claim(owner_client):
    room = create_room(owner_client, "Abandoned room")
    item = create_item(owner_client, "Ladder", room["id"], quantity=1)
    session = start(owner_client, room_ids=[room["id"]]).json()
    row = item_row(owner_client, session["id"], item["id"])
    observed = observe(owner_client, session["id"], row, "present", counted_quantity=1)
    assert observed.status_code == 201
    abandon_request = str(uuid.uuid4())
    abandoned = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/abandon",
        json={"request_id": abandon_request},
    )
    assert abandoned.status_code == 200
    assert abandoned.json()["status"] == "abandoned"
    replay = owner_client.post(
        f"/api/v1/stocktake/sessions/{session['id']}/abandon",
        json={"request_id": abandon_request},
    )
    assert replay.status_code == 200
    assert replay.json()["id"] == abandoned.json()["id"]
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["last_verified"] is None
    data = detail(owner_client, session["id"])
    assert data["items"][0]["latest_observation"]["status"] == "present"
    history = owner_client.get("/api/v1/stocktake/sessions").json()
    listed = next(entry for entry in history["items"] if entry["id"] == session["id"])
    assert listed["status"] == "abandoned"
    finish = complete(owner_client, session["id"], acknowledge_partial=True)
    assert finish.status_code == 409
    assert finish.json()["detail"]["code"] == "stocktake_closed"


def test_viewer_read_only_and_household_isolation(owner_client, anon_client):
    room = create_room(owner_client, "Private room")
    item = create_item(owner_client, "Private camera", room["id"])
    session = start(owner_client, room_ids=[room["id"]]).json()
    viewer = member_headers(owner_client, email="stocktake-viewer@example.com")
    assert anon_client.get("/api/v1/stocktake/sessions", headers=viewer).status_code == 200
    assert (
        anon_client.get(f"/api/v1/stocktake/sessions/{session['id']}", headers=viewer).status_code
        == 200
    )
    assert (
        anon_client.get(
            f"/api/v1/stocktake/sessions/{session['id']}/review", headers=viewer
        ).status_code
        == 200
    )
    assert (
        anon_client.post(
            "/api/v1/stocktake/sessions",
            headers=viewer,
            json={
                "room_ids": [room["id"]],
                "container_ids": [],
                "include_descendants": True,
                "request_id": str(uuid.uuid4()),
            },
        ).status_code
        == 403
    )
    row = item_row(owner_client, session["id"], item["id"])
    assert (
        anon_client.post(
            f"/api/v1/stocktake/sessions/{session['id']}/observations",
            headers=viewer,
            json={
                "request_id": str(uuid.uuid4()),
                "status": "present",
                "snapshot_item_id": row["snapshot_item_id"],
                "counted_quantity": 1,
                "expected_item_updated_at": row["current"]["updated_at"],
                "expected_on_loan_quantity": 0,
            },
        ).status_code
        == 403
    )

    # Create an isolated household directly for the cross-household check.
    with SessionLocal() as db:
        from housetory_api.models import Household

        user = User(
            name="Other household owner",
            email="stocktake-other-household@example.com",
            password_hash=hash_password("member-password-2026"),
        )
        household = Household(name="Other private home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(household_id=household.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="stocktake-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    other_headers = {"Cookie": f"housetory_session={token}"}
    assert (
        anon_client.get(
            f"/api/v1/stocktake/sessions/{session['id']}", headers=other_headers
        ).status_code
        == 404
    )
    cross_start = anon_client.post(
        "/api/v1/stocktake/sessions",
        headers=other_headers,
        json={
            "room_ids": [room["id"]],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_start.status_code == 404
    assert cross_start.json()["detail"]["code"] == "room_not_found"


def test_apply_rejects_a_stale_review_and_replays_idempotently(owner_client):
    room = create_room(owner_client, "Stale apply room")
    item = create_item(owner_client, "Generator", room["id"], quantity=1)
    session = start(owner_client, room_ids=[room["id"]]).json()
    row = item_row(owner_client, session["id"], item["id"])
    observed = observe(owner_client, session["id"], row, "quantity_discrepancy", counted_quantity=0)
    assert observed.status_code == 201, observed.text
    stale_review = review(owner_client, session["id"])
    assert stale_review["proposals"][0]["proposed_quantity"] == 0

    owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 2})
    stale_apply = apply(owner_client, session["id"], stale_review)
    assert stale_apply.status_code == 409
    assert stale_apply.json()["detail"]["code"] == "stocktake_review_stale"
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["quantity"] == 2

    # The observation is now stale against the item too, so re-record it before applying.
    fresh_row = item_row(owner_client, session["id"], item["id"])
    reobserved = observe(
        owner_client, session["id"], fresh_row, "quantity_discrepancy", counted_quantity=1
    )
    assert reobserved.status_code == 201, reobserved.text
    fresh_review = review(owner_client, session["id"])
    request_id = str(uuid.uuid4())
    applied = apply(owner_client, session["id"], fresh_review, request_id=request_id)
    assert applied.status_code == 200, applied.text
    assert applied.json()["applied_count"] == 1
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["quantity"] == 1
    replay = apply(owner_client, session["id"], fresh_review, request_id=request_id)
    assert replay.status_code == 200
    assert replay.json()["application_id"] == applied.json()["application_id"]
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["quantity"] == 1
