import io
import uuid
from datetime import UTC, datetime

import pytest
from pypdf import PdfWriter
from sqlalchemy import func, select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    Document,
    Household,
    HouseholdMember,
    ManualSearchCandidate,
    User,
)
from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai as ai_service
from housetory_api.services import manual_web
from housetory_api.services.auth import create_session
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.ocr import ExtractedText, OcrPage


def create_item(client, name="Cordless drill", **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def manual_pdf_bytes():
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(output)
    return output.getvalue()


def upload_manual(client, *, item_ids=None, title="Tool manual", data=None):
    payload = {
        "title": title,
        "document_type": "manual",
        **(data or {}),
    }
    if item_ids is not None:
        payload["item_ids"] = item_ids
    return client.post(
        "/api/v1/documents",
        files={"file": ("tool-manual.pdf", manual_pdf_bytes(), "application/pdf")},
        data=payload,
    )


def populate_manual(document_id, text, *, pages=None, status="succeeded"):
    with SessionLocal() as db:
        document = db.get(Document, uuid.UUID(document_id))
        assert document is not None
        document.extracted_text = text
        metadata = dict(document.extracted_metadata or {})
        if pages is not None:
            metadata["ocr_pages"] = pages
        document.extracted_metadata = metadata
        document.ocr_status = status
        document.ocr_processed_at = datetime.now(UTC)
        db.commit()


def confirmed_profile(client, item_id, **overrides):
    payload = {
        "manufacturer": "Makita",
        "model_identifier": "DCD791",
        "variant": None,
        "confirmed": True,
        **overrides,
    }
    return client.put(f"/api/v1/items/{item_id}/manual-profile", json=payload)


def fake_ai_status(*, configured=False, consent=False):
    return AiStatus(
        provider="ollama" if configured else "none",
        mode="private" if configured else "disabled",
        task="assistant",
        model="test-model" if configured else None,
        configured=configured,
        available=configured,
        cloud_consent=consent,
        privacy_note="Synthetic test status.",
    )


def viewer_headers(owner_client, email="viewer@example.com"):
    household_id = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    with SessionLocal() as db:
        user = User(name="Read Only", email=email, password_hash="not-used")
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household_id, user_id=user.id, role="viewer"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="manual-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def configure_search(monkeypatch):
    monkeypatch.setattr(
        manual_web, "search_configuration", lambda: (True, "Test manual search", None)
    )


def disable_search(monkeypatch):
    monkeypatch.setattr(
        manual_web,
        "search_configuration",
        lambda: (False, None, "Online manual search is not configured."),
    )


def test_manual_upload_without_model_links_multiple_items_and_viewer_is_read_only(
    owner_client, anon_client
):
    first = create_item(owner_client, "Cordless drill")
    second = create_item(owner_client, "Impact driver")
    response = upload_manual(owner_client, title="Shared tool manual")
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["document_type"] == "manual"
    assert document["items"] == []

    for item in (first, second):
        attached = owner_client.post(f"/api/v1/items/{item['id']}/manuals/{document['id']}")
        assert attached.status_code == 200, attached.text
        assert item["id"] in [entry["id"] for entry in attached.json()["items"]]

    duplicate = upload_manual(owner_client, title="Shared tool manual copy")
    assert duplicate.status_code == 201, duplicate.text
    duplicate_metadata = duplicate.json()["extracted_metadata"]["duplicate_documents"]
    assert duplicate_metadata[0]["id"] == document["id"]
    assert duplicate_metadata[0]["title"] == "Shared tool manual"

    listing = owner_client.get(f"/api/v1/items/{first['id']}/manuals").json()
    assert listing["item_id"] == first["id"]
    assert [entry["id"] for entry in listing["manuals"]] == [document["id"]]
    assert listing["search"]["profile"] is None
    assert listing["search"]["can_search"] is False

    receipt = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.pdf", manual_pdf_bytes(), "application/pdf")},
        data={"title": "Receipt", "document_type": "receipt"},
    ).json()
    not_manual = owner_client.post(f"/api/v1/items/{first['id']}/manuals/{receipt['id']}")
    assert not_manual.status_code == 422
    assert not_manual.json()["detail"]["code"] == "not_a_manual"

    headers = viewer_headers(owner_client)
    assert (
        anon_client.get(f"/api/v1/items/{first['id']}/manuals", headers=headers).status_code == 200
    )
    blocked_profile = anon_client.put(
        f"/api/v1/items/{first['id']}/manual-profile",
        headers=headers,
        json={
            "manufacturer": "Makita",
            "model_identifier": "DCD791",
            "confirmed": True,
        },
    )
    assert blocked_profile.status_code == 403
    blocked_attach = anon_client.post(
        f"/api/v1/items/{second['id']}/manuals/{document['id']}", headers=headers
    )
    assert blocked_attach.status_code == 403
    blocked_question = anon_client.post(
        f"/api/v1/items/{first['id']}/manual-questions",
        headers=headers,
        json={"question": "How do I change the bit?"},
    )
    assert blocked_question.status_code == 200, blocked_question.text

    with SessionLocal() as db:
        other_user = User(name="Other Owner", email="other@example.com", password_hash="not-used")
        other_household = Household(name="Other home")
        db.add_all([other_user, other_household])
        db.flush()
        db.add(
            HouseholdMember(
                user_id=other_user.id,
                household_id=other_household.id,
                role="owner",
            )
        )
        other_token = create_session(
            db,
            user=other_user,
            settings=get_settings(),
            user_agent="manual-test",
            ip_address="127.0.0.1",
            household_id=other_household.id,
        )
        db.commit()
    other = {"Cookie": f"housetory_session={other_token}"}
    assert anon_client.get(f"/api/v1/items/{first['id']}/manuals", headers=other).status_code == 404
    assert (
        anon_client.post(
            f"/api/v1/items/{first['id']}/manuals/{document['id']}", headers=other
        ).status_code
        == 404
    )


def test_manual_identity_gate_and_exact_model_candidates(owner_client, monkeypatch):
    item = create_item(owner_client, "Heavy drill")
    configure_search(monkeypatch)

    no_profile = owner_client.post(f"/api/v1/items/{item['id']}/manual-search")
    assert no_profile.status_code == 409
    assert no_profile.json()["detail"]["code"] == "manual_identity_required"
    online = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    )
    assert online.status_code == 409
    assert online.json()["detail"]["code"] == "manual_identity_required"

    unconfirmed = confirmed_profile(owner_client, item["id"], confirmed=False)
    assert unconfirmed.status_code == 422
    generic = confirmed_profile(
        owner_client, item["id"], manufacturer="Unknown", model_identifier="Heavy drill"
    )
    assert generic.status_code == 422
    assert generic.json()["detail"]["code"] == "incomplete_manual_identity"
    partial = confirmed_profile(
        owner_client, item["id"], manufacturer="Makita", model_identifier="DCD"
    )
    assert partial.status_code == 422
    assert partial.json()["detail"]["code"] == "incomplete_manual_identity"
    no_digits = confirmed_profile(
        owner_client, item["id"], manufacturer="Makita", model_identifier="Heavy drill"
    )
    assert no_digits.status_code == 422

    saved = confirmed_profile(owner_client, item["id"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["manufacturer"] == "Makita"
    assert saved.json()["model_identifier"] == "DCD791"

    calls = []

    def fake_search(payload):
        calls.append(payload)
        return {
            "results": [
                {
                    "title": "Makita DCD791 cordless drill instruction manual",
                    "source_url": "https://www.makita.example/support/DCD791",
                    "file_url": "https://www.makita.example/support/DCD791.pdf",
                    "publisher": "Makita",
                    "language": "en",
                    "source_type": "manufacturer",
                    "model_coverage": ["DCD791", "DCD791Z"],
                    "snippet": "Instruction manual for DCD791.",
                },
                {
                    "title": "DCD790 cordless drill manual",
                    "source_url": "https://example.com/DCD790",
                    "file_url": "https://example.com/DCD790.pdf",
                    "source_type": "other",
                    "model_coverage": ["DCD790"],
                },
                {
                    "title": "Heavy drill manual",
                    "source_url": "https://example.com/heavy-drill",
                    "file_url": "https://example.com/heavy-drill.pdf",
                    "source_type": "other",
                },
            ]
        }

    monkeypatch.setattr(manual_web, "_post_search", fake_search)
    searched = owner_client.post(f"/api/v1/items/{item['id']}/manual-search")
    assert searched.status_code == 200, searched.text
    body = searched.json()
    assert [entry["title"] for entry in body["candidates"]] == [
        "Makita DCD791 cordless drill instruction manual"
    ]
    assert any("exact confirmed model" in notice for notice in body["notices"])
    assert calls == [
        {
            "mode": "manual",
            "manufacturer": "Makita",
            "model": "DCD791",
            "variant": None,
        }
    ]

    repeated = owner_client.post(f"/api/v1/items/{item['id']}/manual-search").json()
    assert len(repeated["candidates"]) == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count(ManualSearchCandidate.id))) == 1

    headers = viewer_headers(owner_client, email="search-viewer@example.com")
    assert (
        owner_client.post(f"/api/v1/items/{item['id']}/manual-search", headers=headers).status_code
        == 403
    )

    disable_search(monkeypatch)
    unconfigured = owner_client.post(f"/api/v1/items/{item['id']}/manual-search")
    assert unconfigured.status_code == 409
    assert unconfigured.json()["detail"]["code"] == "manual_search_unconfigured"


def test_reviewed_download_is_idempotent_duplicate_aware_and_provenanced(
    owner_client, monkeypatch, pdf_bytes
):
    first = create_item(owner_client, "Drill one")
    second = create_item(owner_client, "Drill two")
    assert confirmed_profile(owner_client, first["id"]).status_code == 200
    assert confirmed_profile(owner_client, second["id"]).status_code == 200
    configure_search(monkeypatch)

    candidate_payload = {
        "results": [
            {
                "title": "Makita DCD791 manual",
                "source_url": "https://www.makita.example/DCD791",
                "file_url": "https://www.makita.example/DCD791.pdf",
                "publisher": "Makita",
                "language": "en",
                "source_type": "manufacturer",
                "model_coverage": ["DCD791"],
                "snippet": "Exact model manual.",
            }
        ]
    }
    monkeypatch.setattr(manual_web, "_post_search", lambda payload: candidate_payload)
    first_candidate = owner_client.post(f"/api/v1/items/{first['id']}/manual-search").json()[
        "candidates"
    ][0]
    second_candidate = owner_client.post(f"/api/v1/items/{second['id']}/manual-search").json()[
        "candidates"
    ][0]

    unconfirmed = owner_client.post(
        f"/api/v1/items/{first['id']}/manual-search/{first_candidate['id']}/download",
        json={"request_id": str(uuid.uuid4()), "confirm_model": False},
    )
    assert unconfirmed.status_code == 422

    fetch_calls = []

    def fake_fetch(url):
        fetch_calls.append(url)
        return manual_web.FetchedManual(
            content=pdf_bytes,
            content_type="application/pdf",
            filename="DCD791 manual.pdf",
            final_url=url,
            retrieved_at=datetime.now(UTC),
        )

    monkeypatch.setattr(manual_web, "fetch_manual_pdf", fake_fetch)
    request_id = uuid.uuid4()
    downloaded = owner_client.post(
        f"/api/v1/items/{first['id']}/manual-search/{first_candidate['id']}/download",
        json={"request_id": str(request_id), "confirm_model": True},
    )
    assert downloaded.status_code == 200, downloaded.text
    document = downloaded.json()["document"]
    assert document["document_type"] == "manual"
    assert document["items"] == [{"id": first["id"], "name": "Drill one"}]
    assert document["extracted_metadata"]["manual_source"]["source_url"] == (
        "https://www.makita.example/DCD791"
    )
    assert document["extracted_metadata"]["manual_source"]["retrieved_at"]

    retried = owner_client.post(
        f"/api/v1/items/{first['id']}/manual-search/{first_candidate['id']}/download",
        json={"request_id": str(request_id), "confirm_model": True},
    )
    assert retried.status_code == 200
    assert retried.json()["document"]["id"] == document["id"]
    assert len(fetch_calls) == 1

    new_request = owner_client.post(
        f"/api/v1/items/{first['id']}/manual-search/{first_candidate['id']}/download",
        json={"request_id": str(uuid.uuid4()), "confirm_model": True},
    )
    assert new_request.status_code == 200
    assert new_request.json()["document"]["id"] == document["id"]
    assert len(fetch_calls) == 1

    duplicate = owner_client.post(
        f"/api/v1/items/{second['id']}/manual-search/{second_candidate['id']}/download",
        json={"request_id": str(uuid.uuid4()), "confirm_model": True},
    )
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["document"]["id"] == document["id"]
    assert duplicate.json()["duplicate_documents"][0]["reused"] is True
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Document.id))) == 1
        stored = db.get(Document, uuid.UUID(document["id"]))
        assert stored is not None
        assert sorted(item.name for item in stored.items) == ["Drill one", "Drill two"]

    monkeypatch.setattr(
        manual_web,
        "_post_search",
        lambda payload: {
            "results": [
                {
                    "title": "Makita DCD791 service manual",
                    "source_url": "https://www.makita.example/DCD791-service",
                    "file_url": "https://www.makita.example/DCD791-service.pdf",
                    "source_type": "manufacturer",
                    "model_coverage": ["DCD791"],
                }
            ]
        },
    )
    failing = next(
        candidate
        for candidate in owner_client.post(f"/api/v1/items/{first['id']}/manual-search").json()[
            "candidates"
        ]
        if candidate["file_url"].endswith("DCD791-service.pdf")
    )
    monkeypatch.setattr(
        manual_web,
        "fetch_manual_pdf",
        lambda url: (_ for _ in ()).throw(manual_web.ManualFetchError("unsafe source")),
    )
    failed = owner_client.post(
        f"/api/v1/items/{first['id']}/manual-search/{failing['id']}/download",
        json={"request_id": str(uuid.uuid4()), "confirm_model": True},
    )
    assert failed.status_code == 422
    assert failed.json()["detail"]["code"] == "manual_download_failed"
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Document.id))) == 1
        candidate = db.get(ManualSearchCandidate, uuid.UUID(failing["id"]))
        assert candidate is not None
        assert candidate.document_id is None


def test_manual_questions_cite_real_pages_and_never_fabricate(owner_client, monkeypatch):
    item = create_item(owner_client, "Cordless drill")
    document = upload_manual(owner_client, item_ids=[item["id"]]).json()
    populate_manual(
        document["id"],
        "Safety: unplug the drill before changing the drill bit.\nSpecifications: 18 V battery.\n",
        pages=[
            {
                "page": 3,
                "text": "Safety. Unplug the drill before changing the drill bit. "
                "Keep hands clear of the chuck.",
            },
            {"page": 7, "text": "Specifications. Battery voltage 18 V. Chuck 13 mm."},
        ],
    )
    monkeypatch.setattr(ai_service, "status_for", lambda *args, **kwargs: fake_ai_status())

    asked = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "How do I change the drill bit?"},
    )
    assert asked.status_code == 200, asked.text
    answer = asked.json()
    assert answer["mode"] == "extractive"
    assert answer["citations"]
    assert answer["citations"][0]["page"] == 3
    assert "changing the drill bit" in answer["citations"][0]["excerpt"]
    assert answer["citations"][0]["url"].endswith(f"/documents/{document['id']}/file#page=3")
    assert answer["manuals"][0]["id"] == document["id"]
    assert all(citation["page"] in {3, 7} for citation in answer["citations"])
    assert "not configured" in " ".join(answer["notices"]).lower()

    monkeypatch.setattr(
        ai_service, "status_for", lambda *args, **kwargs: fake_ai_status(configured=True)
    )
    monkeypatch.setattr(
        ai_service,
        "complete_json",
        lambda *args, **kwargs: {
            "answer": "See page 99 for the bit change procedure.",
            "citation_ids": [1],
        },
    )
    fabricated = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "How do I change the drill bit?"},
    ).json()
    assert fabricated["mode"] == "extractive"
    assert all(citation["page"] != 99 for citation in fabricated["citations"])
    assert "page 99" not in fabricated["answer"].lower()

    monkeypatch.setattr(
        ai_service,
        "complete_json",
        lambda *args, **kwargs: {
            "answer": "Unplug the drill before changing the bit.",
            "citation_ids": [1],
        },
    )
    synthesized = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "How do I change the drill bit?"},
    ).json()
    assert synthesized["mode"] == "ai"
    assert synthesized["citations"][0]["page"] == 3

    no_match = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "What is the warranty period for the charger?"},
    ).json()
    assert no_match["mode"] == "no_evidence"
    assert no_match["citations"] == []
    assert "will not infer" in no_match["answer"].lower() or "do not contain" in (
        no_match["answer"].lower()
    )


def test_manual_without_page_metadata_uses_explicit_excerpt_labels(owner_client, monkeypatch):
    item = create_item(owner_client, "Legacy manual item")
    document = upload_manual(owner_client, item_ids=[item["id"]]).json()
    populate_manual(
        document["id"],
        "Lubrication\nClean the chuck weekly and apply light machine oil.\n",
    )
    monkeypatch.setattr(ai_service, "status_for", lambda *args, **kwargs: fake_ai_status())
    answer = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "How should I lubricate the chuck?"},
    ).json()
    assert answer["mode"] == "extractive"
    assert answer["citations"][0]["page"] is None
    assert answer["citations"][0]["section"]
    assert any("page-level text is not available" in notice.lower() for notice in answer["notices"])


def test_ocr_page_metadata_is_stored_for_real_manual_citations(owner_client, monkeypatch):
    item = create_item(owner_client, "Scanned manual item")
    document = upload_manual(owner_client, item_ids=[item["id"]]).json()
    extracted = ExtractedText(
        text="Safety\nDisconnect power before service.\n\nMaintenance\nOil the spindle monthly.",
        confidence=87,
        source="ocr",
        pages=(
            OcrPage(page_number=1, text="Safety. Disconnect power before service."),
            OcrPage(page_number=2, text="Maintenance. Oil the spindle monthly."),
        ),
    )
    run_document_ocr(
        uuid.UUID(document["id"]),
        extractor=lambda path, content_type: extracted,
        parser=lambda text: {},
    )
    refreshed = owner_client.get(f"/api/v1/documents/{document['id']}").json()
    assert refreshed["extracted_metadata"]["ocr_pages"][0]["page"] == 1
    assert refreshed["extracted_metadata"]["ocr_pages"][1]["text"].startswith("Maintenance")
    assert refreshed["extracted_metadata"]["ocr_page_count"] == 2

    monkeypatch.setattr(ai_service, "status_for", lambda *args, **kwargs: fake_ai_status())
    answer = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions",
        json={"question": "How often should I oil the spindle?"},
    ).json()
    assert answer["citations"][0]["page"] == 2
    assert "Oil the spindle" in answer["citations"][0]["excerpt"]


def test_exact_model_filter_honours_confirmed_variant():
    def candidate(title):
        return manual_web.SearchCandidateData(
            title=title,
            source_url="https://www.makita.example/manual",
            file_url="https://www.makita.example/manual.pdf",
            publisher="Makita",
            language="en",
            source_type="manufacturer",
            model_coverage=["DCD791"],
            snippet=None,
            retrieved_at=datetime.now(UTC),
        )

    accepted, notices = manual_web._exact_model_candidates(
        [
            candidate("Makita DCD791 drill manual"),
            candidate("Makita DCD791Z drill manual"),
            candidate("Makita DCD790 drill manual"),
        ],
        manufacturer="Makita",
        model="DCD791",
        variant="Z",
    )
    assert [entry.title for entry in accepted] == ["Makita DCD791Z drill manual"]
    assert any("exact confirmed model" in notice for notice in notices)


def test_online_questions_require_full_gate_and_send_only_product_context(
    owner_client, monkeypatch
):
    item = create_item(owner_client, "Heavy drill")
    disable_search(monkeypatch)
    no_profile = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    )
    assert no_profile.status_code == 409
    assert no_profile.json()["detail"]["code"] == "manual_identity_required"

    assert confirmed_profile(owner_client, item["id"]).status_code == 200
    unconfigured = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    )
    assert unconfigured.status_code == 409
    assert unconfigured.json()["detail"]["code"] == "manual_search_unconfigured"

    configure_search(monkeypatch)
    monkeypatch.setattr(ai_service, "status_for", lambda *args, **kwargs: fake_ai_status())
    calls = []

    def fake_search(payload):
        calls.append(payload)
        return {
            "results": [
                {
                    "title": "Makita DCD791 battery specification",
                    "url": "https://www.makita.example/DCD791",
                    "publisher": "Makita",
                    "language": "en",
                    "source_type": "manufacturer",
                    "model_coverage": ["DCD791"],
                    "snippet": "The DCD791 uses 18 V LXT batteries.",
                },
                {
                    "title": "DCD790 battery guide",
                    "url": "https://example.com/DCD790",
                    "source_type": "other",
                    "snippet": "A similar drill uses a different battery.",
                },
            ]
        }

    monkeypatch.setattr(manual_web, "_post_search", fake_search)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    )
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["mode"] == "extractive"
    assert [citation["url"] for citation in answer["citations"]] == [
        "https://www.makita.example/DCD791"
    ]
    assert "18 V" in answer["citations"][0]["excerpt"]
    assert set(calls[0]) == {"mode", "manufacturer", "model", "variant", "question"}
    assert calls[0]["mode"] == "question"
    assert calls[0]["manufacturer"] == "Makita"
    assert calls[0]["model"] == "DCD791"
    assert calls[0]["question"] == "What battery does it use?"
    serialized = str(calls[0]).lower()
    assert "borrower" not in serialized
    assert "household" not in serialized
    assert "loan" not in serialized

    monkeypatch.setattr(
        manual_web,
        "_post_search",
        lambda payload: {
            "results": [
                {
                    "title": "DCD790 battery guide",
                    "url": "https://example.com/DCD790",
                    "source_type": "other",
                    "snippet": "A similar drill uses a different battery.",
                }
            ]
        },
    )
    similar = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    ).json()
    assert similar["mode"] == "no_evidence"
    assert similar["citations"] == []

    monkeypatch.setattr(manual_web, "_post_search", lambda payload: {"results": "bad"})
    malformed = owner_client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online",
        json={"question": "What battery does it use?"},
    )
    assert malformed.status_code == 502
    assert malformed.json()["detail"]["code"] == "manual_search_unavailable"


def test_public_ip_and_ssrf_download_guards(monkeypatch, pdf_bytes):
    for value in (
        "127.0.0.1",
        "127.1",
        "10.0.0.5",
        "172.16.1.1",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fd00::1",
        "fe80::1",
    ):
        assert manual_web._public_ip(value) is False, value
    assert manual_web._public_ip("93.184.216.34") is True

    def private_dns(host, port, type=None):
        return [(2, 1, 6, "", ("127.0.0.1", port))]

    monkeypatch.setattr(manual_web.socket, "getaddrinfo", private_dns)
    with pytest.raises(manual_web.ManualFetchError):
        manual_web._resolve_public("manual.example", 443)

    def mixed_dns(host, port, type=None):
        return [
            (2, 1, 6, "", ("93.184.216.34", port)),
            (2, 1, 6, "", ("10.0.0.7", port)),
        ]

    monkeypatch.setattr(manual_web.socket, "getaddrinfo", mixed_dns)
    with pytest.raises(manual_web.ManualFetchError):
        manual_web._resolve_public("manual.example", 443)

    with pytest.raises(manual_web.ManualFetchError):
        manual_web.fetch_manual_pdf("file:///etc/passwd")
    with pytest.raises(manual_web.ManualFetchError):
        manual_web.fetch_manual_pdf("http://user:secret@manual.example/a.pdf")
    with pytest.raises(manual_web.ManualFetchError):
        manual_web.fetch_manual_pdf("http://127.0.0.1/a.pdf")

    monkeypatch.setattr(
        manual_web,
        "_request_once",
        lambda url, **kwargs: (302, {"location": "/loop"}, b""),
    )
    with pytest.raises(manual_web.ManualFetchError, match="redirected too many times"):
        manual_web.fetch_manual_pdf("https://manual.example/start.pdf")

    monkeypatch.setattr(
        manual_web,
        "_request_once",
        lambda url, **kwargs: (200, {"content-type": "text/html"}, b"<html></html>"),
    )
    with pytest.raises(manual_web.ManualFetchError):
        manual_web.fetch_manual_pdf("https://manual.example/a.pdf")

    monkeypatch.setattr(
        manual_web,
        "_request_once",
        lambda url, **kwargs: (200, {"content-type": "application/pdf"}, b"%PDF-1.7\nbody"),
    )
    fetched = manual_web.fetch_manual_pdf("https://manual.example/files/DCD791%20manual.pdf")
    assert fetched.content.startswith(b"%PDF-")
    assert fetched.filename == "DCD791 manual.pdf"

    # HTTPS may not silently downgrade to plain HTTP on redirect.
    monkeypatch.setattr(
        manual_web,
        "_request_once",
        lambda url, **kwargs: (
            302,
            {"location": "http://manual.example/a.pdf"},
            b"",
        ),
    )
    with pytest.raises(manual_web.ManualFetchError, match="insecure"):
        manual_web.fetch_manual_pdf("https://manual.example/start.pdf")


def test_pinned_connection_rejects_oversize_and_timeout(monkeypatch, pdf_bytes):
    class FakeResponse:
        def __init__(self, status, headers, body):
            self.status = status
            self._headers = headers
            self._body = body
            self._offset = 0

        def getheaders(self):
            return list(self._headers.items())

        def read(self, amount):
            chunk = self._body[self._offset : self._offset + amount]
            self._offset += len(chunk)
            return chunk

    class FakeConnection:
        instances = []

        def __init__(self, host, port, connect_host, *, timeout):
            self.host = host
            self.port = port
            self.connect_host = connect_host
            self.timeout = timeout
            self.headers = {}
            FakeConnection.instances.append(self)

        def request(self, method, path, headers=None):
            self.method = method
            self.path = path
            self.headers = headers or {}

        def getresponse(self):
            return FakeResponse(200, {"content-type": "application/pdf"}, pdf_bytes)

        def close(self):
            return None

    monkeypatch.setattr(manual_web, "_resolve_public", lambda host, port: ["93.184.216.34"])
    monkeypatch.setattr(manual_web, "_PinnedHTTPConnection", FakeConnection)
    status, headers, body = manual_web._request_once(
        "http://manual.example/files/manual.pdf?x=1",
        timeout=10,
        max_bytes=1024 * 1024,
    )
    assert status == 200
    assert body == pdf_bytes
    connection = FakeConnection.instances[-1]
    assert connection.connect_host == "93.184.216.34"
    assert connection.host == "manual.example"
    assert connection.headers["Host"] == "manual.example"
    assert connection.path == "/files/manual.pdf?x=1"

    monkeypatch.setattr(
        manual_web,
        "_PinnedHTTPConnection",
        _fake_connection_class(FakeResponse(200, {"content-length": str(10 * 1024 * 1024)}, b"x")),
    )
    with pytest.raises(manual_web.ManualFetchError, match="large"):
        manual_web._request_once("http://manual.example/big.pdf", timeout=10, max_bytes=1024 * 1024)

    monkeypatch.setattr(
        manual_web,
        "_PinnedHTTPConnection",
        _fake_connection_class(FakeResponse(200, {}, b"x" * (1024 * 1024 + 1))),
    )
    with pytest.raises(manual_web.ManualFetchError, match="large"):
        manual_web._request_once("http://manual.example/big.pdf", timeout=10, max_bytes=1024 * 1024)

    class TimeoutConnection(FakeConnection):
        def request(self, method, path, headers=None):
            raise TimeoutError("slow")

    monkeypatch.setattr(manual_web, "_PinnedHTTPConnection", TimeoutConnection)
    with pytest.raises(manual_web.ManualFetchError):
        manual_web._request_once("http://manual.example/slow.pdf", timeout=1, max_bytes=1024)


def _fake_connection_class(response):
    class _Connection:
        def __init__(self, host, port, connect_host, *, timeout):
            self.host = host

        def request(self, method, path, headers=None):
            return None

        def getresponse(self):
            return response

        def close(self):
            return None

    return _Connection


def test_bounded_read_enforces_total_deadline_not_only_per_read(monkeypatch):
    class DripResponse:
        def read(self, amount):
            return b"x"

    times = iter([0.0, 0.5, 1.5])
    monkeypatch.setattr(manual_web.time, "monotonic", lambda: next(times))
    with pytest.raises(manual_web.ManualFetchError, match="timed out"):
        manual_web._read_bounded(
            DripResponse(),
            max_bytes=1024,
            timeout=1,
            error_type=manual_web.ManualFetchError,
        )


def test_search_gateway_rejects_redirect_and_invalid_json(monkeypatch):
    configure_search(monkeypatch)
    monkeypatch.setattr(get_settings(), "manual_search_url", "https://search.example/manuals")

    class RedirectResponse:
        status = 302

        def read(self, amount):
            return b""

    class RedirectConnection:
        def __init__(self, host, port, timeout):
            pass

        def request(self, method, path, body=None, headers=None):
            pass

        def getresponse(self):
            return RedirectResponse()

        def close(self):
            pass

    monkeypatch.setattr(manual_web.http.client, "HTTPSConnection", RedirectConnection)
    with pytest.raises(manual_web.ManualSearchUnavailable, match="redirect"):
        manual_web._post_search({"mode": "manual", "manufacturer": "Makita", "model": "DCD791"})

    class InvalidResponse:
        status = 200

        def __init__(self):
            self._body = b"not-json"
            self._offset = 0

        def read(self, amount):
            chunk = self._body[self._offset : self._offset + amount]
            self._offset += len(chunk)
            return chunk

    class InvalidConnection(RedirectConnection):
        def getresponse(self):
            return InvalidResponse()

    monkeypatch.setattr(manual_web.http.client, "HTTPSConnection", InvalidConnection)
    with pytest.raises(manual_web.ManualSearchUnavailable, match="invalid JSON"):
        manual_web._post_search({"mode": "manual", "manufacturer": "Makita", "model": "DCD791"})
