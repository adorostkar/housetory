import io
import os
import stat

from PIL import Image
from pillow_heif import register_heif_opener
from sqlalchemy import select

from housetory_api.db import SessionLocal
from housetory_api.domain import OcrStatus
from housetory_api.models import Document, Job, Purchase

register_heif_opener()


def heic_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (400, 300), (90, 110, 85)).save(buffer, format="HEIF", quality=80)
    return buffer.getvalue()


def jpeg_with_exif() -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (320, 240), (100, 90, 80))
    exif = Image.Exif()
    exif[0x010F] = "Sensitive Camera Make"
    exif[0x0110] = "Sensitive Camera Model"
    image.save(buffer, format="JPEG", quality=90, exif=exif)
    return buffer.getvalue()


def create_item(client, name="Camera", **extra) -> dict:
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def upload_document(client, *, item_ids=None, title="Receipt", data=None):
    payload = {
        "title": title,
        "document_type": "receipt",
        **(data or {}),
    }
    if item_ids is not None:
        payload["item_ids"] = item_ids
    return client.post(
        "/api/v1/documents",
        files={"file": ("receipt.pdf", b"%PDF-1.4\n", "application/pdf")},
        data=payload,
    )


def test_document_library_upload_metadata_multiple_items_and_search(owner_client, pdf_bytes):
    first = create_item(owner_client, "Espresso Machine")
    second = create_item(owner_client, "Coffee Grinder")
    response = owner_client.post(
        "/api/v1/documents",
        files={"file": ("market-receipt.pdf", pdf_bytes, "application/pdf")},
        data={
            "title": "Market receipt",
            "document_type": "receipt",
            "merchant": "La Marzocco Boutique",
            "document_date": "2026-02-14",
            "notes": "Bought together",
            "item_ids": [first["id"], second["id"]],
        },
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["title"] == "Market receipt"
    assert document["document_type"] == "receipt"
    assert document["merchant"] == "La Marzocco Boutique"
    assert document["document_date"] == "2026-02-14"
    assert document["items"] == [
        {"id": second["id"], "name": "Coffee Grinder"},
        {"id": first["id"], "name": "Espresso Machine"},
    ]
    assert document["item_count"] == 2
    assert document["original_url"].endswith("/original")
    assert document["ocr_status"] == "queued"

    with SessionLocal() as db:
        jobs = db.scalars(select(Job).where(Job.task == "documents.ocr")).all()
        assert len(jobs) == 1
        assert jobs[0].payload["document_id"] == document["id"]

    item_detail = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    assert item_detail["documents"][0]["id"] == document["id"]
    assert item_detail["documents"][0]["item_count"] == 2

    # Simulate OCR completion so search can exercise extracted text and metadata.
    with SessionLocal() as db:
        stored = db.get(Document, document["id"])
        stored.extracted_text = "Espresso Machine Linea Mini serial LM-2026-0042"
        stored.extracted_metadata = {
            "invoice_number": "INV-9001",
            "product_names": ["Espresso Machine"],
        }
        stored.ocr_status = OcrStatus.SUCCEEDED.value
        db.commit()

    for query in [
        "market-receipt",
        "La Marzocco",
        "Linea Mini",
        "INV-9001",
        "Espresso Machine",
    ]:
        result = owner_client.get("/api/v1/documents", params={"q": query}).json()
        assert result["total"] == 1, (query, result)

    by_type = owner_client.get("/api/v1/documents", params={"type": "manual"}).json()
    assert by_type["total"] == 0
    by_type = owner_client.get("/api/v1/documents", params={"type": "receipt"}).json()
    assert by_type["total"] == 1
    by_item = owner_client.get("/api/v1/documents", params={"item_id": second["id"]}).json()
    assert by_item["total"] == 1
    by_date = owner_client.get(
        "/api/v1/documents",
        params={"date_from": "2026-02-01", "date_to": "2026-02-28"},
    ).json()
    assert by_date["total"] == 1

    update = owner_client.patch(
        f"/api/v1/documents/{document['id']}",
        json={
            "title": "Espresso receipt",
            "document_type": "invoice",
            "item_ids": [first["id"]],
        },
    )
    assert update.status_code == 200, update.text
    assert update.json()["title"] == "Espresso receipt"
    assert update.json()["document_type"] == "invoice"
    assert update.json()["item_count"] == 1


def test_original_upload_is_preserved_and_default_download_is_sanitized(owner_client, upload_root):
    item = create_item(owner_client)
    original_bytes = jpeg_with_exif()
    response = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.jpg", original_bytes, "image/jpeg")},
        data={"title": "Paper receipt", "document_type": "receipt", "item_ids": [item["id"]]},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["original_byte_size"] == len(original_bytes)
    assert document["original_content_type"] == "image/jpeg"

    normalized = owner_client.get(document["url"])
    assert normalized.status_code == 200
    assert normalized.headers["cache-control"] == "private, no-store"
    stored_image = Image.open(io.BytesIO(normalized.content))
    assert 0x010F not in stored_image.getexif()

    original = owner_client.get(document["original_url"])
    assert original.status_code == 200
    assert original.content == original_bytes
    assert original.headers["x-housetory-original"] == "true"
    assert original.headers["cache-control"] == "private, no-store"
    assert original.headers["content-disposition"].startswith("attachment")

    files = [path for path in upload_root.rglob("*") if path.is_file()]
    assert any("originals" in path.parts for path in files)
    assert all(stat.S_IMODE(os.stat(path).st_mode) == 0o600 for path in files)

    deletion = owner_client.delete(f"/api/v1/documents/{document['id']}")
    assert deletion.status_code == 204
    assert owner_client.get(document["url"]).status_code == 404
    assert owner_client.get(document["original_url"]).status_code == 404
    assert not any("originals" in path.parts for path in upload_root.rglob("*") if path.is_file())


def test_pdf_original_download_is_byte_exact(owner_client, pdf_bytes):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("warranty.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Warranty certificate", "document_type": "warranty_certificate"},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["document_type"] == "warranty_certificate"
    assert owner_client.get(document["url"]).content == pdf_bytes
    assert owner_client.get(document["original_url"]).content == pdf_bytes


def test_document_update_clears_optional_metadata(owner_client):
    item = create_item(owner_client)
    document = owner_client.post(
        "/api/v1/documents",
        files={"file": ("manual.txt", b"Assembly instructions", "text/plain")},
        data={
            "title": "Manual",
            "document_type": "manual",
            "merchant": "Acme",
            "document_date": "2026-01-01",
            "item_ids": [item["id"]],
        },
    ).json()
    updated = owner_client.patch(
        f"/api/v1/documents/{document['id']}",
        json={"merchant": None, "document_date": None, "notes": "Stored in the box"},
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["merchant"] is None
    assert body["document_date"] is None
    assert body["notes"] == "Stored in the box"


def test_document_upload_without_items_is_allowed(owner_client):
    response = owner_client.post(
        "/api/v1/documents",
        files={"file": ("spec.txt", b"Specification", "text/plain")},
        data={"title": "General specification"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["items"] == []


def test_purchase_receipt_association(owner_client, pdf_bytes):
    item = create_item(owner_client)
    document = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Receipt", "document_type": "receipt", "item_ids": [item["id"]]},
    ).json()
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "Boutique",
            "purchase_date": "2026-02-14",
            "price_cents": 5000,
            "currency": "USD",
            "receipt_document_id": document["id"],
            "item_ids": [item["id"]],
        },
    )
    assert purchase.status_code == 201, purchase.text
    body = purchase.json()["purchase"]
    assert body["receipt"]["id"] == document["id"]
    assert body["receipt_document_id"] == document["id"]

    with SessionLocal() as db:
        stored = db.scalar(select(Purchase))
        assert stored is not None
        assert str(stored.receipt_document_id) == document["id"]


def test_heic_document_preserves_original_and_normalizes_download(owner_client):
    item = create_item(owner_client)
    original_bytes = heic_bytes()
    response = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.heic", original_bytes, "image/heic")},
        data={"title": "iPhone receipt", "document_type": "receipt", "item_ids": [item["id"]]},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["content_type"] == "image/jpeg"
    assert document["original_content_type"] == "image/heic"
    assert document["original_filename"] == "receipt.jpg"
    normalized = owner_client.get(document["url"])
    assert normalized.status_code == 200
    assert normalized.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(normalized.content)).format == "JPEG"
    original = owner_client.get(document["original_url"])
    assert original.status_code == 200
    assert original.content == original_bytes
    assert original.headers["content-type"] == "image/heic"
