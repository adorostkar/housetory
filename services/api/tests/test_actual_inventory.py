from pathlib import Path

from housetory_api.services.import_hierarchy import parse_hierarchy
from housetory_api.services.import_pipeline import process_import_batch
from housetory_api.services.import_types import ParsedDocument, SourceBundle

FIXTURE = Path(__file__).parent / "fixtures" / "home_inventory_actual.md"
ACTUAL_SOURCE = Path("/Users/ashkan/Repos/Obsidian/Areas/Home/Inventory.md")


def actual_text() -> str:
    return FIXTURE.read_text()


def upload_text(client, text: str):
    response = client.post(
        "/api/v1/imports",
        files={"file": ("Inventory.md", text.encode(), "text/markdown")},
        data={"title": "Actual inventory upload"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def paste_text(client, text: str):
    response = client.post(
        "/api/v1/imports",
        data={"text": text, "title": "Actual inventory paste"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def process(client, batch_id: str):
    process_import_batch(batch_id)
    response = client.get(f"/api/v1/imports/{batch_id}")
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, batch_id: str, entries):
    response = client.post(
        f"/api/v1/imports/{batch_id}/apply",
        json={
            "entries": [
                {
                    "id": entry["id"],
                    "action": "import",
                    "entity_type": entry["entity_type"],
                    "parent_entry_id": entry["parent_entry_id"],
                    "legacy_identifier": entry["legacy_identifier"],
                }
                for entry in entries
            ]
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_actual_inventory_parser_preserves_source_facts():
    if ACTUAL_SOURCE.exists():
        assert FIXTURE.read_bytes() == ACTUAL_SOURCE.read_bytes()
    text = actual_text()
    bundle = SourceBundle(
        documents=[
            ParsedDocument(
                relative_path="Areas/Home/Inventory.md",
                title="Home Inventory",
                text=text,
                content_type="text/markdown",
                source_format="markdown",
            )
        ],
        source_format="markdown",
    )
    parsed = parse_hierarchy(bundle)
    assert len(parsed.nodes) == 8
    assert len(parsed.items) == 52
    node_by_legacy = {
        node.legacy_identifier: node for node in parsed.nodes if node.legacy_identifier
    }
    assert set(node_by_legacy) == {"STO-01", "STO-02", "STO-03", "STO-04", "STO-05", "STO-06"}
    rooms = [node for node in parsed.nodes if node.entity_type == "room"]
    assert {room.name for room in rooms} == {"Storage", "Storage room 2"}
    storage = next(node for node in rooms if node.name == "Storage")
    storage_room = next(node for node in rooms if node.name == "Storage room 2")
    assert storage_room.parent_key == storage.key
    for legacy, node in node_by_legacy.items():
        assert node.parent_key == storage_room.key
        assert node.confidence == (45 if legacy == "STO-06" else 92)
    assert node_by_legacy["STO-06"].ambiguous is True
    assert any(warning["type"] == "ambiguous_hierarchy_group" for warning in parsed.warnings)

    by_name = {item.draft.name: item.draft for item in parsed.items}
    assert by_name["Keyboards (incl. Dell keyboard)"].quantity == 2
    assert by_name["Laser printer toner"].quantity == 3
    assert by_name["Long wood pieces (~1m)"].quantity == 10
    assert by_name["Persian carpet (6 m²)"].quantity == 1
    assert by_name["Child car seat (up to 4 years)"].quantity == 1
    assert by_name["MagSafe 2 cable"].quantity == 1
    assert by_name["Compact 5V adapter"].quantity == 1
    assert by_name["PS5 empty box"].quantity == 1
    ethernet = by_name["Ethernet cables + long ethernet cable"]
    assert ethernet.quantity == 8
    assert "Ethernet cables (7)" in (ethernet.notes or "")
    assert "long ethernet cable (1)" in (ethernet.notes or "")
    paintings = by_name["Wall-hanging paintings (3 + 2)"]
    assert paintings.quantity == 5
    assert "Includes 2 wall-hanging paintings" in (paintings.notes or "")
    assert "Includes 2 wall-hanging paintings" not in by_name

    # Index/legend/frontmatter/instruction and empty example content is excluded.
    forbidden = {
        "STO",
        "APT",
        "CAR",
        "Home Inventory (boxes) — Storage / Apartment / Car",
        "Keep categories short (KITCH, CABLE, TOOLS, KIDS, CLEAN, ELEC, PAPERS, DECOR, SPORT)",
        "Empty boxes + Switch screen protector",
        "STO-KITCH-01",
        "APT-KIDS-01",
        "CAR-TOOLS-01",
    }
    assert forbidden.isdisjoint(by_name)
    assert all(item.draft.price_cents is None for item in parsed.items)
    assert all(item.draft.purchase_date is None for item in parsed.items)
    assert not any(
        node.name in {"Apartment", "Car", "STO-KITCH-01", "APT-KIDS-01", "CAR-TOOLS-01"}
        for node in parsed.nodes
    )
    assert any(entry["title"] == "STO-KITCH-01" for entry in parsed.ignored)


def test_actual_inventory_upload_and_paste_use_hierarchy_with_ai_disabled(owner_client):
    text = actual_text()
    for batch in (upload_text(owner_client, text), paste_text(owner_client, text)):
        detail = process(owner_client, batch["id"])
        assert detail["metadata"]["hierarchy"] is True
        assert detail["metadata"]["hierarchy_nodes"] == 8
        assert detail["metadata"]["hierarchy_items"] == 52
        assert detail["metadata"]["ai_used"] is False
        assert detail["metadata"]["ai_consulted"] is False
        assert detail["status"] == "review"
        assert len(detail["entries"]) == 60


def test_actual_inventory_approved_apply_persists_relationships_and_is_idempotent(owner_client):
    batch = upload_text(owner_client, actual_text())
    detail = process(owner_client, batch["id"])
    entries = detail["entries"]
    applied = apply(owner_client, batch["id"], entries)
    assert applied["failed"] == 0, applied
    assert applied["created"] == 60

    rooms = owner_client.get("/api/v1/rooms").json()["items"]
    by_room = {room["name"]: room for room in rooms}
    assert set(by_room) == {"Storage", "Storage room 2"}
    assert by_room["Storage room 2"]["parent_id"] == by_room["Storage"]["id"]

    containers = owner_client.get("/api/v1/containers?limit=200").json()["items"]
    by_legacy = {container["legacy_identifier"]: container for container in containers}
    assert set(by_legacy) == {"STO-01", "STO-02", "STO-03", "STO-04", "STO-05", "STO-06"}
    for container in by_legacy.values():
        assert container["room_id"] == by_room["Storage room 2"]["id"]
        assert container["identifier"].startswith("BOX-")
    assert by_legacy["STO-06"]["name"] == "STO-06"

    items = owner_client.get("/api/v1/items?limit=100").json()
    assert items["total"] == 52
    by_name = {item["name"]: item for item in items["items"]}
    assert by_name["Keyboards (incl. Dell keyboard)"]["quantity"] == 2
    assert by_name["Laser printer toner"]["quantity"] == 3
    assert by_name["Ethernet cables + long ethernet cable"]["quantity"] == 8
    assert by_name["Wall-hanging paintings (3 + 2)"]["quantity"] == 5
    assert by_name["MagSafe 2 cable"]["location"]["id"] == by_legacy["STO-03"]["id"]
    assert by_name["Long wood pieces (~1m)"]["location"]["id"] == by_legacy["STO-06"]["id"]
    paintings = owner_client.get(f"/api/v1/items/{by_name['Wall-hanging paintings (3 + 2)']['id']}")
    description = paintings.json()["item"]["description"] or ""
    assert "Includes 2 wall-hanging paintings" in description

    purchases = owner_client.get("/api/v1/purchases").json()
    assert purchases["total"] == 0

    replay = apply(owner_client, batch["id"], entries)
    assert replay["created"] == 0
    assert replay["failed"] == 0
    assert replay["skipped"] == 60
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == 52


def test_actual_inventory_partial_approval_dependency_and_duplicate_guard(owner_client):
    batch = upload_text(owner_client, actual_text())
    detail = process(owner_client, batch["id"])
    entries = detail["entries"]
    storage = next(entry for entry in entries if entry["proposed"]["name"] == "Storage")
    storage_room = next(entry for entry in entries if entry["proposed"]["name"] == "Storage room 2")
    sto03 = next(entry for entry in entries if entry["legacy_identifier"] == "STO-03")
    keyboards = next(
        entry for entry in entries if entry["proposed"]["name"] == "Keyboards (incl. Dell keyboard)"
    )

    partial = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {
                    "id": keyboards["id"],
                    "action": "import",
                    "entity_type": "item",
                    "parent_entry_id": sto03["id"],
                }
            ]
        },
    )
    assert partial.status_code == 200, partial.text
    assert partial.json()["failed"] == 1
    assert "parent" in partial.json()["failures"][0]["message"].lower()
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == 0

    approved = apply(owner_client, batch["id"], [storage, storage_room, sto03, keyboards])
    assert approved["failed"] == 0, approved
    items = owner_client.get("/api/v1/items?limit=100").json()
    assert items["total"] == 1
    assert items["items"][0]["quantity"] == 2
    assert items["items"][0]["location"]["id"] is not None

    second = upload_text(owner_client, actual_text())
    duplicate_detail = process(owner_client, second["id"])
    duplicate_keyboard = next(
        entry
        for entry in duplicate_detail["entries"]
        if entry["proposed"]["name"] == "Keyboards (incl. Dell keyboard)"
    )
    assert duplicate_keyboard["duplicate_candidates"]
    duplicate_storage = next(
        entry for entry in duplicate_detail["entries"] if entry["proposed"]["name"] == "Storage"
    )
    duplicate_room = next(
        entry
        for entry in duplicate_detail["entries"]
        if entry["proposed"]["name"] == "Storage room 2"
    )
    duplicate_sto03 = next(
        entry for entry in duplicate_detail["entries"] if entry["legacy_identifier"] == "STO-03"
    )
    blocked = apply(
        owner_client,
        second["id"],
        [duplicate_storage, duplicate_room, duplicate_sto03, duplicate_keyboard],
    )
    assert blocked["failed"] == 1
    assert "duplicate" in blocked["failures"][0]["message"].lower()
    assert owner_client.get("/api/v1/items?limit=100").json()["total"] == 1


def test_actual_inventory_ai_normalizer_rejects_unsupported_edits(owner_client, monkeypatch):
    from housetory_api.schemas.ai import AiStatus
    from housetory_api.services import import_pipeline

    text = actual_text()
    bundle = SourceBundle(
        documents=[
            ParsedDocument(
                relative_path="Inventory.md",
                title="Home Inventory",
                text=text,
                content_type="text/markdown",
                source_format="markdown",
            )
        ],
        source_format="markdown",
    )
    parsed = parse_hierarchy(bundle)
    sto03 = next(node for node in parsed.nodes if node.legacy_identifier == "STO-03")
    keyboards = next(item for item in parsed.items if item.draft.name.startswith("Keyboards ("))

    status = AiStatus(
        provider="ollama",
        mode="local",
        model="test-model",
        configured=True,
        available=True,
        cloud_enabled=False,
        cloud_consent=False,
        data_leaves_server=False,
        privacy_note="Local test",
    )
    monkeypatch.setattr(import_pipeline.ai, "status_for", lambda *args, **kwargs: status)
    monkeypatch.setattr(import_pipeline.ai, "config_for", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        import_pipeline.ai,
        "complete_json",
        lambda *args, **kwargs: {
            "nodes": [
                {
                    "key": sto03.key,
                    "name": "Invented room",
                    "entity_type": "room",
                    "legacy_identifier": "FAKE-99",
                    "container_type": "crate",
                }
            ],
            "items": [
                {
                    "key": keyboards.key,
                    "name": "Invented grand piano",
                    "quantity": 999,
                }
            ],
            "warnings": [],
        },
    )

    batch = upload_text(owner_client, text)
    detail = process(owner_client, batch["id"])
    assert detail["metadata"]["hierarchy"] is True
    assert detail["metadata"]["ai_consulted"] is True
    assert detail["metadata"]["ai_used"] is False
    assert detail["metadata"]["ai_validation_warnings"]
    entry_by_name = {entry["proposed"]["name"]: entry for entry in detail["entries"]}
    keyboard = next(
        entry for entry in detail["entries"] if entry["proposed"]["name"].startswith("Keyboards (")
    )
    assert keyboard["proposed"]["quantity"] == 2
    assert "Invented grand piano" not in entry_by_name
    assert keyboard["proposed"]["name"].startswith("Keyboards (")
    container = next(entry for entry in detail["entries"] if entry["legacy_identifier"] == "STO-03")
    assert container["entity_type"] == "container"
    assert container["proposed"]["name"] == "STO-03"
    assert "Invented room" not in entry_by_name
    warnings = " ".join(
        str(warning.get("reason", warning))
        for warning in detail["metadata"]["ai_validation_warnings"]
    ).lower()
    assert "name" in warnings
    assert "quantity" in warnings
    assert "entity_type" in warnings or "entity type" in warnings
