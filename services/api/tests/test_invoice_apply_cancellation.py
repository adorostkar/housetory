import copy
import uuid

from housetory_api.db import SessionLocal
from housetory_api.models import Document
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.enrichment import source_version


def test_cancelled_ai_refinement_cannot_apply_but_local_review_stays_available(
    owner_client, configured_ai
):
    room = owner_client.post("/api/v1/rooms", json={"name": "Synthetic workshop"})
    assert room.status_code == 201
    uploaded = owner_client.post(
        "/api/v1/documents",
        data={"document_type": "invoice"},
        files={
            "file": (
                "synthetic.txt",
                b"SYNTHETIC TOOLS\n2026-11-01\nDrill 1 x 25.00 25.00\nTotal USD 25.00",
                "text/plain",
            )
        },
    )
    assert uploaded.status_code == 201
    document_id = uuid.UUID(uploaded.json()["id"])
    run_document_ocr(document_id)
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        metadata = dict(document.extracted_metadata)
        base = metadata["extraction"]
        refined = copy.deepcopy(base)
        refined.update(
            version="cancelled-ai-version",
            base_version=base["version"],
            source_version=source_version(db, document),
        )
        metadata["extraction_refinements"] = {refined["version"]: refined}
        metadata["enhancement"] = {
            "status": "ready",
            "version": source_version(db, document),
            "proposal": {"version": refined["version"]},
        }
        document.extracted_metadata = metadata
        db.commit()
        line = next(line for line in base["lines"] if line["kind"] == "product")
        base_version = base["version"]
    cancelled = owner_client.post(f"/api/v1/documents/{document_id}/extraction/enhancement/cancel")
    assert cancelled.status_code == 200
    decision = {
        "line_id": line["id"],
        "action": "create",
        "new_item": {"name": "Reviewed drill", "quantity": 1, "room_id": room.json()["id"]},
    }
    rejected = owner_client.post(
        f"/api/v1/documents/{document_id}/extraction/apply",
        json={
            "request_id": str(uuid.uuid4()),
            "extraction_version": refined["version"],
            "lines": [decision],
        },
    )
    assert rejected.status_code == 409, rejected.text
    assert owner_client.get("/api/v1/items").json()["total"] == 0
    retry = owner_client.post(f"/api/v1/documents/{document_id}/extraction/enhancement/retry")
    assert retry.status_code == 200, retry.text
    assert retry.json()["enhancement"]["status"] == "queued"
    stale_after_retry = owner_client.post(
        f"/api/v1/documents/{document_id}/extraction/apply",
        json={
            "request_id": str(uuid.uuid4()),
            "extraction_version": refined["version"],
            "lines": [decision],
        },
    )
    assert stale_after_retry.status_code == 409, stale_after_retry.text
    assert stale_after_retry.json()["detail"]["code"] == "extraction_cancelled"
    assert owner_client.get("/api/v1/items").json()["total"] == 0
    manual = owner_client.post(
        f"/api/v1/documents/{document_id}/extraction/apply",
        json={
            "request_id": str(uuid.uuid4()),
            "extraction_version": base_version,
            "lines": [decision],
        },
    )
    assert manual.status_code == 200, manual.text
    assert owner_client.get("/api/v1/items").json()["total"] == 1


def test_credit_evidence_cannot_be_applied_as_an_ordinary_positive_purchase(owner_client):
    room = owner_client.post("/api/v1/rooms", json={"name": "Synthetic workshop"})
    assert room.status_code == 201
    uploaded = owner_client.post(
        "/api/v1/documents",
        data={"document_type": "invoice"},
        files={
            "file": (
                "synthetic-credit.txt",
                b"SYNTHETIC TOOLS\nCREDIT NOTE\n2026-11-01\nDrill 1 x -25.00 -25.00\n"
                b"Total USD -25.00",
                "text/plain",
            )
        },
    )
    assert uploaded.status_code == 201
    document_id = uuid.UUID(uploaded.json()["id"])
    run_document_ocr(document_id)
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        extraction = document.extracted_metadata["extraction"]
        line = next(line for line in extraction["lines"] if line["kind"] == "product")
        assert line["line_total_cents"] == -2500
    response = owner_client.post(
        f"/api/v1/documents/{document_id}/extraction/apply",
        json={
            "request_id": str(uuid.uuid4()),
            "extraction_version": extraction["version"],
            "purchase_action": "create",
            "purchase": {"price_cents": 2500, "currency": "USD"},
            "lines": [
                {
                    "line_id": line["id"],
                    "action": "create",
                    "new_item": {
                        "name": "Refunded drill",
                        "quantity": 1,
                        "room_id": room.json()["id"],
                    },
                }
            ],
        },
    )
    assert response.status_code == 422, response.text
    assert owner_client.get("/api/v1/items").json()["total"] == 0
