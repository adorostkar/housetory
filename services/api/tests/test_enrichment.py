import threading
import time
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
from tests.test_document_extraction import (
    _add_member,
    _headers,
    _refinement_payload,
    ocr_document,
    upload_document,
)
from tests.test_hierarchy_imports import process, upload_markdown
from tests.test_imports import process_import, upload_text_import


def job_payload(detail):
    with SessionLocal() as db:
        job = db.get(Job, detail["enhancement"]["job_id"])
        expected_queue = "ai-documents" if job.payload.get("kind") == "document" else "ai"
        assert job.queue == expected_queue
        return job.payload


@pytest.mark.parametrize("outcome", ["ready", "cancel", "stale", "correlation"])
def test_review_matching_is_queued_guarded_and_publishes_full_proposal(
    owner_client, configured_ai, monkeypatch, outcome
):
    document = upload_document(owner_client, "Hardware\nDrill 1 x 10.00 10.00\nTotal $10.00")
    ocr_document(
        owner_client, document["id"], "Hardware\nDrill 1 x 10.00 10.00\nTotal $10.00"
    ).json()
    assert (
        owner_client.post(f"/api/v1/documents/{document['id']}/processing/cancel").status_code
        == 200
    )
    for name in ("Drill", "Drill"):
        assert owner_client.post("/api/v1/items", json={"name": name}).status_code == 201
    base = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    match = next(match for match in base["matches"] if len(match["candidates"]) >= 2)
    reversed_ids = [candidate["id"] for candidate in reversed(match["candidates"])]
    calls = []

    def rank(*args, **kwargs):
        calls.append(True)
        if outcome == "cancel":
            response = owner_client.post(f"/api/v1/documents/{document['id']}/processing/cancel")
            assert response.status_code == 200
        elif outcome == "stale":
            with SessionLocal() as db:
                stored = db.get(Document, document["id"])
                stored.source_generation += 1
                db.commit()
        elif outcome == "correlation":
            with SessionLocal() as db:
                stored = db.get(Document, document["id"])
                metadata = dict(stored.extracted_metadata)
                metadata["processing"] = {
                    **metadata["processing"],
                    "correlation_id": uuid.uuid4().hex,
                    "stage": "waiting",
                }
                stored.extracted_metadata = metadata
                db.commit()
        return {"matches": [{"line_id": match["line_id"], "candidate_ids": reversed_ids}]}

    monkeypatch.setattr(ai, "complete_json", rank)
    url = f"/api/v1/documents/{document['id']}/processing/retry"
    queued = owner_client.post(url, json={"operation": "matches"})
    assert queued.status_code == 200, queued.text
    assert queued.json()["stage"] == "interpreting"
    assert calls == []
    duplicate = owner_client.post(url, json={"operation": "matches"})
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["correlation_id"] == queued.json()["correlation_id"]
    with SessionLocal() as db:
        jobs = db.scalars(
            select(Job).where(
                Job.queue == "ai-documents",
                Job.payload["correlation_id"].astext == queued.json()["correlation_id"],
            )
        ).all()
        assert len(jobs) == 1
        assert jobs[0].payload["operation"] == "matches"
        assert jobs[0].payload["actor_user_id"]
        payload = jobs[0].payload
    result = run_enhancement(payload)
    after = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    assert len(calls) == 1
    if outcome == "ready":
        assert result["status"] == "ready"
        proposal = after["suggested_refinement"]
        assert proposal["fields"] == base["fields"]
        assert proposal["lines"] == base["lines"]
        ranked = next(
            entry for entry in proposal["matches"] if entry["line_id"] == match["line_id"]
        )
        assert [candidate["id"] for candidate in ranked["candidates"]] == reversed_ids
    else:
        assert result["status"] == "skipped"
        assert after["suggested_refinement"] is None
        processing = owner_client.get(f"/api/v1/documents/{document['id']}/processing").json()
        assert (
            processing["stage"]
            == {
                "cancel": "cancelled",
                "stale": "needs_attention",
                "correlation": "waiting",
            }[outcome]
        )
        if outcome == "stale":
            assert processing["reason"] == "source_changed"


def test_ai_validation_timing_measures_validation_not_provider(
    owner_client, configured_ai, monkeypatch
):
    from housetory_api.services import document_refinement

    document = upload_document(owner_client)
    review = ocr_document(owner_client, document["id"]).json()
    original = document_refinement._validate_lines

    def slow_validation(*args, **kwargs):
        time.sleep(0.03)
        return original(*args, **kwargs)

    monkeypatch.setattr(document_refinement, "_validate_lines", slow_validation)
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: _refinement_payload())
    assert run_enhancement(job_payload(review))["status"] == "ready"
    timings = owner_client.get(f"/api/v1/documents/{document['id']}/processing").json()["timings"]
    assert timings["provider_ms"] is None
    assert timings["validation_ms"] >= 25


def test_explicit_interpret_is_bounded_deduplicated_and_never_runs_in_request(
    owner_client, configured_ai, monkeypatch
):
    document = upload_document(owner_client)
    ocr_document(owner_client, document["id"])
    assert (
        owner_client.post(f"/api/v1/documents/{document['id']}/processing/cancel").status_code
        == 200
    )
    calls = []

    def complete(*args, **kwargs):
        calls.append(True)
        return _refinement_payload()

    monkeypatch.setattr(ai, "complete_json", complete)
    url = f"/api/v1/documents/{document['id']}/processing/retry"
    first = owner_client.post(url, json={"operation": "interpret"})
    assert first.status_code == 200, first.text
    assert first.json()["stage"] == "interpreting"
    assert calls == []
    same = owner_client.post(url, json={"operation": "interpret"})
    assert same.json()["correlation_id"] == first.json()["correlation_id"]
    assert owner_client.post(url, json={"operation": "matches"}).status_code == 409
    assert owner_client.post(url).status_code == 409
    new_review = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    payload = job_payload(new_review)
    assert payload["operation"] == "interpret"
    assert run_enhancement(payload)["status"] == "ready"
    assert len(calls) == 1
    assert owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()[
        "suggested_refinement"
    ]


@pytest.mark.parametrize("operation", ["interpret", "matches"])
def test_explicit_review_ai_does_not_dispatch_when_disabled(owner_client, monkeypatch, operation):
    document = upload_document(owner_client)
    ocr_document(owner_client, document["id"])
    monkeypatch.setattr(ai, "complete_json", lambda *args, **kwargs: pytest.fail("AI disabled"))
    response = owner_client.post(
        f"/api/v1/documents/{document['id']}/processing/retry", json={"operation": operation}
    )
    assert response.status_code == 409
    with SessionLocal() as db:
        assert not db.scalars(
            select(Job).where(
                Job.queue == "ai-documents", Job.payload["source_id"].astext == document["id"]
            )
        ).all()


def test_bounded_openai_json_mode_does_not_retry_after_http_400(configured_ai, monkeypatch):
    config = replace(configured_ai, provider="openai", base_url="https://example.invalid")
    calls = []

    def request(*args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            raise ai.AiUnavailable("Inference provider returned HTTP 400.")
        return {"choices": [{"message": {"content": "{}"}}]}

    monkeypatch.setattr(ai, "_request_json", request)
    with ai.bounded_request_deadline(10), pytest.raises(ai.AiUnavailable):
        ai._openai_chat(config, "system", "user", json_mode=True, image_path=None, image_mime=None)
    assert len(calls) == 1
    calls.clear()
    assert (
        ai._openai_chat(config, "system", "user", json_mode=True, image_path=None, image_mime=None)
        == "{}"
    )
    assert len(calls) == 2


def test_queued_ranking_reports_rate_limit_without_retry(owner_client, configured_ai, monkeypatch):
    document = upload_document(owner_client)
    ocr_document(owner_client, document["id"])
    assert (
        owner_client.post(f"/api/v1/documents/{document['id']}/processing/cancel").status_code
        == 200
    )
    calls = []

    def rate_limited(*args, **kwargs):
        calls.append(True)
        raise ai.AiUnavailable("synthetic rate limit", code="rate_limited")

    monkeypatch.setattr(ai, "_ollama_chat", rate_limited)
    response = owner_client.post(
        f"/api/v1/documents/{document['id']}/processing/retry", json={"operation": "matches"}
    )
    assert response.status_code == 200
    review = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    result = run_enhancement(job_payload(review))
    assert result == {"status": "failed", "reason": "rate_limited"}
    assert len(calls) == 1
    status = owner_client.get(f"/api/v1/documents/{document['id']}/processing").json()
    assert status["stage"] == "needs_attention"
    assert status["reason"] == "rate_limited"
    assert status["can_retry"] is True
    assert status["timings"]["validation_ms"] is None


def test_queued_ranking_cancel_prevents_dispatch_and_viewer_cannot_enqueue(
    owner_client, anon_client, configured_ai, monkeypatch
):
    document = upload_document(owner_client)
    ocr_document(owner_client, document["id"])
    url = f"/api/v1/documents/{document['id']}/processing"
    assert owner_client.post(f"{url}/cancel").status_code == 200
    token, _ = _add_member(owner_client, email="ranking-viewer@example.com", role="viewer")
    assert anon_client.get(url, headers=_headers(token)).status_code == 200
    assert (
        anon_client.post(
            f"{url}/retry", headers=_headers(token), json={"operation": "matches"}
        ).status_code
        == 403
    )
    queued = owner_client.post(f"{url}/retry", json={"operation": "matches"})
    assert queued.status_code == 200
    review = owner_client.get(f"/api/v1/documents/{document['id']}/extraction").json()
    payload = job_payload(review)
    assert owner_client.post(f"{url}/cancel").status_code == 200
    monkeypatch.setattr(ai, "complete_json", lambda *args, **kwargs: pytest.fail("cancelled"))
    assert run_enhancement(payload) == {"status": "skipped", "reason": "superseded"}
    with SessionLocal() as db:
        assert db.get(Job, payload["job_id"]).status == "cancelled"


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
