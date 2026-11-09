import io
import uuid
from datetime import date

from pypdf import PdfReader

from housetory_api.db import SessionLocal
from housetory_api.domain import JobStatus
from housetory_api.models import Item, Job
from housetory_api.services import insurance
from tests.test_item_valuation import (
    ai_estimate_payload,
    create_item,
    create_room,
    install_ai,
    provider_payload,
)


def test_insurance_scope_ai_review_and_immutable_pdf_csv(owner_client, monkeypatch):
    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    room = create_room(owner_client, "Insurance room")
    camera = create_item(
        owner_client,
        "Insurance camera",
        description="Mirrorless camera with battery and charger",
        brand="Fujifilm",
        model="X-T4",
        serial_number="INSURANCE-SN",
        quantity=2,
        room_id=room["id"],
    )
    vague = create_item(owner_client, "Mug", room_id=room["id"])
    install_ai(
        monkeypatch,
        payload=ai_estimate_payload(
            currency="EUR", suggested_cents=4500, low_cents=3500, high_cents=5500
        ),
    )

    preview = owner_client.post(
        "/api/v1/insurance-valuations/scope-preview",
        json={"scope": {"include_home": True}, "include_archived": False},
    )
    assert preview.status_code == 200, preview.text
    rows = preview.json()["items"]
    assert len(rows) == 2
    camera_row = next(row for row in rows if row["item_id"] == camera["id"])
    assert camera_row["ai_eligible"] is True
    assert next(row for row in rows if row["item_id"] == vague["id"])["ai_eligible"] is False

    request_id = str(uuid.uuid4())
    created = owner_client.post(
        "/api/v1/insurance-valuations/batches",
        json={
            "item_ids": [camera["id"]],
            "currency": "EUR",
            "include_web": False,
            "request_id": request_id,
        },
    )
    assert created.status_code == 202, created.text
    with SessionLocal() as db:
        jobs = list(db.query(Job).filter(Job.task == insurance.ESTIMATE_TASK).all())
        assert len(jobs) == 1
        result = insurance.process_estimate(jobs[0].payload)
        jobs[0].result = result
        jobs[0].status = JobStatus.SUCCEEDED.value
        db.commit()
        estimate_id = result["estimate"]["estimate_id"]

    batch = owner_client.get(f"/api/v1/insurance-valuations/batches/{request_id}")
    assert batch.status_code == 200, batch.text
    assert batch.json()["status"] == "completed"
    assert batch.json()["estimated"] == 1
    estimate = batch.json()["items"][0]["estimate"]
    assert estimate["purpose"] == "replacement"
    assert estimate["suggested_cents"] == 4500

    list_request = str(uuid.uuid4())
    created_list = owner_client.post(
        "/api/v1/insurance-lists",
        json={
            "item_ids": [camera["id"], vague["id"]],
            "currency": "EUR",
            "reviewed_on": str(date(2026, 11, 9)),
            "values": [
                {
                    "item_id": camera["id"],
                    "estimate_id": estimate_id,
                    "expected_fingerprint": camera_row["valuation_fingerprint"],
                    "amount_cents": 5000,
                }
            ],
            "request_id": list_request,
        },
    )
    assert created_list.status_code == 202, created_list.text
    job_id = created_list.json()["id"]
    with SessionLocal() as db:
        job = db.get(Job, uuid.UUID(job_id))
        job.result = insurance.process_list(job.payload)
        job.status = JobStatus.SUCCEEDED.value
        db.commit()

        stored = db.get(Item, uuid.UUID(camera["id"]))
        assert stored.current_value_cents is None
        stored.name = "Changed after insurance export"
        db.commit()

    pdf = owner_client.get(f"/api/v1/insurance-lists/{job_id}/pdf")
    assert pdf.status_code == 200, pdf.text
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Insurance replacement list" in text
    assert "Insurance camera" in text
    assert "50.00" in text
    assert "Changed after insurance export" not in text
    assert "not written back to item records" in text

    csv_file = owner_client.get(f"/api/v1/insurance-lists/{job_id}/csv")
    assert csv_file.status_code == 200
    csv_text = csv_file.content.decode("utf-8-sig")
    assert "replacement_value_total_cents" in csv_text
    assert "10000" in csv_text  # 50 EUR × two owned units
    assert "INSURANCE-SN" in csv_text

    stale = insurance._replacement_snapshot
    try:
        with SessionLocal() as db:
            job = db.get(Job, uuid.UUID(job_id))
            stale(db, {**job.payload, "item_ids": [camera["id"]]})
    except Exception as exc:
        assert getattr(exc, "code", None) in {"insurance_value_stale", "insurance_estimate_expired"}
    else:
        raise AssertionError("Changed item and old fingerprint must not create a new list")


def test_insurance_output_escapes_markup_and_spreadsheet_formulas():
    snapshot = {
        "currency": "EUR",
        "reviewed_on": "2026-11-09",
        "generated_at": "2026-11-09T12:00:00+00:00",
        "items": [
            {
                "name": "=SUM(1,2) <b>Unsafe</b>",
                "brand": "A&B",
                "model": None,
                "serial_number": None,
                "quantity": 1,
                "condition": "good",
                "amount_cents": 100,
                "total_cents": 100,
                "estimate": None,
            }
        ],
    }
    csv_text = insurance._csv(snapshot).decode("utf-8-sig")
    assert "'=SUM(1,2) <b>Unsafe</b>" in csv_text
    pdf_text = "\n".join(
        page.extract_text() or ""
        for page in PdfReader(io.BytesIO(insurance._pdf(snapshot))).pages
    )
    assert "A&B" in pdf_text
    assert "Unsafe" in pdf_text
