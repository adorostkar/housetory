import pytest
from sqlalchemy import func, select

from housetory_api.db import SessionLocal
from housetory_api.models import Document, Job, Purchase
from housetory_api.services.document_ocr import run_document_ocr, run_job
from housetory_api.services.ocr import ExtractedText, OcrError, parse_receipt

RECEIPT_TEXT = """LA MARZOCCO BOUTIQUE
123 Main Street
Receipt No: INV-9001
Date: 02/14/2026
Espresso Machine 6250.00
Serial: LM-2026-0042
Subtotal 6250.00
TOTAL $6,250.00
Thank you
"""


def create_item(client, name="Espresso Machine"):
    response = client.post("/api/v1/items", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def upload_text_document(client, item_id, title="Receipt"):
    return client.post(
        "/api/v1/documents",
        files={"file": ("receipt.txt", b"receipt text", "text/plain")},
        data={"title": title, "document_type": "receipt", "item_ids": [item_id]},
    )


def test_receipt_parser_extracts_merchant_date_total_currency_invoice_and_serials():
    parsed = parse_receipt(RECEIPT_TEXT)
    assert parsed["merchant"] == "LA MARZOCCO BOUTIQUE"
    assert parsed["purchase_date"] == "2026-02-14"
    assert parsed["total_cents"] == 625000
    assert parsed["currency"] == "USD"
    assert parsed["invoice_number"] == "INV-9001"
    assert parsed["serial_numbers"] == ["LM-2026-0042"]
    assert "Espresso Machine" in parsed["product_names"]


def test_receipt_parser_handles_day_first_and_iso_dates():
    assert parse_receipt("Shop\nDate: 25/12/2025\nTOTAL 10.00").get("purchase_date") == "2025-12-25"
    assert parse_receipt("Shop\nDate: 2025-07-09\nTOTAL 10.00").get("purchase_date") == "2025-07-09"


def test_ocr_job_extracts_metadata_without_changing_inventory(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    assert document["ocr_status"] == "queued"

    result = run_document_ocr(
        document["id"],
        extractor=lambda path, content_type: ExtractedText(
            text=RECEIPT_TEXT, confidence=91, source="ocr"
        ),
    )
    assert result is not None
    assert result["characters"] == len(RECEIPT_TEXT)

    with SessionLocal() as db:
        stored = db.get(Document, document["id"])
        assert stored is not None
        assert stored.ocr_status == "succeeded"
        assert stored.ocr_confidence == 91
        assert stored.merchant == "LA MARZOCCO BOUTIQUE"
        assert stored.document_date.isoformat() == "2026-02-14"
        assert stored.extracted_metadata["invoice_number"] == "INV-9001"
        assert stored.extracted_metadata["total_cents"] == 625000
        assert stored.extracted_metadata["source"] == "ocr"
        assert stored.ocr_processed_at is not None
        assert db.scalar(select(func.count(Purchase.id))) == 0

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["purchase"] is None
    assert detail["serial_number"] is None


def test_ocr_review_confirmation_applies_purchase_and_item_updates(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    run_document_ocr(
        document["id"],
        extractor=lambda path, content_type: ExtractedText(
            text=RECEIPT_TEXT, confidence=91, source="ocr"
        ),
    )

    applied = owner_client.post(
        f"/api/v1/documents/{document['id']}/ocr/apply",
        json={
            "item_ids": [item["id"]],
            "create_purchase": True,
            "merchant": "La Marzocco Boutique",
            "purchase_date": "2026-02-14",
            "price_cents": 625000,
            "currency": "USD",
            "order_number": "INV-9001",
            "notes": "Confirmed from receipt",
            "document_date": "2026-02-14",
            "attach_as_receipt": True,
            "item_updates": [
                {
                    "item_id": item["id"],
                    "name": "Espresso Machine",
                    "serial_number": "LM-2026-0042",
                }
            ],
        },
    )
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert body["purchase_id"] is not None
    assert body["updated_item_ids"] == [item["id"]]
    assert body["document"]["merchant"] == "La Marzocco Boutique"
    assert body["document"]["extracted_metadata"]["applied_at"]
    assert body["document"]["extracted_metadata"]["applied_item_ids"] == [item["id"]]

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["serial_number"] == "LM-2026-0042"
    assert detail["purchase"]["merchant"] == "La Marzocco Boutique"
    assert detail["purchase"]["price_cents"] == 625000
    assert detail["purchase"]["receipt_document_id"] == document["id"]


def test_failed_ocr_is_recorded_and_can_be_retried(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()

    def broken_extractor(path, content_type):
        raise OcrError("Tesseract is unavailable")

    with pytest.raises(OcrError):
        run_document_ocr(document["id"], extractor=broken_extractor)

    stored = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert stored["ocr_status"] == "failed"
    assert "Tesseract is unavailable" in stored["ocr_error"]

    retry = owner_client.post(f"/api/v1/documents/{document['id']}/ocr")
    assert retry.status_code == 200, retry.text
    assert retry.json()["ocr_status"] == "queued"
    assert retry.json()["ocr_error"] is None

    with SessionLocal() as db:
        jobs = db.scalars(
            select(Job).where(
                Job.task == "documents.ocr",
                Job.payload["document_id"].astext == document["id"],
            )
        ).all()
        assert len(jobs) >= 2


@pytest.mark.parametrize("fails", [False, True])
def test_ocr_discards_both_success_and_failure_after_source_replacement(owner_client, fails):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()

    def replace_during_extraction(path, content_type):
        with SessionLocal() as db:
            current = db.get(Document, document["id"])
            current.source_generation += 1
            current.ocr_status = "queued"
            current.extracted_metadata = {"manual_note": "New content"}
            current.merchant = "Reviewed merchant"
            db.commit()
        if fails:
            raise OcrError("Old source unreadable")
        return ExtractedText(text=RECEIPT_TEXT, confidence=91, source="ocr")

    result = run_document_ocr(document["id"], extractor=replace_during_extraction)
    assert result["skipped"] is True
    assert result["reason"] == "stale_source"
    current = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert current["ocr_status"] == "queued"
    assert current["ocr_error"] is None
    assert current["merchant"] == "Reviewed merchant"
    assert current["extracted_metadata"] == {"manual_note": "New content"}


def test_legacy_and_generation_bound_ocr_jobs_skip_replaced_content(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    with SessionLocal() as db:
        jobs = db.scalars(select(Job).where(Job.task == "documents.ocr")).all()
        assert jobs[0].payload["source_generation"] == 1
        current = db.get(Document, document["id"])
        current.source_generation = 2
        db.commit()
    for payload in [
        {"document_id": document["id"]},
        {"document_id": document["id"], "source_generation": 1},
    ]:
        assert run_job(payload)["reason"] == "stale_source"
    current = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert current["ocr_status"] == "queued"


def test_ocr_refetches_concurrent_manual_metadata_before_publishing(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()

    def edit_during_extraction(path, content_type):
        response = owner_client.patch(
            f"/api/v1/documents/{document['id']}",
            json={"merchant": "Human reviewed", "document_date": "2025-01-02"},
        )
        assert response.status_code == 200
        with SessionLocal() as db:
            current = db.get(Document, document["id"])
            current.extracted_metadata = {"review_note": "Keep me"}
            db.commit()
        return ExtractedText(text=RECEIPT_TEXT, confidence=91, source="ocr")

    run_document_ocr(document["id"], extractor=edit_during_extraction)
    current = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert current["merchant"] == "Human reviewed"
    assert current["document_date"] == "2025-01-02"
    assert current["extracted_metadata"]["review_note"] == "Keep me"


def test_ocr_retry_rejects_an_active_job(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    response = owner_client.post(f"/api/v1/documents/{document['id']}/ocr")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ocr_in_progress"


def test_ocr_apply_requires_confirmed_item_for_purchase(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    response = owner_client.post(
        f"/api/v1/documents/{document['id']}/ocr/apply",
        json={"item_ids": [], "create_purchase": True},
    )
    assert response.status_code == 422


def test_document_ocr_publishes_local_results_without_calling_ai(
    owner_client,
    monkeypatch,
    configured_ai,
):
    from housetory_api.services import document_ocr

    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()

    def no_inference(*args, **kwargs):
        raise AssertionError("Local OCR must not call a model.")

    monkeypatch.setattr(document_ocr.ai, "complete_json", no_inference)
    run_document_ocr(
        document["id"],
        extractor=lambda path, content_type: ExtractedText(
            text=RECEIPT_TEXT, confidence=91, source="ocr"
        ),
    )
    with SessionLocal() as db:
        stored = db.get(Document, document["id"])
        assert stored is not None
        metadata = stored.extracted_metadata
        assert stored.ocr_status == "succeeded"
        assert metadata["processing_mode"] == "deterministic"
        assert metadata["ai_used"] is False
        assert metadata["enhancement"]["status"] == "queued"
        assert metadata["total_cents"] == 625000
        assert metadata["purchase_date"] == "2026-02-14"
        assert metadata["currency"] == "USD"
        assert metadata["serial_numbers"] == ["LM-2026-0042"]
        assert metadata["invoice_number"] == "INV-9001"


def test_empty_ocr_text_is_a_failed_read_not_a_silent_success(owner_client):
    item = create_item(owner_client)
    document = upload_text_document(owner_client, item["id"]).json()
    with pytest.raises(OcrError, match="No readable text"):
        run_document_ocr(
            document["id"],
            extractor=lambda path, content_type: ExtractedText(
                text="   ", confidence=0, source="ocr"
            ),
        )
    stored = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert stored["ocr_status"] == "failed"
    assert "No readable text" in stored["ocr_error"]
    assert stored["ocr_processed_at"] is not None


NORDIC_RECEIPT_TEXT = """Clas Ohlson
Solna Centrum
BUTIK KA. ANV. KVITTO DATUM
b 10-1-272 Strykbrada vikbar 249.00
b 44-5375 STRYKJARN BRAUN S 499 00
(Du sparar 300.00)
Antal artiklar: 2
MOMS BRUTTO MOMS NETTO
b 25.0% 748.00 149.60 598.40
Total 748.00 149.60 598.40
2026-11-10 11:41
KOP
SEK 748,00
"""


def test_nordic_receipt_uses_gross_total_and_real_lines():
    from types import SimpleNamespace

    from housetory_api.services.document_extraction import build_extraction

    document = SimpleNamespace(id="d", document_type="receipt", title="t", document_date=None)
    result = build_extraction(
        document,
        NORDIC_RECEIPT_TEXT,
        parse_receipt(NORDIC_RECEIPT_TEXT),
        source_artifact="x",
    )
    assert result["fields"]["total_cents"] == 74800
    assert result["fields"]["currency"] == "SEK"
    products = [line for line in result["lines"] if line["kind"] == "product"]
    assert [(line["description"], line["line_total_cents"]) for line in products] == [
        ("Strykbrada vikbar", 24900),
        ("STRYKJARN BRAUN S", 49900),
    ]
    assert not any("does not match" in warning for warning in result["warnings"])
