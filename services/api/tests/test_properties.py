import uuid

from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import ActivityEvent, HouseholdMember, User
from housetory_api.security import hash_password
from housetory_api.services.auth import create_session


def create_property(client, name, description=None):
    response = client.post("/api/v1/properties", json={"name": name, "description": description})
    assert response.status_code == 201, response.text
    return response.json()


def create_room(client, name, property_id=None, parent_id=None):
    payload = {"name": name, "parent_id": parent_id}
    if property_id is not None:
        payload["property_id"] = property_id
    return client.post("/api/v1/rooms", json=payload)


def create_container(client, room_id, name):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", "name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id=None, location_id=None, quantity=1):
    payload = {"name": name, "quantity": quantity}
    if room_id is not None:
        payload["room_id"] = room_id
    if location_id is not None:
        payload["storage_location_id"] = location_id
    response = client.post("/api/v1/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(client, item_id, quantity=1):
    response = client.post(
        "/api/v1/loans",
        json={
            "item_id": item_id,
            "borrower_name": "Sam",
            "quantity": quantity,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def household_id(client):
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def other_household(client, *, email=None, role="owner"):
    with SessionLocal() as db:
        from housetory_api.models import Household, Property

        suffix = uuid.uuid4().hex[:8]
        user = User(
            name=f"Other {role}",
            email=email or f"other-property-{suffix}@example.com",
            password_hash=hash_password("other-password-2026"),
        )
        other = Household(name="Other property home")
        db.add_all([user, other])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role=role))
        db.add(Property(household_id=other.id, name="Home"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="property-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
        return {"Cookie": f"housetory_session={token}"}, other.id


def viewer_headers(owner_client, email="property-viewer@example.com"):
    household = household_id(owner_client)
    with SessionLocal() as db:
        user = User(
            name="Property Viewer",
            email=email,
            password_hash=hash_password("viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household, user_id=user.id, role="viewer"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="property-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def complete_stocktake_present(client, room_id, item_id, counted):
    started = client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": [room_id],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert started.status_code == 201, started.text
    session_id = started.json()["id"]
    detail = client.get(f"/api/v1/stocktake/sessions/{session_id}").json()
    row = next(entry for entry in detail["items"] if entry["item_id"] == item_id)
    observed = client.post(
        f"/api/v1/stocktake/sessions/{session_id}/observations",
        json={
            "request_id": str(uuid.uuid4()),
            "status": "present",
            "snapshot_item_id": row["snapshot_item_id"],
            "counted_quantity": counted,
            "expected_item_updated_at": row["current"]["updated_at"],
            "expected_on_loan_quantity": row["current"]["on_loan_quantity"],
        },
    )
    assert observed.status_code == 201, observed.text
    completed = client.post(
        f"/api/v1/stocktake/sessions/{session_id}/complete",
        json={"request_id": str(uuid.uuid4()), "acknowledge_partial": True},
    )
    assert completed.status_code == 200, completed.text
    return session_id


def test_property_crud_room_defaults_filters_and_empty_guards(owner_client):
    initial = owner_client.get("/api/v1/properties").json()["items"]
    assert len(initial) == 1
    assert initial[0]["name"] == "Home"

    summer = create_property(owner_client, "Summer house", "Coastal place")
    assert summer["room_count"] == 0 and summer["is_archived"] is False

    # With two properties an omitted property is ambiguous; the initial one is
    # still usable when explicitly selected.
    ambiguous = create_room(owner_client, "Kitchen")
    assert ambiguous.status_code == 422
    assert ambiguous.json()["detail"]["code"] == "property_required"

    home_room = create_room(owner_client, "Kitchen", initial[0]["id"])
    assert home_room.status_code == 201, home_room.text
    home_room = home_room.json()
    assert home_room["property"]["name"] == "Home"

    summer_room = create_room(owner_client, "Kitchen", summer["id"])
    assert summer_room.status_code == 201, summer_room.text
    summer_room = summer_room.json()
    assert summer_room["property"]["name"] == "Summer house"

    duplicate = create_room(owner_client, "Kitchen", summer["id"])
    assert duplicate.status_code == 409
    same_name_other_property = create_room(owner_client, "Kitchen", initial[0]["id"])
    assert same_name_other_property.status_code == 409

    child = create_room(
        owner_client,
        "Pantry",
        None,
        parent_id=summer_room["id"],
    )
    assert child.status_code == 201, child.text
    assert child.json()["property_id"] == summer["id"]
    mismatch = create_room(
        owner_client,
        "Wrong child",
        initial[0]["id"],
        parent_id=summer_room["id"],
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "room_property_mismatch"

    home_box = create_container(owner_client, home_room["id"], "Home box")
    summer_box = create_container(owner_client, summer_room["id"], "Summer box")
    home_item = create_item(owner_client, "Lamp", home_room["id"], home_box["id"], quantity=2)
    summer_item = create_item(owner_client, "Lamp", summer_room["id"], summer_box["id"], quantity=3)
    unlocated = create_item(owner_client, "Spare key")

    filtered_rooms = owner_client.get(f"/api/v1/rooms?property_id={summer['id']}").json()["items"]
    assert {room["id"] for room in filtered_rooms} == {
        summer_room["id"],
        child.json()["id"],
    }

    filtered_items = owner_client.get(f"/api/v1/items?property_id={summer['id']}").json()["items"]
    assert {item["id"] for item in filtered_items} == {summer_item["id"]}
    assert filtered_items[0]["property"]["name"] == "Summer house"

    filtered_containers = owner_client.get(
        f"/api/v1/containers?property_id={summer['id']}&include_fixed=true"
    ).json()["items"]
    assert {container["id"] for container in filtered_containers} == {summer_box["id"]}
    assert filtered_containers[0]["property"]["name"] == "Summer house"

    all_items = owner_client.get("/api/v1/items?limit=100").json()["items"]
    assert unlocated["id"] in {item["id"] for item in all_items}
    assert unlocated["id"] not in {item["id"] for item in filtered_items}

    # A populated property cannot be archived or deleted.
    archive_home = owner_client.patch(
        f"/api/v1/properties/{initial[0]['id']}", json={"is_archived": True}
    )
    assert archive_home.status_code == 409
    assert archive_home.json()["detail"]["code"] == "property_not_empty"
    delete_home = owner_client.delete(f"/api/v1/properties/{initial[0]['id']}")
    assert delete_home.status_code == 409

    empty = create_property(owner_client, "Storage unit")
    archived = owner_client.patch(f"/api/v1/properties/{empty['id']}", json={"is_archived": True})
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True
    default_properties = owner_client.get("/api/v1/properties").json()["items"]
    assert empty["id"] not in {property_entry["id"] for property_entry in default_properties}
    all_properties = owner_client.get("/api/v1/properties?include_archived=true").json()["items"]
    assert empty["id"] in {property_entry["id"] for property_entry in all_properties}
    restored = owner_client.patch(f"/api/v1/properties/{empty['id']}", json={"is_archived": False})
    assert restored.status_code == 200
    deleted = owner_client.delete(f"/api/v1/properties/{empty['id']}")
    assert deleted.status_code == 204

    assert home_item["property"]["name"] == "Home"


def test_room_property_move_preserves_ids_qr_loans_and_marks_last_checked_stale(
    owner_client,
):
    initial = owner_client.get("/api/v1/properties").json()["items"][0]
    destination = create_property(owner_client, "Cabin")
    room = create_room(owner_client, "Workshop", initial["id"]).json()
    child = create_room(owner_client, "Bench", None, parent_id=room["id"]).json()
    box = create_container(owner_client, child["id"], "Tool box")
    item = create_item(owner_client, "Drill", child["id"], box["id"], quantity=3)
    create_loan(owner_client, item["id"], quantity=1)
    complete_stocktake_present(owner_client, room["id"], item["id"], counted=2)
    before = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert before["last_verified"]["stale"] is False

    preview = owner_client.get(
        f"/api/v1/rooms/{room['id']}/property-move/preview?property_id={destination['id']}"
    )
    assert preview.status_code == 200, preview.text
    preview_data = preview.json()
    assert preview_data["can_move"] is True
    assert preview_data["descendant_room_count"] == 2
    assert preview_data["descendant_container_count"] == 1
    assert preview_data["item_count"] == 1
    assert preview_data["total_quantity"] == 3
    assert preview_data["on_loan_quantity"] == 1

    request_id = str(uuid.uuid4())
    moved = owner_client.post(
        f"/api/v1/rooms/{room['id']}/property-move",
        json={
            "property_id": destination["id"],
            "preview_fingerprint": preview_data["fingerprint"],
            "request_id": request_id,
        },
    )
    assert moved.status_code == 200, moved.text
    result = moved.json()["result"]
    assert result["affected_item_ids"] == [item["id"]]

    moved_room = owner_client.get(f"/api/v1/rooms/{room['id']}").json()
    moved_child = owner_client.get(f"/api/v1/rooms/{child['id']}").json()
    assert moved_room["id"] == room["id"]
    assert moved_room["property"]["name"] == "Cabin"
    assert moved_child["property"]["name"] == "Cabin"
    moved_item = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert moved_item["room"]["id"] == child["id"]
    assert moved_item["location"]["id"] == box["id"]
    assert moved_item["quantity"] == 3
    assert moved_item["on_loan_quantity"] == 1
    assert moved_item["last_verified"]["stale"] is True
    moved_box = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    assert moved_box["id"] == box["id"]
    assert moved_box["property"]["name"] == "Cabin"
    assert moved_box["qr_payload"].endswith(f"/containers/{box['id']}")

    with SessionLocal() as db:
        event = db.scalar(
            select(ActivityEvent).where(
                ActivityEvent.household_id == household_id(owner_client),
                ActivityEvent.action == "room.moved",
            )
        )
        assert event is not None
        assert event.entity_type == "room"
        assert event.details["from_property_name"] == "Home"
        assert event.details["to_property_name"] == "Cabin"
        assert event.details["on_loan_quantity"] == 1

    replay = owner_client.post(
        f"/api/v1/rooms/{room['id']}/property-move",
        json={
            "property_id": destination["id"],
            "preview_fingerprint": preview_data["fingerprint"],
            "request_id": request_id,
        },
    )
    assert replay.status_code == 200
    assert replay.json()["result"]["history_event_id"] == result["history_event_id"]

    # Nested rooms cannot move on their own.
    nested_preview = owner_client.get(
        f"/api/v1/rooms/{child['id']}/property-move/preview?property_id={initial['id']}"
    )
    assert nested_preview.status_code == 200
    assert nested_preview.json()["can_move"] is False
    assert "top-level" in nested_preview.json()["warning"].lower()

    # A duplicate top-level room name in the destination blocks a move.
    duplicate_destination = create_property(owner_client, "Duplicates")
    create_room(owner_client, "Workshop", duplicate_destination["id"])
    duplicate_preview = owner_client.get(
        f"/api/v1/rooms/{room['id']}/property-move/preview?property_id={duplicate_destination['id']}"
    )
    assert duplicate_preview.status_code == 200
    assert duplicate_preview.json()["can_move"] is False
    assert "already exists" in duplicate_preview.json()["warning"]

    # A changed subtree invalidates an earlier preview.
    third = create_property(owner_client, "Loft")
    stale_preview = owner_client.get(
        f"/api/v1/rooms/{room['id']}/property-move/preview?property_id={third['id']}"
    ).json()
    create_item(owner_client, "Late clamp", child["id"], box["id"], quantity=1)
    stale = owner_client.post(
        f"/api/v1/rooms/{room['id']}/property-move",
        json={
            "property_id": third["id"],
            "preview_fingerprint": stale_preview["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "property_move_stale"


def test_container_and_bulk_moves_across_properties_preserve_identity_and_loans(
    owner_client,
):
    initial = owner_client.get("/api/v1/properties").json()["items"][0]
    other = create_property(owner_client, "Annex")
    room_a = create_room(owner_client, "Room A", initial["id"]).json()
    room_b = create_room(owner_client, "Room B", other["id"]).json()
    box = create_container(owner_client, room_a["id"], "Moving box")
    item = create_item(owner_client, "Heater", room_a["id"], box["id"], quantity=2)
    loan = create_loan(owner_client, item["id"], quantity=1)

    moved = owner_client.post(
        f"/api/v1/containers/{box['id']}/move",
        json={"room_id": room_b["id"], "parent_id": None},
    )
    assert moved.status_code == 200, moved.text
    moved_box = moved.json()
    assert moved_box["id"] == box["id"]
    assert moved_box["qr_payload"].endswith(f"/containers/{box['id']}")
    assert moved_box["property"]["name"] == "Annex"
    after = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert after["room"]["id"] == room_b["id"]
    assert after["location"]["id"] == box["id"]
    assert after["quantity"] == 2
    assert after["on_loan_quantity"] == 1
    assert owner_client.get(f"/api/v1/loans/{loan['id']}").json()["status"] == "outstanding"

    # Move the item back with the existing bulk move path.
    bulk = owner_client.post(
        "/api/v1/items/bulk/move",
        json={
            "item_ids": [item["id"]],
            "room_id": room_a["id"],
            "storage_location_id": None,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert bulk.status_code == 200, bulk.text
    assert bulk.json()["on_loan_quantity"] == 1
    back = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert back["property"]["name"] == "Home"
    assert back["quantity"] == 2
    assert back["on_loan_quantity"] == 1


def test_property_scoped_search_stocktake_evidence_and_assistant_paths(owner_client):
    initial = owner_client.get("/api/v1/properties").json()["items"][0]
    cabin = create_property(owner_client, "Cabin")
    home_kitchen = create_room(owner_client, "Kitchen", initial["id"]).json()
    cabin_kitchen = create_room(owner_client, "Kitchen", cabin["id"]).json()
    home_box = create_container(owner_client, home_kitchen["id"], "Home drawer")
    cabin_box = create_container(owner_client, cabin_kitchen["id"], "Cabin drawer")
    home_item = create_item(owner_client, "Kettle", home_kitchen["id"], home_box["id"], quantity=1)
    cabin_item = create_item(
        owner_client, "Lantern", cabin_kitchen["id"], cabin_box["id"], quantity=2
    )

    quick_home = owner_client.get(
        f"/api/v1/search/quick?q=Kettle&property_id={initial['id']}"
    ).json()["results"]
    assert len(quick_home) == 1
    assert quick_home[0]["id"] == home_item["id"]
    assert "Home" in quick_home[0]["context"]
    quick_cabin = owner_client.get(
        f"/api/v1/search/quick?q=Lantern&property_id={cabin['id']}"
    ).json()["results"]
    assert len(quick_cabin) == 1
    assert quick_cabin[0]["id"] == cabin_item["id"]
    assert "Cabin" in quick_cabin[0]["context"]

    stocktake = owner_client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": [cabin_kitchen["id"]],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert stocktake.status_code == 201, stocktake.text
    assert stocktake.json()["scope_label"] == "Room: Cabin / Kitchen"
    detail = owner_client.get(f"/api/v1/stocktake/sessions/{stocktake.json()['id']}").json()
    assert detail["items"][0]["expected_location_path"].startswith("Cabin / Kitchen")

    evidence = owner_client.post(
        "/api/v1/evidence-exports/preview",
        json={"scope": {"item_ids": [cabin_item["id"]]}, "options": {}},
    )
    assert evidence.status_code == 200, evidence.text
    preview_item = evidence.json()["items"][0]
    assert preview_item["property_name"] == "Cabin"
    assert preview_item["full_location_path"].startswith("Cabin / Kitchen")

    answer = owner_client.post(
        "/api/v1/assistant/query", json={"question": "Where is my Lantern?", "history": []}
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert "Cabin → Kitchen" in body["answer"]

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["item_count"] == 2
    assert overview["room_count"] == 2


def test_property_household_isolation_and_viewer_read_only(owner_client, anon_client):
    initial = owner_client.get("/api/v1/properties").json()["items"][0]
    room = create_room(owner_client, "Private property room", initial["id"]).json()
    other_headers, other_household_id = other_household(owner_client)
    with SessionLocal() as db:
        from housetory_api.models import Property, Room

        other_property = db.scalar(
            select(Property).where(Property.household_id == other_household_id)
        )
        assert other_property is not None
        other_room = Room(
            household_id=other_household_id,
            property_id=other_property.id,
            name="Other secret room",
        )
        db.add(other_room)
        db.commit()
        other_property_id = other_property.id

    assert (
        anon_client.get(
            f"/api/v1/properties/{other_property_id}", headers=other_headers
        ).status_code
        == 200
    )
    assert (
        anon_client.get(f"/api/v1/properties/{initial['id']}", headers=other_headers).status_code
        == 404
    )
    cross_room = anon_client.post(
        "/api/v1/rooms",
        headers=other_headers,
        json={"name": "Cross", "property_id": initial["id"]},
    )
    assert cross_room.status_code == 404
    assert cross_room.json()["detail"]["code"] == "property_not_found"

    cross_filter = anon_client.get(
        f"/api/v1/items?property_id={initial['id']}", headers=other_headers
    )
    assert cross_filter.status_code == 404

    # Other-household destinations cannot be used through move paths.
    preview = owner_client.get(
        f"/api/v1/rooms/{room['id']}/property-move/preview?property_id={other_property_id}"
    )
    assert preview.status_code == 404
    container = create_container(owner_client, room["id"], "Private box")
    cross_container = anon_client.post(
        f"/api/v1/containers/{container['id']}/move",
        headers=other_headers,
        json={"room_id": room["id"], "parent_id": None},
    )
    assert cross_container.status_code == 404
    cross_bulk = anon_client.post(
        "/api/v1/items/bulk/move",
        headers=other_headers,
        json={
            "item_ids": [str(uuid.uuid4())],
            "room_id": room["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_bulk.status_code == 404

    viewer = viewer_headers(owner_client)
    assert anon_client.get("/api/v1/properties", headers=viewer).status_code == 200
    assert anon_client.get(f"/api/v1/rooms/{room['id']}", headers=viewer).status_code == 200
    assert (
        anon_client.post(
            "/api/v1/properties", headers=viewer, json={"name": "Viewer property"}
        ).status_code
        == 403
    )
    assert (
        anon_client.patch(
            f"/api/v1/properties/{initial['id']}",
            headers=viewer,
            json={"name": "Renamed"},
        ).status_code
        == 403
    )
    assert (
        anon_client.delete(f"/api/v1/properties/{initial['id']}", headers=viewer).status_code == 403
    )
    assert (
        anon_client.post(
            f"/api/v1/rooms/{room['id']}/property-move",
            headers=viewer,
            json={
                "property_id": str(other_property_id),
                "preview_fingerprint": "x",
                "request_id": str(uuid.uuid4()),
            },
        ).status_code
        == 403
    )


def test_migration_backfills_one_property_per_existing_household_without_touching_ids():
    import os
    import subprocess
    import sys
    from pathlib import Path

    import psycopg
    from sqlalchemy.engine import make_url

    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_property_migration_{uuid.uuid4().hex[:8]}"
    connection_args = {
        "host": admin_url.host,
        "port": admin_url.port or 5432,
        "user": admin_url.username,
        "password": admin_url.password,
        "dbname": database_name,
    }
    admin_args = {**connection_args, "dbname": "postgres"}
    with psycopg.connect(**admin_args, autocommit=True) as connection:
        connection.execute(f'CREATE DATABASE "{database_name}"')
    database_url = (
        f"postgresql+psycopg://{admin_url.username}:{admin_url.password}"
        f"@{admin_url.host}:{admin_url.port or 5432}/{database_name}"
    )
    api_dir = Path(__file__).resolve().parents[1]
    try:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "e9f3a5b7c1d2"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )
        with psycopg.connect(**connection_args) as connection:
            connection.autocommit = False
            household_ids = []
            for suffix in ("one", "two"):
                household_id = connection.execute(
                    "INSERT INTO households (name) VALUES (%s) RETURNING id",
                    (f"Existing {suffix}",),
                ).fetchone()[0]
                user_id = connection.execute(
                    "INSERT INTO users (email, name, password_hash) "
                    "VALUES (%s, %s, %s) RETURNING id",
                    (
                        f"migration-{suffix}-{uuid.uuid4().hex[:6]}@example.com",
                        f"Migration {suffix}",
                        "not-a-real-password-hash",
                    ),
                ).fetchone()[0]
                connection.execute(
                    "INSERT INTO household_members (household_id, user_id, role) "
                    "VALUES (%s, %s, 'owner')",
                    (household_id, user_id),
                )
                room_id = connection.execute(
                    "INSERT INTO rooms (household_id, name) VALUES (%s, %s) RETURNING id",
                    (household_id, f"Existing room {suffix}"),
                ).fetchone()[0]
                container_id = connection.execute(
                    "INSERT INTO storage_locations "
                    "(household_id, room_id, name, kind, is_container, container_type, identifier) "
                    "VALUES (%s, %s, %s, 'box', true, 'box', %s) RETURNING id",
                    (
                        household_id,
                        room_id,
                        f"Existing box {suffix}",
                        f"BOX-90{suffix == 'two' and '2' or '1'}",
                    ),
                ).fetchone()[0]
                item_id, item_updated_at = connection.execute(
                    "INSERT INTO items "
                    "(household_id, room_id, storage_location_id, name, quantity) "
                    "VALUES (%s, %s, %s, %s, 2) RETURNING id, updated_at",
                    (household_id, room_id, container_id, f"Existing item {suffix}"),
                ).fetchone()
                connection.execute(
                    "INSERT INTO stocktake_item_states "
                    "(household_id, item_id, status, verified_at, counted_quantity, "
                    "owned_quantity, on_loan_quantity, location_path, item_updated_at) "
                    "VALUES (%s, %s, 'present', now(), 2, 2, 0, %s, %s)",
                    (household_id, item_id, f"Existing room {suffix}", item_updated_at),
                )
                household_ids.append(
                    (household_id, room_id, container_id, item_id, item_updated_at)
                )
            unlocated_id = connection.execute(
                "INSERT INTO items (household_id, name) VALUES (%s, %s) RETURNING id",
                (household_ids[0][0], "Existing unlocated item"),
            ).fetchone()[0]
            connection.commit()

        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )

        with psycopg.connect(**connection_args) as connection:
            for household_id, room_id, container_id, item_id, item_updated_at in household_ids:
                properties = connection.execute(
                    "SELECT id, name FROM properties WHERE household_id = %s",
                    (household_id,),
                ).fetchall()
                assert len(properties) == 1
                assert properties[0][1] == "Home"
                property_id = properties[0][0]
                stored_room = connection.execute(
                    "SELECT property_id, name FROM rooms WHERE id = %s", (room_id,)
                ).fetchone()
                assert stored_room[0] == property_id
                assert (
                    connection.execute(
                        "SELECT id FROM storage_locations WHERE id = %s", (container_id,)
                    ).fetchone()[0]
                    == container_id
                )
                stored_item = connection.execute(
                    "SELECT id, room_id, storage_location_id, quantity, updated_at "
                    "FROM items WHERE id = %s",
                    (item_id,),
                ).fetchone()
                assert stored_item[0] == item_id
                assert stored_item[1] == room_id
                assert stored_item[2] == container_id
                assert stored_item[3] == 2
                assert stored_item[4] == item_updated_at
                assert (
                    connection.execute(
                        "SELECT item_updated_at FROM stocktake_item_states WHERE item_id = %s",
                        (item_id,),
                    ).fetchone()[0]
                    == item_updated_at
                )
            assert (
                connection.execute(
                    "SELECT room_id FROM items WHERE id = %s", (unlocated_id,)
                ).fetchone()[0]
                is None
            )
            assert (
                connection.execute(
                    "SELECT count(*) FROM properties WHERE household_id = %s",
                    (household_ids[0][0],),
                ).fetchone()[0]
                == 1
            )
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')


def test_import_and_voice_location_matching_stay_inside_the_selected_property(
    owner_client,
):
    from housetory_api.schemas.voice import AiVoiceMention, AiVoiceResult
    from housetory_api.services.import_pipeline import process_import_batch
    from housetory_api.services.voice import build_voice_suggestions

    home = owner_client.get("/api/v1/properties").json()["items"][0]
    cabin = create_property(owner_client, "Cabin")
    home_attic = create_room(owner_client, "Attic", home["id"]).json()
    cabin_attic = create_room(owner_client, "Attic", cabin["id"]).json()
    home_box = create_container(owner_client, home_attic["id"], "Blue boxes")
    cabin_box = create_container(owner_client, cabin_attic["id"], "Blue boxes")
    create_item(owner_client, "Home skis", home_attic["id"], home_box["id"])

    missing_property = owner_client.post(
        "/api/v1/imports",
        data={"text": "Winter clothes are in the Blue boxes.", "title": "No property"},
    )
    assert missing_property.status_code == 422
    assert missing_property.json()["detail"]["code"] == "property_required"

    batch = owner_client.post(
        "/api/v1/imports",
        data={
            "text": "Winter clothes are in the Blue boxes.",
            "title": "Cabin winter clothes",
            "property_id": cabin["id"],
        },
    )
    assert batch.status_code == 201, batch.text
    batch_id = batch.json()["id"]
    process_import_batch(batch_id)
    detail = owner_client.get(f"/api/v1/imports/{batch_id}").json()
    entry = detail["entries"][0]
    assert entry["proposed"]["room"]["matched_id"] == cabin_attic["id"]
    assert entry["proposed"]["storage_location"]["matched_id"] == cabin_box["id"]
    applied = owner_client.post(
        f"/api/v1/imports/{batch_id}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    imported = owner_client.get(f"/api/v1/items?property_id={cabin['id']}").json()["items"]
    assert any(item["name"] == "Winter clothes" for item in imported)

    transcript = "Kettle in the Kitchen Drawer."
    result = AiVoiceResult(
        mentions=[
            AiVoiceMention(
                name="Kettle",
                room="Kitchen",
                storage_location="Drawer",
                evidence="Kettle in the Kitchen Drawer",
            )
        ]
    )
    household = household_id(owner_client)
    home_kitchen = create_room(owner_client, "Kitchen", home["id"]).json()
    cabin_kitchen = create_room(owner_client, "Kitchen", cabin["id"]).json()
    with SessionLocal() as db:
        suggestions, _warnings = build_voice_suggestions(
            db,
            household,
            transcript,
            result,
            default_property_id=uuid.UUID(cabin["id"]),
        )
        assert suggestions[0].room is not None
        assert str(suggestions[0].room.matched_id) == cabin_kitchen["id"]

        ambiguous, warnings = build_voice_suggestions(
            db,
            household,
            transcript,
            result,
            default_property_id=None,
        )
        assert ambiguous[0].room is not None
        assert ambiguous[0].room.status == "ambiguous"
        assert any(
            str(candidate.id) == home_kitchen["id"] for candidate in ambiguous[0].room.candidates
        )
        assert len(ambiguous[0].room.candidates) >= 2
