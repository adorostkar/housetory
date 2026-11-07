import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from PIL import Image
from sqlalchemy import func, select

from housetory_api.api.errors import ApiError
from housetory_api.api.routes import rooms as rooms_route
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    ActivityEvent,
    Household,
    HouseholdMember,
    LocationPhoto,
    StorageLocation,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import history
from housetory_api.services.auth import create_session


def create_room(client, name="Office"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name="Recovery box", parent_id=None):
    response = client.post(
        "/api/v1/containers",
        json={
            "room_id": room_id,
            "container_type": "box",
            "name": name,
            **({"parent_id": parent_id} if parent_id else {}),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, location_id=None, quantity=1):
    response = client.post(
        "/api/v1/items",
        json={
            "name": name,
            "room_id": room_id,
            "quantity": quantity,
            **({"storage_location_id": location_id} if location_id else {}),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def move_item(client, item_id, room_id, location_id=None):
    response = client.patch(
        f"/api/v1/items/{item_id}",
        json={"room_id": room_id, "storage_location_id": location_id},
    )
    assert response.status_code == 200, response.text
    return response.json()["item"]


def delete_container(client, container_id):
    response = client.delete(f"/api/v1/containers/{container_id}")
    assert response.status_code == 204, response.text


def item_history(client, item_id):
    response = client.get(f"/api/v1/items/{item_id}/history")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def move_event_for(client, item_id, location_id):
    for event in item_history(client, item_id):
        if event["action"] != "item.moved":
            continue
        if (event.get("details") or {}).get("from_location_id") == str(location_id):
            return event
    raise AssertionError("Move event not found.")


def restore_preview(client, event_id):
    return client.get(f"/api/v1/history/{event_id}/restore-preview")


def restore_undo(client, event_id, request_id=None):
    return client.post(
        f"/api/v1/history/{event_id}/restore-undo",
        json={"request_id": request_id or str(uuid.uuid4())},
    )


def household_id(client):
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def add_member(client, role="viewer", email=None):
    state = client.get("/api/v1/auth/session").json()
    hid = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"Restore {role.title()}",
            email=email or f"restore-{role}@example.com",
            password_hash=hash_password("restore-member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=hid, user_id=user.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="restore-undo-test",
            ip_address="127.0.0.1",
            household_id=hid,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def other_household_headers():
    with SessionLocal() as db:
        user = User(
            name="Other Owner",
            email=f"other-{uuid.uuid4().hex[:8]}@example.com",
            password_hash=hash_password("other-household-password-2026"),
        )
        household = Household(name="Other Home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(household_id=household.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="other-household-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def make_jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (80, 60), (70, 90, 60)).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_restore_assisted_undo_returns_one_item_and_reuses_identity(owner_client):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")
    attic = create_room(client, "Attic")
    box = create_container(client, office["id"], name="Cable recovery box")
    first = create_item(client, "Router", office["id"], box["id"], quantity=2)
    second = create_item(client, "Cable", office["id"], box["id"], quantity=3)
    client.post(
        "/api/v1/loans",
        json={
            "item_id": first["id"],
            "borrower_name": "Fixture borrower",
            "quantity": 1,
            "lent_on": "2026-10-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    location_photo = client.post(
        f"/api/v1/locations/{box['id']}/photos",
        files={"files": ("box.jpg", make_jpeg(), "image/jpeg")},
    )
    assert location_photo.status_code == 201, location_photo.text
    item_photo = client.post(
        f"/api/v1/items/{first['id']}/photos",
        files={"files": ("router.jpg", make_jpeg(), "image/jpeg")},
    )
    assert item_photo.status_code == 201, item_photo.text

    move_item(client, first["id"], garage["id"])
    move_item(client, second["id"], attic["id"])
    delete_container(client, box["id"])

    event = move_event_for(client, first["id"], box["id"])
    assert event["can_undo"] is False
    assert event["restore_assisted"]["available"] is True
    preview = restore_preview(client, event["id"])
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["available"] is True
    assert body["item_count"] == 1
    assert body["will_restore_container"] is True
    assert body["will_move_item"] is True
    assert body["container"]["id"] == box["id"]
    assert body["container"]["identifier"] == box["identifier"]
    assert body["item"]["id"] == first["id"]
    assert body["item"]["target_location_id"] == box["id"]

    loan_before = client.get(f"/api/v1/loans?item_id={first['id']}").json()
    restored = restore_undo(client, event["id"])
    assert restored.status_code == 200, restored.text
    assert restored.json()["restored_container_id"] == box["id"]

    container = client.get(f"/api/v1/containers/{box['id']}")
    assert container.status_code == 200, container.text
    assert container.json()["identifier"] == box["identifier"]
    first_state = client.get(f"/api/v1/items/{first['id']}").json()["item"]
    assert first_state["quantity"] == 2
    assert first_state["location"]["id"] == box["id"]
    second_state = client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert second_state["quantity"] == 3
    assert second_state["location"] is None
    assert second_state["room"]["id"] == attic["id"]
    assert client.get(f"/api/v1/loans?item_id={first['id']}").json() == loan_before
    assert len(client.get(f"/api/v1/items/{first['id']}/photos").json()["items"]) == 1
    assert len(client.get(f"/api/v1/locations/{box['id']}/photos").json()["items"]) == 1

    # The second item's original place is live again, so ordinary single-item undo
    # is used and no duplicate container is created.
    second_event = move_event_for(client, second["id"], box["id"])
    assert second_event["can_undo"] is True
    assert second_event["restore_assisted"] is None
    undone = client.post(
        f"/api/v1/history/{second_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undone.status_code == 200, undone.text
    second_state = client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert second_state["location"]["id"] == box["id"]
    containers = client.get(
        "/api/v1/containers", params={"q": box["identifier"], "include_fixed": True}
    ).json()["items"]
    assert len([entry for entry in containers if entry["id"] == box["id"]]) == 1


def test_restore_preview_blocks_latest_move(owner_client):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")
    attic = create_room(client, "Attic")
    box = create_container(client, office["id"])
    item = create_item(client, "Tripod", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])
    move_item(client, item["id"], attic["id"])

    event = move_event_for(client, item["id"], box["id"])
    preview = restore_preview(client, event["id"])
    assert preview.status_code == 200, preview.text
    assert preview.json()["available"] is False
    assert "moved since" in (preview.json()["reason"] or "")
    blocked = restore_undo(client, event["id"])
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "restore_not_safe"
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 410
    state = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert state["room"]["id"] == attic["id"]
    assert state["location"] is None


def test_restore_blocks_missing_room_parent_and_identifier_conflicts(owner_client):
    client = owner_client
    hid = household_id(client)
    office = create_room(client)
    garage = create_room(client, "Garage")

    missing_room_box = create_container(client, office["id"], name="Missing room box")
    missing_room_item = create_item(
        client, "Missing room item", office["id"], missing_room_box["id"]
    )
    move_item(client, missing_room_item["id"], garage["id"])
    delete_container(client, missing_room_box["id"])
    missing_room_event = move_event_for(client, missing_room_item["id"], missing_room_box["id"])
    with SessionLocal() as db:
        event = db.get(ActivityEvent, uuid.UUID(missing_room_event["id"]))
        assert event is not None
        event.details = {
            **(event.details or {}),
            "from_room_id": str(uuid.uuid4()),
        }
        db.commit()
    preview = restore_preview(client, missing_room_event["id"]).json()
    assert preview["available"] is False
    assert "room" in (preview["reason"] or "").lower()

    parent_box = create_container(client, office["id"], name="Parent box")
    child_box = create_container(client, office["id"], name="Child box", parent_id=parent_box["id"])
    parent_item = create_item(client, "Parent item", office["id"], child_box["id"])
    move_item(client, parent_item["id"], garage["id"])
    delete_container(client, child_box["id"])
    with SessionLocal() as db:
        parent = db.get(StorageLocation, uuid.UUID(parent_box["id"]))
        assert parent is not None
        parent.deleted_at = datetime.now(UTC)
        parent.deleted_by_name = "Fixture"
        db.commit()
    parent_event = move_event_for(client, parent_item["id"], child_box["id"])
    parent_preview = restore_preview(client, parent_event["id"]).json()
    assert parent_preview["available"] is False
    assert "parent" in (parent_preview["reason"] or "").lower()

    identifier_box = create_container(client, office["id"], name="Identifier box")
    with SessionLocal() as db:
        record = db.get(StorageLocation, uuid.UUID(identifier_box["id"]))
        assert record is not None
        record.legacy_identifier = "OLD-RESTORE-001"
        db.commit()
    identifier_item = create_item(client, "Identifier item", office["id"], identifier_box["id"])
    move_item(client, identifier_item["id"], garage["id"])
    delete_container(client, identifier_box["id"])
    with SessionLocal() as db:
        db.add(
            StorageLocation(
                household_id=hid,
                room_id=uuid.UUID(office["id"]),
                name="Conflicting active place",
                kind="shelf",
                legacy_identifier="OLD-RESTORE-001",
            )
        )
        db.commit()
    identifier_event = move_event_for(client, identifier_item["id"], identifier_box["id"])
    identifier_preview = restore_preview(client, identifier_event["id"]).json()
    assert identifier_preview["available"] is False
    assert "identifier" in (identifier_preview["reason"] or "").lower()


def test_legacy_hard_deleted_place_is_honestly_unrecoverable(owner_client):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")
    box = create_container(client, office["id"], name="Legacy box")
    item = create_item(client, "Legacy item", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    with SessionLocal() as db:
        record = db.get(StorageLocation, uuid.UUID(box["id"]))
        assert record is not None
        db.delete(record)
        db.commit()

    event = move_event_for(client, item["id"], box["id"])
    assert event["can_undo"] is False
    assert event["restore_assisted"]["available"] is False
    assert event["restore_assisted"]["legacy_unrecoverable"] is True
    assert "permanently deleted" in (event["restore_assisted"]["reason"] or "")
    preview = restore_preview(client, event["id"])
    assert preview.status_code == 200, preview.text
    assert preview.json()["available"] is False
    assert preview.json()["legacy_unrecoverable"] is True
    blocked = restore_undo(client, event["id"])
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "restore_not_safe"
    state = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert state["room"]["id"] == garage["id"]


def test_empty_room_with_only_tombstones_can_be_deleted(owner_client):
    client = owner_client
    office = create_room(client, "Tombstone room")
    garage = create_room(client, "Garage")
    box = create_container(client, office["id"], name="Tombstone box")
    item = create_item(client, "Tombstone item", office["id"], box["id"])
    photo = client.post(
        f"/api/v1/locations/{box['id']}/photos",
        files={"files": ("box.jpg", make_jpeg(), "image/jpeg")},
    )
    assert photo.status_code == 201, photo.text
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])
    event = move_event_for(client, item["id"], box["id"])

    deleted = client.delete(f"/api/v1/rooms/{office['id']}")
    assert deleted.status_code == 204, deleted.text
    with SessionLocal() as db:
        tombstone = db.get(StorageLocation, uuid.UUID(box["id"]))
        assert tombstone is not None
        assert tombstone.deleted_at is not None
        assert tombstone.room_id is None
        assert tombstone.detached_at is not None
        assert tombstone.deletion_snapshot["room_id"] == office["id"]
        assert tombstone.deletion_snapshot["room_name"] == "Tombstone room"
        assert (
            db.scalar(
                select(func.count(LocationPhoto.id)).where(
                    LocationPhoto.location_id == tombstone.id
                )
            )
            == 1
        )
    assert client.get(f"/api/v1/rooms/{office['id']}").status_code == 404
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 410
    assert client.get(f"/api/v1/containers/lookup/{box['identifier']}").status_code == 410
    containers = client.get(
        "/api/v1/containers",
        params={"q": box["identifier"], "include_fixed": True},
    ).json()["items"]
    assert box["id"] not in {entry["id"] for entry in containers}

    preview = restore_preview(client, event["id"])
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["available"] is False
    assert "room" in (body["reason"] or "").lower()
    assert body["container"]["room_name"] == "Tombstone room"
    assert body["container"]["property_name"] is not None
    blocked = restore_undo(client, event["id"])
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "restore_not_safe"


def test_parent_container_delete_keeps_child_tombstone_and_blocks_restore(owner_client):
    client = owner_client
    office = create_room(client, "Parent room")
    garage = create_room(client, "Garage")
    parent_box = create_container(client, office["id"], name="Parent box")
    child_box = create_container(client, office["id"], name="Child box", parent_id=parent_box["id"])
    item = create_item(client, "Child item", office["id"], child_box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, child_box["id"])
    child_event = move_event_for(client, item["id"], child_box["id"])

    parent_delete = client.delete(f"/api/v1/containers/{parent_box['id']}")
    assert parent_delete.status_code == 204, parent_delete.text
    with SessionLocal() as db:
        parent = db.get(StorageLocation, uuid.UUID(parent_box["id"]))
        child = db.get(StorageLocation, uuid.UUID(child_box["id"]))
        assert parent is not None and parent.deleted_at is not None
        assert child is not None and child.deleted_at is not None
        assert child.parent_id == parent.id
    preview = restore_preview(client, child_event["id"]).json()
    assert preview["available"] is False
    assert "parent" in (preview["reason"] or "").lower()
    blocked = restore_undo(client, child_event["id"])
    assert blocked.status_code == 409

    # Deleting the now otherwise-empty room detaches both tombstones but keeps
    # their rows, audit and photos.
    room_delete = client.delete(f"/api/v1/rooms/{office['id']}")
    assert room_delete.status_code == 204, room_delete.text
    with SessionLocal() as db:
        parent = db.get(StorageLocation, uuid.UUID(parent_box["id"]))
        child = db.get(StorageLocation, uuid.UUID(child_box["id"]))
        assert parent is not None and parent.room_id is None
        assert child is not None and child.room_id is None
        assert parent.deleted_at is not None and child.deleted_at is not None


def test_active_children_and_contents_still_block_parent_deletion(owner_client):
    client = owner_client
    office = create_room(client, "Active room")
    parent_box = create_container(client, office["id"], name="Active parent")
    child_box = create_container(
        client, office["id"], name="Active child", parent_id=parent_box["id"]
    )
    assert client.delete(f"/api/v1/containers/{parent_box['id']}").status_code == 409
    assert client.delete(f"/api/v1/rooms/{office['id']}").status_code == 409

    # Move the active child out, then an active item still protects the parent.
    move_response = client.patch(
        f"/api/v1/storage-locations/{child_box['id']}",
        json={"parent_id": None},
    )
    assert move_response.status_code == 200, move_response.text
    item = create_item(client, "Active item", office["id"], parent_box["id"])
    assert client.delete(f"/api/v1/containers/{parent_box['id']}").status_code == 409
    assert item["location"]["id"] == parent_box["id"]
    assert client.delete(f"/api/v1/rooms/{office['id']}").status_code == 409


def test_place_transfer_preview_warns_and_room_delete_remains_usable(owner_client):
    client = owner_client
    office = create_room(client, "Transfer room")
    garage = create_room(client, "Garage")
    tombstone_box = create_container(client, office["id"], name="Transfer tombstone")
    move_item(
        client,
        create_item(client, "Moved out", office["id"], tombstone_box["id"])["id"],
        garage["id"],
    )
    delete_container(client, tombstone_box["id"])
    active_item = create_item(client, "Active item", office["id"])

    preview = client.get(
        f"/api/v1/place-management/rooms/{office['id']}/preview",
        params={"destination_room_id": garage["id"]},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["can_proceed"] is True
    assert any("recoverable-deleted" in warning for warning in body["warnings"])
    assert any("restoration unavailable" in warning for warning in body["warnings"])

    transferred = client.post(
        f"/api/v1/place-management/rooms/{office['id']}/transfer",
        json={
            "destination_room_id": garage["id"],
            "delete_source": True,
            "expected_fingerprint": body["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert transferred.status_code == 200, transferred.text
    assert transferred.json()["deleted"] is True
    assert client.get(f"/api/v1/rooms/{office['id']}").status_code == 404
    item_state = client.get(f"/api/v1/items/{active_item['id']}").json()["item"]
    assert item_state["room"]["id"] == garage["id"]
    with SessionLocal() as db:
        tombstone = db.get(StorageLocation, uuid.UUID(tombstone_box["id"]))
        assert tombstone is not None
        assert tombstone.room_id is None
        assert tombstone.deleted_at is not None
        assert tombstone.detached_at is not None


def test_room_delete_rolls_back_detachment_on_failure(owner_client, monkeypatch):
    client = owner_client
    office = create_room(client, "Rollback room")
    garage = create_room(client, "Garage")
    box = create_container(client, office["id"], name="Rollback tombstone")
    item = create_item(client, "Rollback item", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])

    original = rooms_route.detach_tombstones_for_room

    def fail_after_detach(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("fixture failure after detachment")

    monkeypatch.setattr(rooms_route, "detach_tombstones_for_room", fail_after_detach)
    with pytest.raises(RuntimeError):
        client.delete(f"/api/v1/rooms/{office['id']}")
    monkeypatch.setattr(rooms_route, "detach_tombstones_for_room", original)
    assert client.get(f"/api/v1/rooms/{office['id']}").status_code == 200
    with SessionLocal() as db:
        tombstone = db.get(StorageLocation, uuid.UUID(box["id"]))
        assert tombstone is not None
        assert tombstone.room_id == uuid.UUID(office["id"])
        assert tombstone.detached_at is None


def test_restore_is_idempotent_and_concurrent(owner_client):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")

    box = create_container(client, office["id"], name="Idempotent box")
    item = create_item(client, "Idempotent item", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])
    event = move_event_for(client, item["id"], box["id"])
    request_id = str(uuid.uuid4())
    first = restore_undo(client, event["id"], request_id)
    second = restore_undo(client, event["id"], request_id)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["event"]["id"] == second.json()["event"]["id"]
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 200

    concurrent_box = create_container(client, office["id"], name="Concurrent box")
    concurrent_item = create_item(client, "Concurrent item", office["id"], concurrent_box["id"])
    move_item(client, concurrent_item["id"], garage["id"])
    delete_container(client, concurrent_box["id"])
    concurrent_event = move_event_for(client, concurrent_item["id"], concurrent_box["id"])
    hid = household_id(client)

    def restore(request_id):
        with SessionLocal() as db:
            try:
                history.restore_assisted_undo_event(
                    db,
                    hid,
                    uuid.UUID(concurrent_event["id"]),
                    actor_user_id=None,
                    actor_name="Concurrent test",
                    request_id=uuid.UUID(request_id),
                )
                db.commit()
                return "ok"
            except ApiError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(restore, [str(uuid.uuid4()), str(uuid.uuid4())]))
    assert sorted(results) == ["already_undone", "ok"]
    containers = client.get(
        "/api/v1/containers",
        params={"q": concurrent_box["identifier"], "include_fixed": True},
    ).json()["items"]
    assert len([entry for entry in containers if entry["id"] == concurrent_box["id"]]) == 1
    restored_item = client.get(f"/api/v1/items/{concurrent_item['id']}").json()["item"]
    assert restored_item["location"]["id"] == concurrent_box["id"]


def test_restore_permissions_and_cross_household_are_enforced(owner_client):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")
    box = create_container(client, office["id"])
    item = create_item(client, "Permission item", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])
    event = move_event_for(client, item["id"], box["id"])

    viewer = add_member(client, email="restore-viewer@example.com")
    assert restore_preview(client, event["id"]).status_code == 200
    denied = client.post(
        f"/api/v1/history/{event['id']}/restore-undo",
        headers=viewer,
        json={"request_id": str(uuid.uuid4())},
    )
    assert denied.status_code == 403

    other = other_household_headers()
    assert (
        client.get(f"/api/v1/history/{event['id']}/restore-preview", headers=other).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/history/{event['id']}/restore-undo",
            headers=other,
            json={"request_id": str(uuid.uuid4())},
        ).status_code
        == 404
    )
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 410


def test_restore_rolls_back_atomically_and_normal_undo_still_works(owner_client, monkeypatch):
    client = owner_client
    office = create_room(client)
    garage = create_room(client, "Garage")
    box = create_container(client, office["id"], name="Rollback box")
    item = create_item(client, "Rollback item", office["id"], box["id"])
    move_item(client, item["id"], garage["id"])
    delete_container(client, box["id"])
    event = move_event_for(client, item["id"], box["id"])
    hid = household_id(client)

    original_record = history.record_event

    def fail_after_restore(*args, **kwargs):
        if kwargs.get("action") == "container.restored":
            raise RuntimeError("fixture failure after restore mutation")
        return original_record(*args, **kwargs)

    monkeypatch.setattr(history, "record_event", fail_after_restore)
    with SessionLocal() as db:
        with pytest.raises(RuntimeError):
            history.restore_assisted_undo_event(
                db,
                hid,
                uuid.UUID(event["id"]),
                actor_user_id=None,
                actor_name="Rollback test",
                request_id=uuid.uuid4(),
            )
        db.rollback()
    monkeypatch.setattr(history, "record_event", original_record)
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 410
    item_state = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert item_state["room"]["id"] == garage["id"]
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(func.count(ActivityEvent.id)).where(
                    ActivityEvent.household_id == hid,
                    ActivityEvent.action == "item.move_undone",
                )
            )
            == 0
        )

    live_box = create_container(client, office["id"], name="Live box")
    live_item = create_item(client, "Live item", office["id"], live_box["id"])
    move_item(client, live_item["id"], garage["id"])
    live_event = move_event_for(client, live_item["id"], live_box["id"])
    assert live_event["can_undo"] is True
    assert live_event["restore_assisted"] is None
    undone = client.post(
        f"/api/v1/history/{live_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undone.status_code == 200, undone.text
    assert (
        client.get(f"/api/v1/items/{live_item['id']}").json()["item"]["location"]["id"]
        == live_box["id"]
    )


def test_tombstones_are_excluded_from_active_lists_search_counts_and_qr(owner_client):
    client = owner_client
    office = create_room(client)
    before_overview = client.get("/api/v1/overview").json()
    before_properties = client.get("/api/v1/properties").json()["items"]
    property_id = office["property_id"]
    before_property = next(entry for entry in before_properties if entry["id"] == property_id)
    box = create_container(client, office["id"], name="Findable recovery box")
    move_item(client, create_item(client, "Temporary", office["id"], box["id"])["id"], office["id"])
    delete_container(client, box["id"])

    after_overview = client.get("/api/v1/overview").json()
    assert after_overview["location_count"] == before_overview["location_count"]
    after_property = client.get("/api/v1/properties").json()["items"]
    property_after = next(entry for entry in after_property if entry["id"] == property_id)
    assert property_after["location_count"] == before_property["location_count"]

    containers = client.get(
        "/api/v1/containers",
        params={"q": box["identifier"], "include_fixed": True},
    ).json()["items"]
    assert box["id"] not in {entry["id"] for entry in containers}
    locations = client.get("/api/v1/storage-locations", params={"room_id": office["id"]}).json()[
        "items"
    ]
    assert box["id"] not in {entry["id"] for entry in locations}
    rooms = client.get("/api/v1/rooms").json()["items"]
    room_after = next(entry for entry in rooms if entry["id"] == office["id"])
    assert room_after["location_count"] == 0
    search = client.get("/api/v1/search/quick", params={"q": "Findable recovery"}).json()["results"]
    assert box["id"] not in {entry["id"] for entry in search}

    deleted = client.get(f"/api/v1/containers/{box['id']}")
    assert deleted.status_code == 410
    assert deleted.json()["detail"]["code"] == "container_deleted"
    lookup = client.get(f"/api/v1/containers/lookup/{box['identifier']}")
    assert lookup.status_code == 410
    assert lookup.json()["detail"]["code"] == "container_deleted"
    qr = client.get(f"/api/v1/containers/{box['id']}/qr.svg")
    assert qr.status_code == 410
    location_detail = client.get(f"/api/v1/storage-locations/{box['id']}")
    assert location_detail.status_code == 410
    assert location_detail.json()["detail"]["code"] == "location_deleted"
