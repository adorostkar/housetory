import io
import zipfile

import pytest
from PIL import Image

from housetory_api.services.import_pipeline import process_import_batch


def create_room(client, name, parent_id=None):
    response = client.post(
        "/api/v1/rooms", json={"name": name, **({"parent_id": parent_id} if parent_id else {})}
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_location(client, room_id, name, kind="box"):
    response = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_id, "name": name, "kind": kind},
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload_text_import(client, text, title="Notes"):
    response = client.post(
        "/api/v1/imports",
        data={"text": text, "title": title},
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload_file_import(client, name, content, content_type, title=None):
    response = client.post(
        "/api/v1/imports",
        files={"file": (name, content, content_type)},
        data={"title": title or name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def process_import(client, batch_id):
    process_import_batch(batch_id)
    response = client.get(f"/api/v1/imports/{batch_id}")
    assert response.status_code == 200, response.text
    return response.json()


def jpeg_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (80, 60), (90, 100, 80)).save(buffer, format="JPEG")
    return buffer.getvalue()


def make_vault(notes: dict[str, str], attachments: dict[str, bytes] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, text in notes.items():
            archive.writestr(path, text)
        for path, content in (attachments or {}).items():
            archive.writestr(path, content)
    return buffer.getvalue()


def make_xlsx(rows: list[list[str]]) -> bytes:
    buffer = io.BytesIO()
    sheet_rows = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for column_index, value in enumerate(row):
            column = chr(65 + column_index)
            cells.append(f'<c r="{column}{row_index}" t="inlineStr"><is><t>{value}</t></is></c>')
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{''.join(sheet_rows)}</sheetData></worksheet>",
        )
    return buffer.getvalue()


def make_docx(paragraphs: list[str], table: list[list[str]] | None = None) -> bytes:
    buffer = io.BytesIO()
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs)
    if table:
        rows = "".join(
            "<w:tr>"
            + "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row)
            + "</w:tr>"
            for row in table
        )
        body += f"<w:tbl>{rows}</w:tbl>"
    document = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


def test_text_import_extracts_natural_language_and_matches_locations(owner_client):
    attic = create_room(owner_client, "Attic")
    office = create_room(owner_client, "Office")
    guest = create_room(owner_client, "Guest Bedroom")
    create_location(owner_client, attic["id"], "Blue Boxes", "box")
    create_location(owner_client, office["id"], "Cupboard", "cabinet")
    create_location(owner_client, office["id"], "Desk", "drawer")

    text = (
        "Winter clothes are in the blue boxes in the attic. "
        "Camera equipment is in the office cupboard. "
        "Two suitcases are stored under the guest bed. "
        "My old MacBook is in the desk drawer."
    )
    batch = upload_text_import(owner_client, text)
    assert batch["status"] == "queued"
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    entries = {entry["proposed"]["name"]: entry for entry in detail["entries"]}
    assert set(entries) == {"Winter clothes", "Camera equipment", "Suitcases", "MacBook"}
    assert entries["Suitcases"]["proposed"]["quantity"] == 2
    winter = entries["Winter clothes"]["proposed"]
    assert winter["room"]["status"] == "matched"
    assert winter["room"]["name"] == "Attic"
    assert winter["storage_location"]["status"] == "matched"
    assert winter["storage_location"]["name"] == "Blue Boxes"
    camera = entries["Camera equipment"]["proposed"]
    assert camera["room"]["name"] == "Office"
    assert camera["storage_location"]["name"] == "Cupboard"
    suitcases = entries["Suitcases"]["proposed"]
    assert suitcases["room"]["name"] == "Guest Bedroom"
    assert suitcases["storage_location"]["status"] == "missing"
    assert suitcases["storage_location"]["name"] == "Under the bed"
    macbook = entries["MacBook"]["proposed"]
    assert macbook["room"]["name"] == "Office"
    assert macbook["storage_location"]["name"] == "Desk"

    under_bed = create_location(owner_client, guest["id"], "Under the bed", "other")
    suitcase_entry = entries["Suitcases"]
    suitcase_proposed = dict(suitcase_entry["proposed"])
    suitcase_proposed["storage_location"] = {
        **suitcase_proposed["storage_location"],
        "status": "matched",
        "matched_id": under_bed["id"],
        "name": "Under the bed",
        "room_id": guest["id"],
    }
    apply_payload = {
        "entries": [
            {
                "id": entry["id"],
                "action": "import",
                **({"proposed": suitcase_proposed} if entry["id"] == suitcase_entry["id"] else {}),
            }
            for entry in detail["entries"]
        ]
    }
    applied = owner_client.post(f"/api/v1/imports/{batch['id']}/apply", json=apply_payload)
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["created"] == 4
    assert result["batch"]["status"] == "completed"
    assert result["batch"]["imported_entries"] == 4

    items = owner_client.get("/api/v1/items").json()
    assert items["total"] == 4
    created = {item["name"]: item for item in items["items"]}
    assert created["Suitcases"]["quantity"] == 2
    assert created["Winter clothes"]["room"]["name"] == "Attic"
    assert created["MacBook"]["location"]["name"] == "Desk"
    assert created["Suitcases"]["location"]["name"] == "Under the bed"

    replay = owner_client.post(f"/api/v1/imports/{batch['id']}/apply", json=apply_payload)
    assert replay.status_code == 200, replay.text
    assert replay.json()["created"] == 0
    assert replay.json()["skipped"] == 4
    assert owner_client.get("/api/v1/items").json()["total"] == 4

    source = owner_client.get(f"/api/v1/imports/{batch['id']}/source")
    assert source.status_code == 200
    assert source.headers["cache-control"] == "private, no-store"
    assert source.content.decode("utf-8") == text


def test_assistant_item_description_keeps_quantity_and_named_destination(owner_client):
    room = create_room(owner_client, "Utility Room")
    box = create_location(owner_client, room["id"], "Box 2", "box")
    batch = upload_text_import(
        owner_client,
        "I bought three Ethernet cables; put them in box 2.",
        title="Assistant item description",
    )
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert len(detail["entries"]) == 1
    proposed = detail["entries"][0]["proposed"]
    assert proposed["quantity"] == 3
    assert proposed["storage_location"]["status"] == "matched"
    assert proposed["storage_location"]["matched_id"] == box["id"]
    assert proposed["room"]["matched_id"] == room["id"]
    assert proposed["purchase"] is None


@pytest.mark.parametrize(
    ("text", "quantity"),
    [
        ("Add a Validation Monitor to Storage", 1),
        ("Add one Validation Monitor to Storage", 1),
        ("Could you add a Validation Monitor to Storage?", 1),
        ("Create a Validation Monitor in Storage.", 1),
        ("یک Validation Monitor را به Storage اضافه کن", 1),
        ("سه کابل اترنت را به Storage اضافه کن", 3),
        ("I bought three Ethernet cables; put them in box 2.", 3),
    ],
)
def test_natural_creation_text_produces_reviewable_item_and_saves_explicitly(
    owner_client, text, quantity
):
    room = create_room(owner_client, "Utility Room")
    location_name = "Box 2" if "Ethernet" in text else "Storage"
    location = create_location(owner_client, room["id"], location_name)
    batch = upload_text_import(owner_client, text, title="Assistant item description")
    detail = process_import(owner_client, batch["id"])

    assert detail["status"] == "review"
    assert detail["ignored_notes"] == []
    assert len(detail["entries"]) == 1
    entry = detail["entries"][0]
    proposed = entry["proposed"]
    expected_name = (
        "Ethernet cables"
        if "Ethernet" in text
        else "کابل اترنت"
        if "کابل اترنت" in text
        else "Validation Monitor"
    )
    assert proposed["name"] == expected_name
    assert proposed["quantity"] == quantity
    assert proposed["purchase"] is None
    assert proposed["storage_location"]["status"] == "matched"
    assert proposed["storage_location"]["matched_id"] == location["id"]
    assert proposed["room"]["matched_id"] == room["id"]
    assert owner_client.get("/api/v1/items").json()["total"] == 0

    apply_payload = {
        "entries": [
            {
                "id": entry["id"],
                "action": "import",
                "proposed": proposed,
            }
        ]
    }
    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply", json=apply_payload
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 1

    items = owner_client.get("/api/v1/items").json()
    assert items["total"] == 1
    created = items["items"][0]
    assert created["name"] == expected_name
    assert created["quantity"] == quantity
    assert created["location"]["id"] == location["id"]

    replay = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply", json=apply_payload
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["created"] == 0
    assert replay.json()["skipped"] == 1
    assert owner_client.get("/api/v1/items").json()["total"] == 1


def test_natural_creation_with_duplicate_place_name_requires_resolution(owner_client):
    house = create_room(owner_client, "House")
    annex = create_room(owner_client, "Annex")
    first_room = create_room(owner_client, "Storage", house["id"])
    second_room = create_room(owner_client, "Storage", annex["id"])
    batch = upload_text_import(owner_client, "Add a Validation Monitor to Storage")

    detail = process_import(owner_client, batch["id"])

    assert detail["ignored_notes"] == []
    assert len(detail["entries"]) == 1
    proposed = detail["entries"][0]["proposed"]
    destination = proposed["room"]
    assert destination["status"] == "ambiguous"
    assert destination["matched_id"] is None
    assert {candidate["id"] for candidate in destination["candidates"]} == {
        first_room["id"],
        second_room["id"],
    }


def test_natural_creation_duplicate_can_be_skipped_without_creating_another_item(
    owner_client,
):
    room = create_room(owner_client, "Utility Room")
    existing = owner_client.post(
        "/api/v1/items",
        json={"name": "Validation Monitor", "room_id": room["id"]},
    ).json()["item"]
    batch = upload_text_import(owner_client, "Add a Validation Monitor to Utility Room")
    detail = process_import(owner_client, batch["id"])

    assert len(detail["entries"]) == 1
    entry = detail["entries"][0]
    assert entry["duplicate_candidates"][0]["item_id"] == existing["id"]

    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "skip"}]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 0
    assert applied.json()["skipped"] == 1
    assert owner_client.get("/api/v1/items").json()["total"] == 1


def test_import_duplicate_detection_and_skip(owner_client):
    kitchen = create_room(owner_client, "Kitchen")
    existing = owner_client.post(
        "/api/v1/items",
        json={"name": "Espresso Machine", "brand": "La Marzocco", "room_id": kitchen["id"]},
    ).json()["item"]
    batch = upload_text_import(owner_client, "Espresso Machine is in the kitchen.")
    detail = process_import(owner_client, batch["id"])
    entry = detail["entries"][0]
    assert entry["duplicate_candidates"][0]["item_id"] == existing["id"]
    assert entry["duplicate_candidates"][0]["score"] >= 55
    assert "same name" in entry["duplicate_candidates"][0]["reasons"]

    result = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "skip"}]},
    ).json()
    assert result["skipped"] == 1
    assert owner_client.get("/api/v1/items").json()["total"] == 1


def test_import_merge_updates_only_selected_fields(owner_client):
    kitchen = create_room(owner_client, "Kitchen")
    existing = owner_client.post(
        "/api/v1/items",
        json={"name": "Camera", "brand": None, "room_id": kitchen["id"]},
    ).json()["item"]
    batch = upload_text_import(
        owner_client,
        "- Camera in the kitchen\n  - Serial: CAM-9999\n  - Brand: Canon",
    )
    detail = process_import(owner_client, batch["id"])
    entry = detail["entries"][0]
    result = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {
                    "id": entry["id"],
                    "action": "merge",
                    "merge_item_id": existing["id"],
                    "merge_fields": ["serial_number"],
                }
            ]
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["merged"] == 1
    item = owner_client.get(f"/api/v1/items/{existing['id']}").json()["item"]
    assert item["name"] == "Camera"
    assert item["serial_number"] == "CAM-9999"
    assert item["brand"] is None


def test_import_requires_location_ambiguity_resolution(owner_client):
    house = create_room(owner_client, "House")
    annex = create_room(owner_client, "Annex")
    first = create_room(owner_client, "Attic", house["id"])
    create_room(owner_client, "Attic", annex["id"])
    batch = upload_text_import(owner_client, "Camera in the attic.")
    detail = process_import(owner_client, batch["id"])
    entry = detail["entries"][0]
    assert entry["proposed"]["room"]["status"] == "ambiguous"
    assert len(entry["proposed"]["room"]["candidates"]) >= 2
    result = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert result.status_code == 200, result.text
    assert result.json()["failed"] == 1
    assert result.json()["failures"][0]["entry_id"] == entry["id"]
    candidate_ids = {
        candidate["id"] for candidate in detail["entries"][0]["proposed"]["room"]["candidates"]
    }
    assert first["id"] in candidate_ids


def test_markdown_and_obsidian_vault_parsing(owner_client):
    attic = create_room(owner_client, "Attic")
    study = create_room(owner_client, "Study")
    create_location(owner_client, study["id"], "Shelf", "shelf")
    create_location(owner_client, attic["id"], "Blue Boxes", "box")
    vault = make_vault(
        {
            "Home/Photography Equipment.md": """---
type: collection
tags:
  - photography
  - gear/camera
aliases: [Camera Gear]
---
# Photography Equipment
Everything for taking pictures.

- Sony camera body
  - Serial: SN-ABC-123
  - Brand: Sony
  - Model: A7 III
  - Bought 2024-01-15 for $1,200 from Camera Shop
- Two lenses
- [ ] Tripod
- Camera bag
![[assets/camera.jpg]]
See [[Receipts/Camera Receipt|the receipt]] and [[Missing Note]].
""",
            "Home/Film Gear.md": """---
type: collection
---
| Item | Qty | Room | Location | Brand | Serial | Purchase Date | Price | Currency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Film Camera | 1 | Study | Shelf | Nikon | NK-1 | 2023-05-01 | $300.00 | USD |
""",
            "Home/Attic.md": "---\ntype: room\n---\nBlue boxes live here.\n",
            "Receipts/Camera Receipt.md": (
                "---\ntype: purchase\n---\nReceipt for [[Photography Equipment]].\n"
            ),
            "Templates/Daily.md": "---\ntype: template\n---\n- [ ] daily note\n",
            "Missing attachment note.md": "![[assets/missing.png]]\n",
        },
        {"assets/camera.jpg": jpeg_bytes()},
    )
    batch = upload_file_import(owner_client, "vault.zip", vault, "application/zip")
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert detail["metadata"]["source_format"] == "obsidian_vault"
    assert detail["vault_tree"]
    assert any(item["type"] == "folder" for item in detail["vault_tree"])
    paths = {file["relative_path"] for file in detail["files"]}
    assert "Home/Photography Equipment.md" in paths
    assert "assets/camera.jpg" in paths
    reasons = {note["path"]: note["reason"] for note in detail["ignored_notes"]}
    assert "Home/Attic.md" in reasons
    assert "Templates/Daily.md" in reasons
    assert "Receipts/Camera Receipt.md" in reasons
    broken_targets = {link["target"] for link in detail["broken_links"]}
    assert "Missing Note" in broken_targets
    assert "assets/missing.png" in broken_targets

    entries = {entry["proposed"]["name"]: entry for entry in detail["entries"]}
    camera = entries["Sony camera body"]["proposed"]
    assert camera["serial_number"] == "SN-ABC-123"
    assert camera["brand"] == "Sony"
    assert camera["model"] == "A7 III"
    assert camera["purchase"]["price_cents"] == 120000
    assert camera["purchase"]["currency"] == "USD"
    assert camera["purchase"]["merchant"] == "Camera Shop"
    assert camera["purchase"]["purchase_date"] == "2024-01-15"
    assert camera["collection"] == "Photography Equipment"
    assert "photography" in camera["tags"]
    assert "gear/camera" in camera["tags"]
    assert camera["relationships"]["wikilinks"]
    assert entries["Lenses"]["proposed"]["quantity"] == 2
    assert "Tripod" in entries
    assert "Camera bag" in entries
    film = entries["Film Camera"]["proposed"]
    assert film["quantity"] == 1
    assert film["room"]["name"] == "Study"
    assert film["storage_location"]["name"] == "Shelf"
    assert film["purchase"]["price_cents"] == 30000
    assert film["purchase"]["currency"] == "USD"
    assert film["serial_number"] == "NK-1"
    note_entry = entries["Sony camera body"]
    assert note_entry["source_file_id"] is not None
    file_response = owner_client.get(
        f"/api/v1/imports/{batch['id']}/files/{note_entry['source_file_id']}/download"
    )
    assert file_response.status_code == 200
    assert file_response.headers["cache-control"] == "private, no-store"
    assert b"Photography Equipment" in file_response.content


def test_csv_xlsx_and_docx_imports(owner_client):
    create_room(owner_client, "Kitchen")
    csv_content = (
        b"Item,Qty,Room,Location,Brand,Model,Serial,Purchase Date,Price,Currency\n"
        b"Blender,1,Kitchen,Counter,Acme,BL-1,SN-1,2024-02-01,$99.50,USD\n"
        b"Toaster,2,Kitchen,,,,,,,\n"
    )
    batch = upload_file_import(owner_client, "inventory.csv", csv_content, "text/csv")
    detail = process_import(owner_client, batch["id"])
    entries = {entry["proposed"]["name"]: entry["proposed"] for entry in detail["entries"]}
    assert entries["Blender"]["quantity"] == 1
    assert entries["Blender"]["storage_location"]["status"] == "missing"
    assert entries["Blender"]["purchase"]["price_cents"] == 9950
    assert entries["Toaster"]["quantity"] == 2

    xlsx = make_xlsx(
        [
            ["Item", "Qty", "Room", "Brand", "Price", "Currency"],
            ["Kettle", "1", "Kitchen", "Kettle Co", "$45.00", "USD"],
        ]
    )
    batch = upload_file_import(
        owner_client,
        "inventory.xlsx",
        xlsx,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    detail = process_import(owner_client, batch["id"])
    proposal = detail["entries"][0]["proposed"]
    assert proposal["name"] == "Kettle"
    assert proposal["purchase"]["price_cents"] == 4500

    docx = make_docx(
        ["Household inventory"],
        [
            ["Item", "Qty", "Room", "Serial"],
            ["Desk Lamp", "1", "Kitchen", "DL-42"],
        ],
    )
    batch = upload_file_import(
        owner_client,
        "inventory.docx",
        docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    detail = process_import(owner_client, batch["id"])
    proposal = detail["entries"][0]["proposed"]
    assert proposal["name"] == "Desk Lamp"
    assert proposal["room"]["name"] == "Kitchen"
    assert proposal["serial_number"] == "DL-42"


def test_vault_rejects_path_traversal_symlinks_and_hidden_plugin_files(owner_client):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../escape.md", "Camera in the attic")
        archive.writestr(".obsidian/plugins/bad/main.js", "alert(1)")
        symlink = zipfile.ZipInfo("symlink.md")
        symlink.create_system = 3
        symlink.external_attr = 0o120777 << 16
        archive.writestr(symlink, "Camera link")
        archive.writestr("Safe.md", "Safe item in the attic.")
    batch = upload_file_import(owner_client, "vault.zip", buffer.getvalue(), "application/zip")
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    warnings = detail["warnings"]
    assert sum(1 for item in warnings if item["type"] == "unsafe_entry") >= 2
    paths = {file["relative_path"] for file in detail["files"]}
    assert "Safe.md" in paths
    assert not any("escape" in path for path in paths)
    assert not any(".obsidian" in path for path in paths)


def test_import_retry_after_failure(owner_client, monkeypatch):
    from housetory_api.services import import_pipeline

    batch = upload_text_import(owner_client, "Camera in the attic.")
    original = import_pipeline.read_source_bundle

    def broken(*args, **kwargs):
        raise ValueError("This workbook contains no readable sheets.")

    monkeypatch.setattr(import_pipeline, "read_source_bundle", broken)
    process_import_batch(batch["id"])
    failed = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert failed["status"] == "failed"
    assert failed["error"]

    monkeypatch.setattr(import_pipeline, "read_source_bundle", original)
    retry = owner_client.post(f"/api/v1/imports/{batch['id']}/retry")
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "queued"
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert "Camera" in {entry["proposed"]["name"] for entry in detail["entries"]}


def test_import_partial_approval_rejection_and_traceability(owner_client):
    attic = create_room(owner_client, "Attic")
    batch = upload_text_import(
        owner_client,
        "Ladder in the attic. Paint cans in the attic. Rope in the attic.",
    )
    detail = process_import(owner_client, batch["id"])
    entries = {entry["proposed"]["name"]: entry for entry in detail["entries"]}
    assert len(entries) == 3
    result = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={
            "entries": [
                {"id": entries["Ladder"]["id"], "action": "import"},
                {"id": entries["Paint cans"]["id"], "action": "reject"},
                {"id": entries["Rope"]["id"], "action": "skip"},
            ]
        },
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["created"] == 1
    assert body["rejected"] == 1
    assert body["skipped"] == 1
    assert body["batch"]["status"] == "completed"
    assert body["batch"]["imported_entries"] == 1
    items = owner_client.get("/api/v1/items").json()["items"]
    assert [item["name"] for item in items] == ["Ladder"]
    item_detail = owner_client.get(f"/api/v1/items/{items[0]['id']}").json()["item"]
    assert item_detail["import_source"]["batch_id"] == batch["id"]
    assert item_detail["import_source"]["url"] == f"/imports/{batch['id']}"
    assert item_detail["room"]["id"] == attic["id"]


def test_ai_import_enhancement_is_review_only(owner_client, monkeypatch, configured_ai):
    from housetory_api.schemas.ai import AiStatus
    from housetory_api.services import import_pipeline

    fake_status = AiStatus(
        provider="ollama",
        mode="local",
        model="extract-test",
        configured=True,
        available=True,
        privacy_note="Local",
    )
    monkeypatch.setattr(import_pipeline.ai, "provider_status", lambda probe=True: fake_status)
    monkeypatch.setattr(
        import_pipeline.ai,
        "complete_json",
        lambda *args, **kwargs: {
            "items": [
                {
                    "name": "Vintage Camera",
                    "brand": "Acme",
                    "model": "V-1",
                    "room": "Attic",
                    "tags": ["vintage"],
                    "confidence": 71,
                }
            ],
            "warnings": ["AI guessed the category"],
        },
    )
    batch = upload_text_import(owner_client, "Some household notes without clear items.")
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert detail["enhancement"]["status"] == "queued"
    from housetory_api.db import SessionLocal
    from housetory_api.models import Job
    from housetory_api.services.enrichment import run_enhancement

    with SessionLocal() as db:
        job = db.get(Job, detail["enhancement"]["job_id"])
        assert job.queue == "ai"
        payload = job.payload
    assert run_enhancement(payload)["status"] == "ready"
    detail = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert detail["enhancement"]["ai_succeeded"] is True
    assert detail["entries"] == []
    assert owner_client.get("/api/v1/items").json()["total"] == 0
    accepted = owner_client.post(f"/api/v1/imports/{batch['id']}/enhancement/accept")
    assert accepted.status_code == 200, accepted.text
    entry = accepted.json()["entries"][0]
    assert entry["proposed"]["name"] == "Vintage Camera"
    assert entry["proposed"]["field_sources"]["name"] == "inferred"
    assert entry["proposed"]["room"]["status"] == "missing"
    assert owner_client.get("/api/v1/items").json()["total"] == 0


def test_ai_import_invalid_output_falls_back_without_failing(
    owner_client,
    monkeypatch,
    configured_ai,
):
    from housetory_api.schemas.ai import AiStatus
    from housetory_api.services import import_pipeline

    fake_status = AiStatus(
        provider="ollama",
        mode="local",
        model="extract-test",
        configured=True,
        available=True,
        privacy_note="Local",
    )
    monkeypatch.setattr(import_pipeline.ai, "provider_status", lambda probe=True: fake_status)
    monkeypatch.setattr(
        import_pipeline.ai,
        "complete_json",
        lambda *args, **kwargs: {"not_items": []},
    )
    attic = create_room(owner_client, "Attic")
    batch = upload_text_import(owner_client, "Camera in the attic.")
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "review"
    assert detail["metadata"]["ai_used"] is False
    from housetory_api.db import SessionLocal
    from housetory_api.models import Job
    from housetory_api.services.enrichment import run_enhancement

    with SessionLocal() as db:
        payload = db.get(Job, detail["enhancement"]["job_id"]).payload
    assert run_enhancement(payload)["status"] == "failed"
    current = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert current["enhancement"]["reason"] == "invalid_output"
    assert current["entries"] == detail["entries"]
    assert detail["entries"][0]["proposed"]["room"]["matched_id"] == attic["id"]


def test_vault_file_and_size_limits_are_enforced(owner_client, monkeypatch):
    from housetory_api.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "import_max_files", 2)
    vault = make_vault(
        {
            "one.md": "Camera in the attic.",
            "two.md": "Lamp in the attic.",
            "three.md": "Rope in the attic.",
        }
    )
    batch = upload_file_import(owner_client, "large-vault.zip", vault, "application/zip")
    detail = process_import(owner_client, batch["id"])
    assert detail["status"] == "failed"
    assert "limited to 2 files" in (detail["error"] or "")


def test_import_sources_are_preserved_in_private_import_volume(
    owner_client, imports_root, upload_root
):
    batch = upload_text_import(owner_client, "Camera in the attic.")
    process_import(owner_client, batch["id"])
    files = [path for path in imports_root.rglob("*") if path.is_file()]
    assert files
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in files)
    assert not any("pasted-notes" in str(path) for path in upload_root.rglob("*"))
    source = owner_client.get(f"/api/v1/imports/{batch['id']}/source")
    assert source.status_code == 200
    assert b"Camera in the attic" in source.content
