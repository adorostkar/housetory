import io
import uuid
from datetime import UTC, datetime

import pytest
from PIL import Image, ImageDraw
from pillow_heif import register_heif_opener
from pypdf import PdfReader
from sqlalchemy import func, select, update

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    Document,
    DocumentScan,
    Household,
    HouseholdMember,
    Job,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import scan as scan_service
from housetory_api.services.auth import create_session
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.ocr import ExtractedText

register_heif_opener()


def heic_bytes(size=(480, 640)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (210, 204, 188)).save(buffer, format="HEIF", quality=85)
    return buffer.getvalue()


def scan_png(
    *,
    size=(600, 900),
    top=(180, 60, 60),
    bottom=(60, 90, 180),
    text: str | None = None,
) -> bytes:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, size[0], size[1] // 2], fill=top)
    draw.rectangle([0, size[1] // 2, size[0], size[1]], fill=bottom)
    draw.rectangle([8, 8, size[0] - 8, size[1] - 8], outline="black", width=4)
    if text:
        draw.text((30, 30), text, fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create_scan(client):
    response = client.post("/api/v1/documents/scans")
    assert response.status_code == 201, response.text
    return response.json()


def upload_page(client, scan_id, data: bytes, name="page.png"):
    response = client.post(
        f"/api/v1/documents/scans/{scan_id}/pages",
        files={"file": (name, data, "image/png")},
    )
    assert response.status_code == 201, response.text
    return response.json()


def patch_page(client, scan_id, page_id, payload):
    response = client.patch(f"/api/v1/documents/scans/{scan_id}/pages/{page_id}", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def commit_scan(client, scan_id, **overrides):
    payload = {
        "request_id": str(uuid.uuid4()),
        "title": "Scanned receipt",
        "document_type": "receipt",
        "item_ids": [],
        **overrides,
    }
    return client.post(f"/api/v1/documents/scans/{scan_id}/commit", json=payload)


def create_item(client, name="Scanned item"):
    response = client.post("/api/v1/items", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def _add_member(owner_client, *, email: str, role: str) -> tuple[str, uuid.UUID]:
    household_id = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password("member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household_id, user_id=user.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="scan-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def test_scan_editor_crop_rotation_contrast_and_original_bytes(owner_client):
    scan = create_scan(owner_client)
    original = scan_png(text="RECEIPT")
    page = upload_page(owner_client, scan["id"], original)
    assert page["page_number"] == 1
    assert page["original_byte_size"] == len(original)
    assert page["width"] == 600
    assert page["height"] == 900

    default_cleaned = owner_client.get(page["cleaned_url"]).content
    cropped = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "corners": [
                {"x": 0.0, "y": 0.0},
                {"x": 1.0, "y": 0.0},
                {"x": 1.0, "y": 0.5},
                {"x": 0.0, "y": 0.5},
            ],
            "color_mode": "grayscale",
            "contrast": 1.4,
        },
    )
    assert cropped["width"] == 600
    assert abs(cropped["height"] - 450) <= 2
    cleaned = owner_client.get(cropped["cleaned_url"]).content
    assert cleaned != default_cleaned
    image = Image.open(io.BytesIO(cleaned))
    assert image.width == cropped["width"]
    assert image.height == cropped["height"]
    pixel = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert pixel[0] == pixel[1] == pixel[2]

    rotated = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "rotation": 90,
            "corners": [
                {"x": 0.0, "y": 0.0},
                {"x": 1.0, "y": 0.0},
                {"x": 1.0, "y": 1.0},
                {"x": 0.0, "y": 1.0},
            ],
        },
    )
    assert rotated["width"] == 900
    assert rotated["height"] == 600

    skewed = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "rotation": 0,
            "corners": [
                {"x": 0.05, "y": 0.04},
                {"x": 0.94, "y": 0.08},
                {"x": 0.9, "y": 0.94},
                {"x": 0.08, "y": 0.9},
            ],
            "color_mode": "document",
            "contrast": 1.2,
        },
    )
    assert 1 <= skewed["width"] <= 600
    assert 1 <= skewed["height"] <= 900
    assert owner_client.get(page["original_url"]).content == original

    reset = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "rotation": 0,
            "corners": [
                {"x": 0.0, "y": 0.0},
                {"x": 1.0, "y": 0.0},
                {"x": 1.0, "y": 1.0},
                {"x": 0.0, "y": 1.0},
            ],
            "color_mode": "color",
            "contrast": 1.0,
        },
    )
    assert reset["width"] == 600
    assert reset["height"] == 900


def test_scan_detects_inset_page_but_keeps_uncertain_full_frame(owner_client):
    scan = create_scan(owner_client)
    uncertain = upload_page(owner_client, scan["id"], scan_png())
    assert uncertain["detection_status"] == "manual_required"
    assert (uncertain["width"], uncertain["height"]) == (600, 900)
    image = Image.new("RGB", (800, 1000), (40, 50, 60))
    draw = ImageDraw.Draw(image)
    draw.polygon([(160, 100), (700, 160), (650, 900), (100, 800)], fill="white")
    for y in range(250, 750, 60):
        draw.line([(220, y), (550, y)], fill="black", width=3)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    original = buffer.getvalue()
    detected = upload_page(owner_client, scan["id"], original)
    assert detected["detection_status"] == "detected"
    assert detected["width"] < 650
    assert detected["height"] < 850
    assert owner_client.get(detected["original_url"]).content == original


def test_cleanup_existing_scan_preserves_identity_originals_and_metadata(owner_client):
    item = create_item(owner_client)
    scan = create_scan(owner_client)
    original = scan_png()
    page = upload_page(owner_client, scan["id"], original)
    document = commit_scan(
        owner_client,
        scan["id"],
        item_ids=[item["id"]],
        merchant="Reviewed shop",
        notes="Keep this note",
    ).json()
    original_pdf = owner_client.get(document["original_url"]).content
    before_pdf = owner_client.get(document["url"]).content
    with SessionLocal() as db:
        current = db.get(Document, document["id"])
        current.extracted_text = "Old OCR"
        current.extracted_metadata = {
            "extraction": {"version": "old"},
            "extraction_refinements": {"old": "proposal"},
            "enhancement": {"status": "succeeded"},
            "extraction_applied": {"purchase_id": "reviewed-history"},
            "applied_at": "2026-01-02T00:00:00Z",
            "applied_item_ids": [item["id"]],
        }
        db.commit()
    draft_response = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    )
    assert draft_response.status_code == 201, draft_response.text
    draft = draft_response.json()
    assert draft["target_document_id"] == document["id"]
    assert len(draft["pages"]) == 1
    draft_page = draft["pages"][0]
    assert draft_page["id"] != page["id"]
    patch_page(owner_client, draft["id"], draft_page["id"], {"rotation": 90})
    assert owner_client.get(document["url"]).content == before_pdf
    assert (
        owner_client.post(
            f"/api/v1/documents/scans/{draft['id']}/pages",
            files={"file": ("extra.png", original, "image/png")},
        ).status_code
        == 409
    )
    assert (
        owner_client.delete(
            f"/api/v1/documents/scans/{draft['id']}/pages/{draft_page['id']}",
        ).status_code
        == 409
    )
    assert (
        owner_client.post(
            f"/api/v1/documents/scans/{draft['id']}/pages/reorder",
            json={"page_ids": [draft_page["id"]]},
        ).status_code
        == 409
    )
    request_id = str(uuid.uuid4())
    saved = commit_scan(
        owner_client,
        draft["id"],
        request_id=request_id,
        title="Ignored",
        merchant="Untrusted",
        item_ids=[],
    )
    assert saved.status_code == 200, saved.text
    updated = saved.json()
    assert updated["id"] == document["id"]
    assert updated["title"] == document["title"]
    assert updated["merchant"] == "Reviewed shop"
    assert updated["notes"] == "Keep this note"
    assert [entry["id"] for entry in updated["items"]] == [item["id"]]
    assert [entry["id"] for entry in updated["pages"]] == [page["id"]]
    assert owner_client.get(document["original_url"]).content == original_pdf
    assert owner_client.get(page["original_url"]).content == original
    assert owner_client.get(document["url"]).content != before_pdf
    assert updated["extracted_text"] is None
    assert updated["ocr_status"] == "queued"
    assert updated["extracted_metadata"]["extraction_applied"] == {
        "purchase_id": "reviewed-history",
    }
    assert updated["extracted_metadata"]["applied_item_ids"] == [item["id"]]
    assert not (
        {"extraction", "extraction_refinements", "enhancement"}
        & updated["extracted_metadata"].keys()
    )
    replay = commit_scan(owner_client, draft["id"], request_id=request_id)
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == document["id"]
    assert owner_client.get("/api/v1/documents").json()["total"] == 1
    with SessionLocal() as db:
        assert db.get(Document, document["id"]).source_generation == 2
        assert (
            db.scalar(
                select(func.count(DocumentScan.id)).where(
                    DocumentScan.document_id == uuid.UUID(document["id"]),
                )
            )
            == 1
        )
        jobs = db.scalars(select(Job).where(Job.task == "documents.ocr")).all()
        assert sorted(job.payload["source_generation"] for job in jobs) == [1, 2]


def test_manual_perspective_rectifies_projected_internal_grid_and_preserves_rgb(owner_client):
    # Known projective camera mapping, independent of the scanner's warp implementation.
    def projected(u, v):
        denominator = 0.8 * u + 0.2 * v + 1
        return ((600 * u + 80 * v + 100) / denominator, (30 * u + 800 * v + 80) / denominator)

    image = Image.new("RGB", (550, 850), (40, 50, 60))
    draw = ImageDraw.Draw(image)
    corners = [projected(0, 0), projected(1, 0), projected(1, 1), projected(0, 1)]
    draw.polygon(corners, fill="white")
    for fraction in (0.25, 0.5, 0.75):
        draw.line([projected(fraction, 0), projected(fraction, 1)], fill="red", width=5)
        draw.line([projected(0, fraction), projected(1, fraction)], fill="blue", width=5)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], buffer.getvalue())
    corrected = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "corners": [{"x": x / 550, "y": y / 850} for x, y in corners],
        },
    )
    assert corrected["detection_status"] == "manual"
    output = Image.open(io.BytesIO(owner_client.get(corrected["cleaned_url"]).content))
    for fraction in (0.25, 0.5, 0.75):
        red = output.getpixel(
            (round((output.width - 1) * fraction), round((output.height - 1) * 0.125))
        )
        blue = output.getpixel(
            (round((output.width - 1) * 0.125), round((output.height - 1) * fraction))
        )
        assert red[0] > 170 and red[1] < 100 and red[2] < 100
        assert blue[2] > 170 and blue[0] < 100 and blue[1] < 100


def test_standalone_image_cleanup_keeps_exact_original_and_normalizes_pdf_download(owner_client):
    original = scan_png()
    response = owner_client.post(
        "/api/v1/documents",
        files={"file": ("camera.png", original, "image/png")},
        data={"title": "Camera receipt", "document_type": "receipt"},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    draft = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    ).json()
    saved = commit_scan(owner_client, draft["id"])
    assert saved.status_code == 200, saved.text
    updated = saved.json()
    assert updated["id"] == document["id"]
    assert updated["original_filename"] == document["original_filename"]
    assert updated["original_content_type"] == "image/png"
    assert updated["content_type"] == "application/pdf"
    normalized = owner_client.get(updated["url"])
    assert normalized.headers["content-type"] == "application/pdf"
    assert normalized.headers["content-disposition"].endswith('.pdf"')
    source = owner_client.get(updated["original_url"])
    assert source.content == original
    assert source.headers["content-type"] == "image/png"
    assert source.headers["content-disposition"].endswith('.png"')
    again = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    )
    assert again.status_code == 201, again.text
    assert len(again.json()["pages"]) == 1


@pytest.mark.parametrize("expire", [False, True])
def test_abandoned_cleanup_removes_only_draft_owned_files(owner_client, upload_root, expire):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    document = commit_scan(owner_client, scan["id"]).json()
    retained = {path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()}
    draft = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    ).json()
    patch_page(owner_client, draft["id"], draft["pages"][0]["id"], {"rotation": 90})
    if expire:
        with SessionLocal() as db:
            current = db.get(DocumentScan, draft["id"])
            current.updated_at = datetime(2020, 1, 1, tzinfo=UTC)
            db.commit()
            scan_service.prune_expired_scans(db)
    else:
        assert owner_client.delete(f"/api/v1/documents/scans/{draft['id']}").status_code == 204
    assert {
        path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()
    } == retained
    assert owner_client.get(page["original_url"]).status_code == 200


def test_concurrent_cleanup_conflicts_without_overwriting_or_duplicate_document(owner_client):
    scan = create_scan(owner_client)
    upload_page(owner_client, scan["id"], scan_png())
    document = commit_scan(owner_client, scan["id"]).json()
    drafts = [
        owner_client.post(
            "/api/v1/documents/scans",
            json={"target_document_id": document["id"]},
        ).json()
        for _ in range(2)
    ]
    assert commit_scan(owner_client, drafts[0]["id"]).status_code == 200
    current = owner_client.get(document["url"]).content
    stale = commit_scan(owner_client, drafts[1]["id"])
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "cleanup_stale"
    assert owner_client.get(document["url"]).content == current
    assert owner_client.get("/api/v1/documents").json()["total"] == 1
    assert owner_client.delete(f"/api/v1/documents/scans/{drafts[1]['id']}").status_code == 204


def test_failed_cleanup_publication_preserves_document_draft_and_all_originals(
    owner_client,
    upload_root,
    monkeypatch,
):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    document = commit_scan(owner_client, scan["id"]).json()
    draft = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    ).json()
    patch_page(owner_client, draft["id"], draft["pages"][0]["id"], {"rotation": 90})
    before = {path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()}
    enqueue = scan_service.enqueue_ocr

    def failed_enqueue(*args, **kwargs):
        raise RuntimeError("Simulated publication failure")

    monkeypatch.setattr(scan_service, "enqueue_ocr", failed_enqueue)
    with pytest.raises(RuntimeError, match="Simulated publication failure"):
        commit_scan(owner_client, draft["id"])
    assert {path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()} == before
    current = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert current["pages"][0]["id"] == page["id"]
    assert current["pages"][0]["width"] == page["width"]
    assert owner_client.get(f"/api/v1/documents/scans/{draft['id']}").json()["status"] == "draft"
    monkeypatch.setattr(scan_service, "enqueue_ocr", enqueue)
    assert commit_scan(owner_client, draft["id"]).status_code == 200


def test_cleanup_rechecks_generation_after_staging_and_keeps_concurrent_edits(
    owner_client,
    upload_root,
    monkeypatch,
):
    scan = create_scan(owner_client)
    upload_page(owner_client, scan["id"], scan_png())
    document = commit_scan(owner_client, scan["id"]).json()
    draft = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    ).json()
    before = {path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()}
    write = scan_service.storage.write_document_pdf

    def replace_before_publication(*args, **kwargs):
        result = write(*args, **kwargs)
        with SessionLocal() as db:
            current = db.get(Document, document["id"])
            current.source_generation += 1
            current.notes = "Concurrent manual note"
            db.commit()
        return result

    monkeypatch.setattr(scan_service.storage, "write_document_pdf", replace_before_publication)
    response = commit_scan(owner_client, draft["id"])
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "cleanup_stale"
    assert {path: path.read_bytes() for path in upload_root.rglob("*") if path.is_file()} == before
    current = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert current["notes"] == "Concurrent manual note"


def test_scan_honors_exif_without_network_and_bounds_automatic_analysis(owner_client, monkeypatch):
    import cv2

    scan = create_scan(owner_client)
    image = Image.new("RGB", (1800, 900), (180, 20, 40))
    exif = Image.Exif()
    exif[274] = 6
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    original = buffer.getvalue()
    analyzed = []
    convert = cv2.cvtColor

    def bounded_conversion(pixels, code, *args, **kwargs):
        analyzed.append(pixels.shape[:2])
        assert max(pixels.shape[:2]) <= 1200
        return convert(pixels, code, *args, **kwargs)

    def no_network(*args, **kwargs):
        raise AssertionError("Scan processing must not access the network")

    monkeypatch.setattr(cv2, "cvtColor", bounded_conversion)
    monkeypatch.setattr("socket.create_connection", no_network)
    page = upload_page(owner_client, scan["id"], original, name="camera.jpg")
    assert analyzed
    assert cv2.getNumThreads() == 1
    assert not cv2.ocl.useOpenCL()
    assert (page["width"], page["height"]) == (900, 1800)
    assert page["detection_status"] == "manual_required"
    assert owner_client.get(page["original_url"]).content == original


def test_cleanup_rejects_non_image_pdf_and_deleted_targets(owner_client, pdf_bytes):
    pdf = owner_client.post(
        "/api/v1/documents",
        files={"file": ("paper.pdf", pdf_bytes, "application/pdf")},
    )
    assert pdf.status_code == 201
    response = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": pdf.json()["id"]},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "cleanup_unsupported"
    scan = create_scan(owner_client)
    upload_page(owner_client, scan["id"], scan_png())
    document = commit_scan(owner_client, scan["id"]).json()
    draft = owner_client.post(
        "/api/v1/documents/scans",
        json={"target_document_id": document["id"]},
    ).json()
    assert owner_client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    stale = commit_scan(owner_client, draft["id"])
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "cleanup_stale"
    assert owner_client.delete(f"/api/v1/documents/scans/{draft['id']}").status_code == 204


def test_large_page_preview_and_perspective_keep_aspect_ratio_within_bounds(owner_client):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png(size=(5000, 1000)))
    assert (page["width"], page["height"]) == (3500, 700)
    cropped = patch_page(
        owner_client,
        scan["id"],
        page["id"],
        {
            "corners": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 0.5}, {"x": 0, "y": 0.5}],
        },
    )
    assert (cropped["width"], cropped["height"]) == (3500, 350)


def test_expiry_skips_draft_locked_for_publication(owner_client):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    with SessionLocal() as db:
        db.get(DocumentScan, scan["id"]).updated_at = datetime(2020, 1, 1, tzinfo=UTC)
        db.commit()
    with SessionLocal() as saving, SessionLocal() as pruning:
        scan_service.get_scan(
            saving,
            uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"]),
            uuid.UUID(scan["id"]),
            for_update=True,
        )
        assert scan_service.prune_expired_scans(pruning)["scans"] == 0
    assert owner_client.get(page["original_url"]).status_code == 200


def test_scan_commit_builds_ordered_pdf_idempotently_and_links_item(owner_client):
    item = create_item(owner_client)
    scan = create_scan(owner_client)
    portrait = upload_page(owner_client, scan["id"], scan_png())
    landscape = upload_page(
        owner_client,
        scan["id"],
        scan_png(size=(1200, 800), top=(20, 120, 80), bottom=(80, 90, 20)),
    )
    reordered = owner_client.post(
        f"/api/v1/documents/scans/{scan['id']}/pages/reorder",
        json={"page_ids": [landscape["id"], portrait["id"]]},
    )
    assert reordered.status_code == 200, reordered.text
    assert [page["id"] for page in reordered.json()["pages"]] == [
        landscape["id"],
        portrait["id"],
    ]
    request_id = str(uuid.uuid4())
    first = commit_scan(
        owner_client,
        scan["id"],
        request_id=request_id,
        title="Two page receipt",
        item_ids=[item["id"]],
    )
    assert first.status_code == 200, first.text
    document = first.json()
    assert document["page_count"] == 2
    assert [page["id"] for page in document["pages"]] == [
        landscape["id"],
        portrait["id"],
    ]
    assert document["items"][0]["id"] == item["id"]
    assert document["content_type"] == "application/pdf"
    assert document["original_content_type"] == "application/pdf"
    assert document["extracted_metadata"]["scan"]["page_count"] == 2
    assert document["ocr_status"] == "queued"

    pdf = PdfReader(io.BytesIO(owner_client.get(document["url"]).content))
    assert len(pdf.pages) == 2
    assert float(pdf.pages[0].mediabox.width) > float(pdf.pages[0].mediabox.height)
    assert float(pdf.pages[1].mediabox.width) < float(pdf.pages[1].mediabox.height)
    source_pdf = PdfReader(io.BytesIO(owner_client.get(document["original_url"]).content))
    assert len(source_pdf.pages) == 2

    item_after = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert [entry["id"] for entry in item_after["documents"]] == [document["id"]]
    assert owner_client.get("/api/v1/items").json()["total"] == 1
    assert owner_client.get("/api/v1/purchases").json()["total"] == 0

    replay = commit_scan(
        owner_client,
        scan["id"],
        request_id=request_id,
        title="Two page receipt",
        item_ids=[item["id"]],
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == document["id"]
    with SessionLocal() as db:
        assert int(db.scalar(select(func.count(Document.id))) or 0) == 1
        committed = db.get(DocumentScan, uuid.UUID(scan["id"]))
        assert committed is not None
        assert committed.status == "committed"

    different = commit_scan(
        owner_client,
        scan["id"],
        request_id=str(uuid.uuid4()),
        title="Two page receipt",
    )
    assert different.status_code == 409
    assert different.json()["detail"]["code"] == "scan_committed"

    # Deleting the document removes the scan, page derivatives and source files.
    assert owner_client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    assert owner_client.get(document["url"]).status_code == 404
    assert owner_client.get(document["pages"][0]["cleaned_url"]).status_code == 404
    with SessionLocal() as db:
        assert db.get(DocumentScan, uuid.UUID(scan["id"])) is None


def test_scan_ocr_uses_cleaned_pdf_and_preserves_scan_metadata(owner_client):
    item = create_item(owner_client)
    scan = create_scan(owner_client)
    upload_page(owner_client, scan["id"], scan_png(text="TOTAL 12.34"))
    response = commit_scan(owner_client, scan["id"], item_ids=[item["id"]])
    assert response.status_code == 200, response.text
    document = response.json()

    seen: dict[str, str] = {}

    def extractor(path, content_type):
        seen["name"] = path.name
        seen["content_type"] = content_type
        return ExtractedText(text="TOTAL 12.34", confidence=88, source="ocr")

    result = run_document_ocr(
        uuid.UUID(document["id"]),
        extractor=extractor,
        parser=lambda _text: {"merchant": "Corner Shop", "total_cents": 1234},
    )
    assert result is not None
    assert seen["content_type"] == "application/pdf"
    assert seen["name"] == f"{document['id']}.pdf"
    refreshed = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert refreshed["ocr_status"] == "succeeded"
    assert refreshed["extracted_metadata"]["ocr_artifact"] == "cleaned_pdf"
    assert refreshed["extracted_metadata"]["scan"]["page_count"] == 1
    assert refreshed["extracted_text"] == "TOTAL 12.34"


def test_scan_cancel_and_prune_cleanup_private_files(owner_client, upload_root):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    assert [path for path in upload_root.rglob("*") if path.is_file()]
    response = owner_client.delete(f"/api/v1/documents/scans/{scan['id']}")
    assert response.status_code == 204
    assert owner_client.get(f"/api/v1/documents/scans/{scan['id']}").status_code == 404
    assert owner_client.get(page["original_url"]).status_code == 404
    assert [path for path in upload_root.rglob("*") if path.is_file()] == []

    pruned_scan = create_scan(owner_client)
    pruned_page = upload_page(owner_client, pruned_scan["id"], scan_png())
    with SessionLocal() as db:
        db.execute(
            update(DocumentScan)
            .where(DocumentScan.id == uuid.UUID(pruned_scan["id"]))
            .values(updated_at=datetime(2020, 1, 1, tzinfo=UTC))
        )
        db.commit()
        pruned = scan_service.prune_expired_scans(
            db,
            household_id=uuid.UUID(
                owner_client.get("/api/v1/auth/session").json()["household"]["id"]
            ),
        )
    assert pruned == {"scans": 1, "files": 2}
    assert owner_client.get(pruned_page["cleaned_url"]).status_code == 404
    assert [path for path in upload_root.rglob("*") if path.is_file()] == []


def test_scan_household_isolation_and_viewer_rules(owner_client, anon_client):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    viewer_token, _ = _add_member(owner_client, email="scan-viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    assert anon_client.post("/api/v1/documents/scans", headers=viewer).status_code == 403
    document = commit_scan(owner_client, scan["id"]).json()
    assert (
        anon_client.post(
            "/api/v1/documents/scans",
            headers=viewer,
            json={"target_document_id": document["id"]},
        ).status_code
        == 403
    )
    assert (
        anon_client.get(f"/api/v1/documents/scans/{scan['id']}", headers=viewer).status_code == 200
    )
    assert anon_client.get(page["cleaned_url"], headers=viewer).status_code == 200

    with SessionLocal() as db:
        other = Household(name="Other Scan Home")
        user = User(
            name="Other Scan Owner",
            email="other-scan@example.com",
            password_hash=hash_password("other-scan-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="scan-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
    other_headers = _headers(token)
    assert (
        anon_client.post(
            "/api/v1/documents/scans",
            headers=other_headers,
            json={"target_document_id": document["id"]},
        ).status_code
        == 404
    )
    assert (
        anon_client.get(f"/api/v1/documents/scans/{scan['id']}", headers=other_headers).status_code
        == 404
    )
    assert anon_client.get(page["original_url"], headers=other_headers).status_code == 404
    cross_page = anon_client.post(
        f"/api/v1/documents/scans/{scan['id']}/pages",
        headers=other_headers,
        files={"file": ("page.png", scan_png(), "image/png")},
    )
    assert cross_page.status_code == 404


def test_scan_validation_limits_corners_and_unsupported_pages(owner_client, monkeypatch):
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    invalid_type = owner_client.post(
        f"/api/v1/documents/scans/{scan['id']}/pages",
        files={"file": ("not-image.txt", b"plain text", "text/plain")},
    )
    assert invalid_type.status_code == 422
    assert invalid_type.json()["detail"]["code"] == "unsupported_scan_page"
    invalid_corners = owner_client.patch(
        f"/api/v1/documents/scans/{scan['id']}/pages/{page['id']}",
        json={
            "corners": [
                {"x": 0.5, "y": 0.5},
                {"x": 0.5, "y": 0.5},
                {"x": 0.5, "y": 0.5},
                {"x": 0.5, "y": 0.5},
            ]
        },
    )
    assert invalid_corners.status_code == 422
    outside = owner_client.patch(
        f"/api/v1/documents/scans/{scan['id']}/pages/{page['id']}",
        json={"contrast": 5},
    )
    assert outside.status_code == 422

    request_id = str(uuid.uuid4())
    committed = commit_scan(owner_client, scan["id"], request_id=request_id)
    assert committed.status_code == 200, committed.text
    reuse = owner_client.post(
        "/api/v1/documents/scans",
    )
    assert reuse.status_code in {201, 409}
    if reuse.status_code == 201:
        second = reuse.json()
        upload_page(owner_client, second["id"], scan_png(size=(100, 120)))
        duplicate = commit_scan(
            owner_client,
            second["id"],
            request_id=request_id,
            title="Different scan",
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"]["code"] == "request_id_reused"
        owner_client.delete(f"/api/v1/documents/scans/{second['id']}")

    monkeypatch.setattr(scan_service, "SCAN_MAX_PAGES", 1)
    limited = create_scan(owner_client)
    upload_page(owner_client, limited["id"], scan_png(size=(100, 120)))
    overflow = owner_client.post(
        f"/api/v1/documents/scans/{limited['id']}/pages",
        files={"file": ("second.png", scan_png(size=(100, 120)), "image/png")},
    )
    assert overflow.status_code == 409
    assert overflow.json()["detail"]["code"] == "scan_page_limit"

    # An empty scan cannot be committed.
    empty = create_scan(owner_client)
    empty_commit = commit_scan(owner_client, empty["id"])
    assert empty_commit.status_code == 422
    assert empty_commit.json()["detail"]["code"] == "scan_empty"


def test_deleting_item_removes_exclusive_scanned_document_and_page_files(owner_client):
    item = create_item(owner_client)
    scan = create_scan(owner_client)
    page = upload_page(owner_client, scan["id"], scan_png())
    committed = commit_scan(owner_client, scan["id"], item_ids=[item["id"]])
    assert committed.status_code == 200, committed.text
    document = committed.json()
    assert owner_client.delete(f"/api/v1/items/{item['id']}").status_code == 204
    assert owner_client.get(document["url"]).status_code == 404
    assert owner_client.get(page["original_url"]).status_code == 404
    with SessionLocal() as db:
        assert db.get(Document, uuid.UUID(document["id"])) is None
        assert db.get(DocumentScan, uuid.UUID(scan["id"])) is None


def test_scan_page_accepts_heic_and_keeps_exact_original_bytes(owner_client):
    scan = create_scan(owner_client)
    original = heic_bytes()
    response = owner_client.post(
        f"/api/v1/documents/scans/{scan['id']}/pages",
        files={"file": ("iphone-page.heic", original, "image/heic")},
    )
    assert response.status_code == 201, response.text
    page = response.json()
    assert page["original_content_type"] == "image/heic"
    assert page["cleaned_content_type"] == "image/jpeg"
    assert owner_client.get(page["original_url"]).content == original
    cleaned = Image.open(io.BytesIO(owner_client.get(page["cleaned_url"]).content))
    assert cleaned.format == "JPEG"
    assert cleaned.size == (480, 640)
