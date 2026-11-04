from housetory_api.services.import_pipeline import process_import_batch


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_location(client, room_id, name, kind="shelf"):
    response = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_id, "name": name, "kind": kind},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", "name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def process(client, batch_id):
    process_import_batch(batch_id)
    response = client.get(f"/api/v1/imports/{batch_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_import_context_defaults_only_when_source_has_no_destination(owner_client):
    office = create_room(owner_client, "Context Office")
    shelf = create_location(owner_client, office["id"], "Context Shelf")
    attic = create_room(owner_client, "Context Attic")
    box = create_container(owner_client, attic["id"], "Context Box")

    response = owner_client.post(
        "/api/v1/imports",
        data={
            "text": "- Camera charger",
            "title": "Context default",
            "room_id": office["id"],
            "location_id": shelf["id"],
        },
    )
    assert response.status_code == 201, response.text
    batch = response.json()
    detail = process(owner_client, batch["id"])
    assert detail["metadata"]["context"]["room_id"] == office["id"]
    assert detail["metadata"]["context"]["location_id"] == shelf["id"]
    entry = detail["entries"][0]
    assert entry["proposed"]["room"]["matched_id"] == office["id"]
    assert entry["proposed"]["storage_location"]["matched_id"] == shelf["id"]
    assert entry["proposed"]["field_sources"]["room"] == "inferred"
    assert entry["proposed"]["field_sources"]["storage_location"] == "inferred"

    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {
                    "id": entry["id"],
                    "action": "import",
                    "proposed": entry["proposed"],
                }
            ]
        },
    )
    assert applied.status_code == 200, applied.text
    applied_entry = applied.json()["batch"]["entries"][0]
    item = owner_client.get(f"/api/v1/items/{applied_entry['imported_item_id']}").json()["item"]
    assert item["room"]["id"] == office["id"]
    assert item["location"]["id"] == shelf["id"]

    explicit_room = owner_client.post(
        "/api/v1/imports",
        data={
            "text": "- Passport in Context Attic",
            "title": "Explicit room",
            "room_id": office["id"],
            "location_id": shelf["id"],
        },
    ).json()
    explicit_detail = process(owner_client, explicit_room["id"])
    explicit_entry = explicit_detail["entries"][0]
    assert explicit_entry["proposed"]["room"]["matched_id"] == attic["id"]
    assert explicit_entry["proposed"]["storage_location"] is None

    explicit_container = owner_client.post(
        "/api/v1/imports",
        data={
            "text": f"- Travel adapter in {box['identifier']}",
            "title": "Explicit container",
            "room_id": office["id"],
            "location_id": shelf["id"],
        },
    ).json()
    container_detail = process(owner_client, explicit_container["id"])
    container_entry = container_detail["entries"][0]
    assert container_entry["proposed"]["storage_location"]["matched_id"] == box["id"]
    assert container_entry["proposed"]["room"]["matched_id"] == attic["id"]


def test_import_context_does_not_override_source_hierarchy(owner_client):
    office = create_room(owner_client, "Context Office")
    shelf = create_location(owner_client, office["id"], "Context Shelf")
    markdown = "# Source hierarchy\n\n### QSR-01 (Source room)\n- Legacy source item\n"
    response = owner_client.post(
        "/api/v1/imports",
        files={"file": ("source.md", markdown.encode(), "text/markdown")},
        data={
            "title": "Hierarchy context",
            "room_id": office["id"],
            "location_id": shelf["id"],
        },
    )
    batch = response.json()
    detail = process(owner_client, batch["id"])
    assert detail["metadata"]["hierarchy"] is True
    nodes = [entry for entry in detail["entries"] if entry["entity_type"] != "item"]
    item = next(entry for entry in detail["entries"] if entry["entity_type"] == "item")
    source_room = next(entry for entry in nodes if entry["proposed"]["name"] == "Source room")
    container = next(entry for entry in nodes if entry["legacy_identifier"] == "QSR-01")
    assert source_room["parent_entry_id"] is None
    assert container["parent_entry_id"] == source_room["id"]
    assert item["parent_entry_id"] == container["id"]
    assert item["proposed"]["room"] is None


def test_import_context_rejects_other_household_targets(owner_client):
    from tests.test_cross_household import _other_household_headers

    other = _other_household_headers()
    with owner_client as client:
        response = client.post(
            "/api/v1/imports",
            data={
                "text": "- Private context item",
                "room_id": str(other["household_id"]),
            },
        )
    assert response.status_code == 404


def test_import_context_requires_matching_room_and_location(owner_client):
    office = create_room(owner_client, "Office A")
    other = create_room(owner_client, "Office B")
    shelf = create_location(owner_client, other["id"], "Shelf B")
    response = owner_client.post(
        "/api/v1/imports",
        data={
            "text": "- Item",
            "room_id": office["id"],
            "location_id": shelf["id"],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "context_mismatch"
