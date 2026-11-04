import io

from PIL import Image

from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai
from housetory_api.services.recognition import run_recognition


def make_image():
    buffer = io.BytesIO()
    Image.new("RGB", (140, 100), (90, 80, 70)).save(buffer, format="PNG")
    return buffer.getvalue()


def create_room(client):
    return client.post("/api/v1/rooms", json={"name": "Office"}).json()


def create_container(client, room_id):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", "name": "Camera gear"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def fake_vision(monkeypatch, suggestions):
    status = AiStatus(
        provider="openai",
        mode="cloud",
        model="gpt-4o",
        configured=True,
        available=True,
        cloud_enabled=True,
        cloud_consent=True,
        data_leaves_server=True,
        privacy_note="Cloud",
    )
    monkeypatch.setattr(ai, "status_for", lambda *args, **kwargs: status)
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *args, **kwargs: {"suggestions": suggestions, "warnings": []},
    )


def test_multi_object_recognition_review_and_idempotent_apply(owner_client, monkeypatch):
    room = create_room(owner_client)
    container = create_container(owner_client, room["id"])
    fake_vision(
        monkeypatch,
        [
            {
                "name": "Camera body",
                "quantity": 1,
                "category": "Electronics",
                "brand": "Acme",
                "model": "C-1",
                "confidence": 88,
                "field_sources": {"name": "inferred", "brand": "inferred"},
            },
            {
                "name": "USB-C cables",
                "quantity": 3,
                "category": "Electronics",
                "confidence": 74,
                "field_sources": {"name": "inferred"},
            },
        ],
    )
    response = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("gear.png", make_image(), "image/png")},
        data={"location_id": container["id"]},
    )
    assert response.status_code == 201, response.text
    recognition = response.json()
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["processing_mode"] == "cloud"
    assert detail["model_name"] == "gpt-4o"
    assert detail["location_id"] == container["id"]
    assert detail["location_label"] == "BOX-001"
    assert len(detail["result"]["suggestions"]) == 2

    apply = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={
            "entries": [
                {"suggestion_index": 0, "action": "create"},
                {"suggestion_index": 1, "action": "create"},
                {"suggestion_index": 1, "action": "reject"},
            ]
        },
    )
    assert apply.status_code == 200, apply.text
    body = apply.json()
    assert body["created"] == 2
    assert body["rejected"] == 1
    assert body["recognition"]["applied_at"] is not None
    assert len(body["recognition"]["applied_items"]) == 2
    items = owner_client.get("/api/v1/items?limit=50").json()["items"]
    assert {item["name"] for item in items} == {"Camera body", "USB-C cables"}
    assert all(item["location"]["id"] == container["id"] for item in items)
    assert next(item for item in items if item["name"] == "USB-C cables")["quantity"] == 3

    replay = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={
            "entries": [
                {"suggestion_index": 0, "action": "create"},
                {"suggestion_index": 1, "action": "create"},
            ]
        },
    )
    assert replay.status_code == 200
    assert replay.json()["created"] == 0
    assert replay.json()["skipped"] == 2
    assert owner_client.get("/api/v1/items?limit=50").json()["total"] == 2


def test_recognition_update_existing_and_duplicate_guard(owner_client, monkeypatch):
    room = create_room(owner_client)
    container = create_container(owner_client, room["id"])
    existing = owner_client.post(
        "/api/v1/items",
        json={"name": "Camera body", "room_id": room["id"], "storage_location_id": container["id"]},
    ).json()["item"]
    fake_vision(
        monkeypatch,
        [
            {
                "name": "Camera body",
                "quantity": 1,
                "brand": "Acme",
                "confidence": 90,
                "field_sources": {"name": "inferred"},
            }
        ],
    )
    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("camera.png", make_image(), "image/png")},
        data={"location_id": container["id"]},
    ).json()
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["suggestion_duplicates"]
    blocked = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={"entries": [{"suggestion_index": 0, "action": "create"}]},
    )
    assert blocked.status_code == 200
    assert blocked.json()["failed"] == 1
    assert "duplicate" in blocked.json()["failures"][0]["message"].lower()

    updated = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={
            "entries": [
                {
                    "suggestion_index": 0,
                    "action": "update",
                    "item_id": existing["id"],
                }
            ]
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["updated"] == 1
    item = owner_client.get(f"/api/v1/items/{existing['id']}").json()["item"]
    assert item["brand"] == "Acme"
    assert owner_client.get("/api/v1/items?limit=50").json()["total"] == 1


def test_recognition_split_entries_same_suggestion_are_distinct_and_idempotent(
    owner_client, monkeypatch
):
    room = create_room(owner_client)
    container = create_container(owner_client, room["id"])
    fake_vision(
        monkeypatch,
        [
            {
                "name": "Camera kit",
                "quantity": 1,
                "confidence": 80,
                "field_sources": {"name": "inferred"},
            }
        ],
    )
    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("kit.png", make_image(), "image/png")},
        data={"location_id": container["id"]},
    ).json()
    run_recognition(recognition["id"])
    entries = [
        {
            "suggestion_index": 0,
            "entry_key": "0",
            "action": "create",
            "proposal": {
                "name": "Camera kit",
                "quantity": 1,
                "field_sources": {"name": "inferred"},
            },
        },
        {
            "suggestion_index": 0,
            "entry_key": "0-split-1",
            "action": "create",
            "allow_duplicate": True,
            "proposal": {
                "name": "Camera kit (split)",
                "quantity": 1,
                "field_sources": {"name": "inferred"},
            },
        },
    ]
    applied = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={"entries": entries},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 2
    assert len(applied.json()["recognition"]["applied_items"]) == 2
    assert {item["entry_key"] for item in applied.json()["recognition"]["applied_items"]} == {
        "0",
        "0-split-1",
    }
    assert owner_client.get("/api/v1/items?limit=50").json()["total"] == 2

    replay = owner_client.post(
        f"/api/v1/ai/recognitions/{recognition['id']}/apply",
        json={"entries": entries},
    )
    assert replay.status_code == 200
    assert replay.json()["created"] == 0
    assert replay.json()["skipped"] == 2
    assert owner_client.get("/api/v1/items?limit=50").json()["total"] == 2
