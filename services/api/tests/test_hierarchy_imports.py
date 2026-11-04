from pathlib import Path

from housetory_api.services.import_pipeline import process_import_batch

FIXTURE = Path(__file__).parent / "fixtures" / "home_inventory.md"


def upload_markdown(client):
    content = FIXTURE.read_bytes()
    response = client.post(
        "/api/v1/imports",
        files={"file": ("home_inventory.md", content, "text/markdown")},
        data={"title": "Home Inventory fixture"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def process(client, batch_id):
    process_import_batch(batch_id)
    response = client.get(f"/api/v1/imports/{batch_id}")
    assert response.status_code == 200, response.text
    return response.json()


def apply_all(client, batch_id, entries, action="import"):
    payload = {
        "entries": [
            {
                "id": entry["id"],
                "action": action,
                "parent_entry_id": entry["parent_entry_id"],
                "legacy_identifier": entry["legacy_identifier"],
            }
            for entry in entries
        ]
    }
    response = client.post(f"/api/v1/imports/{batch_id}/apply", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_home_inventory_hierarchy_fixture(owner_client):
    batch = upload_markdown(owner_client)
    detail = process(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert detail["metadata"]["hierarchy"] is True
    assert detail["metadata"]["hierarchy_nodes"] == 14
    assert detail["metadata"]["hierarchy_items"] == 33

    entries = detail["entries"]
    nodes = [entry for entry in entries if entry["entity_type"] != "item"]
    items = [entry for entry in entries if entry["entity_type"] == "item"]
    assert {entry["entity_type"] for entry in nodes} == {"room", "container"}
    assert len(nodes) == 14
    assert len(items) == 33

    storage = next(entry for entry in nodes if entry["proposed"]["name"] == "Storage")
    storage_room = next(entry for entry in nodes if entry["proposed"]["name"] == "Storage room 2")
    assert storage_room["parent_entry_id"] == storage["id"]
    sto03 = next(entry for entry in nodes if entry["legacy_identifier"] == "STO-03")
    assert sto03["parent_entry_id"] == storage_room["id"]
    sto06 = next(entry for entry in nodes if entry["legacy_identifier"] == "STO-06")
    assert sto06["confidence"] == 45
    assert any(warning.get("type") == "ambiguous_hierarchy_group" for warning in detail["warnings"])

    keyboard = next(entry for entry in items if entry["proposed"]["name"] == "Keyboards")
    ethernet = next(entry for entry in items if entry["proposed"]["name"] == "Ethernet cables")
    assert keyboard["parent_entry_id"] == sto03["id"]
    assert keyboard["proposed"]["quantity"] == 2
    assert ethernet["proposed"]["quantity"] == 7
    assert "plus one long cable" in (ethernet["proposed"]["notes"] or "")
    assert all(entry["source_excerpt"] for entry in entries)

    # Index entries and template examples must not become inventory items.
    assert not any(entry["proposed"]["name"] == "Sample item" for entry in entries)
    assert sum(entry["proposed"]["name"] == "Empty boxes" for entry in items) == 1

    applied = apply_all(owner_client, batch["id"], entries)
    assert applied["created"] == len(entries)
    assert applied["failed"] == 0
    assert applied["batch"]["status"] == "completed"

    rooms = owner_client.get("/api/v1/rooms").json()["items"]
    by_name = {room["name"]: room for room in rooms}
    assert {"Storage", "Storage room 2", "Apartment", "Car"} <= set(by_name)
    assert by_name["Storage room 2"]["parent_id"] == by_name["Storage"]["id"]

    containers = owner_client.get("/api/v1/containers?include_fixed=true&limit=200").json()["items"]
    sto03_location = next(
        container for container in containers if container["name"] == "Cables and computer parts"
    )
    assert sto03_location["identifier"].startswith("BOX-")
    assert sto03_location["legacy_identifier"] == "STO-03"
    assert sto03_location["room_id"] == by_name["Storage room 2"]["id"]
    assert sto03_location["parent_id"] is None

    items_response = owner_client.get("/api/v1/items?limit=100").json()
    item_names = {item["name"] for item in items_response["items"]}
    assert "Keyboards" in item_names
    assert "Ethernet cables" in item_names
    assert "PhD thesis" in item_names
    assert "Sample item" not in item_names
    keyboards = next(item for item in items_response["items"] if item["name"] == "Keyboards")
    detail_item = owner_client.get(f"/api/v1/items/{keyboards['id']}").json()["item"]
    assert detail_item["quantity"] == 2
    assert detail_item["location"]["id"] == sto03_location["id"]

    again = apply_all(owner_client, batch["id"], entries)
    assert again["created"] == 0
    assert again["skipped"] == len(entries)
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == len(items)


def test_hierarchy_apply_requires_parent_and_rolls_back(owner_client):
    batch = upload_markdown(owner_client)
    detail = process(owner_client, batch["id"])
    entries = detail["entries"]
    item = next(entry for entry in entries if entry["entity_type"] == "item")
    response = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {
                    "id": item["id"],
                    "action": "import",
                    "parent_entry_id": item["parent_entry_id"],
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["failed"] == 1
    assert "parent" in body["failures"][0]["message"].lower()
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == 0
    refreshed = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert refreshed["status"] == "review"


def test_hierarchy_review_can_move_items_and_change_entity_types(owner_client):
    batch = upload_markdown(owner_client)
    detail = process(owner_client, batch["id"])
    entries = detail["entries"]
    sto02 = next(entry for entry in entries if entry["legacy_identifier"] == "STO-02")
    sto03 = next(entry for entry in entries if entry["legacy_identifier"] == "STO-03")
    ethernet = next(entry for entry in entries if entry["proposed"]["name"] == "Ethernet cables")
    # Approve the branch that creates the destination, then move the item into it.
    branch = [sto02, sto03]
    branch.extend(
        entry
        for entry in entries
        if entry["entity_type"] == "room"
        and entry["proposed"]["name"] in {"Storage", "Storage room 2"}
    )
    response = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {
                    "id": entry["id"],
                    "action": "import",
                    "entity_type": entry["entity_type"],
                    "parent_entry_id": entry["parent_entry_id"],
                }
                for entry in branch
            ]
            + [
                {
                    "id": ethernet["id"],
                    "action": "import",
                    "entity_type": "item",
                    "parent_entry_id": sto02["id"],
                    "proposed": {
                        **ethernet["proposed"],
                        "name": "Long Ethernet cable",
                        "quantity": 8,
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["failed"] == 0, response.json()
    item = next(
        entry
        for entry in owner_client.get("/api/v1/items?limit=100").json()["items"]
        if entry["name"] == "Long Ethernet cable"
    )
    assert item["quantity"] == 8
    sto02_location = next(
        entry
        for entry in owner_client.get("/api/v1/containers?limit=200").json()["items"]
        if entry["legacy_identifier"] == "STO-02"
    )
    assert item["location"]["id"] == sto02_location["id"]


def test_hierarchy_duplicate_prevention_and_override(owner_client):
    batch = upload_markdown(owner_client)
    detail = process(owner_client, batch["id"])
    entries = detail["entries"]
    applied = apply_all(owner_client, batch["id"], entries)
    assert applied["failed"] == 0

    second = upload_markdown(owner_client)
    duplicate_detail = process(owner_client, second["id"])
    duplicate_entries = duplicate_detail["entries"]
    keyboard = next(
        entry for entry in duplicate_entries if entry["proposed"]["name"] == "Keyboards"
    )
    assert keyboard["duplicate_candidates"]
    parents = [
        entry
        for entry in duplicate_entries
        if entry["id"] == keyboard["parent_entry_id"]
        or entry["entity_type"] == "room"
        and entry["proposed"]["name"] in {"Storage", "Storage room 2"}
    ]
    base_entries = [
        {
            "id": entry["id"],
            "action": "import",
            "entity_type": entry["entity_type"],
            "parent_entry_id": entry["parent_entry_id"],
        }
        for entry in parents
    ]
    blocked = owner_client.post(
        f"/api/v1/imports/{second['id']}/apply",
        json={
            "entries": base_entries
            + [
                {
                    "id": keyboard["id"],
                    "action": "import",
                    "entity_type": "item",
                    "parent_entry_id": keyboard["parent_entry_id"],
                }
            ]
        },
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["failed"] == 1
    assert "duplicate" in blocked.json()["failures"][0]["message"].lower()
    before = owner_client.get("/api/v1/items?limit=100").json()["total"]

    allowed = owner_client.post(
        f"/api/v1/imports/{second['id']}/apply",
        json={
            "entries": base_entries
            + [
                {
                    "id": keyboard["id"],
                    "action": "import",
                    "entity_type": "item",
                    "parent_entry_id": keyboard["parent_entry_id"],
                    "allow_duplicate": True,
                }
            ]
        },
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["failed"] == 0
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == before + 1
