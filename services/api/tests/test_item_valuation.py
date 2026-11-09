import io
import uuid
from datetime import UTC, datetime

from pypdf import PdfReader

from housetory_api.db import SessionLocal
from housetory_api.models import Item
from housetory_api.services import ai as ai_service
from housetory_api.services import evidence_export, manual_web, valuation


def provider_payload(**overrides):
    return {
        "provider": "openai",
        "display_name": "Valuation test provider",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-valuation-test",
        "api_key": "sk-valuation-not-real",
        "enabled": True,
        "cloud_consent": True,
        **overrides,
    }


def create_room(client, name="Valuation room"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name="Camera kit", **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def ai_estimate_payload(**overrides):
    return {
        "currency": "USD",
        "low_cents": 3500,
        "suggested_cents": 4000,
        "high_cents": 5000,
        "confidence": "medium",
        "reasoning": "Comparable used camera kits in recorded condition support this range.",
        "assumptions": ["Battery and basic accessories are included."],
        **overrides,
    }


def install_ai(monkeypatch, payload=None, *, error=None, prompts=None):
    def fake_complete_json(system, user, **kwargs):
        if prompts is not None:
            prompts.append({"system": system, "user": user})
        if error is not None:
            raise error
        return payload or ai_estimate_payload()

    monkeypatch.setattr(ai_service, "complete_json", fake_complete_json)


def preview(client, item_id, *, purpose="resale", currency="USD", include_web=False):
    return client.post(
        f"/api/v1/items/{item_id}/valuation/estimate",
        json={
            "purpose": purpose,
            "currency": currency,
            "include_web": include_web,
        },
    )


def apply_value(
    client,
    item_id,
    *,
    fingerprint,
    estimate_id=None,
    purpose="resale",
    amount_cents=4000,
    currency="USD",
):
    return client.post(
        f"/api/v1/items/{item_id}/valuation/apply",
        json={
            "estimate_id": estimate_id,
            "purpose": purpose,
            "amount_cents": amount_cents,
            "currency": currency,
            "expected_fingerprint": fingerprint,
        },
    )


def test_resale_preview_apply_quantity_history_and_privacy(owner_client, monkeypatch):
    configured = owner_client.post("/api/v1/ai/providers", json=provider_payload())
    assert configured.status_code == 201, configured.text
    room = create_room(owner_client, "Secret valuation room")
    item = create_item(
        owner_client,
        "Mirrorless camera",
        description="Used mirrorless camera with two batteries.",
        brand="Fujifilm",
        model="X-T4",
        serial_number="SN-SECRET-VALUATION",
        condition="excellent",
        quantity=2,
        room_id=room["id"],
        purchase={
            "merchant": "Camera Shop",
            "purchase_date": "2024-05-01",
            "price_cents": 120000,
            "currency": "USD",
        },
    )
    owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": item["id"],
            "borrower_name": "Private Borrower",
            "quantity": 1,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    owner_client.post(
        "/api/v1/borrowed",
        json={
            "item_name": "Private borrowed grinder",
            "owner_name": "Private Owner",
            "quantity": 1,
            "borrowed_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    prompts: list[dict[str, str]] = []
    install_ai(monkeypatch, prompts=prompts)

    estimated = preview(owner_client, item["id"], purpose="resale")
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()
    assert body["purpose"] == "resale"
    assert body["source"] == "ai"
    assert body["web_used"] is False
    assert body["owned_quantity"] == 2
    assert body["low_cents"] == 3500
    assert body["low_total_cents"] == 7000
    assert body["suggested_total_cents"] == 8000
    assert body["high_total_cents"] == 10000
    assert body["confidence"] == "medium"
    assert body["fingerprint"] == owner_client.get(
        f"/api/v1/items/{item['id']}"
    ).json()["item"]["valuation_fingerprint"]
    assert body["disclaimer"].startswith("Estimate only")

    unchanged = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert unchanged["current_value_cents"] is None
    assert unchanged["current_value_estimate"] is None

    prompt_text = prompts[0]["user"]
    assert "Fujifilm" in prompt_text and "X-T4" in prompt_text
    assert "excellent" in prompt_text
    assert "SN-SECRET-VALUATION" not in prompt_text
    assert "Secret valuation room" not in prompt_text
    assert "Private Borrower" not in prompt_text
    assert "Private Owner" not in prompt_text
    assert "private borrowed grinder" not in prompt_text.lower()

    applied = apply_value(
        owner_client,
        item["id"],
        estimate_id=body["estimate_id"],
        fingerprint=body["fingerprint"],
        amount_cents=4200,
    )
    assert applied.status_code == 200, applied.text
    detail = applied.json()["item"]
    assert detail["current_value_cents"] == 4200
    assert detail["current_value_basis"] == "per_unit"
    assert detail["current_value_total_cents"] == 8400
    assert detail["on_loan_quantity"] == 1
    estimate = detail["current_value_estimate"]
    assert estimate["purpose"] == "resale"
    assert estimate["source"] == "ai"
    assert estimate["low_cents"] == 3500
    assert estimate["high_cents"] == 5000
    assert estimate["confidence"] == "medium"
    assert estimate["as_of"] == body["as_of"]
    assert detail["current_value_estimated_at"] is not None

    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()["items"]
    value_event = next(event for event in history if event["action"] == "item.value_updated")
    assert value_event["actor_name"] == "Ada Lovelace"
    assert value_event["details"]["from"]["value_cents"] is None
    assert value_event["details"]["to"]["value_cents"] == 4200
    assert value_event["details"]["to"]["estimate"]["purpose"] == "resale"
    assert "AI" in value_event["summary"] or "Resale" in value_event["summary"]


def test_shared_purchase_total_is_not_treated_as_per_unit(owner_client, monkeypatch):
    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    room = create_room(owner_client, "Shared purchase room")
    camera = create_item(
        owner_client,
        "Shared purchase camera",
        room_id=room["id"],
        quantity=2,
        condition="good",
    )
    lens = create_item(owner_client, "Shared purchase lens", room_id=room["id"])
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "Camera bundle",
            "purchase_date": "2024-02-01",
            "price_cents": 100000,
            "currency": "USD",
            "item_ids": [camera["id"], lens["id"]],
        },
    )
    assert purchase.status_code == 201, purchase.text
    prompts: list[dict[str, str]] = []
    install_ai(
        monkeypatch,
        ai_estimate_payload(
            currency="EUR",
            low_cents=4500,
            suggested_cents=5000,
            high_cents=5500,
            confidence="low",
            reasoning="Shared purchase has no reviewed camera allocation.",
        ),
        prompts=prompts,
    )

    estimated = preview(
        owner_client,
        camera["id"],
        purpose="replacement",
        currency="EUR",
    )
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()
    assert body["purpose"] == "replacement"
    assert body["source"] == "ai"
    assert body["currency"] == "EUR"
    assert body["suggested_total_cents"] == 10000
    assert '"item_count": 2' in prompts[0]["user"]
    assert '"has_reviewed_allocation": false' in prompts[0]["user"]
    assert '"item_allocation_cents": null' in prompts[0]["user"]
    assert "replacement" in prompts[0]["user"].lower()
    assert "resale" in prompts[0]["user"].lower()

    applied = apply_value(
        owner_client,
        camera["id"],
        estimate_id=body["estimate_id"],
        purpose="replacement",
        fingerprint=body["fingerprint"],
        amount_cents=5200,
        currency="EUR",
    )
    assert applied.status_code == 200, applied.text
    detail = applied.json()["item"]
    assert detail["current_value_total_cents"] == 10400
    assert detail["current_value_estimate"]["purpose"] == "replacement"
    assert detail["purchase"]["price_cents"] == 100000
    financial = owner_client.get("/api/v1/financial-overview").json()
    eur = next(row for row in financial["currency_totals"] if row["currency"] == "EUR")
    usd = next(row for row in financial["currency_totals"] if row["currency"] == "USD")
    assert eur["current_value_total_cents"] == 10400
    assert usd["purchase_total_cents"] == 100000


def test_purpose_stale_and_invalid_ai_do_not_save(owner_client, monkeypatch):
    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    room = create_room(owner_client, "Stale room")
    item = create_item(owner_client, "Stale camera", room_id=room["id"], quantity=2)
    install_ai(monkeypatch)
    estimated = preview(owner_client, item["id"], purpose="resale")
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()

    changed_purpose = apply_value(
        owner_client,
        item["id"],
        estimate_id=body["estimate_id"],
        purpose="replacement",
        fingerprint=body["fingerprint"],
    )
    assert changed_purpose.status_code == 409
    assert changed_purpose.json()["detail"]["code"] == "valuation_purpose_changed"
    unchanged = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert unchanged["current_value_cents"] is None
    assert unchanged["current_value_estimate"] is None

    owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    stale = apply_value(
        owner_client,
        item["id"],
        estimate_id=body["estimate_id"],
        fingerprint=body["fingerprint"],
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "valuation_stale"
    unchanged = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert unchanged["current_value_cents"] is None

    install_ai(monkeypatch, ai_estimate_payload(currency="ZZZ"))
    invalid_currency = preview(owner_client, item["id"], purpose="resale")
    assert invalid_currency.status_code == 502
    assert (
        invalid_currency.json()["detail"]["code"]
        == "valuation_currency_mismatch"
    )

    install_ai(monkeypatch, ai_estimate_payload(low_cents=5000, suggested_cents=4000))
    invalid_range = preview(owner_client, item["id"], purpose="resale")
    assert invalid_range.status_code == 502
    assert invalid_range.json()["detail"]["code"] == "valuation_invalid_response"

    install_ai(
        monkeypatch,
        error=ai_service.AiUnavailable("Provider timed out"),
    )
    unavailable = preview(owner_client, item["id"], purpose="resale")
    assert unavailable.status_code == 502
    assert unavailable.json()["detail"]["code"] == "valuation_ai_failed"

    # Manual entry remains available and is explicitly labelled.
    latest = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    manual = apply_value(
        owner_client,
        item["id"],
        purpose="replacement",
        fingerprint=latest["valuation_fingerprint"],
        amount_cents=3000,
    )
    assert manual.status_code == 200, manual.text
    detail = manual.json()["item"]
    assert detail["current_value_cents"] == 3000
    assert detail["current_value_total_cents"] == 9000
    estimate = detail["current_value_estimate"]
    assert estimate["purpose"] == "replacement"
    assert estimate["source"] == "manual"
    assert estimate["confidence"] is None
    assert estimate["sources"] == []

    # Editing the value through the existing manual form clears stale AI provenance.
    edited = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"current_value_cents": 3100}
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["item"]["current_value_estimate"] is None


def test_ai_not_configured_and_web_unavailable_rough_estimate(owner_client, monkeypatch):
    room = create_room(owner_client, "Optional AI room")
    item = create_item(owner_client, "Optional AI drill", room_id=room["id"])
    no_ai = preview(owner_client, item["id"])
    assert no_ai.status_code == 422
    assert no_ai.json()["detail"]["code"] == "valuation_ai_not_configured"

    latest = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    manual = apply_value(
        owner_client,
        item["id"],
        purpose="resale",
        fingerprint=latest["valuation_fingerprint"],
        amount_cents=2500,
    )
    assert manual.status_code == 200, manual.text
    assert manual.json()["item"]["current_value_cents"] == 2500

    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    install_ai(monkeypatch)

    def unavailable(*args, **kwargs):
        raise manual_web.ManualSearchUnavailable("Brave is not configured for this test.")

    monkeypatch.setattr(valuation.manual_web, "search_generic_web", unavailable)
    estimated = preview(owner_client, item["id"], include_web=True)
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()
    assert body["source"] == "ai"
    assert body["web_used"] is False
    assert body["sources"] == []
    assert "without verified current comparisons" in body["web_reason"]
    assert "no verified" not in body["reasoning"].lower()


def test_web_comparables_persist_and_appear_in_evidence_pdf(owner_client, monkeypatch, pdf_bytes):
    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    room = create_room(owner_client, "Web evidence room")
    item = create_item(
        owner_client,
        "Web camera",
        room_id=room["id"],
        quantity=2,
        serial_number="SN-WEB-PRIVATE",
        description="Good condition camera with charger.",
        purchase={
            "merchant": "Web Shop",
            "purchase_date": "2024-01-01",
            "price_cents": 10000,
            "currency": "USD",
        },
    )
    prompts: list[dict[str, str]] = []
    install_ai(monkeypatch, prompts=prompts)
    retrieved = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)

    def fake_search(db, household_id, query, *, count=5):
        assert "Secret" not in query
        assert "SN-WEB-PRIVATE" not in query
        return [
            manual_web.GenericWebResult(
                title="Used Web camera listing",
                url="https://example.com/used-camera",
                snippet="Good condition camera, asking USD 45.00.",
                retrieved_at=retrieved,
            ),
            manual_web.GenericWebResult(
                title="Camera price guide",
                url="https://example.org/camera-guide",
                snippet="No current listing price shown.",
                retrieved_at=retrieved,
            ),
        ]

    monkeypatch.setattr(valuation.manual_web, "search_generic_web", fake_search)
    estimated = preview(owner_client, item["id"], include_web=True)
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()
    assert body["source"] == "ai_web"
    assert body["web_used"] is True
    assert body["web_query"]
    assert [source["url"] for source in body["sources"]] == [
        "https://example.com/used-camera",
        "https://example.org/camera-guide",
    ]
    assert body["sources"][0]["price_cents"] == 4500
    assert body["sources"][0]["currency"] == "USD"
    assert body["sources"][0]["price_kind"] == "asking"
    assert body["sources"][1]["price_cents"] is None
    assert "https://example.com/used-camera" in prompts[0]["user"]
    assert "SN-WEB-PRIVATE" not in prompts[0]["user"]

    applied = apply_value(
        owner_client,
        item["id"],
        estimate_id=body["estimate_id"],
        fingerprint=body["fingerprint"],
        amount_cents=4500,
    )
    assert applied.status_code == 200, applied.text
    detail = applied.json()["item"]
    assert detail["current_value_estimate"]["source"] == "ai_web"
    assert detail["current_value_estimate"]["web_used"] is True
    assert detail["current_value_estimate"]["sources"][0]["url"] == (
        "https://example.com/used-camera"
    )

    preview_response = owner_client.post(
        "/api/v1/evidence-exports/preview",
        json={"scope": {"item_ids": [item["id"]]}, "options": {}},
    )
    assert preview_response.status_code == 200, preview_response.text
    preview_data = preview_response.json()
    created = owner_client.post(
        "/api/v1/evidence-exports",
        json={
            "scope": {"item_ids": [item["id"]]},
            "include_archived": False,
            "options": preview_data["options"],
            "fingerprint": preview_data["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert created.status_code == 202, created.text
    package_id = created.json()["id"]
    assert evidence_export.run_evidence_export({"export_id": package_id})["status"] == "succeeded"
    pdf = owner_client.get(f"/api/v1/evidence-exports/{package_id}/pdf")
    assert pdf.status_code == 200
    text = "\n".join(
        page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages
    )
    assert "Resale estimate" in text
    assert "AI with public web search snippets" in text
    assert f"as of {body['as_of']}" in text
    assert "Medium confidence" in text
    assert "Estimated per-unit range" in text
    assert "90.00 USD total" in text
    assert "Supporting source" in text
    assert "https://example.com/used-camera" in text
    assert "asking/listed" in text
    assert "not a professional appraisal" in text
    assert "SN-WEB-PRIVATE" in text  # serials remain in the local evidence export


def test_legacy_record_total_is_reviewed_before_per_unit_conversion(owner_client, monkeypatch):
    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    install_ai(monkeypatch)
    room = create_room(owner_client, "Legacy valuation room")
    item = create_item(owner_client, "Legacy valuation camera", room_id=room["id"], quantity=2)
    with SessionLocal() as db:
        stored = db.get(Item, uuid.UUID(item["id"]))
        assert stored is not None
        stored.current_value_cents = 8000
        stored.current_value_basis = "legacy_record_total"
        stored.current_value_currency = "USD"
        db.commit()

    estimated = preview(owner_client, item["id"])
    assert estimated.status_code == 200, estimated.text
    body = estimated.json()
    assert body["existing_value_cents"] == 8000
    assert body["existing_value_basis"] == "legacy_record_total"
    assert body["suggested_total_cents"] == 8000

    before = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert before["current_value_total_cents"] == 8000

    applied = apply_value(
        owner_client,
        item["id"],
        estimate_id=body["estimate_id"],
        fingerprint=body["fingerprint"],
        amount_cents=3000,
    )
    assert applied.status_code == 200, applied.text
    detail = applied.json()["item"]
    assert detail["current_value_cents"] == 3000
    assert detail["current_value_basis"] == "per_unit"
    assert detail["current_value_total_cents"] == 6000
    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()["items"]
    event = next(entry for entry in history if entry["action"] == "item.value_updated")
    assert event["details"]["from"]["basis"] == "legacy_record_total"
    assert event["details"]["from"]["total_cents"] == 8000
    assert event["details"]["to"]["total_cents"] == 6000
    assert "Legacy current value converted" in event["summary"]


def test_owned_storage_host_value_does_not_double_count_contents(owner_client):
    room = create_room(owner_client, "Storage value room")
    host = create_item(
        owner_client,
        "Value toolbox",
        room_id=room["id"],
        current_value_cents=5000,
        current_value_currency="USD",
    )
    enabled = owner_client.post(f"/api/v1/items/{host['id']}/storage", json={})
    assert enabled.status_code == 200, enabled.text
    storage = enabled.json()["item"]["storage"]
    child = create_item(
        owner_client,
        "Value screwdriver",
        room_id=room["id"],
        storage_location_id=storage["location_id"],
        current_value_cents=2500,
        current_value_currency="USD",
    )
    borrowed = owner_client.post(
        "/api/v1/borrowed",
        json={
            "item_name": "Borrowed value sander",
            "owner_name": "External owner",
            "quantity": 4,
            "borrowed_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert borrowed.status_code == 201, borrowed.text
    latest = owner_client.get(f"/api/v1/items/{host['id']}").json()["item"]
    applied = apply_value(
        owner_client,
        host["id"],
        purpose="replacement",
        fingerprint=latest["valuation_fingerprint"],
        amount_cents=6000,
    )
    assert applied.status_code == 200, applied.text
    host_detail = applied.json()["item"]
    assert host_detail["current_value_total_cents"] == 6000
    assert host_detail["quantity"] == 1
    child_detail = owner_client.get(f"/api/v1/items/{child['id']}").json()["item"]
    assert child_detail["current_value_total_cents"] == 2500
    financial = owner_client.get("/api/v1/financial-overview").json()
    usd = next(row for row in financial["currency_totals"] if row["currency"] == "USD")
    assert usd["current_value_total_cents"] == 8500


def test_valuation_permissions_and_cross_household_guard(owner_client, anon_client, monkeypatch):
    from tests.test_cross_household import _other_household_headers
    from tests.test_lending import _add_member, _headers

    owner_client.post("/api/v1/ai/providers", json=provider_payload())
    install_ai(monkeypatch)
    room = create_room(owner_client, "Permission room")
    item = create_item(owner_client, "Permission camera", room_id=room["id"])
    token, _user_id = _add_member(
        owner_client, email="valuation-viewer@example.com", role="viewer"
    )
    viewer = _headers(token)
    estimated = owner_client.post(
        f"/api/v1/items/{item['id']}/valuation/estimate",
        json={"purpose": "resale", "currency": "USD", "include_web": False},
        headers=viewer,
    )
    assert estimated.status_code == 403
    assert anon_client.post(
        f"/api/v1/items/{item['id']}/valuation/estimate",
        json={"purpose": "resale", "currency": "USD", "include_web": False},
    ).status_code == 401

    other = _other_household_headers("valuation-other@example.com", "Other Valuer")
    denied = owner_client.post(
        f"/api/v1/items/{item['id']}/valuation/estimate",
        json={"purpose": "resale", "currency": "USD", "include_web": False},
        headers=other["headers"],
    )
    assert denied.status_code == 404
