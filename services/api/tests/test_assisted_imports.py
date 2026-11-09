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

    assert owner_client.post(
        f"/api/v1/ai/recognitions/{recognition_id}/retry"
    ).status_code == 409
    assert owner_client.post(
        f"/api/v1/ai/recognitions/{recognition_id}/apply",
        json={"entries": [{"suggestion_index": 0, "action": "reject"}]},
    ).status_code == 409

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
    assert detail["metadata"]["product_url"] == "https://shop.example/unavailable"
    assert detail["metadata"]["purchase_date"] == "2026-10-15"
