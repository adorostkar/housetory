import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from sqlalchemy import select

from housetory_api.api.errors import ApiError
from housetory_api.db import SessionLocal
from housetory_api.jobs import claim_job, enqueue, mark_succeeded
from housetory_api.models import Document, ImportEntry, Job
from housetory_api.schemas.extraction import ExtractionApplyRequest
from housetory_api.services import ai
from housetory_api.services.document_extraction_apply import apply_extraction
from housetory_api.services.enrichment import run_enhancement
from tests.test_document_extraction import _refinement_payload, ocr_document, upload_document
from tests.test_hierarchy_imports import process, upload_markdown
from tests.test_imports import process_import, upload_text_import


def job_payload(detail):
    with SessionLocal() as db:
        job = db.get(Job, detail["enhancement"]["job_id"])
        assert job.queue == "ai"
        return job.payload


def test_stalled_ai_does_not_block_local_review_apply_or_queue(
    owner_client,
    configured_ai,
    monkeypatch,
):
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    payload = job_payload(detail)
    started, release = threading.Event(), threading.Event()

    def stall(*args, **kwargs):
        started.set()
        assert release.wait(10)
        return {"refinements": [], "items": [], "warnings": []}

    monkeypatch.setattr(ai, "complete_json", stall)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_enhancement, payload)
        try:
            assert started.wait(5)
            current = owner_client.get(f"/api/v1/imports/{detail['id']}").json()
            assert current["status"] == "review"
            assert current["enhancement"]["status"] == "running"
            assert current["entries"] == detail["entries"]
            with SessionLocal() as db:
                local = enqueue(db, "maintenance.ping", priority=100)
                claimed = claim_job(db, worker_id="local-worker", queue="default")
                assert claimed.id == local.id
                mark_succeeded(db, local.id, result={"pong": True})
            applied = owner_client.post(
                f"/api/v1/imports/{detail['id']}/apply",
                json={"entries": [{"id": detail["entries"][0]["id"], "action": "import"}]},
            )
            assert applied.status_code == 200, applied.text
        finally:
            release.set()
        assert future.result(timeout=5) == {"status": "skipped", "reason": "source_changed"}
    assert owner_client.get("/api/v1/items").json()["total"] == 1
    assert run_enhancement(payload)["status"] == "skipped"


@pytest.mark.parametrize("change", ["edit", "cancel", "delete", "configuration", "consent"])
def test_late_import_suggestions_never_overwrite_changed_source_or_permissions(
    owner_client,
    configured_ai,
    monkeypatch,
    change,
):
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    payload = job_payload(detail)
    entry_id = detail["entries"][0]["id"]

    def complete(*args, **kwargs):
        if change == "edit":
            with SessionLocal() as db:
                entry = db.get(ImportEntry, entry_id)
                entry.proposed = {**entry.proposed, "name": "Manual name"}
                db.commit()
        elif change == "cancel":
            response = owner_client.post(f"/api/v1/imports/{detail['id']}/enhancement/cancel")
            assert response.status_code == 200, response.text
        elif change == "delete":
            assert owner_client.delete(f"/api/v1/imports/{detail['id']}").status_code == 204
        else:
            changed = replace(
                configured_ai,
                model="another-model" if change == "configuration" else configured_ai.model,
                mode="cloud" if change == "consent" else configured_ai.mode,
                cloud_consent=False,
            )
            monkeypatch.setattr(ai, "config_for", lambda *a, **k: changed)
        return {"refinements": [{"key": entry_id, "brand": "Canon"}], "items": []}

    monkeypatch.setattr(ai, "complete_json", complete)
    assert run_enhancement(payload)["status"] == "skipped"
    assert owner_client.get("/api/v1/items").json()["total"] == 0
    if change != "delete":
        after = owner_client.get(f"/api/v1/imports/{detail['id']}").json()
        assert after["entries"][0]["proposed"]["brand"] is None
        if change == "edit":
            assert after["entries"][0]["proposed"]["name"] == "Manual name"


def test_changed_configuration_skips_queued_job_without_sending_content(
    owner_client,
    configured_ai,
    monkeypatch,
):
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    monkeypatch.setattr(ai, "config_for", lambda *a, **k: replace(configured_ai, model="new"))
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: pytest.fail("No inference allowed"))
    assert run_enhancement(job_payload(detail)) == {
        "status": "skipped",
        "reason": "configuration_changed",
    }


def test_changed_consent_stops_remaining_import_chunks(owner_client, configured_ai, monkeypatch):
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    payload = job_payload(detail)
    payload["inputs"]["documents"] *= 2
    calls = []

    def complete(*args, **kwargs):
        calls.append(1)
        monkeypatch.setattr(
            ai,
            "config_for",
            lambda *a, **k: replace(configured_ai, mode="cloud", cloud_consent=False),
        )
        return {"refinements": [], "items": []}

    monkeypatch.setattr(ai, "complete_json", complete)
    assert run_enhancement(payload)["status"] == "skipped"
    assert calls == [1]


def test_ai_only_retry_reuses_private_snapshot_without_parsing_or_duplicating(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import import_pipeline

    monkeypatch.setattr(
        ai,
        "config_for",
        lambda *a, **k: replace(configured_ai, configured=False, enabled=False),
    )
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    assert detail["enhancement"]["status"] == "off"
    assert "_enhancement_snapshot" not in detail["metadata"]
    monkeypatch.setattr(ai, "config_for", lambda *a, **k: configured_ai)
    monkeypatch.setattr(
        import_pipeline,
        "read_source_bundle",
        lambda *a, **k: pytest.fail("Must not parse again"),
    )
    entry_id = detail["entries"][0]["id"]
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "refinements": [{"key": entry_id, "brand": "Canon"}],
            "items": [],
        },
    )
    retry = owner_client.post(f"/api/v1/imports/{detail['id']}/enhancement/retry")
    assert retry.status_code == 200, retry.text
    assert (
        owner_client.post(
            f"/api/v1/imports/{detail['id']}/enhancement/retry",
        ).status_code
        == 409
    )
    assert run_enhancement(job_payload(retry.json()))["status"] == "ready"
    before_accept = owner_client.get(f"/api/v1/imports/{detail['id']}").json()
    assert before_accept["entries"] == detail["entries"]
    accepted = owner_client.post(f"/api/v1/imports/{detail['id']}/enhancement/accept")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["entries"][0]["id"] == entry_id
    assert accepted.json()["entries"][0]["proposed"]["brand"] == "Canon"
    assert (
        owner_client.post(
            f"/api/v1/imports/{detail['id']}/enhancement/accept",
        ).status_code
        == 409
    )
    assert owner_client.get("/api/v1/items").json()["total"] == 0


def test_failed_worker_is_retryable_and_source_is_still_usable(owner_client, configured_ai):
    detail = process_import(
        owner_client,
        upload_text_import(owner_client, "Camera in the attic.")["id"],
    )
    with SessionLocal() as db:
        job = db.get(Job, detail["enhancement"]["job_id"])
        job.status = "failed"
        db.commit()
    current = owner_client.get(f"/api/v1/imports/{detail['id']}").json()
    assert current["status"] == "review"
    assert current["enhancement"]["reason"] == "worker_interrupted"
    assert (
        owner_client.post(
            f"/api/v1/imports/{detail['id']}/enhancement/retry",
        ).status_code
        == 200
    )


def test_hierarchy_enrichment_preserves_entry_and_parent_identities(
    owner_client,
    configured_ai,
    monkeypatch,
):
    detail = process(owner_client, upload_markdown(owner_client)["id"])
    payload = job_payload(detail)
    hierarchy = payload["inputs"]["hierarchy"]
    node = hierarchy["nodes"][0]
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "nodes": [
                {
                    "key": node["key"],
                    "name": node["name"].upper(),
                    "entity_type": node["entity_type"],
                    "container_type": node["container_type"],
                    "legacy_identifier": node["legacy_identifier"],
                }
            ],
            "items": [
                {
                    "key": item["key"],
                    "name": item["draft"]["name"],
                    "quantity": item["draft"]["quantity"],
                }
                for item in hierarchy["items"]
            ],
        },
    )
    assert run_enhancement(payload)["status"] == "ready"
    accepted = owner_client.post(f"/api/v1/imports/{detail['id']}/enhancement/accept")
    assert accepted.status_code == 200, accepted.text
    assert [(entry["id"], entry["parent_entry_id"]) for entry in accepted.json()["entries"]] == [
        (entry["id"], entry["parent_entry_id"]) for entry in detail["entries"]
    ]
    assert accepted.json()["total_entries"] == len(detail["entries"])


@pytest.mark.parametrize("change", ["merchant", "generation"])
def test_document_proposal_is_separate_and_publication_holds_no_inference_lock(
    owner_client,
    configured_ai,
    monkeypatch,
    change,
):
    document = upload_document(owner_client)
    review = ocr_document(owner_client, document["id"]).json()
    payload = job_payload(review)

    def complete(*args, **kwargs):
        with SessionLocal() as db:
            stored = db.scalar(
                select(Document)
                .where(
                    Document.id == document["id"],
                )
                .with_for_update(nowait=True)
            )
            if change == "merchant":
                stored.merchant = "Manual merchant"
            else:
                stored.source_generation += 1
            db.commit()
        return _refinement_payload()

    monkeypatch.setattr(ai, "complete_json", complete)
    assert run_enhancement(payload)["status"] == "skipped"
    after = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert after["version"] == review["version"]
    assert after["suggested_refinement"] is None
    if change == "merchant":
        assert owner_client.get(f"/api/v1/documents/{document['id']}").json()["merchant"] == (
            "Manual merchant"
        )


def test_document_ready_proposal_does_not_promote_ai_metadata(
    owner_client,
    configured_ai,
    monkeypatch,
):
    document = upload_document(owner_client)
    review = ocr_document(owner_client, document["id"]).json()
    before = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: _refinement_payload())
    assert run_enhancement(job_payload(review))["status"] == "ready"
    after = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert after["merchant"] == before["merchant"]
    assert after["document_date"] == before["document_date"]
    ready = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert ready["version"] == review["version"]
    assert ready["suggested_refinement"]["fields"]["merchant"] == "Corner Hardware"
    assert owner_client.get("/api/v1/items").json()["total"] == 0

    with SessionLocal() as stale_db:
        cached_document = stale_db.get(Document, document["id"])
        with SessionLocal() as db:
            stored = db.get(Document, document["id"])
            stored.merchant = "New manual merchant"
            db.commit()
        with pytest.raises(ApiError) as error:
            apply_extraction(
                stale_db,
                cached_document.household_id,
                cached_document,
                ExtractionApplyRequest(
                    request_id=uuid.uuid4(),
                    extraction_version=ready["suggested_refinement"]["version"],
                    purchase_action="none",
                    lines=[],
                ),
                actor_user_id=None,
                actor_name=None,
            )
        assert error.value.code == "extraction_stale"
    stale = owner_client.post(
        f"/api/v1/documents/{document['id']}/extraction/apply",
        json={
            "request_id": str(uuid.uuid4()),
            "extraction_version": ready["suggested_refinement"]["version"],
            "purchase_action": "none",
            "lines": [],
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "extraction_stale"


@pytest.mark.parametrize("automatic", [False, True])
def test_identical_document_refinement_completes_without_outstanding_suggestions(
    owner_client,
    configured_ai,
    monkeypatch,
    automatic,
):
    document = upload_document(owner_client, "Hardware\nDrill 1 x 10.00 10.00\nTotal $10.00")
    review = ocr_document(
        owner_client,
        document["id"],
        "Hardware\nDrill 1 x 10.00 10.00\nTotal $10.00",
    ).json()
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "fields": {},
            "lines": [
                {
                    "description": line["description"],
                    "kind": line["kind"],
                    "quantity": line["quantity"],
                    "unit_price_cents": line["unit_price_cents"],
                    "line_total_cents": line["line_total_cents"],
                    "evidence": line["evidence"]["text"],
                    "uncertainty": ["Different provenance, not a new decision."],
                }
                for line in review["lines"]
            ],
            "warnings": ["Review completed."],
        },
    )
    if automatic:
        assert run_enhancement(job_payload(review)) == {
            "status": "skipped",
            "reason": "no_changes",
        }
    else:
        result = owner_client.post(f"/api/v1/documents/{document['id']}/extraction/refine")
        assert result.status_code == 200, result.text
        assert result.json()["ai_used"] is False
        assert result.json()["version"] == review["version"]
    after = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert after["enhancement"]["reason"] == "no_changes"
    assert after["suggested_refinement"] is None
    assert after["fields"] == review["fields"]
    assert after["lines"] == review["lines"]


@pytest.mark.parametrize("change", [None, "amount", "quantity", "metadata", "match", "strength"])
def test_persisted_document_suggestions_ignore_generated_identity_but_keep_real_changes(
    owner_client,
    configured_ai,
    change,
):
    document = upload_document(owner_client)
    review = ocr_document(owner_client, document["id"]).json()
    created = owner_client.post("/api/v1/items", json={"name": review["lines"][0]["description"]})
    assert created.status_code == 201, created.text
    review = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    proposal = {
        **review,
        "base_version": review["version"],
        "version": "generated-ai-version",
        "ai_used": True,
        "warnings": ["Different AI provenance."],
        "fields": {**review["fields"], "field_sources": {}, "uncertain_fields": []},
        "lines": [
            {
                **line,
                "id": f"generated-{index}",
                "line_number": index + 10,
                "evidence": {"text": "Other source formatting"},
                "warnings": [],
            }
            for index, line in enumerate(review["lines"])
        ],
        "matches": [
            {**match, "line_id": f"generated-{index}"}
            for index, match in enumerate(review["matches"])
        ],
    }
    if change == "amount":
        proposal["lines"][0]["line_total_cents"] += 1
    elif change == "quantity":
        proposal["lines"][0]["quantity"] = 3
    elif change == "metadata":
        proposal["fields"]["order_number"] = "INV-CHANGED"
    elif change == "match":
        proposal["matches"][0]["candidates"][0]["id"] = str(uuid.uuid4())
    elif change == "strength":
        proposal["matches"][0]["candidates"][0]["match_quality"] = "possible"
    with SessionLocal() as db:
        stored = db.get(Document, document["id"])
        stored.extracted_metadata = {
            **stored.extracted_metadata,
            "enhancement": {
                **stored.extracted_metadata["enhancement"],
                "status": "ready",
                "ai_attempted": True,
                "ai_succeeded": True,
                "proposal": proposal,
            },
        }
        db.commit()
    after = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert after["enhancement"]["status"] == ("ready" if change else "skipped")
    assert bool(after["suggested_refinement"]) is bool(change)
    if change is None:
        assert after["enhancement"]["reason"] == "no_changes"


@pytest.mark.parametrize("automatic", [False, True])
def test_cancelled_document_refinement_cannot_publish_late_suggestions(
    owner_client,
    configured_ai,
    monkeypatch,
    automatic,
):
    document = upload_document(owner_client)
    review = ocr_document(owner_client, document["id"]).json()

    def complete(*args, **kwargs):
        response = owner_client.post(
            f"/api/v1/documents/{document['id']}/extraction/enhancement/cancel",
        )
        assert response.status_code == 200, response.text
        return _refinement_payload()

    monkeypatch.setattr(ai, "complete_json", complete)
    if automatic:
        assert run_enhancement(job_payload(review)) == {
            "status": "skipped",
            "reason": "superseded",
        }
    else:
        result = owner_client.post(f"/api/v1/documents/{document['id']}/extraction/refine")
        assert result.status_code == 409, result.text
        assert result.json()["detail"]["code"] == "refinement_stale"
    after = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert after["enhancement"]["reason"] == "cancelled"
    assert after["suggested_refinement"] is None
    assert after["fields"] == review["fields"]
