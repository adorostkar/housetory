import csv
import hashlib
import io
import json
import uuid
import zipfile
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image
from pypdf import PdfReader

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    Document,
    Household,
    HouseholdMember,
    InventoryEvidenceExport,
    Purchase,
    PurchaseAllocation,
    User,
)
from housetory_api.services import evidence_export, storage
from housetory_api.services.auth import create_session


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", "name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def jpeg_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (320, 240), (110, 130, 100)).save(output, format="JPEG", quality=85)
    return output.getvalue()


def upload_document(
    client,
    *,
    title,
    document_type,
    item_ids,
    data,
    filename,
    content_type,
):
    response = client.post(
        "/api/v1/documents",
        files={"file": (filename, data, content_type)},
        data={"title": title, "document_type": document_type, "item_ids": item_ids},
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload_photo(client, item_id):
    response = client.post(
        f"/api/v1/items/{item_id}/photos",
        files={"files": ("item-photo.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert response.status_code == 201, response.text


def add_allocation(purchase_id, item_id, amount, *, line="line"):
    with SessionLocal() as db:
        purchase = db.get(Purchase, uuid.UUID(str(purchase_id)))
        assert purchase is not None
        db.add(
            PurchaseAllocation(
                household_id=purchase.household_id,
                purchase_id=purchase.id,
                item_id=uuid.UUID(str(item_id)),
                source_line_id=f"{line}-{item_id}",
                description=f"Reviewed line for {item_id}",
                quantity=1,
                allocated_cents=amount,
                currency=purchase.currency,
            )
        )
        db.commit()


def viewer_headers(client, email):
    household_id = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    with SessionLocal() as db:
        user = User(name="Evidence Viewer", email=email, password_hash="not-used")
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household_id, user_id=user.id, role="viewer"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="evidence-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def other_household_headers(email):
    with SessionLocal() as db:
        user = User(name="Other Owner", email=email, password_hash="not-used")
        household = Household(name="Other evidence household")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(household_id=household.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="evidence-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def preview(client, scope, *, options=None, include_archived=False):
    return client.post(
        "/api/v1/evidence-exports/preview",
        json={
            "scope": scope,
            "include_archived": include_archived,
            "options": options or {},
        },
    )


def create_package(client, preview_data, *, options=None, include_archived=False, request_id=None):
    scope = {
        key: value
        for key, value in preview_data["scope"].items()
        if key in {"item_ids", "room_ids", "container_ids", "include_home"}
    }
    return client.post(
        "/api/v1/evidence-exports",
        json={
            "scope": scope,
            "include_archived": include_archived,
            "options": options or preview_data["options"],
            "fingerprint": preview_data["fingerprint"],
            "request_id": str(request_id or uuid.uuid4()),
        },
    )


def run_package(package_id):
    return evidence_export.run_evidence_export({"export_id": package_id})


def package_detail(client, package_id):
    response = client.get(f"/api/v1/evidence-exports/{package_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_preview_and_generation_preserve_purchase_loan_privacy_and_evidence(
    owner_client, pdf_bytes
):
    room = create_room(owner_client, "Evidence room")
    container = create_container(owner_client, room["id"], "Evidence box")
    first = create_item(
        owner_client,
        "Café Drill 日本",
        description="=SUM(A1) reviewed description",
        room_id=room["id"],
        storage_location_id=container["id"],
        quantity=2,
        purchase={
            "merchant": "Hardware Store",
            "purchase_date": "2026-02-01",
            "price_cents": 12000,
            "currency": "USD",
            "notes": "private purchase note",
        },
        current_value_cents=9000,
        current_value_currency="USD",
    )
    second = create_item(
        owner_client,
        "Unselected Grinder",
        room_id=room["id"],
        purchase_id=first["purchase"]["id"],
    )
    add_allocation(first["purchase"]["id"], first["id"], 7000, line="a")
    add_allocation(first["purchase"]["id"], second["id"], 5000, line="b")

    receipt = upload_document(
        owner_client,
        title="Shared receipt",
        document_type="receipt",
        item_ids=[first["id"]],
        data=pdf_bytes,
        filename="receipt.pdf",
        content_type="application/pdf",
    )
    upload_document(
        owner_client,
        title="Warranty certificate",
        document_type="warranty_certificate",
        item_ids=[first["id"]],
        data=b"Warranty terms for the drill. " + b"x" * 100,
        filename="warranty.txt",
        content_type="text/plain",
    )
    manual = upload_document(
        owner_client,
        title="Long manual",
        document_type="manual",
        item_ids=[first["id"]],
        data=b"Manual " + b"m" * 200,
        filename="manual.txt",
        content_type="text/plain",
    )
    owner_client.patch(
        f"/api/v1/purchases/{first['purchase']['id']}",
        json={"receipt_document_id": receipt["id"]},
    )
    upload_photo(owner_client, first["id"])
    loan = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": first["id"],
            "borrower_name": "Private Borrower",
            "quantity": 1,
            "lent_on": "2026-02-10",
            "notes": "private loan note",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert loan.status_code == 201, loan.text

    response = preview(owner_client, {"item_ids": [first["id"]]})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["item_count"] == 1
    assert data["unit_count"] == 2
    assert data["at_home_unit_count"] == 1
    assert data["on_loan_unit_count"] == 1
    assert data["photo_count"] == 1
    assert data["document_count"] == 3
    assert data["included_document_count"] == 2
    assert data["document_bytes"] > 0
    assert data["purchase_references"][0]["selected_item_count"] == 1
    assert data["purchase_references"][0]["item_count_in_household"] == 2
    assert data["purchase_references"][0]["selected_allocated_cents"] == 7000
    assert data["purchase_references"][0]["has_unselected_items"] is True
    assert data["currency_totals"][0]["selected_allocated_purchase_cents"] == 7000
    assert data["currency_totals"][0]["current_value_cents"] == 9000
    assert any("shared with items outside" in warning for warning in data["warnings"])
    assert any("manual" in warning.lower() for warning in data["warnings"])
    manual_preview = next(doc for doc in data["documents"] if doc["id"] == manual["id"])
    assert manual_preview["evidence_kind"] == "manual"
    assert manual_preview["included"] is False
    receipt_preview = next(doc for doc in data["documents"] if doc["id"] == receipt["id"])
    assert receipt_preview["shared_with_unselected"] is True

    created = create_package(owner_client, data)
    assert created.status_code == 202, created.text
    package = created.json()
    run_result = run_package(package["id"])
    assert run_result["status"] == "succeeded"
    detail = package_detail(owner_client, package["id"])
    assert detail["status"] == "succeeded"
    assert detail["pdf_available"] is True
    assert detail["csv_available"] is True
    assert detail["bundle_available"] is True

    pdf_response = owner_client.get(f"/api/v1/evidence-exports/{package['id']}/pdf")
    assert pdf_response.status_code == 200
    assert pdf_response.headers["cache-control"] == "private, no-store"
    assert pdf_response.content.startswith(b"%PDF-")
    pdf_reader = PdfReader(io.BytesIO(pdf_response.content))
    assert len(pdf_reader.pages) >= 3
    pdf_text = "\n".join(page.extract_text() or "" for page in pdf_reader.pages)
    assert "Café Drill 日本" in pdf_text
    assert "Hardware Store" in pdf_text
    assert "70.00" in pdf_text
    assert "90.00" in pdf_text
    assert "120.00" in pdf_text
    assert "Private Borrower" not in pdf_text
    assert "private loan note" not in pdf_text
    assert "private purchase note" not in pdf_text
    assert "Unselected Grinder" not in pdf_text
    assert "Evidence index" in pdf_text

    csv_response = owner_client.get(f"/api/v1/evidence-exports/{package['id']}/csv")
    assert csv_response.status_code == 200
    assert csv_response.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
    assert rows[0][0] == "export_id"
    assert "item_id" in rows[0]
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["item_name"] == "Café Drill 日本"
    assert row["description"].startswith("'=SUM")
    assert row["quantity"] == "2"
    assert row["on_loan_quantity"] == "1"
    assert row["purchase_item_allocation_cents"] == "7000"
    assert "Private Borrower" not in csv_response.text

    zip_response = owner_client.get(f"/api/v1/evidence-exports/{package['id']}/bundle")
    assert zip_response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(zip_response.content)) as archive:
        names = archive.namelist()
        assert any(name.endswith(".pdf") for name in names)
        assert any(name.endswith(".csv") for name in names)
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["counts"]["items"] == 1
        assert manifest["counts"]["units"] == 2
        assert manifest["missing_files"] == []
        assert "Private Borrower" not in json.dumps(manifest)
        receipt_manifest = next(
            doc for doc in manifest["documents"] if doc["title"] == "Shared receipt"
        )
        assert receipt_manifest["shared_with_unselected"] is True
        assert len([doc for doc in manifest["documents"] if doc["id"] == receipt["id"]]) == 1
        original = next(item for item in receipt_manifest["files"] if item["role"] == "original")
        assert archive.read(original["path"]) == pdf_bytes
        assert original["sha256"] == hashlib.sha256(pdf_bytes).hexdigest()


def test_scope_overlap_archives_empty_viewer_and_household_boundaries(owner_client, anon_client):
    parent_room = create_room(owner_client, "Parent room")
    child_room = create_room(owner_client, "Child room")
    owner_client.patch(f"/api/v1/rooms/{child_room['id']}", json={"parent_id": parent_room["id"]})
    parent_box = create_container(owner_client, parent_room["id"], "Parent box")
    child_box = create_container(owner_client, parent_room["id"], "Child box")
    owner_client.patch(
        f"/api/v1/storage-locations/{child_box['id']}",
        json={"parent_id": parent_box["id"]},
    )
    item = create_item(
        owner_client,
        "Nested lantern",
        room_id=parent_room["id"],
        storage_location_id=child_box["id"],
    )
    archived = create_item(owner_client, "Archived radio", room_id=parent_room["id"])
    owner_client.patch(f"/api/v1/items/{archived['id']}", json={"is_archived": True})

    overlap = preview(
        owner_client,
        {
            "room_ids": [parent_room["id"]],
            "container_ids": [parent_box["id"]],
            "item_ids": [item["id"]],
        },
    )
    assert overlap.status_code == 200, overlap.text
    assert overlap.json()["item_count"] == 1
    assert "Room:" in overlap.json()["scope_label"]
    assert overlap.json()["archived_excluded_count"] == 1

    archived_preview = preview(
        owner_client,
        {"room_ids": [parent_room["id"]]},
        include_archived=True,
    )
    assert archived_preview.status_code == 200
    assert archived_preview.json()["item_count"] == 2

    empty_room = create_room(owner_client, "Empty evidence room")
    empty = preview(owner_client, {"room_ids": [empty_room["id"]]})
    assert empty.status_code == 200
    assert empty.json()["item_count"] == 0
    assert empty.json()["can_generate"] is False

    missing = preview(owner_client, {"item_ids": [str(uuid.uuid4())]})
    assert missing.status_code == 422
    assert missing.json()["detail"]["code"] == "scope_not_found"

    viewer = viewer_headers(owner_client, "evidence-viewer@example.com")
    viewer_preview = anon_client.post(
        "/api/v1/evidence-exports/preview",
        headers=viewer,
        json={"scope": {"item_ids": [item["id"]]}, "options": {}},
    )
    assert viewer_preview.status_code == 200, viewer_preview.text
    viewer_created = anon_client.post(
        "/api/v1/evidence-exports",
        headers=viewer,
        json={
            "scope": {"item_ids": [item["id"]]},
            "options": viewer_preview.json()["options"],
            "fingerprint": viewer_preview.json()["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert viewer_created.status_code == 202, viewer_created.text
    viewer_package_id = viewer_created.json()["id"]
    run_package(viewer_package_id)
    assert (
        anon_client.get(
            f"/api/v1/evidence-exports/{viewer_package_id}/pdf", headers=viewer
        ).status_code
        == 200
    )

    owner_package = create_package(
        owner_client, preview(owner_client, {"item_ids": [item["id"]]}).json()
    )
    assert owner_package.status_code == 202
    owner_package_id = owner_package.json()["id"]
    assert (
        anon_client.post(
            f"/api/v1/evidence-exports/{owner_package_id}/cancel", headers=viewer
        ).status_code
        == 403
    )

    other = other_household_headers("evidence-other@example.com")
    assert (
        anon_client.get(f"/api/v1/evidence-exports/{owner_package_id}", headers=other).status_code
        == 404
    )
    assert (
        anon_client.post(
            "/api/v1/evidence-exports/preview",
            headers=other,
            json={"scope": {"item_ids": [item["id"]]}, "options": {}},
        ).status_code
        == 422
    )


def test_snapshot_stale_state_idempotency_missing_files_and_expiry(owner_client, pdf_bytes):
    item = create_item(owner_client, "Snapshot drill")
    doc = upload_document(
        owner_client,
        title="Snapshot receipt",
        document_type="receipt",
        item_ids=[item["id"]],
        data=pdf_bytes,
        filename="snapshot-receipt.pdf",
        content_type="application/pdf",
    )
    first = preview(owner_client, {"item_ids": [item["id"]]}).json()
    owner_client.patch(f"/api/v1/items/{item['id']}", json={"name": "Changed after preview"})
    stale = create_package(owner_client, first)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "inventory_changed"

    fresh = preview(owner_client, {"item_ids": [item["id"]]}).json()
    request_id = uuid.uuid4()
    created = create_package(owner_client, fresh, request_id=request_id)
    assert created.status_code == 202, created.text
    package_id = created.json()["id"]
    replay = create_package(owner_client, fresh, request_id=request_id)
    assert replay.status_code == 202
    assert replay.json()["id"] == package_id
    conflicting = create_package(
        owner_client,
        fresh,
        request_id=request_id,
        options={**fresh["options"], "include_csv": False},
    )
    assert conflicting.status_code == 409

    owner_client.patch(f"/api/v1/items/{item['id']}", json={"name": "Changed after create"})
    with SessionLocal() as db:
        stored = db.get(Document, uuid.UUID(doc["id"]))
        assert stored is not None
        original_path = storage.resolve_key(stored.original_storage_key)
        original_path.unlink()
    run_package(package_id)
    detail = package_detail(owner_client, package_id)
    assert detail["status"] == "succeeded"
    assert any("missing" in warning.lower() for warning in detail["warnings"])
    pdf = owner_client.get(f"/api/v1/evidence-exports/{package_id}/pdf")
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Changed after create" not in text
    assert "Changed after preview" in text

    with SessionLocal() as db:
        package = db.get(InventoryEvidenceExport, uuid.UUID(package_id))
        assert package is not None
        package.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
    expired = owner_client.get(f"/api/v1/evidence-exports/{package_id}")
    assert expired.status_code == 200
    assert expired.json()["status"] == "expired"
    assert owner_client.get(f"/api/v1/evidence-exports/{package_id}/pdf").status_code == 410


def test_cancel_retry_failure_and_limits(owner_client, monkeypatch):
    item = create_item(owner_client, "Retry drill")
    preview_data = preview(owner_client, {"item_ids": [item["id"]]}).json()
    created = create_package(owner_client, preview_data)
    package_id = created.json()["id"]
    cancelled = owner_client.post(f"/api/v1/evidence-exports/{package_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert owner_client.get(f"/api/v1/evidence-exports/{package_id}/pdf").status_code == 409

    retried = owner_client.post(f"/api/v1/evidence-exports/{package_id}/retry")
    assert retried.status_code == 200
    assert retried.json()["status"] == "queued"

    original_build = evidence_export.build_pdf
    monkeypatch.setattr(
        evidence_export,
        "build_pdf",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("fixture failure")),
    )
    with pytest.raises(RuntimeError, match="fixture failure"):
        run_package(package_id)
    failed = package_detail(owner_client, package_id)
    assert failed["status"] == "failed"
    assert "could not be generated" in failed["error"]
    monkeypatch.setattr(evidence_export, "build_pdf", original_build)
    retried = owner_client.post(f"/api/v1/evidence-exports/{package_id}/retry")
    assert retried.status_code == 200
    run_package(package_id)
    assert package_detail(owner_client, package_id)["status"] == "succeeded"

    settings = get_settings()
    monkeypatch.setattr(settings, "evidence_export_max_items", 1)
    second = create_item(owner_client, "Second drill")
    too_many = preview(owner_client, {"item_ids": [item["id"], second["id"]]})
    assert too_many.status_code == 422
    assert too_many.json()["detail"]["code"] == "export_too_many_items"


def test_multicurrency_legacy_purchase_and_shared_document_dedup(owner_client, pdf_bytes):
    usd_item = create_item(
        owner_client,
        "USD drill",
        purchase={
            "merchant": "USD Store",
            "purchase_date": "2026-01-01",
            "price_cents": 10000,
            "currency": "USD",
        },
    )
    unselected = create_item(
        owner_client,
        "Unselected attachment",
        purchase_id=usd_item["purchase"]["id"],
    )
    eur_item = create_item(
        owner_client,
        "EUR lamp",
        current_value_cents=5000,
        current_value_currency="EUR",
        purchase={
            "merchant": "EUR Store",
            "purchase_date": "2026-01-02",
            "price_cents": 6000,
            "currency": "EUR",
        },
    )
    receipt = upload_document(
        owner_client,
        title="Shared receipt with another product",
        document_type="receipt",
        item_ids=[usd_item["id"], unselected["id"]],
        data=pdf_bytes,
        filename="shared-receipt.pdf",
        content_type="application/pdf",
    )
    owner_client.patch(
        f"/api/v1/purchases/{usd_item['purchase']['id']}",
        json={"receipt_document_id": receipt["id"]},
    )
    preview_data = preview(owner_client, {"item_ids": [usd_item["id"], eur_item["id"]]})
    assert preview_data.status_code == 200, preview_data.text
    data = preview_data.json()
    assert data["item_count"] == 2
    totals = {entry["currency"]: entry for entry in data["currency_totals"]}
    assert "USD" not in totals
    assert totals["EUR"]["current_value_cents"] == 5000
    usd_purchase = next(
        entry for entry in data["purchase_references"] if entry["currency"] == "USD"
    )
    assert usd_purchase["has_allocations"] is False
    assert usd_purchase["selected_allocated_cents"] == 0
    assert usd_purchase["unallocated_cents"] == 10000
    assert usd_purchase["has_unselected_items"] is True
    receipt_preview = next(doc for doc in data["documents"] if doc["id"] == receipt["id"])
    assert receipt_preview["shared_with_unselected"] is True

    created = create_package(owner_client, data)
    assert created.status_code == 202, created.text
    run_package(created.json()["id"])
    csv_response = owner_client.get(f"/api/v1/evidence-exports/{created.json()['id']}/csv")
    rows = list(csv.reader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
    records = [dict(zip(rows[0], row, strict=True)) for row in rows[1:]]
    by_name = {record["item_name"]: record for record in records}
    assert by_name["USD drill"]["purchase_item_allocation_cents"] == ""
    assert by_name["USD drill"]["purchase_unallocated_cents"] == "10000"
    assert "includes items outside selection" in by_name["USD drill"]["purchase_total_scope"]
    assert by_name["EUR lamp"]["purchase_currency"] == "EUR"
    bundle = owner_client.get(f"/api/v1/evidence-exports/{created.json()['id']}/bundle")
    with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    assert len([doc for doc in manifest["documents"] if doc["id"] == receipt["id"]]) == 1


def test_evidence_package_includes_exact_last_checked_state_and_marks_it_stale(
    owner_client,
):
    room = create_room(owner_client, "Checked evidence room")
    item = create_item(owner_client, "Checked radio", room_id=room["id"])
    started = owner_client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": [room["id"]],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert started.status_code == 201, started.text
    session_id = started.json()["id"]
    session = owner_client.get(f"/api/v1/stocktake/sessions/{session_id}").json()
    row = session["items"][0]
    observation = owner_client.post(
        f"/api/v1/stocktake/sessions/{session_id}/observations",
        json={
            "request_id": str(uuid.uuid4()),
            "status": "present",
            "snapshot_item_id": row["snapshot_item_id"],
            "counted_quantity": 1,
            "expected_item_updated_at": row["current"]["updated_at"],
            "expected_on_loan_quantity": 0,
        },
    )
    assert observation.status_code == 201, observation.text
    completed = owner_client.post(
        f"/api/v1/stocktake/sessions/{session_id}/complete",
        json={
            "request_id": str(uuid.uuid4()),
            "acknowledge_partial": True,
        },
    )
    assert completed.status_code == 200, completed.text

    preview_data = preview(owner_client, {"item_ids": [item["id"]]}).json()
    created = create_package(owner_client, preview_data)
    assert created.status_code == 202, created.text
    run_package(created.json()["id"])
    csv_response = owner_client.get(f"/api/v1/evidence-exports/{created.json()['id']}/csv")
    rows = list(csv.reader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
    record = dict(zip(rows[0], rows[1], strict=True))
    assert record["last_checked_status"] == "present"
    assert record["last_checked_quantity"] == "1"
    assert record["last_checked_stale"] == "no"
    pdf = owner_client.get(f"/api/v1/evidence-exports/{created.json()['id']}/pdf")
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Last checked" in text

    owner_client.patch(f"/api/v1/items/{item['id']}", json={"name": "Checked radio edited"})
    stale_preview = preview(owner_client, {"item_ids": [item["id"]]}).json()
    stale_created = create_package(owner_client, stale_preview)
    assert stale_created.status_code == 202
    run_package(stale_created.json()["id"])
    stale_csv = owner_client.get(f"/api/v1/evidence-exports/{stale_created.json()['id']}/csv")
    stale_rows = list(csv.reader(io.StringIO(stale_csv.content.decode("utf-8-sig"))))
    stale_record = dict(zip(stale_rows[0], stale_rows[1], strict=True))
    assert stale_record["last_checked_stale"] == "yes"
    stale_pdf = owner_client.get(f"/api/v1/evidence-exports/{stale_created.json()['id']}/pdf")
    stale_text = "\n".join(
        page.extract_text() or "" for page in PdfReader(io.BytesIO(stale_pdf.content)).pages
    )
    assert "changed after that check" in stale_text
