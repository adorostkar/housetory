import io
import uuid

import pytest
from PIL import Image

from housetory_api.db import SessionLocal
from housetory_api.models import AiRecognition, Document, ImportBatch, Job
from housetory_api.services import ai
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.import_pipeline import process_import_batch
from housetory_api.services.recognition import run_recognition


def image_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def create_capture(client, kind):
    if kind == "import":
        response = client.post(
            "/api/v1/imports",
            data={
                "title": "Dismiss cable",
                "text": "Add one Dismiss cable",
                "assistant_capture": "true",
            },
        )
    elif kind == "document":
        response = client.post(
            "/api/v1/documents",
            data={
                "title": "Dismiss invoice",
                "document_type": "invoice",
                "assistant_capture": "true",
            },
            files={"file": ("invoice.txt", b"Invoice\nCable 1 20.00\nTotal 20.00", "text/plain")},
        )
    else:
        response = client.post(
            "/api/v1/ai/recognitions",
            data={"assistant_capture": "true"},
            files={"file": ("dismiss-box.png", image_bytes(), "image/png")},
        )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def capture(client, capture_id, *, dismissed=False):
    response = client.get("/api/v1/inventory-review/captures", params={"dismissed": dismissed})
    assert response.status_code == 200, response.text
    return next((review for review in response.json() if review["id"] == capture_id), None)


def dismiss(client, kind, capture_id):
    review = capture(client, capture_id)
    response = client.post(
        f"/api/v1/inventory-review/captures/{kind}/{capture_id}/dismiss",
        json={"generation": review["generation"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


def undo(client, review):
    return client.post(
        f"/api/v1/inventory-review/captures/{review['kind']}/{review['id']}/undo",
        json={"dismissal_id": review["dismissal_id"]},
    )


@pytest.mark.parametrize(
    ("kind", "status"),
    [
        ("import", "review"),
        ("import", "failed"),
        ("import", "processing"),
        ("document", "ready"),
        ("document", "failed"),
        ("document", "cancelled"),
        ("document", "reading"),
        ("photo", "succeeded"),
        ("photo", "failed"),
        ("photo", "processing"),
    ],
)
def test_capture_dismissal_preserves_evidence_and_inventory_and_undo_persists(
    owner_client,
    kind,
    status,
):
    capture_id = create_capture(owner_client, kind)
    model = {"import": ImportBatch, "document": Document, "photo": AiRecognition}[kind]
    with SessionLocal() as db:
        source = db.get(model, uuid.UUID(capture_id))
        if kind == "document":
            metadata = dict(source.extracted_metadata)
            metadata["processing"] = {**metadata["processing"], "stage": status}
            source.extracted_metadata = metadata
        else:
            source.status = status
        db.commit()
    source_path = (
        f"/api/v1/imports/{capture_id}/source"
        if kind == "import"
        else f"/api/v1/documents/{capture_id}/original"
        if kind == "document"
        else f"/api/v1/ai/recognitions/{capture_id}/original"
    )
    original = owner_client.get(source_path)
    assert original.status_code == 200
    inventory = owner_client.get("/api/v1/items").json()
    dismissed = dismiss(owner_client, kind, capture_id)
    assert dismissed["dismissal_id"]
    assert capture(owner_client, capture_id) is None
    assert (
        capture(owner_client, capture_id, dismissed=True)["dismissal_id"]
        == dismissed["dismissal_id"]
    )
    assert owner_client.get(source_path).content == original.content
    assert owner_client.get("/api/v1/items").json() == inventory
    repeated = owner_client.post(
        f"/api/v1/inventory-review/captures/{kind}/{capture_id}/dismiss",
        json={"generation": dismissed["generation"]},
    )
    assert repeated.json()["dismissal_id"] == dismissed["dismissal_id"]
    assert undo(owner_client, dismissed).status_code == 200
    assert capture(owner_client, capture_id)["notify"] is False
    assert capture(owner_client, capture_id, dismissed=True) is None
    assert owner_client.get(source_path).content == original.content
    assert owner_client.get("/api/v1/items").json() == inventory


@pytest.mark.parametrize("retry_during_inference", [False, True])
def test_photo_dismissal_survives_late_vision_and_retry_fences_old_attempt(
    owner_client,
    monkeypatch,
    configured_ai,
    retry_during_inference,
):
    capture_id = create_capture(owner_client, "photo")
    old = capture(owner_client, capture_id)
    dismissal = None

    def late_result(*args, **kwargs):
        nonlocal dismissal
        dismissal = dismiss(owner_client, "photo", capture_id)
        if retry_during_inference:
            response = owner_client.post(f"/api/v1/ai/recognitions/{capture_id}/retry")
            assert response.status_code == 200, response.text
        return {"suggestions": [{"name": "Visible box", "quantity": 1}]}

    monkeypatch.setattr(ai, "complete_json", late_result)
    result = run_recognition(capture_id)
    if retry_during_inference:
        assert result["reason"] == "superseded"
        new = capture(owner_client, capture_id)
        assert new["generation"] != old["generation"]
        assert new["notify"] is True
        assert undo(owner_client, dismissal).status_code == 409
        stale = owner_client.post(
            f"/api/v1/inventory-review/captures/photo/{capture_id}/dismiss",
            json={"generation": old["generation"]},
        )
        assert stale.status_code == 409
        monkeypatch.setattr(
            ai,
            "complete_json",
            lambda *a, **k: {
                "suggestions": [{"name": "New visible box", "quantity": 1}],
            },
        )
        run_recognition(capture_id)
        batch = owner_client.post(f"/api/v1/imports/from-recognition/{capture_id}").json()
        assert batch["entries"][0]["proposed"]["name"] == "New visible box"
    else:
        assert capture(owner_client, capture_id) is None
        assert capture(owner_client, capture_id, dismissed=True)["status"] == "succeeded"
        blocked = owner_client.post(f"/api/v1/imports/from-recognition/{capture_id}")
        assert blocked.status_code == 409
        assert undo(owner_client, dismissal).status_code == 200
        batch = owner_client.post(f"/api/v1/imports/from-recognition/{capture_id}").json()
        assert batch["entries"][0]["proposed"]["name"] == "Visible box"
        assert capture(owner_client, batch["id"])["notify"] is False
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_document_dismissal_during_local_extraction_survives_completion(owner_client):
    from housetory_api.services.ocr import ExtractedText

    capture_id = create_capture(owner_client, "document")
    dismissed = None

    def extractor(*args):
        nonlocal dismissed
        dismissed = dismiss(owner_client, "document", capture_id)
        return ExtractedText(
            text="Invoice\nCable 1 20.00\nTotal 20.00", source="text", confidence=100
        )

    run_document_ocr(capture_id, extractor=extractor)
    assert capture(owner_client, capture_id) is None
    saved = owner_client.get(f"/api/v1/documents/{capture_id}").json()
    assert saved["extracted_text"].startswith("Invoice")
    assert saved["extracted_metadata"]["review_dismissed"]["id"] == dismissed["dismissal_id"]
    assert undo(owner_client, dismissed).status_code == 200
    assert capture(owner_client, capture_id)["notify"] is False
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_import_dismissal_during_parsing_preserves_proposals_and_edits(owner_client, monkeypatch):
    from housetory_api.services import import_pipeline

    capture_id = create_capture(owner_client, "import")
    parse = import_pipeline.parse_documents
    dismissed = None

    def parser(bundle):
        nonlocal dismissed
        dismissed = dismiss(owner_client, "import", capture_id)
        return parse(bundle)

    monkeypatch.setattr(import_pipeline, "parse_documents", parser)
    process_import_batch(capture_id)
    assert capture(owner_client, capture_id) is None
    batch = owner_client.get(f"/api/v1/imports/{capture_id}").json()
    assert batch["entries"]
    proposals = batch["entries"]
    assert undo(owner_client, dismissed).status_code == 200
    assert owner_client.get(f"/api/v1/imports/{capture_id}").json()["entries"] == proposals
    assert capture(owner_client, capture_id)["notify"] is False
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_dismissed_primary_import_survives_late_ai_and_undo(
    owner_client,
    monkeypatch,
    configured_ai,
):
    from housetory_api.services.enrichment import run_enhancement

    capture_id = create_capture(owner_client, "import")
    process_import_batch(capture_id)
    batch = owner_client.get(f"/api/v1/imports/{capture_id}").json()
    with SessionLocal() as db:
        payload = dict(db.get(Job, uuid.UUID(batch["metadata"]["enhancement"]["job_id"])).payload)
    dismissed = None

    def extract(*args, **kwargs):
        nonlocal dismissed
        dismissed = dismiss(owner_client, "import", capture_id)
        return {"items": [{"name": "Cable", "quantity": 1}], "refinements": []}

    monkeypatch.setattr(ai, "complete_json", extract)
    assert run_enhancement(payload)["status"] == "ready"
    assert capture(owner_client, capture_id) is None
    completed = owner_client.get(f"/api/v1/imports/{capture_id}").json()
    assert completed["entries"][0]["proposed"]["name"] == "Cable"
    assert completed["metadata"]["review_dismissed"]["id"] == dismissed["dismissal_id"]
    assert owner_client.get("/api/v1/items").json()["items"] == []
    assert undo(owner_client, dismissed).status_code == 200
    assert capture(owner_client, capture_id)["notify"] is False
    assert (
        owner_client.get(f"/api/v1/imports/{capture_id}").json()["entries"] == completed["entries"]
    )
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_cancelled_document_retry_starts_new_visible_attempt(owner_client):
    capture_id = create_capture(owner_client, "document")
    cancelled = owner_client.post(f"/api/v1/documents/{capture_id}/processing/cancel")
    assert cancelled.status_code == 200, cancelled.text
    old = capture(owner_client, capture_id)
    dismissed = dismiss(owner_client, "document", capture_id)
    retried = owner_client.post(f"/api/v1/documents/{capture_id}/processing/retry")
    assert retried.status_code == 200, retried.text
    new = capture(owner_client, capture_id)
    assert new["generation"] != old["generation"]
    assert new["notify"] is True
    assert new["status"] == "waiting"
    assert undo(owner_client, dismissed).status_code == 409
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_cancelled_import_ai_review_can_be_dismissed_and_explicitly_retried(
    owner_client,
    configured_ai,
):
    from housetory_api.services.enrichment import run_enhancement

    capture_id = create_capture(owner_client, "import")
    process_import_batch(capture_id)
    batch = owner_client.get(f"/api/v1/imports/{capture_id}").json()
    with SessionLocal() as db:
        old_job = dict(db.get(Job, uuid.UUID(batch["metadata"]["enhancement"]["job_id"])).payload)
    cancelled = owner_client.post(f"/api/v1/imports/{capture_id}/enhancement/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert capture(owner_client, capture_id)["retry"] == "enhancement"
    dismissed = dismiss(owner_client, "import", capture_id)
    retried = owner_client.post(f"/api/v1/imports/{capture_id}/enhancement/retry")
    assert retried.status_code == 200, retried.text
    new = capture(owner_client, capture_id)
    assert new["notify"] is True
    assert new["generation"] != dismissed["generation"]
    assert run_enhancement(old_job)["reason"] == "superseded"
    assert undo(owner_client, dismissed).status_code == 409
    assert owner_client.get("/api/v1/items").json()["items"] == []


def test_capture_dismissal_respects_household_scope_and_viewer_permissions(owner_client):
    from test_inventory_review import add_member

    capture_id = create_capture(owner_client, "import")
    generation = capture(owner_client, capture_id)["generation"]
    viewer = add_member(owner_client, role="viewer")
    denied = owner_client.post(
        f"/api/v1/inventory-review/captures/import/{capture_id}/dismiss",
        json={"generation": generation},
        headers=viewer,
    )
    assert denied.status_code == 403
    other = owner_client.post(
        "/api/v1/households",
        json={"name": "Other review scope", "property_name": "Other"},
    ).json()
    owner_client.post(f"/api/v1/households/{other['household']['id']}/select")
    denied = owner_client.post(
        f"/api/v1/inventory-review/captures/import/{capture_id}/dismiss",
        json={"generation": generation},
        headers={"X-Household-Id": other["household"]["id"]},
    )
    assert denied.status_code == 404


def test_manual_from_the_assistant_is_saved_without_a_pending_review(owner_client):
    response = owner_client.post(
        "/api/v1/documents",
        data={"document_type": "manual", "assistant_capture": "true"},
        files={"file": ("drill-manual.txt", b"Drill manual\nTorque settings", "text/plain")},
    )
    assert response.status_code == 201, response.text
    manual_id = response.json()["id"]
    invoice_id = create_capture(owner_client, "document")

    # The manual is kept and can be opened, but it is not a review to finish.
    assert capture(owner_client, manual_id) is None
    assert capture(owner_client, invoice_id) is not None
    assert owner_client.get(f"/api/v1/documents/{manual_id}/file").status_code == 200

    # Saying later that it is an invoice makes it a review like any other.
    changed = owner_client.patch(
        f"/api/v1/documents/{manual_id}", json={"document_type": "invoice"}
    )
    assert changed.status_code == 200, changed.text
    assert capture(owner_client, manual_id) is not None


def test_partly_applied_document_stays_pending_until_every_line_is_applied_or_skipped(
    owner_client,
):
    from housetory_api.services.ocr import ExtractedText

    text = (
        "CORNER HARDWARE\nDate: 02/14/2026\nInvoice: INV-9100\n"
        "Ladder 1 x 100.00 100.00\nPaint Roller 2 x 25.00 50.00\n"
        "Work Lamp 1 x 150.00 150.00\nTotal $300.00\n"
    )
    uploaded = owner_client.post(
        "/api/v1/documents",
        data={"document_type": "invoice", "assistant_capture": "true"},
        files={"file": ("invoice.txt", text.encode(), "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["id"]
    run_document_ocr(
        document_id,
        extractor=lambda *args: ExtractedText(text=text, source="text", confidence=100),
    )
    review_url = f"/api/v1/documents/{document_id}/extraction"
    extraction = owner_client.get(review_url).json()
    ladder, roller, lamp = [line for line in extraction["lines"] if line["kind"] == "product"]
    room = owner_client.post("/api/v1/rooms", json={"name": "Garage"}).json()

    def add(line, name):
        response = owner_client.post(
            f"{review_url}/apply",
            json={
                "request_id": str(uuid.uuid4()),
                "extraction_version": extraction["version"],
                "lines": [
                    {
                        "line_id": line["id"],
                        "action": "create",
                        "new_item": {"name": name, "quantity": 1, "room_id": room["id"]},
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text

    assert capture(owner_client, document_id) is not None

    # One of three lines is applied: the review is not finished.
    add(ladder, "Ladder")
    assert capture(owner_client, document_id) is not None

    # A kept correction is not a decision. With drafts on both other lines, they still
    # wait, the review is the same one, and a dismissal of it is not undone by a draft.
    before = capture(owner_client, document_id)
    for line in (roller, lamp):
        kept = owner_client.put(
            f"{review_url}/lines/{line['id']}/draft", json={"draft": {"quantity": "4"}}
        )
        assert kept.status_code == 200, kept.text
    assert capture(owner_client, document_id) == before
    dismissed = dismiss(owner_client, "document", document_id)
    kept = owner_client.put(
        f"{review_url}/lines/{lamp['id']}/draft", json={"draft": {"quantity": "5"}}
    )
    assert kept.status_code == 200, kept.text
    assert capture(owner_client, document_id) is None
    assert undo(owner_client, dismissed).status_code == 200

    # A skipped line no longer waits, but the third one still does. The unfinished
    # review can still be dismissed and brought back.
    assert owner_client.post(f"{review_url}/lines/{roller['id']}/skip").status_code == 200
    assert capture(owner_client, document_id) is not None
    dismissed = dismiss(owner_client, "document", document_id)
    assert capture(owner_client, document_id) is None
    assert undo(owner_client, dismissed).status_code == 200
    assert capture(owner_client, document_id) is not None

    # With the last waiting line applied, every line is applied or skipped: finished.
    add(lamp, "Work lamp")
    assert capture(owner_client, document_id) is None

    # Restoring the skipped line makes the review wait again, until that line is applied.
    assert owner_client.post(f"{review_url}/lines/{roller['id']}/restore").status_code == 200
    assert capture(owner_client, document_id) is not None
    add(roller, "Paint roller")
    assert capture(owner_client, document_id) is None
    assert capture(owner_client, document_id, dismissed=True) is None
    names = sorted(item["name"] for item in owner_client.get("/api/v1/items").json()["items"])
    assert names == ["Ladder", "Paint roller", "Work lamp"]
