import io

import pytest
from PIL import Image

from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai
from housetory_api.services.ocr import ExtractedText
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


def test_assistant_photo_queue_restores_attempts_converts_once_and_cancels(
    owner_client, monkeypatch
):
    fake_vision(monkeypatch, [{"name": "Photo cable", "quantity": 2, "confidence": 90}])
    uploaded = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("capture.png", make_image(), "image/png")},
        data={"assistant_capture": "true"},
    )
    assert uploaded.status_code == 201, uploaded.text
    photo_id = uploaded.json()["id"]
    path = f"/api/v1/ai/recognitions/{photo_id}"
    initial = owner_client.get("/api/v1/inventory-review/captures").json()
    assert initial[0]["kind"] == "photo"
    run_recognition(photo_id)
    assert owner_client.get(path).json()["status"] == "succeeded"
    assert (
        owner_client.get("/api/v1/inventory-review/captures").json()[0]["generation"]
        == (initial[0]["generation"])
    )
    retry = owner_client.post(f"{path}/retry")
    assert retry.status_code == 200, retry.text
    retried = owner_client.get("/api/v1/inventory-review/captures").json()
    assert retried[0]["generation"] != initial[0]["generation"]
    run_recognition(photo_id)
    converted = owner_client.post(f"/api/v1/imports/from-recognition/{photo_id}")
    assert converted.status_code == 201, converted.text
    replay = owner_client.post(f"/api/v1/imports/from-recognition/{photo_id}")
    assert replay.json()["id"] == converted.json()["id"]
    queue = owner_client.get("/api/v1/inventory-review/captures").json()
    assert [(entry["kind"], entry["id"]) for entry in queue] == [("import", converted.json()["id"])]
    assert owner_client.get("/api/v1/items").json()["items"] == []
    entry = converted.json()["entries"][0]
    assert entry["proposed"]["name"] == "Photo cable"
    assert entry["proposed"]["quantity"] == 2
    applied = owner_client.post(
        f"/api/v1/imports/{converted.json()['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    assert owner_client.get("/api/v1/items").json()["items"][0]["quantity"] == 2
    assert owner_client.get("/api/v1/inventory-review/captures").json() == []
    cancelled = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("cancel.png", make_image(), "image/png")},
        data={"assistant_capture": "true"},
    )
    assert len(owner_client.get("/api/v1/inventory-review/captures").json()) == 1
    deleted = owner_client.delete(f"/api/v1/ai/recognitions/{cancelled.json()['id']}")
    assert deleted.status_code == 204
    assert owner_client.get("/api/v1/inventory-review/captures").json() == []


@pytest.mark.parametrize(
    ("caption", "phrases", "target"),
    [
        ("A synthetic test box in Storage.", None, "room"),
        ("A synthetic test box in Camera gear.", None, "container"),
        ("این جعبه در Camera gear در Office است", ["Camera gear", "Office"], "container"),
        ("A cardboard box.", [], None),
        ("A box in Storage. Also buy an off-image laptop.", ["Storage"], "room"),
    ],
)
def test_assistant_photo_caption_resolves_destination_before_explicit_apply(
    owner_client, monkeypatch, caption, phrases, target
):
    room = owner_client.post("/api/v1/rooms", json={"name": "Storage"}).json()
    office = create_room(owner_client)
    container = create_container(owner_client, office["id"])
    fake_vision(monkeypatch, [{"name": "Cardboard box", "quantity": 1, "confidence": 90}])
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *args, **kwargs: {
            "suggestions": [{"name": "Cardboard box", "quantity": 1, "confidence": 90}],
            "destination_phrases": phrases,
        },
    )
    uploaded = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("box.png", make_image(), "image/png")},
        data={"assistant_capture": "true", "text": caption},
    )
    assert uploaded.status_code == 201, uploaded.text
    run_recognition(uploaded.json()["id"])
    converted = owner_client.post(f"/api/v1/imports/from-recognition/{uploaded.json()['id']}")
    assert converted.status_code == 201, converted.text
    batch = converted.json()
    assert len(batch["entries"]) == 1
    proposed = batch["entries"][0]["proposed"]
    assert proposed["name"] == "Cardboard box"
    if target is None:
        assert proposed["room"] is None
        assert proposed["storage_location"] is None
    else:
        destination_room = office if target == "container" else room
        assert proposed["room"]["matched_id"] == destination_room["id"]
        if target == "container":
            assert proposed["storage_location"]["matched_id"] == container["id"]
    assert batch["metadata"]["ai_used"] is True
    assert batch["metadata"]["ai_provider"] == "openai"
    assert batch["metadata"]["ai_model"] == "gpt-4o"
    assert batch["metadata"]["extraction_method"] == "vision"
    assert batch["entries"][0]["source_excerpt"] == caption
    replay = owner_client.post(f"/api/v1/imports/from-recognition/{uploaded.json()['id']}")
    assert replay.json()["id"] == batch["id"]
    assert owner_client.get("/api/v1/items").json()["items"] == []
    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": batch["entries"][0]["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    saved = owner_client.get("/api/v1/items").json()["items"]
    assert len(saved) == 1
    if target is None:
        assert saved[0]["room"] is None
    else:
        assert saved[0]["room"]["id"] == destination_room["id"]
        if target == "container":
            assert saved[0]["location"]["id"] == container["id"]
    reapplied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": batch["entries"][0]["id"], "action": "import"}]},
    )
    assert reapplied.status_code == 200, reapplied.text
    assert len(owner_client.get("/api/v1/items").json()["items"]) == 1


@pytest.mark.parametrize("kind", ["room", "container"])
def test_photo_caption_ambiguous_destination_requires_reviewed_choice(
    owner_client, monkeypatch, kind
):
    office = create_room(owner_client)
    other = owner_client.post("/api/v1/rooms", json={"name": "Workshop"}).json()
    if kind == "room":
        first = owner_client.post(
            "/api/v1/rooms", json={"name": "Storage", "parent_id": office["id"]}
        ).json()
        second = owner_client.post(
            "/api/v1/rooms", json={"name": "Storage", "parent_id": other["id"]}
        ).json()
        caption = "A test box in Storage."
    else:
        first = create_container(owner_client, office["id"])
        second = create_container(owner_client, other["id"])
        caption = "A test box in Camera gear."
    fake_vision(monkeypatch, [{"name": "Cardboard box", "quantity": 1}])
    uploaded = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("box.png", make_image(), "image/png")},
        data={"assistant_capture": "true", "text": caption},
    )
    run_recognition(uploaded.json()["id"])
    batch = owner_client.post(f"/api/v1/imports/from-recognition/{uploaded.json()['id']}").json()
    entry = batch["entries"][0]
    destination = entry["proposed"]["room" if kind == "room" else "storage_location"]
    assert destination["status"] == "ambiguous"
    assert destination["matched_id"] is None
    assert {value["id"] for value in destination["candidates"]} == {first["id"], second["id"]}
    assert owner_client.get("/api/v1/items").json()["items"] == []
    unresolved = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert unresolved.status_code == 200, unresolved.text
    assert unresolved.json()["failed"] == 1
    assert owner_client.get("/api/v1/items").json()["items"] == []
    room_id = second["id"] if kind == "room" else other["id"]
    destination.update(status="matched", matched_id=second["id"], room_id=room_id)
    approved = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import", "proposed": entry["proposed"]}]},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["created"] == 1
    saved = owner_client.get("/api/v1/items").json()["items"][0]
    assert saved["room"]["id"] == room_id
    if kind == "container":
        assert saved["location"]["id"] == second["id"]


def test_photo_caption_destination_respects_property_scope(owner_client, monkeypatch):
    first_room = owner_client.post("/api/v1/rooms", json={"name": "Storage"}).json()
    first_property = owner_client.get("/api/v1/properties").json()["items"][0]
    second_property = owner_client.post("/api/v1/properties", json={"name": "Annex"}).json()
    second_room = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Storage", "property_id": second_property["id"]},
    ).json()
    fake_vision(monkeypatch, [{"name": "Cardboard box", "quantity": 1}])
    uploaded = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("box.png", make_image(), "image/png")},
        data={
            "assistant_capture": "true",
            "text": "A test box in Storage.",
            "property_id": second_property["id"],
        },
    )
    assert uploaded.status_code == 201, uploaded.text
    run_recognition(uploaded.json()["id"])
    batch = owner_client.post(f"/api/v1/imports/from-recognition/{uploaded.json()['id']}").json()
    entry = batch["entries"][0]
    assert batch["metadata"]["context"]["property_id"] == second_property["id"]
    assert entry["proposed"]["room"]["matched_id"] == second_room["id"]
    assert entry["proposed"]["room"]["matched_id"] != first_room["id"]
    assert second_property["id"] != first_property["id"]
    assert owner_client.get("/api/v1/items").json()["items"] == []
    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    assert owner_client.get("/api/v1/items").json()["items"][0]["room"]["id"] == second_room["id"]


@pytest.mark.parametrize("destination", ["Office", "..."])
def test_photo_caption_rejects_ungrounded_ai_destination(owner_client, monkeypatch, destination):
    create_room(owner_client)
    fake_vision(monkeypatch, [{"name": "Cardboard box"}])
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *args, **kwargs: {
            "suggestions": [{"name": "Cardboard box"}],
            "destination_phrases": [destination],
        },
    )
    uploaded = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("box.png", make_image(), "image/png")},
        data={"assistant_capture": "true", "text": "A cardboard box."},
    )
    run_recognition(uploaded.json()["id"])
    batch = owner_client.post(f"/api/v1/imports/from-recognition/{uploaded.json()['id']}").json()
    assert batch["entries"][0]["proposed"]["room"] is None
    assert batch["entries"][0]["proposed"]["storage_location"] is None
    assert any(warning["type"] == "caption_destination" for warning in batch["warnings"])
    assert owner_client.get("/api/v1/items").json()["items"] == []


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


def test_recognition_never_uses_text_model_without_vision_task(owner_client, monkeypatch):
    owner_client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Text only",
            "base_url": "https://api.openai.com/v1",
            "default_model": "plain-text-model",
            "api_key": "sk-test-not-real",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("label.png", make_image(), "image/png")},
    ).json()

    from housetory_api.services import recognition as recognition_service

    monkeypatch.setattr(
        recognition_service,
        "extract_text",
        lambda path, content_type: ExtractedText(
            text="ACME TOASTER\nModel: T-100", confidence=88, source="ocr"
        ),
    )
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("vision must not run")),
    )
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["processing_path"] == "ocr"
    assert detail["model_name"] is None
    assert detail["model_provider"] is None
    batch = owner_client.post(f"/api/v1/imports/from-recognition/{recognition['id']}").json()
    assert batch["metadata"]["ai_used"] is False
    assert batch["metadata"]["extraction_method"] == "ocr"
    assert batch["metadata"]["ai_model"] is None
    assert batch["entries"][0]["note_title"] == "OCR photo recognition"
    assert any(
        "No vision task is configured" in warning for warning in detail["result"]["warnings"]
    )


def test_vision_fixtures_and_uncertain_observations_are_flagged(owner_client, monkeypatch):
    room = create_room(owner_client)
    container = create_container(owner_client, room["id"])
    fake_vision(
        monkeypatch,
        [
            {"name": "Window", "confidence": 82, "field_sources": {"name": "inferred"}},
            {"name": "Portable heater", "confidence": 80, "field_sources": {"name": "inferred"}},
            {"name": "Radiator", "confidence": 78, "field_sources": {"name": "inferred"}},
            {"name": "Mystery object", "confidence": 22, "field_sources": {"name": "inferred"}},
        ],
    )
    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("room.png", make_image(), "image/png")},
        data={"room_id": room["id"], "location_id": container["id"]},
    ).json()
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["processing_path"] == "vision"
    suggestions = {item["name"]: item for item in detail["result"]["suggestions"]}
    assert suggestions["Window"]["review"] is True
    assert "fixed" in suggestions["Window"]["review_reason"].lower()
    assert suggestions["Radiator"]["review"] is True
    assert "radiator" in suggestions["Radiator"]["review_reason"].lower()
    assert suggestions["Portable heater"]["review"] is False
    assert suggestions["Mystery object"]["review"] is True
    assert "low-confidence" in suggestions["Mystery object"]["review_reason"].lower()


def _create_vision_recognition(client, *, room_id=None, location_id=None):
    data = {}
    if room_id is not None:
        data["room_id"] = room_id
    if location_id is not None:
        data["location_id"] = location_id
    response = client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("item.png", make_image(), "image/png")},
        data=data,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _run_fake_vision(owner_client, monkeypatch, name="Camera body", **destination):
    fake_vision(
        monkeypatch,
        [
            {
                "name": name,
                "confidence": 88,
                "field_sources": {"name": "inferred"},
            }
        ],
    )
    recognition = _create_vision_recognition(owner_client, **destination)
    run_recognition(recognition["id"])
    return owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()


def test_room_only_and_container_destinations_persist_relationships(owner_client, monkeypatch):
    room = create_room(owner_client)
    other_room = owner_client.post("/api/v1/rooms", json={"name": "Garage"}).json()
    container = create_container(owner_client, room["id"])

    room_only = _run_fake_vision(owner_client, monkeypatch, name="Room camera", room_id=room["id"])
    assert room_only["room_id"] == room["id"]
    assert room_only["location_id"] is None
    applied = owner_client.post(
        f"/api/v1/ai/recognitions/{room_only['id']}/apply",
        json={"entries": [{"suggestion_index": 0, "action": "create"}]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 1
    item = next(
        entry
        for entry in owner_client.get("/api/v1/items?limit=50").json()["items"]
        if entry["name"] == "Room camera"
    )
    assert item["room"]["id"] == room["id"]
    assert item["location"] is None

    location_only = _run_fake_vision(
        owner_client,
        monkeypatch,
        name="Container camera",
        location_id=container["id"],
    )
    assert location_only["room_id"] == room["id"]
    assert location_only["location_id"] == container["id"]
    applied = owner_client.post(
        f"/api/v1/ai/recognitions/{location_only['id']}/apply",
        json={"entries": [{"suggestion_index": 0, "action": "create"}]},
    )
    assert applied.status_code == 200, applied.text
    item = next(
        entry
        for entry in owner_client.get("/api/v1/items?limit=50").json()["items"]
        if entry["name"] == "Container camera"
    )
    assert item["room"]["id"] == room["id"]
    assert item["location"]["id"] == container["id"]

    mismatch = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("mismatch.png", make_image(), "image/png")},
        data={"room_id": other_room["id"], "location_id": container["id"]},
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "location_room_mismatch"

    switch = _run_fake_vision(owner_client, monkeypatch, name="Switch camera", room_id=room["id"])
    blocked = owner_client.post(
        f"/api/v1/ai/recognitions/{switch['id']}/apply",
        json={
            "entries": [
                {
                    "suggestion_index": 0,
                    "action": "create",
                    "room_id": other_room["id"],
                    "location_id": container["id"],
                }
            ]
        },
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["failed"] == 1
    assert "different room" in blocked.json()["failures"][0]["message"].lower()

    clear = _run_fake_vision(
        owner_client, monkeypatch, name="Clear camera", location_id=container["id"]
    )
    applied = owner_client.post(
        f"/api/v1/ai/recognitions/{clear['id']}/apply",
        json={
            "entries": [
                {
                    "suggestion_index": 0,
                    "action": "create",
                    "room_id": room["id"],
                    "location_id": None,
                }
            ]
        },
    )
    assert applied.status_code == 200, applied.text
    item = owner_client.get(
        f"/api/v1/items/{applied.json()['recognition']['applied_items'][0]['item_id']}"
    ).json()["item"]
    assert item["room"]["id"] == room["id"]
    assert item["location"] is None


def test_receipt_photo_is_routed_as_document_without_ocr_model(owner_client, monkeypatch):
    from housetory_api.services import recognition as recognition_service

    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("receipt.png", make_image(), "image/png")},
    ).json()
    receipt = "Clas Ohlson\nKVITTO\nStrykbrada 249.00\nStrykjarn 499.00\nMOMS 149.60\nTotal 748.00"
    monkeypatch.setattr(
        recognition_service,
        "extract_text",
        lambda path, content_type: ExtractedText(text=receipt, confidence=70, source="ocr"),
    )
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["result"]["is_document"] is True
    assert detail["result"]["document_type"] == "receipt"
    assert detail["result"]["suggestions"] == []


def test_vision_document_verdict_drops_suggestions(owner_client, monkeypatch):
    fake_vision(monkeypatch, [{"name": "Paper receipt", "quantity": 1}])
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *args, **kwargs: {
            "is_document": True,
            "document_type": "invoice",
            "suggestions": [{"name": "Paper receipt", "quantity": 1}],
            "warnings": [],
        },
    )
    recognition = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("invoice.png", make_image(), "image/png")},
    ).json()
    run_recognition(recognition["id"])
    detail = owner_client.get(f"/api/v1/ai/recognitions/{recognition['id']}").json()
    assert detail["result"]["is_document"] is True
    assert detail["result"]["document_type"] == "invoice"
    assert detail["result"]["suggestions"] == []
