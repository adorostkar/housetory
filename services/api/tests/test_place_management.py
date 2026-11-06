import uuid

from sqlalchemy import func, select

from housetory_api.api.errors import ApiError
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    BorrowedRecord,
    HouseholdMember,
    Item,
    Room,
    StorageLocation,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import place_management
from housetory_api.services.auth import create_session


def create_room(client, name, headers=None, **extra):
    response = client.post("/api/v1/rooms", json={"name": name, **extra}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def create_location(client, room_id, name, kind="shelf", parent_id=None):
    response = client.post(
        "/api/v1/storage-locations",
        json={
            "room_id": room_id,
            "name": name,
            "kind": kind,
            "parent_id": parent_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name=None, parent_id=None, headers=None):
    response = client.post(
        "/api/v1/containers",
        headers=headers,
        json={
            "room_id": room_id,
            "container_type": "box",
            **({"name": name} if name else {}),
            **({"parent_id": parent_id} if parent_id else {}),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, location_id=None, **extra):
    response = client.post(
        "/api/v1/items",
        json={
            "name": name,
            "room_id": room_id,
            **({"storage_location_id": location_id} if location_id else {}),
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def archive_item(client, item_id):
    response = client.patch(f"/api/v1/items/{item_id}", json={"is_archived": True})
    assert response.status_code == 200, response.text
    return response.json()["item"]


def create_borrowed(client, name, room_id, location_id):
    response = client.post(
        "/api/v1/borrowed",
        json={
            "item_name": name,
            "owner_name": "Fixture owner",
            "quantity": 1,
            "borrowed_on": "2026-10-01",
            "room_id": room_id,
            "storage_location_id": location_id,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def preview_location(
    client,
    location_id,
    destination_room_id,
    destination_location_id=None,
    headers=None,
):
    params = {"destination_room_id": destination_room_id}
    if destination_location_id:
        params["destination_location_id"] = destination_location_id
    response = client.get(
        f"/api/v1/place-management/locations/{location_id}/preview",
        params=params,
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def transfer_location(
    client,
    location_id,
    *,
    destination_room_id,
    fingerprint,
    destination_location_id=None,
    delete_source=False,
    request_id=None,
    headers=None,
):
    return client.post(
        f"/api/v1/place-management/locations/{location_id}/transfer",
        headers=headers,
        json={
            "destination_room_id": destination_room_id,
            "destination_location_id": destination_location_id,
            "delete_source": delete_source,
            "expected_fingerprint": fingerprint,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def preview_room(client, room_id, destination_room_id, destination_location_id=None):
    params = {"destination_room_id": destination_room_id}
    if destination_location_id:
        params["destination_location_id"] = destination_location_id
    response = client.get(f"/api/v1/place-management/rooms/{room_id}/preview", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def transfer_room(
    client,
    room_id,
    *,
    destination_room_id,
    fingerprint,
    destination_location_id=None,
    delete_source=False,
    request_id=None,
):
    return client.post(
        f"/api/v1/place-management/rooms/{room_id}/transfer",
        json={
            "destination_room_id": destination_room_id,
            "destination_location_id": destination_location_id,
            "delete_source": delete_source,
            "expected_fingerprint": fingerprint,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def item_count() -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count(Item.id))) or 0)


def add_member(client, role="viewer", email="place-viewer@example.com") -> dict[str, str]:
    state = client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name="Place Viewer",
            email=email,
            password_hash=hash_password("place-viewer-password-2026"),
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
            user_agent="place-management-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def test_move_all_contents_preserves_nested_places_items_and_borrowed(owner_client):
    client = owner_client
    room = create_room(client, "Utility")
    destination = create_room(client, "Garage")
    box = create_container(client, room["id"], name="Holiday box")
    tray = create_location(client, room["id"], "Tray", "drawer", parent_id=box["id"])
    direct = create_item(client, "Fairy lights", room["id"], box["id"], quantity=2)
    nested = create_item(client, "Baubles", room["id"], tray["id"], quantity=12)
    archived = archive_item(
        client,
        create_item(client, "Old tinsel", room["id"], tray["id"])["id"],
    )
    borrowed = create_borrowed(client, "Borrowed heater", room["id"], tray["id"])
    before_items = item_count()

    preview = preview_location(client, box["id"], destination["id"])
    assert preview["source_label"] == box["identifier"]
    assert preview["direct_item_count"] == 1
    assert preview["nested_item_count"] == 2
    assert preview["total_item_count"] == 3
    assert preview["total_quantity"] == 15
    assert preview["archived_item_count"] == 1
    assert preview["nested_place_count"] == 1
    assert preview["borrowed_record_count"] == 1
    assert preview["destination"]["room_id"] == destination["id"]
    assert any("archived" in warning for warning in preview["warnings"])
    assert preview["can_proceed"] is True

    moved = transfer_location(
        client,
        box["id"],
        destination_room_id=destination["id"],
        fingerprint=preview["fingerprint"],
    )
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["deleted"] is False
    assert body["direct_items_moved"] == 1
    assert body["nested_items_moved"] == 2
    assert body["total_items_preserved"] == 3
    assert body["nested_places_moved"] == 1
    assert body["borrowed_records_moved"] == 1
    assert item_count() == before_items

    direct_state = client.get(f"/api/v1/items/{direct['id']}").json()["item"]
    nested_state = client.get(f"/api/v1/items/{nested['id']}").json()["item"]
    archived_state = client.get(f"/api/v1/items/{archived['id']}").json()["item"]
    assert direct_state["room"]["id"] == destination["id"]
    assert direct_state["location"] is None
    assert direct_state["quantity"] == 2
    assert nested_state["room"]["id"] == destination["id"]
    assert nested_state["location"]["id"] == tray["id"]
    assert archived_state["location"]["id"] == tray["id"]

    tray_state = client.get(f"/api/v1/storage-locations/{tray['id']}").json()
    assert tray_state["room_id"] == destination["id"]
    assert tray_state["parent_id"] is None
    source_state = client.get(f"/api/v1/containers/{box['id']}").json()
    assert source_state["total_item_count"] == 0
    assert source_state["child_count"] == 0

    borrowed_state = client.get(f"/api/v1/borrowed/{borrowed['id']}").json()
    assert borrowed_state["room_id"] == destination["id"]
    assert borrowed_state["storage_location_id"] == tray["id"]

    # Replaying the same request returns the stored result and does not move twice.
    replay = transfer_location(
        client,
        box["id"],
        destination_room_id=destination["id"],
        fingerprint=preview["fingerprint"],
        request_id=body["request_id"],
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["history_event_id"] == body["history_event_id"]

    empty_delete = client.delete(f"/api/v1/containers/{box['id']}")
    assert empty_delete.status_code == 204, empty_delete.text


def test_move_contents_and_delete_never_deletes_inventory(owner_client):
    client = owner_client
    room = create_room(client, "Loft")
    destination = create_room(client, "Spare room")
    box = create_container(client, room["id"], name="Winter box")
    tray = create_location(client, room["id"], "Gloves tray", "drawer", parent_id=box["id"])
    direct = create_item(client, "Scarf", room["id"], box["id"], quantity=2)
    nested = create_item(client, "Gloves", room["id"], tray["id"], quantity=3)
    before_items = item_count()

    preview = preview_location(client, box["id"], destination["id"])
    deleted = transfer_location(
        client,
        box["id"],
        destination_room_id=destination["id"],
        fingerprint=preview["fingerprint"],
        delete_source=True,
    )
    assert deleted.status_code == 200, deleted.text
    result = deleted.json()
    assert result["deleted"] is True
    assert result["total_items_preserved"] == 2
    assert item_count() == before_items
    assert client.get(f"/api/v1/containers/{box['id']}").status_code == 404

    direct_state = client.get(f"/api/v1/items/{direct['id']}").json()["item"]
    nested_state = client.get(f"/api/v1/items/{nested['id']}").json()["item"]
    assert direct_state["quantity"] == 2
    assert nested_state["quantity"] == 3
    assert nested_state["location"]["id"] == tray["id"]
    assert nested_state["room"]["id"] == destination["id"]

    with SessionLocal() as db:
        from housetory_api.models import ActivityEvent

        event = db.get(ActivityEvent, uuid.UUID(result["history_event_id"]))
        assert event is not None
        assert event.action == "place.contents_moved_and_deleted"
        assert event.household_id is not None


def test_room_delete_with_contents_reparents_child_rooms_and_places(owner_client):
    client = owner_client
    property_id = create_room(client, "Temporary")["property_id"]
    source = create_room(client, "Store room", property_id=property_id)
    child = create_room(client, "Mezzanine", parent_id=source["id"])
    destination = create_room(client, "Workshop", property_id=property_id)
    destination_shelf = create_location(client, destination["id"], "Incoming shelf", "shelf")
    source_shelf = create_location(client, source["id"], "Packing shelf", "shelf")
    child_shelf = create_location(client, child["id"], "Child shelf", "shelf")
    direct = create_item(client, "Direct chair", source["id"], quantity=1)
    in_shelf = create_item(client, "Shelf boxes", source["id"], source_shelf["id"], quantity=4)
    in_child = create_item(client, "Child lamp", child["id"], child_shelf["id"], quantity=2)
    borrowed_direct = create_borrowed(client, "Borrowed ladder", source["id"], None)
    before_items = item_count()

    preview = preview_room(client, source["id"], destination["id"], destination_shelf["id"])
    assert preview["child_room_count"] == 1
    assert preview["nested_place_count"] == 2
    assert preview["total_item_count"] == 3
    assert preview["destination"]["room_id"] == destination["id"]
    assert any("sub-room" in warning for warning in preview["warnings"])

    deleted = client.post(
        f"/api/v1/place-management/rooms/{source['id']}/transfer",
        json={
            "destination_room_id": destination["id"],
            "destination_location_id": destination_shelf["id"],
            "delete_source": True,
            "expected_fingerprint": preview["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert deleted.status_code == 200, deleted.text
    result = deleted.json()
    assert result["deleted"] is True
    assert result["child_rooms_moved"] == 1
    assert result["nested_places_moved"] == 2
    assert item_count() == before_items
    assert client.get(f"/api/v1/rooms/{source['id']}").status_code == 404

    child_state = client.get(f"/api/v1/rooms/{child['id']}").json()
    assert child_state["parent_id"] == destination["id"]
    shelf_state = client.get(f"/api/v1/storage-locations/{source_shelf['id']}").json()
    assert shelf_state["room_id"] == destination["id"]
    assert shelf_state["parent_id"] == destination_shelf["id"]
    assert (
        client.get(f"/api/v1/storage-locations/{child_shelf['id']}").json()["room_id"]
        == child["id"]
    )
    assert (
        client.get(f"/api/v1/items/{direct['id']}").json()["item"]["room"]["id"]
        == destination["id"]
    )
    assert (
        client.get(f"/api/v1/items/{in_shelf['id']}").json()["item"]["location"]["id"]
        == source_shelf["id"]
    )
    assert client.get(f"/api/v1/items/{in_child['id']}").json()["item"]["room"]["id"] == child["id"]
    borrowed_state = client.get(f"/api/v1/borrowed/{borrowed_direct['id']}").json()
    assert borrowed_state["room_id"] == destination["id"]
    assert borrowed_state["storage_location_id"] == destination_shelf["id"]


def test_destination_blockers_permissions_and_stale_preview(owner_client):
    client = owner_client
    room = create_room(client, "Blockers")
    destination = create_room(client, "Elsewhere")
    box = create_container(client, room["id"], name="Blocked box")
    tray = create_location(client, room["id"], "Blocked tray", "drawer", parent_id=box["id"])
    create_item(client, "Blocked item", room["id"], tray["id"])
    before_items = item_count()

    cycle = preview_location(client, box["id"], room["id"], tray["id"])
    assert cycle["can_proceed"] is False
    assert any("outside" in blocker for blocker in cycle["blockers"])

    room_cycle = preview_room(client, room["id"], room["id"])
    assert room_cycle["can_proceed"] is False

    stale_preview = preview_location(client, box["id"], destination["id"])
    create_item(client, "Late item", room["id"], tray["id"])
    stale = transfer_location(
        client,
        box["id"],
        destination_room_id=destination["id"],
        fingerprint=stale_preview["fingerprint"],
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "place_contents_changed"
    assert item_count() == before_items + 1

    viewer = add_member(client, "viewer")
    viewer_transfer = client.post(
        f"/api/v1/place-management/locations/{box['id']}/transfer",
        headers=viewer,
        json={
            "destination_room_id": destination["id"],
            "delete_source": True,
            "expected_fingerprint": stale_preview["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert viewer_transfer.status_code == 403

    member = add_member(client, "member", email="place-member@example.com")
    fresh = preview_location(client, box["id"], destination["id"])
    member_move = client.post(
        f"/api/v1/place-management/locations/{box['id']}/transfer",
        headers=member,
        json={
            "destination_room_id": destination["id"],
            "delete_source": False,
            "expected_fingerprint": fresh["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert member_move.status_code == 200, member_move.text


def test_cross_household_sources_and_destinations_are_rejected(owner_client):
    client = owner_client
    first_household = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    source_room = create_room(client, "Cross household source")
    source_box = create_container(client, source_room["id"], name="Cross source box")
    create_item(client, "Cross item", source_room["id"], source_box["id"])

    second = client.post(
        "/api/v1/households",
        json={"name": "Other household", "property_name": "Other home"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    second_room = create_room(client, "Other home room", headers=second_headers)
    second_box = create_container(
        client, second_room["id"], name="Other box", headers=second_headers
    )
    selected = client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200, selected.text
    headers = {"X-Household-Id": str(first_household)}

    preview = preview_location(
        client,
        source_box["id"],
        second_room["id"],
        headers=headers,
    )
    assert preview["can_proceed"] is False
    assert preview["destination"] is None

    denied = transfer_location(
        client,
        source_box["id"],
        destination_room_id=second_room["id"],
        fingerprint="0" * 64,
        headers=headers,
    )
    assert denied.status_code == 422
    assert denied.json()["detail"]["code"] == "place_destination_invalid"

    hidden = client.get(
        f"/api/v1/place-management/locations/{second_box['id']}/preview",
        headers=headers,
    )
    assert hidden.status_code == 404


def test_post_move_verification_failure_rolls_back_everything(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client, "Rollback")
    destination = create_room(client, "Rollback target")
    box = create_container(client, room["id"], name="Rollback box")
    item = create_item(client, "Rollback item", room["id"], box["id"], quantity=3)
    before_items = item_count()
    preview = preview_location(client, box["id"], destination["id"])

    def fail_verification(*_args, **_kwargs):
        raise ApiError(409, "place_not_emptied", "Synthetic post-move failure.")

    monkeypatch.setattr(place_management, "_assert_location_empty", fail_verification)
    failed = transfer_location(
        client,
        box["id"],
        destination_room_id=destination["id"],
        fingerprint=preview["fingerprint"],
        delete_source=True,
    )
    assert failed.status_code == 409
    assert failed.json()["detail"]["code"] == "place_not_emptied"
    assert item_count() == before_items
    item_state = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert item_state["room"]["id"] == room["id"]
    assert item_state["location"]["id"] == box["id"]
    with SessionLocal() as db:
        assert db.get(StorageLocation, uuid.UUID(box["id"])) is not None
        assert db.get(Room, uuid.UUID(destination["id"])) is not None
        assert db.scalar(select(func.count(BorrowedRecord.id))) == 0
