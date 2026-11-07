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
    Item,
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
    build_product_profile,
    parse_brave_image_results,
    rank_candidates,
    reference_search_ready,
    source_permission,
)


def png_bytes(color=(30, 90, 140), size=(720, 520)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def avif_bytes(color=(90, 50, 140), size=(720, 520)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="AVIF")
    return output.getvalue()


def gif_bytes(color=(140, 90, 30), size=(720, 520)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="GIF")
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


def provider(
    monkeypatch,
    *,
    candidates=None,
    download=None,
    permitted_domains="lg.com",
    permitted_licenses=None,
):
    domains = frozenset(
        domain.strip()
        for domain in permitted_domains.replace(";", ",").split(",")
        if domain.strip()
    )

    def fake_provider(*args, **kwargs):
        return ImageSearchProvider(
            kind="brave",
            label="Brave Image Search API",
            api_key="fixture",
            base_url="https://api.search.brave.com",
            source="household",
            permitted_domains=domains,
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
            lambda candidate, **_kwargs: (
                png_bytes(),
                candidate.image_url,
                "original",
            )
        ),
    )
    settings = get_settings()
    monkeypatch.setattr(
        settings,
        "item_image_permitted_source_domains",
        permitted_domains,
    )
    if permitted_licenses is not None:
        monkeypatch.setattr(settings, "item_image_permitted_licenses", permitted_licenses)
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


def test_category_icon_fallback_and_actual_photo_priority(owner_client):
    room = create_room(owner_client)
    vague = create_item(owner_client, "Mystery object", room["id"])
    state = owner_client.get(f"/api/v1/items/{vague['id']}/image").json()
    assert state["image"] is None
    assert state["selected"] is None
    assert "builtin_options" not in state
    assert "automatic_builtin" not in state
    removed_builtin = owner_client.post(
        f"/api/v1/items/{vague['id']}/image/builtin",
        json={"illustration_key": "generic"},
    )
    assert removed_builtin.status_code == 404
    summary = owner_client.get(f"/api/v1/items/{vague['id']}").json()["item"]
    assert summary["primary_photo"] is None
    assert summary["representative_image"] is None

    tv = create_item(owner_client, "OLED television 77 inch", room["id"])
    automatic = owner_client.get(f"/api/v1/items/{tv['id']}/image").json()
    assert automatic["image"] is None
    assert automatic["selected"] is None

    photo = owner_client.post(
        f"/api/v1/items/{tv['id']}/photos",
        files={"files": ("actual.png", png_bytes(), "image/png")},
    )
    assert photo.status_code == 201, photo.text
    detail = owner_client.get(f"/api/v1/items/{tv['id']}").json()["item"]
    assert detail["primary_photo"] is not None
    assert detail["photos"][0]["url"]
    assert detail["representative_image"] is None
    blocked = owner_client.post(f"/api/v1/items/{tv['id']}/image/find", json={"force": False})
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "actual_photo_exists"


def test_legacy_builtin_rows_are_ignored_without_deleting_them(owner_client):
    room = create_room(owner_client)
    item = create_item(owner_client, "Power drill", room["id"])
    with SessionLocal() as db:
        stored = db.get(Item, uuid.UUID(item["id"]))
        assert stored is not None
        db.add(
            ItemImage(
                household_id=stored.household_id,
                item_id=stored.id,
                source_type="builtin",
                status="active",
                illustration_key="drill",
            )
        )
        db.commit()

    state = owner_client.get(f"/api/v1/items/{item['id']}/image").json()
    assert state["image"] is None
    assert state["selected"] is None
    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["representative_image"] is None
    with SessionLocal() as db:
        legacy = db.scalar(
            select(ItemImage).where(
                ItemImage.item_id == uuid.UUID(item["id"]),
                ItemImage.source_type == "builtin",
            )
        )
        assert legacy is not None
        assert legacy.illustration_key == "drill"


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
    assert "optional source-domain restriction" in state["selected"]["license_note"]
    assert "not a legal determination" in state["selected"]["license_note"]
    assert state["selected"]["permission_basis"] == "configured_source_policy"
    assert state["selected"]["license_name"] is None
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
    assert wrong_state["image"] is None


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
        anon_client.delete(
            f"/api/v1/items/{item['id']}/image",
            headers=viewer,
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


def test_name_only_brand_and_description_attributes_are_query_only(owner_client, monkeypatch):
    room = create_room(owner_client, "Name-only brand room")
    item = create_item(owner_client, "LG TV", room["id"], description="OLED77inch")
    with SessionLocal() as db:
        stored_item = db.get(Item, uuid.UUID(item["id"]))
        assert stored_item is not None
        profile = build_product_profile(stored_item)
        assert profile.brand == "lg"
        assert profile.brand_source == "inferred"
        assert profile.item_type == "tv"
        assert profile.size_constraint == 77
        assert profile.tech_constraint == "oled"
        assert reference_search_ready(stored_item) is True

    provider(
        monkeypatch,
        candidates=[lg_candidate(title="LG OLED TV 77 inch product photo")],
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    selected = response.json()["selected"]
    assert selected["source_type"] == "reference"
    assert selected["exact_model_confirmed"] is False
    assert selected["model_label"] is None
    assert selected["permission_basis"] == "configured_source_policy"
    assert "optional source-domain restriction" in selected["license_note"]
    assert "not a legal determination" in selected["license_note"]

    # Inference is query-only: no brand/model/description facts were written.
    with SessionLocal() as db:
        stored_item = db.get(Item, uuid.UUID(item["id"]))
        assert stored_item is not None
        assert stored_item.brand is None
        assert stored_item.model is None
        assert stored_item.description == "OLED77inch"
        stored_image = db.scalar(select(ItemImage).where(ItemImage.item_id == stored_item.id))
        assert stored_image is not None
        assert stored_image.source_page_url == "https://www.lg.com/us/tvs/oled-tv"
        assert stored_image.permission_basis == "configured_source_policy"


def test_conflicting_size_technology_and_variant_evidence_is_rejected(owner_client):
    room = create_room(owner_client, "Attribute conflict room")
    created = create_item(owner_client, "LG TV", room["id"], description="OLED77inch")
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(created["id"]))
        assert item is not None
        compatible = rank_candidates(item, [lg_candidate(title="LG OLED TV 77 inch product photo")])
        assert compatible
        assert compatible[0].exact_model_confirmed is False

        assert rank_candidates(item, [lg_candidate(title="LG OLED TV 65 inch product photo")]) == []
        assert rank_candidates(item, [lg_candidate(title="LG LCD TV 77 inch product photo")]) == []
        assert rank_candidates(item, [lg_candidate(title="LG LCD TV 65 inch product photo")]) == []

    pro = create_item(owner_client, "LG TV Pro", room["id"], description="OLED77inch")
    with SessionLocal() as db:
        pro_item = db.get(Item, uuid.UUID(pro["id"]))
        assert pro_item is not None
        assert build_product_profile(pro_item).variants == frozenset({"pro"})
        assert (
            rank_candidates(pro_item, [lg_candidate(title="LG OLED TV 77 inch Lite product photo")])
            == []
        )
        assert rank_candidates(
            pro_item, [lg_candidate(title="LG OLED TV 77 inch Pro product photo")]
        )


def test_vague_or_brandless_items_fall_back_without_forcing_a_match(owner_client):
    room = create_room(owner_client, "Vague image room")
    vague = create_item(
        owner_client, "Mystery object", room["id"], description="Something in the cupboard"
    )
    generic = replace(
        lg_candidate(title="Mystery object product photo"),
        page_url="https://www.lg.com/mystery",
        image_url="https://media.lg.com/mystery.png",
    )
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(vague["id"]))
        assert item is not None
        assert build_product_profile(item).brand is None
        assert build_product_profile(item).item_type is None
        assert reference_search_ready(item) is False
        assert rank_candidates(item, [generic]) == []

    television = create_item(owner_client, "Television", room["id"], description="65 inch LCD")
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(television["id"]))
        assert item is not None
        assert build_product_profile(item).item_type == "tv"
        assert build_product_profile(item).brand is None
        assert (
            rank_candidates(
                item,
                [lg_candidate(title="65 inch LCD television product photo")],
            )
            == []
        )

    ambiguous = create_item(owner_client, "LG Samsung TV", room["id"], description="65 inch LCD")
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(ambiguous["id"]))
        assert item is not None
        assert build_product_profile(item).brand_ambiguous is True
        assert (
            rank_candidates(item, [lg_candidate(title="LG 65 inch LCD television product photo")])
            == []
        )


def test_unknown_attributes_are_representative_and_exact_model_has_token_boundaries(
    owner_client,
):
    room = create_room(owner_client, "Exact model room")
    unknown = create_item(owner_client, "LG TV", room["id"], description="OLED 77 inch")
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(unknown["id"]))
        assert item is not None
        ranked = rank_candidates(item, [lg_candidate(title="LG television product photo")])
        assert ranked
        assert ranked[0].exact_model_confirmed is False

    exact = create_item(
        owner_client,
        "LG TV",
        room["id"],
        brand="LG",
        model="A1",
        description="OLED 77 inch",
    )
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(exact["id"]))
        assert item is not None
        ranked = rank_candidates(item, [lg_candidate(title="LG A1 OLED TV 77 inch product photo")])
        assert ranked
        assert ranked[0].exact_model_confirmed is True

        # A10 and A1X are not the exact A1 model; A10 is a contradictory longer
        # model and A1X simply fails the token boundary.
        assert (
            rank_candidates(item, [lg_candidate(title="LG A10 OLED TV 77 inch product photo")])
            == []
        )
        suffix_ranked = rank_candidates(
            item, [lg_candidate(title="LG A1X OLED TV 77 inch product photo")]
        )
        assert suffix_ranked
        assert suffix_ranked[0].exact_model_confirmed is False

        # An extra known variant prevents an exact-model claim when the item's
        # own variant is not established.
        variant_ranked = rank_candidates(
            item, [lg_candidate(title="LG A1 Pro OLED TV 77 inch product photo")]
        )
        assert variant_ranked
        assert variant_ranked[0].exact_model_confirmed is False


def test_manufacturer_provenance_uses_official_registrable_domains(owner_client):
    room = create_room(owner_client, "Provenance room")
    created = create_item(owner_client, "LG TV", room["id"], description="OLED 77 inch")
    with SessionLocal() as db:
        item = db.get(Item, uuid.UUID(created["id"]))
        assert item is not None
        official = rank_candidates(item, [lg_candidate()])
        assert official
        assert official[0].manufacturer_verified is True

        malicious = replace(
            lg_candidate(),
            page_url="https://lg.com.evil.example/tv",
            source_domain="lg.com",
            image_url="https://lg.com.evil.example/tv.png",
        )
        assert rank_candidates(item, [malicious]) == []

        deceptive = replace(
            lg_candidate(),
            page_url="https://lg-deals.example/tv",
            source_domain="lg-deals.example",
            image_url="https://cdn.lg-deals.example/tv.png",
        )
        assert rank_candidates(item, [deceptive]) == []

        retailer = replace(
            lg_candidate(title="LG OLED TV 77 inch retailer listing"),
            page_url="https://shop.example/lg-tv",
            source_domain="shop.example",
            image_url="https://cdn.example/tv.png",
        )
        ranked = rank_candidates(item, [retailer])
        assert ranked
        assert ranked[0].manufacturer_verified is False
        assert source_permission(retailer).kind == "public_web"


def test_downloads_require_permitted_policy_or_license_evidence(owner_client, monkeypatch):
    room = create_room(owner_client, "Permission room")
    item = create_item(owner_client, "LG TV", room["id"], description="OLED 77 inch")
    provider(
        monkeypatch,
        candidates=[lg_candidate()],
        permitted_domains="example.com",
    )
    denied = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert denied.status_code == 422, denied.text
    assert denied.json()["detail"]["code"] == "no_permitted_image_candidate"
    with SessionLocal() as db:
        assert (
            db.scalar(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"]))) is None
        )

    provider(monkeypatch, candidates=[lg_candidate()], permitted_domains="lg.com")
    allowed = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert allowed.status_code == 200, allowed.text
    selected = allowed.json()["selected"]
    assert selected["permission_basis"] == "configured_source_policy"
    assert selected["license_name"] is None
    assert "permission guarantee" in selected["license_note"]

    licensed_item = create_item(
        owner_client,
        "LG TV",
        room["id"],
        description="OLED 77 inch licensed fixture",
    )
    licensed = replace(
        lg_candidate(),
        page_url="https://photos.example.org/lg-tv",
        source_domain="photos.example.org",
        image_url="https://photos.example.org/lg-tv.png",
        license_name="cc-by",
        license_url="https://creativecommons.org/licenses/by/4.0/",
    )
    provider(
        monkeypatch,
        candidates=[licensed],
        permitted_domains="example.com",
    )
    licensed_response = owner_client.post(
        f"/api/v1/items/{licensed_item['id']}/image/find", json={}
    )
    assert licensed_response.status_code == 200, licensed_response.text
    licensed_selected = licensed_response.json()["selected"]
    assert licensed_selected["permission_basis"] == "provider_license"
    assert licensed_selected["license_name"] == "cc-by"
    assert licensed_selected["license_url"] == "https://creativecommons.org/licenses/by/4.0/"
    assert "Provider metadata records the license" in licensed_selected["license_note"]

    unknown_item = create_item(
        owner_client,
        "LG TV",
        room["id"],
        description="OLED 77 inch unknown-rights fixture",
    )
    unknown = replace(
        licensed,
        license_name="all-rights-reserved",
        license_url="https://example.org/terms",
    )
    provider(
        monkeypatch,
        candidates=[unknown],
        permitted_domains="example.com",
    )
    unknown_response = owner_client.post(f"/api/v1/items/{unknown_item['id']}/image/find", json={})
    assert unknown_response.status_code == 422, unknown_response.text
    assert unknown_response.json()["detail"]["code"] == "no_permitted_image_candidate"


def test_public_web_search_selects_one_image_without_a_domain_allowlist(owner_client, monkeypatch):
    room = create_room(owner_client, "Public web room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    first = replace(
        lg_candidate(title="LG OLED TV 77 inch product photo"),
        page_url="https://public-shop.example/lg-oled-77",
        source_domain="public-shop.example",
        image_url="https://cdn.public-shop.example/lg-oled-77.png",
    )
    second = replace(
        lg_candidate(title="LG TV 77 inch accessories listing"),
        page_url="https://other-public.example/lg-tv",
        source_domain="other-public.example",
        image_url="https://cdn.other-public.example/lg-tv.png",
    )
    calls = provider(monkeypatch, candidates=[first, second], permitted_domains="")
    state = owner_client.get(f"/api/v1/items/{item['id']}/image").json()
    assert state["search_configured"] is True
    assert state["search_reason"] is None
    selected = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert selected.status_code == 200, selected.text
    body = selected.json()["selected"]
    assert body["permission_basis"] == "public_web"
    assert body["source_page_url"] == first.page_url
    assert body["license_name"] is None
    assert "public web result" in body["license_note"]
    assert "No license metadata or reuse permission" in body["license_note"]
    assert "not a user photo" in body["license_note"]
    assert calls["count"] == 1
    with SessionLocal() as db:
        rows = list(
            db.scalars(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"]))).all()
        )
        assert len(rows) == 1
        assert rows[0].permission_basis == "public_web"


def test_openrouter_image_adapter_contract_and_output_validation(monkeypatch):
    import base64

    from housetory_api.services import ai
    from housetory_api.services.ai_runtime import AiRuntimeConfig

    config = AiRuntimeConfig(
        provider="openrouter",
        base_url="https://openrouter.ai/api/v1",
        api_key="fixture",
        model="bytedance-seed/seedream-test",
        task="item_images",
        provider_id=None,
        display_name="OpenRouter Images",
        mode="cloud",
        source="database",
        enabled=True,
        cloud_consent=True,
        configured=True,
    )
    image_data = png_bytes()
    captured = {}

    def fake_request(url, payload, **kwargs):
        captured["url"] = url
        captured["payload"] = payload
        captured["headers"] = kwargs.get("headers")
        return {
            "created": 1748372400,
            "data": [
                {
                    "b64_json": base64.b64encode(image_data).decode(),
                    "media_type": "image/png",
                }
            ],
            "usage": {"cost": 0.01},
        }

    monkeypatch.setattr(ai, "_request_json", fake_request)
    assert ai.generate_image("A clean product illustration", config=config) == image_data
    assert str(captured["url"]).endswith("/images")
    assert not str(captured["url"]).endswith("/images/generations")
    assert captured["payload"] == {
        "model": "bytedance-seed/seedream-test",
        "prompt": "A clean product illustration",
    }
    assert captured["headers"]["Authorization"] == "Bearer fixture"
    assert captured["headers"]["X-Title"] == "Housetory"

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda *_args, **_kwargs: {"data": [{"url": "https://example.com/generated.png"}]},
    )
    try:
        ai.generate_image("prompt", config=config)
    except ai.AiInvalidOutput as exc:
        assert "URL-only" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("OpenRouter URL-only output was accepted")

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda *_args, **_kwargs: {
            "data": [
                {
                    "b64_json": base64.b64encode(image_data).decode(),
                    "media_type": "image/svg+xml",
                }
            ]
        },
    )
    try:
        ai.generate_image("prompt", config=config)
    except ai.AiInvalidOutput as exc:
        assert "unsupported image media type" in str(exc).lower()
    else:  # pragma: no cover
        raise AssertionError("SVG output was accepted as an item illustration")

    monkeypatch.setattr(
        ai,
        "_request_json",
        lambda *_args, **_kwargs: {"data": []},
    )
    try:
        ai.generate_image("prompt", config=config)
    except ai.AiInvalidOutput as exc:
        assert "no generated image" in str(exc).lower()
    else:  # pragma: no cover
        raise AssertionError("Empty OpenRouter image output was accepted")

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
        raise AssertionError("Invalid OpenRouter base64 was accepted")


def test_representative_thumbnail_preserves_aspect_without_cropping(upload_root):
    from housetory_api.services import storage

    stored = storage.store_item_image_bytes(
        uuid.uuid4(),
        uuid.uuid4(),
        png_bytes(size=(1200, 400)),
        source_type="reference",
        filename="wide-product.png",
    )
    thumbnail_path = storage.resolve_key(stored.thumbnail_key)
    with Image.open(thumbnail_path) as thumbnail:
        assert thumbnail.size[0] == 640
        assert abs((thumbnail.width / thumbnail.height) - 3.0) < 0.02
    assert (upload_root / stored.storage_key).is_file()


def test_reference_download_rejects_oversized_and_malformed_images(owner_client, monkeypatch):
    room = create_room(owner_client, "Unsafe image room")
    malformed = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    provider(
        monkeypatch,
        candidates=[lg_candidate()],
        permitted_domains="",
        download=lambda candidate, **_kwargs: (
            b"not-an-image",
            candidate.image_url,
            "original",
        ),
    )
    rejected = owner_client.post(f"/api/v1/items/{malformed['id']}/image/find", json={})
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["detail"]["code"] == "image_download_failed"
    assert "invalid or corrupt image" in rejected.json()["detail"]["message"]

    oversized = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    settings = get_settings()
    monkeypatch.setattr(settings, "item_image_max_download_mb", 1)
    provider(
        monkeypatch,
        candidates=[lg_candidate()],
        permitted_domains="",
        download=lambda candidate, **_kwargs: (
            b"x" * (settings.item_image_max_download_bytes + 1),
            candidate.image_url,
            "original",
        ),
    )
    rejected_large = owner_client.post(f"/api/v1/items/{oversized['id']}/image/find", json={})
    assert rejected_large.status_code == 422, rejected_large.text
    assert rejected_large.json()["detail"]["code"] == "image_download_failed"
    assert "size limit" in rejected_large.json()["detail"]["message"]


def test_reference_lookup_is_offline_when_disabled_or_without_a_key(owner_client, monkeypatch):
    from housetory_api.config import get_settings

    room = create_room(owner_client, "Offline image room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    settings = get_settings()
    monkeypatch.setattr(settings, "item_image_search_provider", "none")

    state = owner_client.get(f"/api/v1/items/{item['id']}/image")
    assert state.status_code == 200, state.text
    assert state.json()["search_configured"] is False
    assert state.json()["selected"] is None
    blocked = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert blocked.status_code == 503, blocked.text
    assert blocked.json()["detail"]["code"] == "image_search_unconfigured"
    with SessionLocal() as db:
        assert (
            db.scalar(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"]))) is None
        )


def test_reference_lookup_falls_through_unsupported_candidate_to_valid_image(
    owner_client, monkeypatch
):
    room = create_room(owner_client, "Fallback format room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    gif_candidate = replace(
        lg_candidate(title="LG OLED TV 77 inch animated product image"),
        page_url="https://public-images.example/lg-77-gif",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/lg-77.gif",
    )
    png_candidate = replace(
        lg_candidate(title="LG OLED TV 77 inch product photo"),
        page_url="https://other-public.example/lg-77",
        source_domain="other-public.example",
        image_url="https://cdn.other-public.example/lg-77.png",
    )

    def download(candidate, **_kwargs):
        if candidate.image_url.endswith(".gif"):
            return gif_bytes(), candidate.image_url, "original"
        return png_bytes(), candidate.image_url, "original"

    provider(
        monkeypatch,
        candidates=[gif_candidate, png_candidate],
        permitted_domains="",
        download=download,
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    selected = response.json()["selected"]
    assert selected["source_page_url"] == png_candidate.page_url
    assert selected["permission_basis"] == "public_web"
    with SessionLocal() as db:
        rows = list(
            db.scalars(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"]))).all()
        )
        assert len(rows) == 1
        assert rows[0].source_page_url == png_candidate.page_url
        assert rows[0].content_type in {"image/jpeg", "image/png"}


def test_reference_lookup_accepts_real_avif_and_reencodes_it(owner_client, monkeypatch):
    room = create_room(owner_client, "AVIF room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    avif_candidate = replace(
        lg_candidate(title="LG OLED TV 77 inch AVIF product photo"),
        page_url="https://public-images.example/lg-77-avif",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/lg-77.avif",
    )
    provider(
        monkeypatch,
        candidates=[avif_candidate],
        permitted_domains="",
        download=lambda candidate, **_kwargs: (
            avif_bytes(),
            candidate.image_url,
            "original",
        ),
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    assert response.json()["selected"]["source_page_url"] == avif_candidate.page_url
    with SessionLocal() as db:
        stored = db.scalar(select(ItemImage).where(ItemImage.item_id == uuid.UUID(item["id"])))
        assert stored is not None
        assert stored.content_type in {"image/jpeg", "image/png"}
        assert stored.storage_key is not None and stored.storage_key.endswith((".jpg", ".png"))


def test_reference_lookup_skips_failed_candidates_and_reports_bounded_exhaustion(
    owner_client, monkeypatch
):
    from housetory_api.api.errors import ApiError

    room = create_room(owner_client, "Candidate fallback room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    forbidden = replace(
        lg_candidate(title="LG OLED TV 77 inch forbidden"),
        page_url="https://public-images.example/lg-forbidden",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/forbidden.png",
    )
    html = replace(
        lg_candidate(title="LG OLED TV 77 inch html"),
        page_url="https://public-images.example/lg-html",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/page.html",
    )
    corrupt = replace(
        lg_candidate(title="LG OLED TV 77 inch corrupt"),
        page_url="https://public-images.example/lg-corrupt",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/corrupt.png",
    )
    oversized = replace(
        lg_candidate(title="LG OLED TV 77 inch oversized"),
        page_url="https://public-images.example/lg-large",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/large.png",
    )
    private_redirect = replace(
        lg_candidate(title="LG OLED TV 77 inch private redirect"),
        page_url="https://public-images.example/lg-private",
        source_domain="public-images.example",
        image_url="https://cdn.public-images.example/private.png",
    )
    valid = replace(
        lg_candidate(title="LG OLED TV 77 inch final valid image"),
        page_url="https://other-public.example/lg-valid",
        source_domain="other-public.example",
        image_url="https://cdn.other-public.example/lg-valid.png",
    )
    settings = get_settings()
    monkeypatch.setattr(settings, "item_image_max_download_mb", 1)

    def download(candidate, **_kwargs):
        url = candidate.image_url
        if url.endswith("forbidden.png"):
            raise ApiError(502, "image_download_failed", "Image source returned HTTP 403.")
        if url.endswith("page.html"):
            return b"<html>not an image</html>", url, "original"
        if url.endswith("corrupt.png"):
            return b"not-an-image", url, "original"
        if url.endswith("large.png"):
            return b"x" * (settings.item_image_max_download_bytes + 1), url, "original"
        if url.endswith("private.png"):
            raise ApiError(
                422,
                "image_download_failed",
                "Image source resolves to a private or internal address.",
            )
        return png_bytes(), url, "original"

    provider(
        monkeypatch,
        candidates=[forbidden, html, corrupt, oversized, private_redirect, valid],
        permitted_domains="",
        download=download,
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    assert response.json()["selected"]["source_page_url"] == valid.page_url

    failing_item = create_item(
        owner_client, "LG television 77 inch", room["id"], description="OLED 77 inch"
    )
    provider(
        monkeypatch,
        candidates=[html, corrupt],
        permitted_domains="",
        download=download,
    )
    exhausted = owner_client.post(f"/api/v1/items/{failing_item['id']}/image/find", json={})
    assert exhausted.status_code == 422, exhausted.text
    detail = exhausted.json()["detail"]
    assert detail["code"] == "image_download_failed"
    assert "after trying 2 compatible public candidate" in detail["message"]
    assert "invalid or corrupt image" in detail["message"]
    assert "Item images must be" not in detail["message"]
    with SessionLocal() as db:
        assert (
            db.scalar(select(ItemImage).where(ItemImage.item_id == uuid.UUID(failing_item["id"])))
            is None
        )


def test_ps5_empty_box_alias_prefers_packaging_not_console(owner_client, monkeypatch):
    room = create_room(owner_client, "PS5 box room")
    item = create_item(owner_client, "PS5 empty box", room["id"])
    with SessionLocal() as db:
        stored = db.get(Item, uuid.UUID(item["id"]))
        assert stored is not None
        profile = build_product_profile(stored)
        assert profile.brand == "sony"
        assert profile.brand_source == "inferred"
        assert profile.item_type == "box"
        assert "ps5" in profile.brand_terms
        console = replace(
            lg_candidate(title="Sony PlayStation 5 console product photo"),
            page_url="https://public-shop.example/ps5-console",
            source_domain="public-shop.example",
            image_url="https://cdn.public-shop.example/ps5-console.png",
        )
        box = replace(
            lg_candidate(title="PS5 empty box packaging photo"),
            page_url="https://public-shop.example/ps5-box",
            source_domain="public-shop.example",
            image_url="https://cdn.public-shop.example/ps5-box.png",
        )
        ranked = rank_candidates(stored, [console, box])
        assert ranked
        assert ranked[0].candidate.page_url == box.page_url

    provider(
        monkeypatch,
        candidates=[console, box],
        permitted_domains="",
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 200, response.text
    selected = response.json()["selected"]
    assert selected["source_page_url"] == box.page_url
    assert selected["exact_model_confirmed"] is False


def test_actual_photo_added_during_download_aborts_without_reference_artifact(
    owner_client, monkeypatch
):
    from housetory_api.models import ItemPhoto

    room = create_room(owner_client, "Concurrent photo room")
    item = create_item(owner_client, "LG OLED TV 77 inch", room["id"])
    added = {"done": False}

    def download(candidate, **_kwargs):
        if not added["done"]:
            added["done"] = True
            with SessionLocal() as db:
                db.add(
                    ItemPhoto(
                        item_id=uuid.UUID(item["id"]),
                        storage_key=f"test/actual-{uuid.uuid4().hex}.jpg",
                        original_filename="actual.jpg",
                        content_type="image/jpeg",
                        byte_size=10,
                        width=10,
                        height=10,
                    )
                )
                db.commit()
        return png_bytes(), candidate.image_url, "original"

    provider(
        monkeypatch,
        candidates=[lg_candidate()],
        permitted_domains="",
        download=download,
    )
    response = owner_client.post(f"/api/v1/items/{item['id']}/image/find", json={})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "actual_photo_exists"
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(ItemImage).where(
                    ItemImage.item_id == uuid.UUID(item["id"]),
                    ItemImage.source_type == "reference",
                )
            )
            is None
        )
        stored_item = db.get(Item, uuid.UUID(item["id"]))
        assert stored_item is not None
        image_dir = (
            get_settings().resolved_uploads_dir
            / "households"
            / str(stored_item.household_id)
            / "items"
            / str(stored_item.id)
            / "images"
        )
        assert not image_dir.exists() or not any(image_dir.iterdir())
