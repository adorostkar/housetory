import io
import uuid
from dataclasses import replace

from PIL import Image
from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    AiProvider,
    AiTaskSetting,
    Household,
    HouseholdMember,
    ItemImage,
    Job,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import item_image_search
from housetory_api.services.auth import create_session
from housetory_api.services.item_image_generation import run_batch_job, run_new_item_job
from housetory_api.services.item_image_search import (
    ImageCandidate,
    ImageSearchProvider,
    parse_brave_image_results,
    rank_candidates,
)


def png_bytes(color=(30, 90, 140), size=(720, 520)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def create_room(client, name="Workshop"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, **extra):
    response = client.post(
        "/api/v1/items",
        json={"name": name, "room_id": room_id, "quantity": 2, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def provider(monkeypatch, *, candidates=None, download=None):
    def fake_provider():
        return ImageSearchProvider(
            kind="brave",
            label="Brave Image Search API",
            api_key="fixture",
            base_url="https://api.search.brave.com",
        )

    monkeypatch.setattr(item_image_search, "resolve_image_search_provider", fake_provider)
    from housetory_api.services import item_image_generation

    monkeypatch.setattr(item_image_generation, "resolve_image_search_provider", fake_provider)
    search_calls = {"count": 0}

    def fake_results(_provider, _query):
        search_calls["count"] += 1
        return list(candidates or [])

    monkeypatch.setattr(item_image_search, "_brave_image_results", fake_results)
    monkeypatch.setattr(
        item_image_search,
        "_download_candidate",
        download
        or (
            lambda candidate: (
                png_bytes(),
                candidate.image_url,
                "original",
            )
        ),
    )
    return search_calls


def lg_candidate(title="LG OLED TV 77 inch product photo", source="lg.com", exact=False):
    return ImageCandidate(
        title=title,
        page_url="https://www.lg.com/us/tvs/oled-tv",
        source_domain=source,
        image_url="https://media.lg.com/product/oled77.png",
        thumbnail_url="https://imgs.search.brave.com/oled77.jpg",
        width=1600,
        height=900,
    )


def configure_illustration(household_id, monkeypatch):
    with SessionLocal() as db:
        provider_record = AiProvider(
            household_id=household_id,
            provider="openai",
            display_name="Fixture Images",
            base_url="https://api.openai.com/v1",
            default_model="gpt-image-1",
            cloud_consent=True,
        )
        db.add(provider_record)
        db.flush()
        db.add(
            AiTaskSetting(
                household_id=household_id,
                task="item_images",
                provider_id=provider_record.id,
                model="gpt-image-1",
                enabled=True,
            )
        )
        db.commit()
    captured = {}

    def fake_generate(prompt, *, config, size="1024x1024"):
        captured["prompt"] = prompt
        captured["provider_id"] = config.provider_id
        return png_bytes((120, 40, 60))

    from housetory_api.services import item_image_generation

    monkeypatch.setattr(item_image_generation.ai, "generate_image", fake_generate)
    return captured


def viewer_headers(owner_client, email="image-viewer@example.com"):
    state = owner_client.get("/api/v1/auth/session").json()
    with SessionLocal() as db:
        user = User(
            name="Image Viewer",
            email=email,
            password_hash=hash_password("image-viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=uuid.UUID(state["household"]["id"]),
                user_id=user.id,
                role="viewer",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="image-test",
            ip_address="127.0.0.1",
            household_id=uuid.UUID(state["household"]["id"]),
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def other_household_headers(email="other-images@example.com"):
    with SessionLocal() as db:
        user = User(
            name="Other Images",
            email=email,
            password_hash=hash_password("other-images-password-2026"),
        )
        household = Household(name="Other image home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(household_id=household.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="image-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def test_builtin_library_override_remove_and_actual_photo_priority(owner_client):
    room = create_room(owner_client)
    vague = create_item(owner_client, "Mystery object", room["id"])
    state = owner_client.get(f"/api/v1/items/{vague['id']}/image").json()
    assert state["image"] is None
    assert len(state["builtin_options"]) >= 10

    chosen = owner_client.post(
        f"/api/v1/items/{vague['id']}/image/builtin",
        json={"illustration_key": "generic"},
    )
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["selected"]["source_type"] == "builtin"
    assert chosen.json()["selected"]["illustration_key"] == "generic"
    summary = owner_client.get(f"/api/v1/items/{vague['id']}").json()["item"]
    assert summary["primary_photo"] is None
    assert summary["representative_image"]["illustration_key"] == "generic"

    removed = owner_client.delete(f"/api/v1/items/{vague['id']}/image")
    assert removed.status_code == 200
    assert removed.json()["selected"] is None
    assert removed.json()["image"] is None

    tv = create_item(owner_client, "OLED television 77 inch", room["id"])
    automatic = owner_client.get(f"/api/v1/items/{tv['id']}/image").json()
    assert automatic["automatic_builtin"]["illustration_key"] == "tv"
    assert automatic["image"]["automatic"] is True

    photo = owner_client.post(
        f"/api/v1/items/{tv['id']}/photos",
        files={"files": ("actual.png", png_bytes(), "image/png")},
    )
    assert photo.status_code == 201, photo.text
    detail = owner_client.get(f"/api/v1/items/{tv['id']}").json()["item"]
    assert detail["primary_photo"] is not None
    assert detail["photos"][0]["url"]
    assert detail["representative_image"]["source_type"] == "builtin"
    blocked = owner_client.post(f"/api/v1/items/{tv['id']}/image/find", json={"force": False})
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "actual_photo_exists"


def test_brave_image_contract_ranking_conflicts_and_representative_selection(
    owner_client, monkeypatch
):
    payload = {
        "results": [
            {
                "title": "LG OLED TV 77 inch official",
                "url": "https://www.lg.com/us/tvs/oled",
                "source": "lg.com",
                "thumbnail": {"src": "https://imgs.search.brave.com/a", "width": 500},
                "properties": {
                    "url": "https://media.lg.com/oled.png",
                    "width": 1600,
                    "height": 900,
                },
            }
        ]
    }
    parsed = parse_brave_image_results(payload)
    assert parsed[0].page_url == "https://www.lg.com/us/tvs/oled"
    assert parsed[0].image_url == "https://media.lg.com/oled.png"
    assert parsed[0].width == 1600

    room = create_room(owner_client)
    item = create_item(
        owner_client,
        "LG OLED TV 77 inch",
        room["id"],
        brand="LG",
        description="OLED television, 77-inch, thin bezel",
    )
    search_calls = provider(monkeypatch, candidates=[lg_candidate()])
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["selected"]["source_type"] == "reference"
    assert state["selected"]["label"] == "Reference image"
    assert state["selected"]["exact_model_confirmed"] is False
    assert state["selected"]["source_page_url"] == "https://www.lg.com/us/tvs/oled-tv"
    assert "licensing rights are not independently verified" in state["selected"]["license_note"]
    assert search_calls["count"] == 1

    # A second identical item reuses the household reference instead of calling
    # the external search again.
    duplicate = create_item(
        owner_client,
        "LG OLED TV 77 inch",
        room["id"],
        brand="LG",
        description="OLED television, 77-inch, thin bezel",
    )
    second = owner_client.post(f"/api/v1/items/{duplicate['id']}/image/find", json={})
    assert second.status_code == 200, second.text
    assert search_calls["count"] == 1

    # Contradictory brand candidates are rejected and the built-in remains.
    wrong = create_item(owner_client, "LG OLED TV 77 inch", room["id"], brand="LG")
    provider(
        monkeypatch,
        candidates=[
            replace(
                lg_candidate(
                    title="Samsung 77 inch television product photo",
                    source="samsung.com",
                ),
                page_url="https://www.samsung.com/tv",
                image_url="https://images.samsung.com/tv.png",
            )
        ],
    )
    rejected = owner_client.post(f"/api/v1/items/{wrong['id']}/image/find", json={})
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "no_image_candidate"
    wrong_state = owner_client.get(f"/api/v1/items/{wrong['id']}/image").json()
    assert wrong_state["selected"] is None
    assert wrong_state["automatic_builtin"]["illustration_key"] == "tv"


def test_reference_is_excluded_from_evidence_and_does_not_mutate_stock(owner_client, monkeypatch):
    room = create_room(owner_client)
    item = create_item(
        owner_client,
        "LG OLED TV 77 inch",
        room["id"],
        brand="LG",
        description="OLED television 77 inch",
    )
    provider(monkeypatch, candidates=[lg_candidate()])
    assert owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={}).status_code == 200

    preview = owner_client.post(
        "/api/v1/evidence-exports/preview",
        json={"scope": {"item_ids": [item["id"]]}, "options": {"include_photos": True}},
    )
    assert preview.status_code == 200, preview.text
    preview_item = preview.json()["items"][0]
    assert preview_item["photo_count"] == 0

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["quantity"] == 2
    assert detail["photos"] == []
    assert detail["representative_image"]["source_type"] == "reference"

    started = owner_client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": [room["id"]],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert started.status_code == 201, started.text
    session = owner_client.get(f"/api/v1/stocktake/sessions/{started.json()['id']}").json()
    assert session["items"][0]["item_id"] == item["id"]
    assert "representative" not in str(session["items"][0]).lower()


def test_manual_ai_illustration_preview_accept_reject_and_cap(owner_client, monkeypatch):
    room = create_room(owner_client)
    item = create_item(
        owner_client,
        "Oak reading chair",
        room["id"],
        description="Oak frame, pale fabric, reading chair for the study",
    )
    state = owner_client.get(f"/api/v1/items/{item['id']}/image").json()
    assert state["generation_configured"] is False
    unconfigured = owner_client.post(f"/api/v1/items/{item['id']}/illustration")
    assert unconfigured.status_code == 503
    assert unconfigured.json()["detail"]["code"] == "illustration_generation_unconfigured"

    captured = configure_illustration(
        uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"]),
        monkeypatch,
    )
    generated = owner_client.post(f"/api/v1/items/{item['id']}/illustration")
    assert generated.status_code == 200, generated.text
    pending = generated.json()["pending"]
    assert len(pending) == 1
    assert pending[0]["source_type"] == "ai"
    assert pending[0]["label"] == "AI illustration"
    assert "Oak reading chair" in captured["prompt"]
    assert "borrower" not in captured["prompt"].lower()

    accepted = owner_client.post(f"/api/v1/items/{item['id']}/images/{pending[0]['id']}/accept")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["selected"]["source_type"] == "ai"
    assert accepted.json()["selected"]["exact_model_confirmed"] is False
    assert accepted.json()["pending"] == []

    # Hard cap is checked against stored AI images for the household day.
    owner_client.patch("/api/v1/household", json={"item_image_daily_generation_cap": 1})
    second = owner_client.post(f"/api/v1/items/{item['id']}/illustration")
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "illustration_generation_cap"

    # Remove the active AI image; actual photos are unaffected.
    removed = owner_client.delete(f"/api/v1/items/{item['id']}/image")
    assert removed.status_code == 200
    assert removed.json()["selected"] is None


def test_auto_new_item_reference_job_and_batch_cancel(owner_client, monkeypatch):
    owner_client.patch(
        "/api/v1/household",
        json={"item_image_auto_reference": True, "item_image_auto_generate": False},
    )
    room = create_room(owner_client)
    item = create_item(
        owner_client,
        "LG OLED TV 77 inch",
        room["id"],
        brand="LG",
        description="OLED television 77 inch with slim bezel",
    )
    with SessionLocal() as db:
        job = db.scalar(
            select(Job).where(
                Job.task == "item_images.new_item",
                Job.payload["item_id"].astext == item["id"],
            )
        )
        assert job is not None
        payload = dict(job.payload)

    provider(monkeypatch, candidates=[lg_candidate()])
    assert run_new_item_job(payload)["status"] == "reference"
    state = owner_client.get(f"/api/v1/items/{item['id']}/image").json()
    assert state["selected"]["source_type"] == "reference"

    # Batch preview accounts for existing photos and the household cap.
    other = create_item(owner_client, "LG OLED television second", room["id"], brand="LG")
    preview = owner_client.post(
        "/api/v1/items/images/batch/preview",
        json={"item_ids": [item["id"], other["id"]], "action": "reference"},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["eligible_count"] >= 1

    request_id = str(uuid.uuid4())
    created = owner_client.post(
        "/api/v1/items/images/batch",
        json={
            "item_ids": [item["id"], other["id"]],
            "action": "reference",
            "request_id": request_id,
        },
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]
    replay = owner_client.post(
        "/api/v1/items/images/batch",
        json={
            "item_ids": [item["id"], other["id"]],
            "action": "reference",
            "request_id": request_id,
        },
    )
    assert replay.status_code == 202
    assert replay.json()["job_id"] == job_id

    cancelled = owner_client.post(f"/api/v1/items/images/batch/{job_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    with SessionLocal() as db:
        job = db.get(Job, uuid.UUID(job_id))
        assert job is not None
        result = run_batch_job(job.payload, job.id)
    assert result["completed"] == 0


def test_image_permissions_household_isolation_and_viewer_read_only(owner_client, anon_client):
    room = create_room(owner_client)
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"], brand="LG")
    viewer = viewer_headers(owner_client)
    other = other_household_headers()

    assert anon_client.get(f"/api/v1/items/{item['id']}/image", headers=viewer).status_code == 200
    assert (
        anon_client.post(
            f"/api/v1/items/{item['id']}/image/builtin",
            headers=viewer,
            json={"illustration_key": "tv"},
        ).status_code
        == 403
    )
    assert anon_client.get(f"/api/v1/items/{item['id']}/image", headers=other).status_code == 404
    assert (
        anon_client.post(
            f"/api/v1/items/{item['id']}/image/find",
            headers=other,
            json={},
        ).status_code
        == 404
    )
    with SessionLocal() as db:
        stored = db.scalar(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"])))
        assert stored is None


def test_brave_image_ranker_rejects_missing_brand_and_stock_hosts(owner_client):
    from housetory_api.models import Item

    room = create_room(owner_client)
    created = create_item(owner_client, "65 inch OLED television", room["id"])
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(created["id"]))
        assert item is not None
        assert rank_candidates(item, [lg_candidate()]) == []

    branded_created = create_item(owner_client, "LG OLED TV", room["id"], brand="LG")
    with SessionLocal() as db:
        branded = db.get(Item, uuid.UUID(branded_created["id"]))
        assert branded is not None
    stock = ImageCandidate(
        title="LG OLED TV stock photo",
        page_url="https://www.shutterstock.com/image/lg",
        source_domain="shutterstock.com",
        image_url="https://www.shutterstock.com/image.jpg",
        thumbnail_url=None,
        width=1200,
        height=800,
    )
    assert rank_candidates(branded, [stock]) == []


def test_openai_image_adapter_contract_and_invalid_outputs(monkeypatch):
    from housetory_api.services import ai
    from housetory_api.services.ai_runtime import AiRuntimeConfig

    config = AiRuntimeConfig(
        provider="openai",
        base_url="https://api.openai.com/v1",
        api_key="fixture",
        model="gpt-image-1",
        task="item_images",
        provider_id=None,
        display_name="OpenAI Images",
        mode="cloud",
        source="database",
        enabled=True,
        cloud_consent=True,
        configured=True,
    )
    captured = {}
    image_data = png_bytes()

    def fake_request(url, payload, **kwargs):
        captured["url"] = url
        captured["payload"] = payload
        import base64

        return {"data": [{"b64_json": base64.b64encode(image_data).decode()}]}

    monkeypatch.setattr(ai, "_request_json", fake_request)
    assert ai.generate_image("A clean product illustration", config=config) == image_data
    assert captured["url"].endswith("/images/generations")
    assert captured["payload"]["model"] == "gpt-image-1"
    assert captured["payload"]["n"] == 1

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda *_args, **_kwargs: {"data": [{"url": "https://example.com/image.png"}]},
    )
    try:
        ai.generate_image("prompt", config=config)
    except ai.AiInvalidOutput as exc:
        assert "URL-only" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("URL-only image response was accepted")

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda *_args, **_kwargs: {"data": [{"b64_json": "not-base64!"}]},
    )
    try:
        ai.generate_image("prompt", config=config)
    except ai.AiInvalidOutput as exc:
        assert "invalid base64" in str(exc).lower()
    else:  # pragma: no cover
        raise AssertionError("Invalid base64 image was accepted")

    non_openai = replace(config, provider="gemini")
    try:
        ai.generate_image("prompt", config=non_openai)
    except ai.AiUnavailable as exc:
        assert "OpenAI Images" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Unsupported image provider was accepted")


def test_image_download_rejects_private_or_nonimage_responses(monkeypatch):
    from housetory_api.services import item_image_search
    from housetory_api.services.manual_web import ManualFetchError

    candidate = lg_candidate()

    def private(_url, **_kwargs):
        raise ManualFetchError("private address")

    monkeypatch.setattr(item_image_search, "_request_following_redirects", private)
    try:
        item_image_search._download_candidate(candidate)
    except Exception as exc:  # ApiError is imported from the API layer
        assert getattr(exc, "code", None) == "image_download_failed"
    else:  # pragma: no cover
        raise AssertionError("Private image URL was accepted")

    monkeypatch.setattr(
        item_image_search,
        "_request_following_redirects",
        lambda *_args, **_kwargs: (
            200,
            {"content-type": "text/html"},
            b"<html>not an image</html>",
            "https://media.lg.com/not-image",
        ),
    )
    try:
        item_image_search._download_candidate(candidate)
    except Exception as exc:
        assert getattr(exc, "code", None) == "image_download_failed"
    else:  # pragma: no cover
        raise AssertionError("Non-image response was accepted")
