import io

from PIL import Image

from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai
from housetory_api.services.import_pipeline import process_import_batch
from housetory_api.services.product_pages import ProductPage, ProductPageError
from housetory_api.services.recognition import run_recognition


def image_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (120, 90), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def create_room(client, name="Assisted room"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def test_recognition_context_becomes_one_idempotent_import_review(owner_client, monkeypatch):
    room = create_room(owner_client)
    prompts: list[str] = []
    status = AiStatus(
        provider="ollama",
        mode="local",
        model="vision-test",
        configured=True,
        available=True,
        privacy_note="Local",
    )
    monkeypatch.setattr(ai, "status_for", lambda *args, **kwargs: status)

    def fake_complete(system, prompt, **kwargs):
        prompts.append(prompt)
        return {
            "suggestions": [
                {
                    "name": "Osprey Jet 18",
                    "description": "Blue kids backpack",
                    "category": "Bags",
                    "brand": "Osprey",
                    "model": "Jet 18",
                    "tags": ["camping"],
                    "confidence": 86,
                    "review": True,
                    "review_reason": "Verify the exact variant",
                    "field_sources": {"name": "inferred"},
                }
            ],
            "warnings": [],
        }

    monkeypatch.setattr(ai, "complete_json", fake_complete)
    created = owner_client.post(
        "/api/v1/ai/recognitions",
        files={"file": ("backpack.png", image_bytes(), "image/png")},
        data={"room_id": room["id"], "text": "The blue backpack on the left"},
    )
    assert created.status_code == 201, created.text
    recognition_id = created.json()["id"]
    run_recognition(recognition_id)
    assert "<untrusted_context>" in prompts[0]
    assert "The blue backpack on the left" in prompts[0]

    recognition = owner_client.get(f"/api/v1/ai/recognitions/{recognition_id}").json()
    assert recognition["result"]["_add_items"]["text"] == "The blue backpack on the left"

    first = owner_client.post(f"/api/v1/imports/from-recognition/{recognition_id}")
    assert first.status_code == 201, first.text
    batch = first.json()
    second = owner_client.post(f"/api/v1/imports/from-recognition/{recognition_id}")
    assert second.status_code == 201, second.text
    assert second.json()["id"] == batch["id"]
    assert len(batch["entries"]) == 1
    entry = batch["entries"][0]
    assert entry["proposed"]["name"] == "Osprey Jet 18"
    assert entry["proposed"]["tags"] == ["camping"]
    assert entry["proposed"]["room"]["matched_id"] == room["id"]
    assert entry["proposed"]["relationships"]["review"] is True
    assert entry["source_excerpt"] == "The blue backpack on the left"

    assert owner_client.post(f"/api/v1/ai/recognitions/{recognition_id}/retry").status_code == 409
    assert (
        owner_client.post(
            f"/api/v1/ai/recognitions/{recognition_id}/apply",
            json={"entries": [{"suggestion_index": 0, "action": "reject"}]},
        ).status_code
        == 409
    )

    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 1


def test_product_url_fetches_in_worker_and_preserves_explicit_purchase_date(
    owner_client, monkeypatch
):
    calls: list[str] = []

    def fake_fetch(url: str) -> ProductPage:
        calls.append(url)
        return ProductPage(
            text="Osprey Kids Jet 18\nDescription: Blue children's hiking backpack",
            title="Osprey Kids Jet 18",
            final_url=url,
        )

    from housetory_api.services import product_import

    monkeypatch.setattr(product_import, "fetch_product_page", fake_fetch)
    created = owner_client.post(
        "/api/v1/imports",
        data={
            "product_url": "https://shop.example/osprey-jet-18",
            "purchase_date": "2026-10-15",
        },
    )
    assert created.status_code == 201, created.text
    batch = created.json()
    assert calls == []
    process_import_batch(batch["id"])
    assert calls == ["https://shop.example/osprey-jet-18"]

    detail = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert detail["status"] == "review"
    assert detail["entries"]
    entry = detail["entries"][0]
    assert entry["proposed"]["purchase"]["purchase_date"] == "2026-10-15"
    assert entry["proposed"]["purchase"]["price_cents"] is None
    assert entry["field_sources"]["purchase_date"] == "explicit"

    applied = owner_client.post(
        f"/api/v1/imports/{batch['id']}/apply",
        json={"entries": [{"id": entry["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    items = owner_client.get("/api/v1/items").json()["items"]
    assert items[0]["purchase"]["purchase_date"] == "2026-10-15"
    assert items[0]["purchase"]["price_cents"] is None


def test_product_url_failure_and_validation_preserve_source(owner_client, monkeypatch):
    invalid = owner_client.post(
        "/api/v1/imports",
        data={"product_url": "file:///etc/passwd"},
    )
    assert invalid.status_code == 422

    from housetory_api.services import product_import

    def fail_fetch(url: str):
        raise ProductPageError("The product page could not be fetched safely.")

    monkeypatch.setattr(product_import, "fetch_product_page", fail_fetch)
    created = owner_client.post(
        "/api/v1/imports",
        data={
            "product_url": "https://shop.example/unavailable",
            "purchase_date": "2026-10-15",
        },
    )
    batch = created.json()
    process_import_batch(batch["id"])
    detail = owner_client.get(f"/api/v1/imports/{batch['id']}").json()
    assert detail["status"] == "failed"
    assert detail["error"] == "The product page could not be fetched safely."
    assert detail["metadata"]["product_url"] == "https://shop.example/unavailable"
    assert detail["metadata"]["purchase_date"] == "2026-10-15"


def test_read_bounded_truncates_only_when_requested():
    import io

    import pytest

    from housetory_api.services.manual_web import ManualFetchError, _read_bounded

    def read(truncate: bool) -> bytes:
        return _read_bounded(
            io.BytesIO(b"x" * 1000),
            max_bytes=100,
            timeout=5,
            error_type=ManualFetchError,
            truncate=truncate,
        )

    assert len(read(True)) == 100
    with pytest.raises(ManualFetchError):
        read(False)


def test_fetch_falls_back_to_next_address_when_first_is_unreachable(monkeypatch):
    from housetory_api.services import manual_web

    monkeypatch.setattr(
        manual_web, "_resolve_public", lambda host, port: ["3.173.190.67", "2600:9000::1"]
    )
    attempts: list[str] = []

    class FakeConnection:
        def __init__(self, host, port, connect_host, **kwargs):
            self.connect_host = connect_host

        def request(self, *args, **kwargs):
            attempts.append(self.connect_host)
            if self.connect_host.startswith("3."):
                raise OSError(101, "Network unreachable")

        def getresponse(self):
            class Response:
                status = 200

                def getheaders(self):
                    return [("content-type", "text/html")]

                def read(self, n=-1):
                    return b""

            return Response()

        def close(self):
            pass

    monkeypatch.setattr(manual_web, "_PinnedHTTPSConnection", FakeConnection)
    status, _, _ = manual_web._request_once(
        "https://shop.example/p", timeout=5, max_bytes=1000, accept="text/html"
    )
    assert status == 200
    assert attempts == ["3.173.190.67", "2600:9000::1"]


PRODUCT_HTML = b"""<html><head>
<title>VS-ELECTRONIC - 420212 l\xc3\xb6dstation, 48 W, justerbar, VTSS4N : Amazon.se: Bygg</title>
<meta name="description" content="Soldering station">
</head><body>
<a id="bylineInfo" href="/s?node=1&amp;field-brandtextbin=Velleman">Varum\xc3\xa4rke: Velleman</a>
<script>{"displayPrice":"305,99 kr","priceAmount":305.99}</script>
</body></html>"""


def test_product_page_fields_become_clean_name_brand_merchant_and_price(monkeypatch):
    from housetory_api.services import product_pages
    from housetory_api.services.product_pages import fetch_product_page, render_product_note

    monkeypatch.setattr(
        product_pages,
        "_request_following_redirects",
        lambda url, **kwargs: (
            200,
            {"content-type": "text/html"},
            PRODUCT_HTML,
            "https://www.amazon.se/dp/B004VDJ72E",
        ),
    )
    page = fetch_product_page("https://www.amazon.se/dp/B004VDJ72E")
    assert page.fields == {
        "name": "VS-ELECTRONIC - 420212 l\u00f6dstation, 48 W, justerbar, VTSS4N",
        "brand": "Velleman",
        "model": "VTSS4N",
        "merchant": "Amazon.se",
        "price": "305.99",
        "currency": "SEK",
    }
    note = render_product_note(page, "2026-11-01")
    assert note.startswith("---\nname: VS-ELECTRONIC")
    assert "purchase_date: 2026-11-01" in note


def test_product_note_imports_with_structured_purchase_fields(owner_client, monkeypatch):
    from housetory_api.services import product_import
    from housetory_api.services.product_pages import ProductPage

    monkeypatch.setattr(
        product_import,
        "fetch_product_page",
        lambda url: ProductPage(
            text="Product page metadata (untrusted source data).",
            title="Soldering station",
            final_url=url,
            fields={
                "name": "Soldering station 48 W",
                "brand": "Velleman",
                "model": "VTSS4N",
                "merchant": "Amazon.se",
                "price": "305.99",
                "currency": "SEK",
            },
        ),
    )
    created = owner_client.post(
        "/api/v1/imports", data={"product_url": "https://www.amazon.se/dp/B004VDJ72E"}
    )
    process_import_batch(created.json()["id"])
    detail = owner_client.get(f"/api/v1/imports/{created.json()['id']}").json()
    proposed = detail["entries"][0]["proposed"]
    assert proposed["name"] == "Soldering station 48 W"
    assert proposed["brand"] == "Velleman"
    assert proposed["model"] == "VTSS4N"
    assert proposed["purchase"]["merchant"] == "Amazon.se"
    assert proposed["purchase"]["price_cents"] == 30599
    assert proposed["purchase"]["currency"] == "SEK"


def test_ai_enhancement_renames_weak_names_but_drops_ungrounded_values(monkeypatch):
    from housetory_api.services.import_pipeline import ai_enrichment

    item = {"serial_number": "ZZZ999", "price_cents": 12345, "currency": "SEK"}
    ai_enrichment._drop_ungrounded(item, "Soldering station, paid 305,99 kr")
    assert item["serial_number"] is None
    assert item["price_cents"] is None and item["currency"] is None

    grounded = {"serial_number": "AB123", "price_cents": 30599, "currency": "SEK"}
    ai_enrichment._drop_ungrounded(grounded, "Serial AB123 paid 305,99 kr")
    assert grounded["serial_number"] == "AB123"
    assert grounded["price_cents"] == 30599
