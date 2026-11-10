import csv
import io
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from pypdf import PdfReader

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.services import containers as container_service
from housetory_api.services.auth import create_session
from housetory_api.services.import_pipeline import process_import_batch


def create_room(client, name, parent_id=None):
    response = client.post(
        "/api/v1/rooms",
        json={"name": name, **({"parent_id": parent_id} if parent_id else {})},
    )
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


def create_container(client, room_id, container_type="box", **extra):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": container_type, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_container_list_batches_queries_and_preserves_nested_counts(
    owner_client, sql_statements
):
    room = create_room(owner_client, "Batch room")
    parent = create_container(owner_client, room["id"], name="Parent")
    child = create_container(owner_client, room["id"], parent_id=parent["id"], name="Child")
    empty = create_container(owner_client, room["id"], name="Empty")
    deleted = create_container(owner_client, room["id"], parent_id=parent["id"], name="Deleted")
    assert owner_client.delete(f"/api/v1/storage-locations/{deleted['id']}").status_code == 204
    create_item(
        owner_client, "Stored", room_id=room["id"], storage_location_id=child["id"], quantity=3
    )
    archived = create_item(
        owner_client, "Archived", room_id=room["id"], storage_location_id=child["id"]
    )
    assert owner_client.patch(
        f"/api/v1/items/{archived['id']}", json={"is_archived": True}
    ).status_code == 200

    sql_statements.clear()
    first = owner_client.get("/api/v1/containers", params={"limit": 1})
    assert first.status_code == 200, first.text
    first_count = len(sql_statements)
    sql_statements.clear()
    response = owner_client.get("/api/v1/containers", params={"limit": 100})
    assert response.status_code == 200, response.text
    assert len(sql_statements) == first_count
    assert first_count <= 10
    entries = {entry["id"]: entry for entry in response.json()["items"]}
    assert entries[parent["id"]]["item_count"] == 0
    assert entries[parent["id"]]["total_item_count"] == 1
    assert entries[parent["id"]]["total_quantity"] == 3
    assert entries[parent["id"]]["container_count"] == 2
    assert entries[parent["id"]]["recoverable_deleted_child_count"] == 1
    assert [entry["id"] for entry in entries[child["id"]]["path"]] == [parent["id"], child["id"]]
    empty_page = owner_client.get("/api/v1/containers", params={"empty": True, "limit": 1}).json()
    assert empty_page["total"] == 1
    assert empty_page["items"][0]["id"] == empty["id"]
    occupied = owner_client.get("/api/v1/containers", params={"empty": False, "limit": 1}).json()
    assert occupied["total"] == 2
    assert len(occupied["items"]) == 1


def create_text_import(client, text, title="Container import"):
    response = client.post("/api/v1/imports", data={"text": text, "title": title})
    assert response.status_code == 201, response.text
    return response.json()


def other_household_headers(email="grace@example.com", name="Grace Hopper"):
    with SessionLocal() as db:
        user = User(name=name, email=email, password_hash="not-used-in-this-test")
        household = Household(name=f"{name}'s Home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(user_id=user.id, household_id=household.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="security-test",
            ip_address="127.0.0.1",
        )
        db.commit()
        return {"Cookie": f"housetory_session={token}"}


def pdf_text(pdf: bytes) -> str:
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf)).pages)


def test_container_creation_identifiers_and_non_reuse(owner_client):
    room = create_room(owner_client, "Storage Room")
    box = create_container(owner_client, room["id"])
    assert box["identifier"] == "BOX-001"
    assert box["name"] == "BOX-001"
    assert box["is_container"] is True
    assert box["container_type"] == "box"

    bin_container = create_container(owner_client, room["id"], "bin", name="Christmas")
    assert bin_container["identifier"] == "BIN-001"
    assert bin_container["name"] == "Christmas"

    bulk = owner_client.post(
        "/api/v1/containers/bulk",
        json={"room_id": room["id"], "container_type": "box", "quantity": 3},
    )
    assert bulk.status_code == 201, bulk.text
    identifiers = bulk.json()["identifiers"]
    assert identifiers == ["BOX-002", "BOX-003", "BOX-004"]
    assert len(set(identifiers)) == 3

    deleted = owner_client.delete(f"/api/v1/storage-locations/{bulk.json()['items'][-1]['id']}")
    assert deleted.status_code == 204
    replacement = create_container(owner_client, room["id"])
    assert replacement["identifier"] == "BOX-005"

    renamed = owner_client.patch(
        f"/api/v1/containers/{box['id']}", json={"name": "Winter clothing"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["identifier"] == "BOX-001"
    assert renamed.json()["name"] == "Winter clothing"

    lookup = owner_client.get("/api/v1/containers/lookup/box-001")
    assert lookup.status_code == 200, lookup.text
    assert lookup.json()["id"] == box["id"]
    assert owner_client.get("/api/v1/containers/lookup/NOPE-1").status_code == 422


def test_identifier_allocation_is_concurrent_and_atomic(owner_client):
    session = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(session["household"]["id"])

    def allocate(_index):
        with SessionLocal() as db:
            identifier = container_service.allocate_identifiers(db, household_id, "BOX", 1)[0]
            db.commit()
            return identifier

    with ThreadPoolExecutor(max_workers=10) as pool:
        identifiers = list(pool.map(allocate, range(20)))
    assert len(set(identifiers)) == 20
    assert sorted(identifiers) == [f"BOX-{value:03d}" for value in range(1, 21)]

    room = create_room(owner_client, "Concurrent Room")
    next_container = create_container(owner_client, room["id"])
    assert next_container["identifier"] == "BOX-021"


def test_existing_location_conversion_preserves_uuid_children_and_item(owner_client, pdf_bytes):
    room = create_room(owner_client, "Utility")
    cabinet = create_location(owner_client, room["id"], "Old Cabinet", "cabinet")
    shelf = create_location(owner_client, room["id"], "Top Shelf", "shelf", cabinet["id"])
    item = create_item(
        owner_client,
        "Toolbox",
        room_id=room["id"],
        storage_location_id=shelf["id"],
    )
    document = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("manual.pdf", pdf_bytes, "application/pdf")},
    ).json()

    response = owner_client.post(
        "/api/v1/containers/convert",
        json={"location_id": cabinet["id"], "container_type": "crate"},
    )
    assert response.status_code == 200, response.text
    converted = response.json()
    assert converted["id"] == cabinet["id"]
    assert converted["is_container"] is True
    assert converted["container_type"] == "crate"
    assert converted["identifier"] == "CRATE-001"

    detail = owner_client.get(f"/api/v1/containers/{cabinet['id']}").json()
    assert detail["id"] == cabinet["id"]
    assert {child["id"] for child in detail["children"]} == {shelf["id"]}
    assert {entry["id"] for entry in detail["items"]} == {item["id"]}

    item_detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert item_detail["location"]["id"] == shelf["id"]
    assert item_detail["documents"][0]["id"] == document["id"]


def test_cross_room_move_preserves_identity_contents_and_derived_views(owner_client):
    storage = create_room(owner_client, "Storage Room")
    attic = create_room(owner_client, "Attic")
    shelf = create_location(owner_client, storage["id"], "Shelf 2", "shelf")
    box = create_container(owner_client, storage["id"], parent_id=shelf["id"])
    nested = create_location(owner_client, storage["id"], "Small Parts", "other", box["id"])
    item = create_item(
        owner_client,
        "Camera Charger",
        room_id=storage["id"],
        storage_location_id=box["id"],
        current_value_cents=4500,
    )
    nested_item = create_item(
        owner_client,
        "USB-C Cable",
        room_id=storage["id"],
        storage_location_id=nested["id"],
        quantity=2,
    )
    qr_before = owner_client.get(f"/api/v1/containers/{box['id']}/qr.svg").content
    payload_before = owner_client.get(f"/api/v1/containers/{box['id']}").json()["qr_payload"]

    moved = owner_client.post(
        f"/api/v1/containers/{box['id']}/move",
        json={"room_id": attic["id"], "parent_id": None},
    )
    assert moved.status_code == 200, moved.text
    detail = moved.json()
    assert detail["id"] == box["id"]
    assert detail["identifier"] == "BOX-001"
    assert detail["room_id"] == attic["id"]
    assert detail["parent_id"] is None
    assert detail["qr_payload"] == payload_before
    assert owner_client.get(f"/api/v1/containers/{box['id']}/qr.svg").content == qr_before

    nested_detail = owner_client.get(f"/api/v1/storage-locations/{nested['id']}").json()
    assert nested_detail["room_id"] == attic["id"]
    assert nested_detail["parent_id"] == box["id"]

    for item_id in (item["id"], nested_item["id"]):
        item_detail = owner_client.get(f"/api/v1/items/{item_id}").json()["item"]
        assert item_detail["room"]["id"] == attic["id"]
        assert any(entry["identifier"] == "BOX-001" for entry in item_detail["location_path"])

    storage_locations = owner_client.get(
        f"/api/v1/storage-locations?room_id={storage['id']}"
    ).json()["items"]
    attic_locations = owner_client.get(f"/api/v1/storage-locations?room_id={attic['id']}").json()[
        "items"
    ]
    assert {entry["id"] for entry in storage_locations} == {shelf["id"]}
    assert {entry["id"] for entry in attic_locations} == {box["id"], nested["id"]}

    rooms = owner_client.get("/api/v1/rooms").json()["items"]
    storage_room = next(entry for entry in rooms if entry["id"] == storage["id"])
    attic_room = next(entry for entry in rooms if entry["id"] == attic["id"])
    assert storage_room["location_count"] == 1
    assert attic_room["location_count"] == 2
    assert attic_room["item_count"] == 2
    assert attic_room["total_item_count"] == 2

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["item_count"] == 2

    search = owner_client.get("/api/v1/items?q=BOX-001").json()
    assert {entry["name"] for entry in search["items"]} == {"Camera Charger", "USB-C Cable"}
    assert all(
        any(location["identifier"] == "BOX-001" for location in entry["location_path"])
        for entry in search["items"]
    )

    financial = owner_client.get("/api/v1/financial-overview").json()
    attic_value = [row for row in financial["value_by_room"] if row["name"] == "Attic"]
    assert attic_value and attic_value[0]["current_value_total_cents"] == 4500

    inventory = owner_client.get("/api/v1/exports/inventory.csv").text
    rows = list(csv.DictReader(io.StringIO(inventory)))
    charger = next(row for row in rows if row["item"] == "Camera Charger")
    assert charger["room"] == "Attic"
    assert charger["container"] == "BOX-001"

    assistant = owner_client.post(
        "/api/v1/assistant/query", json={"question": "Where is the Camera Charger?"}
    ).json()
    assert assistant["items"][0]["room"]["name"] == "Attic"
    assert assistant["items"][0]["location"]["identifier"] == "BOX-001"

    container_answer = owner_client.post(
        "/api/v1/assistant/query", json={"question": "What is in BOX-001?"}
    ).json()
    assert container_answer["tool"] == "get_container_contents"
    assert "USB-C Cable" in container_answer["answer"]
    assert any(
        reference["url"] == f"/containers/{box['id']}"
        for reference in container_answer["references"]
    )

    smart = owner_client.post(
        "/api/v1/search/natural", json={"question": "Find items in BOX-001"}
    ).json()
    assert smart["filters"]["location_id"] == box["id"]
    assert {entry["name"] for entry in smart["items"]} == {"Camera Charger", "USB-C Cable"}


def test_move_rejects_cycles_cross_room_parent_and_fixed_locations(owner_client):
    storage = create_room(owner_client, "Storage")
    attic = create_room(owner_client, "Attic")
    box = create_container(owner_client, storage["id"])
    child = create_container(owner_client, storage["id"], parent_id=box["id"])
    fixed = create_location(owner_client, storage["id"], "Fixed Shelf", "shelf")
    other_parent = create_location(owner_client, attic["id"], "Attic Shelf", "shelf")

    into_child = owner_client.post(
        f"/api/v1/containers/{box['id']}/move",
        json={"room_id": storage["id"], "parent_id": child["id"]},
    )
    assert into_child.status_code == 422
    assert into_child.json()["detail"]["code"] == "container_cycle"

    into_self = owner_client.post(
        f"/api/v1/containers/{box['id']}/move",
        json={"room_id": storage["id"], "parent_id": box["id"]},
    )
    assert into_self.status_code == 422
    assert into_self.json()["detail"]["code"] == "container_cycle"

    fixed_move = owner_client.post(
        f"/api/v1/containers/{fixed['id']}/move",
        json={"room_id": attic["id"], "parent_id": None},
    )
    assert fixed_move.status_code == 422
    assert fixed_move.json()["detail"]["code"] == "not_a_container"

    wrong_room = owner_client.post(
        f"/api/v1/containers/{box['id']}/move",
        json={"room_id": storage["id"], "parent_id": other_parent["id"]},
    )
    assert wrong_room.status_code == 422
    assert wrong_room.json()["detail"]["code"] == "container_room_mismatch"

    unchanged = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    assert unchanged["room_id"] == storage["id"]
    assert unchanged["parent_id"] is None
    assert owner_client.get(f"/api/v1/containers/{child['id']}").json()["parent_id"] == box["id"]


def test_move_rolls_back_when_an_update_fails(owner_client, monkeypatch):
    storage = create_room(owner_client, "Storage")
    attic = create_room(owner_client, "Attic")
    box = create_container(owner_client, storage["id"])
    item = create_item(
        owner_client,
        "Rollback Item",
        room_id=storage["id"],
        storage_location_id=box["id"],
    )
    session = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(session["household"]["id"])
    real_update = container_service.update

    def fail_on_items(statement):
        if getattr(statement, "__tablename__", "") == "items":
            raise RuntimeError("simulated item update failure")
        return real_update(statement)

    monkeypatch.setattr(container_service, "update", fail_on_items)
    with SessionLocal() as db:
        with pytest.raises(RuntimeError):
            container_service.move_container(
                db,
                household_id,
                uuid.UUID(box["id"]),
                destination_room_id=uuid.UUID(attic["id"]),
                destination_parent_id=None,
            )
        db.rollback()

    detail = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    assert detail["room_id"] == storage["id"]
    item_detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert item_detail["room"]["id"] == storage["id"]


def test_concurrent_moves_leave_a_consistent_tree(owner_client):
    storage = create_room(owner_client, "Storage")
    attic = create_room(owner_client, "Attic")
    garage = create_room(owner_client, "Garage")
    box = create_container(owner_client, storage["id"])
    nested = create_container(owner_client, storage["id"], parent_id=box["id"])
    item = create_item(
        owner_client, "Concurrent Item", room_id=storage["id"], storage_location_id=nested["id"]
    )
    session = owner_client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(session["household"]["id"])
    barrier = threading.Barrier(2)

    def move_to(room_id):
        with SessionLocal() as db:
            barrier.wait()
            container_service.move_container(
                db,
                household_id,
                uuid.UUID(box["id"]),
                destination_room_id=uuid.UUID(room_id),
                destination_parent_id=None,
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(move_to, attic["id"]),
            pool.submit(move_to, garage["id"]),
        ]
        for future in futures:
            future.result()

    detail = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    assert detail["room_id"] in {attic["id"], garage["id"]}
    all_locations = owner_client.get("/api/v1/storage-locations").json()["items"]
    subtree = [entry for entry in all_locations if entry["id"] in {box["id"], nested["id"]}]
    assert {entry["room_id"] for entry in subtree} == {detail["room_id"]}
    item_detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert item_detail["room"]["id"] == detail["room_id"]


def test_fixed_location_identifier_qr_and_label(owner_client):
    room = create_room(owner_client, "Office")
    shelf = create_location(owner_client, room["id"], "Reference Shelf", "shelf")
    assigned = owner_client.post(f"/api/v1/containers/{shelf['id']}/identifier")
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["identifier"] == "SHELF-001"
    assert assigned.json()["is_container"] is False

    qr = owner_client.get(f"/api/v1/containers/{shelf['id']}/qr.svg")
    assert qr.status_code == 200
    assert qr.headers["content-type"].startswith("image/svg+xml")
    assert qr.headers["cache-control"] == "private, no-store"
    assert b"<svg" in qr.content

    detail = owner_client.get(f"/api/v1/containers/{shelf['id']}").json()
    assert detail["identifier"] == "SHELF-001"
    assert detail["summary"]["empty"] is True

    labels = owner_client.post(
        "/api/v1/labels/pdf",
        json={
            "location_ids": [shelf["id"]],
            "template": "L7163",
            "layout": "compact",
            "record": True,
        },
    )
    assert labels.status_code == 200, labels.text
    assert labels.headers["content-type"].startswith("application/pdf")
    assert "SHELF-001" in pdf_text(labels.content)


def test_live_container_summary_updates_and_retires_saved_summaries(owner_client):
    room = create_room(owner_client, "Attic")
    box = create_container(owner_client, room["id"], name="Winter clothing")
    empty = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    assert empty["summary"]["empty"] is True
    assert empty["summary"]["item_count"] == 0
    assert empty["summary"]["total_quantity"] == 0
    assert empty["summary"]["direct_item_count"] == 0
    assert empty["summary"]["categories"] == []

    create_item(
        owner_client,
        "Winter jacket",
        quantity=3,
        room_id=room["id"],
        storage_location_id=box["id"],
    )
    create_item(
        owner_client,
        "Scarf",
        quantity=2,
        room_id=room["id"],
        storage_location_id=box["id"],
    )
    create_item(
        owner_client,
        "Gloves",
        room_id=room["id"],
        storage_location_id=box["id"],
    )
    nested = create_container(owner_client, room["id"], name="Gloves pocket", parent_id=box["id"])
    create_item(
        owner_client,
        "Liner gloves",
        quantity=2,
        room_id=room["id"],
        storage_location_id=nested["id"],
    )

    detail = owner_client.get(f"/api/v1/containers/{box['id']}").json()
    summary = detail["summary"]
    assert summary["item_count"] == 4
    assert summary["total_quantity"] == 8
    assert summary["direct_item_count"] == 3
    assert summary["direct_total_quantity"] == 6
    assert {row["name"] for row in summary["categories"]} == {"Uncategorised"}
    assert summary["empty"] is False
    assert "stale" not in summary
    assert "short" not in summary
    assert "headline" not in summary

    label = owner_client.post(
        "/api/v1/labels/pdf",
        json={"location_ids": [box["id"]], "template": "L7165", "record": True},
    )
    assert label.status_code == 200, label.text
    label_text = pdf_text(label.content)
    assert "BOX-001" in label_text
    assert "Winter clothing" in label_text
    assert "Winter jacket" not in label_text
    assert "Liner gloves" not in label_text
    assert "Attic" not in label_text

    create_item(
        owner_client,
        "Ski goggles",
        room_id=room["id"],
        storage_location_id=box["id"],
    )
    updated = owner_client.get(f"/api/v1/containers/{box['id']}").json()["summary"]
    assert updated["item_count"] == 5
    assert updated["total_quantity"] == 9
    assert updated["direct_item_count"] == 4
    assert updated["direct_total_quantity"] == 7

    for path, method in [
        (f"/api/v1/containers/{box['id']}/summary", "post"),
        (f"/api/v1/containers/{box['id']}/summary/ai", "post"),
        (f"/api/v1/containers/{box['id']}/summary", "patch"),
    ]:
        response = getattr(owner_client, method)(
            path,
            **({"json": {"headline": "Winter gear"}} if method == "patch" else {}),
        )
        assert response.status_code == 410, response.text
        assert response.json()["detail"]["code"] == "feature_retired"


def test_label_templates_geometry_partial_sheets_and_calibration(owner_client):
    from housetory_api.services.labels import label_positions, resolve_geometry

    templates = owner_client.get("/api/v1/labels/templates").json()
    assert templates["default"] == "L7165"
    by_code = {entry["code"]: entry for entry in templates["items"]}
    assert by_code["L7160"]["label_width_mm"] == 63.5
    assert by_code["L7163"]["label_height_mm"] == 38.1
    assert by_code["L7165"]["rows"] == 4
    assert by_code["L7651"]["columns"] == 5
    assert by_code["LARGE_A6"]["label_width_mm"] == 105.0

    geometry = resolve_geometry("L7165", None)
    positions = label_positions(geometry, start_slot=0, count=4)
    assert positions[0] == (0, 4.7, 216.2)
    assert positions[1][1] == pytest.approx(106.3)
    assert positions[2][2] == pytest.approx(148.5)
    shifted = label_positions(geometry, start_slot=0, count=1, offset_x_mm=1.5, offset_y_mm=-0.5)
    assert shifted[0][1] == pytest.approx(6.2)
    assert shifted[0][2] == pytest.approx(215.7)

    room = create_room(owner_client, "Storage")
    first = create_container(owner_client, room["id"])
    second = create_container(owner_client, room["id"])
    preview = owner_client.post(
        "/api/v1/labels/pdf",
        json={
            "location_ids": [first["id"], second["id"]],
            "template": "L7165",
            "layout": "detailed",
            "copies": 1,
            "start_slot": 7,
            "record": False,
        },
    )
    assert preview.status_code == 200, preview.text
    preview_reader = PdfReader(io.BytesIO(preview.content))
    assert len(preview_reader.pages) == 2
    assert float(preview_reader.pages[0].mediabox.width) == pytest.approx(595.2756, abs=0.01)
    assert float(preview_reader.pages[0].mediabox.height) == pytest.approx(841.8898, abs=0.01)
    assert "BOX-001" in pdf_text(preview.content)
    assert "BOX-002" in pdf_text(preview.content)
    assert (
        owner_client.get(f"/api/v1/containers/{first['id']}").json()["label_generated_at"] is None
    )

    recorded = owner_client.post(
        "/api/v1/labels/pdf",
        json={
            "location_ids": [first["id"], second["id"]],
            "template": "L7165",
            "layout": "standard",
            "copies": 3,
            "record": True,
        },
    )
    assert recorded.status_code == 200, recorded.text
    assert len(PdfReader(io.BytesIO(recorded.content)).pages) == 1
    detail = owner_client.get(f"/api/v1/containers/{first['id']}").json()
    assert detail["label_generated_at"] is not None

    calibration = owner_client.get(
        "/api/v1/labels/calibration.pdf?template=L7165&offset_x_mm=1.5&offset_y_mm=-0.5"
    )
    assert calibration.status_code == 200
    assert "Calibration" in pdf_text(calibration.content)
    assert "offsets X +1.5 mm / Y -0.5 mm" in pdf_text(calibration.content)

    custom = owner_client.post(
        "/api/v1/labels/pdf",
        json={
            "location_ids": [first["id"]],
            "template": "custom",
            "custom": {
                "paper_width_mm": 210,
                "paper_height_mm": 297,
                "label_width_mm": 150,
                "label_height_mm": 200,
                "columns": 2,
                "rows": 2,
                "top_margin_mm": 0,
                "left_margin_mm": 0,
                "horizontal_pitch_mm": 150,
                "vertical_pitch_mm": 200,
            },
        },
    )
    assert custom.status_code == 422


def test_standard_label_presets_use_identity_only(owner_client):
    room = create_room(owner_client, "Attic")
    box = create_container(owner_client, room["id"], name="Winter clothing")
    create_item(
        owner_client,
        "Winter jacket",
        quantity=3,
        room_id=room["id"],
        storage_location_id=box["id"],
    )
    for template in ["L7160", "L7163", "L7165", "L7651", "LARGE_A6"]:
        response = owner_client.post(
            "/api/v1/labels/pdf",
            json={
                "location_ids": [box["id"]],
                "template": template,
                "layout": "detailed",
                "record": False,
            },
        )
        assert response.status_code == 200, response.text
        text = pdf_text(response.content)
        assert "BOX-001" in text
        assert "Winter jacket" not in text
        assert "Attic" not in text
        assert "3" not in text


def test_import_matching_recognizes_container_identifiers(owner_client):
    room = create_room(owner_client, "Office")
    box = create_container(owner_client, room["id"])
    batch = create_text_import(owner_client, "Camera charger in BOX-001.")
    process_import_batch(batch["id"])
    detail = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    entry = detail["entries"][0]
    assert entry["proposed"]["room"]["matched_id"] == room["id"]
    assert entry["proposed"]["storage_location"]["matched_id"] == box["id"]
    assert entry["proposed"]["storage_location"]["identifier"] == "BOX-001"
    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    item_id = applied.json()["batch"]["entries"][0]["imported_item_id"]
    item = owner_client.get(f"/api/v1/items/{item_id}").json()["item"]
    assert item["location"]["id"] == box["id"]


def test_container_and_qr_cross_household_isolation(owner_client, anon_client):
    room = create_room(owner_client, "Private")
    box = create_container(owner_client, room["id"])
    other_headers = other_household_headers()
    assert (
        anon_client.get(f"/api/v1/containers/{box['id']}", headers=other_headers).status_code == 404
    )
    assert (
        anon_client.get(f"/api/v1/containers/{box['id']}/qr.svg", headers=other_headers).status_code
        == 404
    )
    assert (
        anon_client.post(
            f"/api/v1/containers/{box['id']}/move",
            headers=other_headers,
            json={"room_id": room["id"], "parent_id": None},
        ).status_code
        == 404
    )
    assert (
        anon_client.post(
            "/api/v1/labels/pdf",
            headers=other_headers,
            json={"location_ids": [box["id"]], "template": "L7165"},
        ).status_code
        == 404
    )
    assert anon_client.get(f"/api/v1/containers/{box['id']}").status_code == 401
    assert anon_client.get(f"/api/v1/containers/{box['id']}/qr.svg").status_code == 401
