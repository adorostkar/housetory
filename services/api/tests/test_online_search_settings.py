import io
import uuid

from PIL import Image
from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    HouseholdMember,
    HouseholdOnlineSearchSettings,
    Job,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import item_image_search, manual_web
from housetory_api.services.ai_credentials import decrypt_secret, generate_key
from housetory_api.services.auth import create_session
from housetory_api.services.item_image_generation import run_new_item_job
from housetory_api.services.item_image_search import ImageCandidate

SETTINGS_URL = "/api/v1/settings/online-search"
TEST_URL = "/api/v1/settings/online-search/test"
HOUSEHOLD_SETTINGS = "Household Settings"


def _household_id(client) -> uuid.UUID:
    state = client.get("/api/v1/auth/session").json()
    return uuid.UUID(state["household"]["id"])


def _add_member(client, role: str, email: str = "search-settings-member@example.com") -> str:
    household_id = _household_id(client)
    with SessionLocal() as db:
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password("member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household_id,
                user_id=user.id,
                role=role,
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="online-search-settings-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
        return token


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def _create_room(client, name: str = "Workshop") -> dict:
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _create_item(client, name: str, room_id: str, **extra) -> dict:
    response = client.post(
        "/api/v1/items",
        json={"name": name, "room_id": room_id, "quantity": 1, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def _save(
    client,
    *,
    key: str | None = None,
    manual: bool = False,
    reference: bool = False,
    domains: list[str] | None = None,
    clear_key: bool = False,
    headers: dict[str, str] | None = None,
) -> dict:
    payload: dict = {
        "manual_enabled": manual,
        "reference_enabled": reference,
    }
    if key is not None:
        payload["api_key"] = key
    if domains is not None:
        payload["permitted_source_domains"] = domains
    if clear_key:
        payload["clear_api_key"] = True
    response = client.put(SETTINGS_URL, json=payload, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (320, 180), (40, 90, 150)).save(output, format="PNG")
    return output.getvalue()


def _lg_candidate() -> ImageCandidate:
    return ImageCandidate(
        title="LG OLED TV 77 inch product photo",
        page_url="https://www.lg.com/us/tvs/oled-tv",
        source_domain="lg.com",
        image_url="https://media.lg.com/product/oled77.png",
        thumbnail_url="https://imgs.search.brave.com/oled77.jpg",
        width=1600,
        height=900,
    )


def test_online_search_settings_are_owner_only_and_household_scoped(owner_client):
    first_household = _household_id(owner_client)
    saved = _save(owner_client, key="brave-household-one-key", manual=True)
    assert saved["has_api_key"] is True
    assert saved["credential_source"] == "household"

    member = _add_member(owner_client, "member")
    viewer = _add_member(owner_client, "viewer", email="search-viewer@example.com")
    for token in (member, viewer):
        denied_get = owner_client.get(SETTINGS_URL, headers=_headers(token))
        assert denied_get.status_code == 403
        assert denied_get.json()["detail"]["code"] == "owner_required"
        denied_put = owner_client.put(
            SETTINGS_URL,
            json={"manual_enabled": True},
            headers=_headers(token),
        )
        assert denied_put.status_code == 403
        denied_test = owner_client.post(
            TEST_URL,
            json={"confirm": False},
            headers=_headers(token),
        )
        assert denied_test.status_code == 403

    created = owner_client.post(
        "/api/v1/households",
        json={"name": "Second Home", "property_name": "Flat"},
    )
    assert created.status_code == 201, created.text
    state = created.json()
    second_household = uuid.UUID(state["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}

    isolated = owner_client.get(SETTINGS_URL).json()
    assert isolated["has_api_key"] is False
    assert isolated["manual_enabled"] is False
    assert isolated["credential_source"] == "none"
    assert "brave-household-one-key" not in str(isolated)

    _save(
        owner_client,
        key="brave-household-two-key",
        manual=True,
        headers=second_headers,
    )
    with SessionLocal() as db:
        first_row = db.get(HouseholdOnlineSearchSettings, first_household)
        second_row = db.get(HouseholdOnlineSearchSettings, second_household)
        assert first_row is not None and second_row is not None
        assert decrypt_secret(first_row.encrypted_api_key) == "brave-household-one-key"
        assert decrypt_secret(second_row.encrypted_api_key) == "brave-household-two-key"

    selected = owner_client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200, selected.text
    first = owner_client.get(SETTINGS_URL)
    assert first.status_code == 200
    assert first.json()["has_api_key"] is True
    assert "brave-household-two-key" not in first.text


def test_write_only_key_lifecycle_and_household_authority(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "")
    monkeypatch.setattr(settings, "manual_search_url", "")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "")

    initial = owner_client.get(SETTINGS_URL)
    assert initial.status_code == 200, initial.text
    body = initial.json()
    assert body["has_api_key"] is False
    assert body["credential_source"] == "none"
    assert body["manual"]["configured"] is False
    assert body["reference"]["configured"] is False

    refused = owner_client.put(
        SETTINGS_URL,
        json={"manual_enabled": True},
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "online_search_key_required"

    saved = _save(owner_client, key="brave-secret-one", manual=True)
    assert saved["has_api_key"] is True
    assert saved["api_key_version"] == 1
    assert "brave-secret-one" not in str(saved)

    kept = _save(owner_client, manual=True)
    assert kept["has_api_key"] is True
    assert kept["api_key_version"] == 1

    blank = owner_client.put(
        SETTINGS_URL,
        json={"manual_enabled": True, "api_key": "   "},
    )
    assert blank.status_code == 200, blank.text
    assert blank.json()["has_api_key"] is True
    assert blank.json()["api_key_version"] == 1

    replaced = _save(owner_client, key="brave-secret-two", manual=True)
    assert replaced["api_key_version"] == 2
    assert "brave-secret-two" not in str(replaced)

    household_id = _household_id(owner_client)
    with SessionLocal() as db:
        row = db.get(HouseholdOnlineSearchSettings, household_id)
        assert row is not None
        assert decrypt_secret(row.encrypted_api_key) == "brave-secret-two"
        assert row.encrypted_api_key != "brave-secret-two"
        assert "brave-secret-two" not in (row.encrypted_api_key or "")

    still_enabled = owner_client.put(
        SETTINGS_URL,
        json={"manual_enabled": True, "clear_api_key": True},
    )
    assert still_enabled.status_code == 422
    assert still_enabled.json()["detail"]["code"] == "online_search_disable_required"

    monkeypatch.setattr(settings, "brave_search_api_key", "environment-fallback-key")
    monkeypatch.setattr(settings, "manual_search_provider", "auto")
    removed = _save(owner_client, clear_key=True)
    assert removed["has_api_key"] is False
    assert removed["api_key_version"] == 3
    assert removed["credential_source"] == "household"
    assert removed["environment_api_key_available"] is True
    assert removed["manual"]["source"] == "household"
    assert removed["manual"]["configured"] is False
    assert removed["reference"]["source"] == "household"

    with SessionLocal() as db:
        row = db.get(HouseholdOnlineSearchSettings, household_id)
        assert row is not None and row.encrypted_api_key is None
        manual = manual_web.resolve_search_provider(db, household_id)
        image = item_image_search.resolve_image_search_provider(db, household_id)
        assert manual.kind == "none"
        assert manual.source == "household"
        assert image.kind == "none"
        assert image.source == "household"


def test_environment_fallback_is_used_only_without_a_household_row(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "environment-brave-key")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "lg.com")
    monkeypatch.setattr(settings, "manual_search_url", "")
    monkeypatch.setattr(settings, "manual_search_provider", "auto")
    monkeypatch.setattr(settings, "item_image_search_provider", "auto")

    fallback = owner_client.get(SETTINGS_URL).json()
    assert fallback["credential_source"] == "environment"
    assert fallback["manual"]["source"] == "environment"
    assert fallback["manual"]["configured"] is True
    assert fallback["reference"]["source"] == "environment"
    assert fallback["reference"]["configured"] is True
    assert fallback["reference"]["policy_configured"] is True
    assert fallback["environment_api_key_available"] is True

    household_id = _household_id(owner_client)
    with SessionLocal() as db:
        assert manual_web.resolve_search_provider(db, household_id).kind == "brave"
        assert item_image_search.resolve_image_search_provider(db, household_id).kind == "brave"

    suppressed = _save(owner_client, manual=False, reference=False)
    assert suppressed["credential_source"] == "household"
    assert suppressed["manual"]["source"] == "household"
    assert suppressed["manual"]["configured"] is False
    assert suppressed["reference"]["source"] == "household"
    assert suppressed["reference"]["configured"] is False
    assert suppressed["environment_manual_available"] is True
    assert suppressed["environment_reference_available"] is True

    with SessionLocal() as db:
        manual = manual_web.resolve_search_provider(db, household_id)
        image = item_image_search.resolve_image_search_provider(db, household_id)
        assert manual.kind == "none" and manual.source == "household"
        assert image.kind == "none" and image.source == "household"
        assert "disabled in Settings" in (manual.reason or "")
        assert "disabled in Settings" in (image.reason or "")


def test_permitted_domains_and_reference_prerequisites(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "")

    key_only = _save(owner_client, key="brave-domain-key", manual=False)
    assert key_only["permitted_source_domains"] == []
    no_domains = owner_client.put(
        SETTINGS_URL,
        json={"reference_enabled": True},
    )
    assert no_domains.status_code == 422
    assert no_domains.json()["detail"]["code"] == "online_search_domains_required"

    invalid_values = [
        "https://example.com/path",
        "*.example.com",
        "127.0.0.1",
        "localhost",
        "example.com:443",
        "user@example.com",
        "co.uk",
        "github.io",
    ]
    for value in invalid_values:
        response = owner_client.put(
            SETTINGS_URL,
            json={"permitted_source_domains": [value]},
        )
        assert response.status_code == 422, (value, response.text)
        assert response.json()["detail"]["code"] == "invalid_permitted_domains"

    normalized = owner_client.put(
        SETTINGS_URL,
        json={
            "reference_enabled": True,
            "permitted_source_domains": [
                "shop.example.co.uk",
                "example.com",
                "Sub.Example.com",
                "other.co.uk",
                "example.com.",
                "tenant.github.io",
            ],
        },
    )
    assert normalized.status_code == 200, normalized.text
    body = normalized.json()
    assert body["permitted_source_domains"] == [
        "example.co.uk",
        "example.com",
        "other.co.uk",
        "tenant.github.io",
    ]
    assert body["reference"]["configured"] is True
    assert body["reference"]["policy_configured"] is True
    assert body["reference"]["source"] == "household"

    household_id = _household_id(owner_client)
    with SessionLocal() as db:
        image = item_image_search.resolve_image_search_provider(db, household_id)
        assert image.kind == "brave"
        assert image.permitted_domains == frozenset(
            {
                "example.co.uk",
                "example.com",
                "other.co.uk",
                "tenant.github.io",
            }
        )
        assert item_image_search.permitted_source_policy_configured(image) is True


def test_shared_brave_credential_and_worker_pick_up_changes_immediately(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "")

    owner_client.patch(
        "/api/v1/household",
        json={"item_image_auto_reference": True, "item_image_auto_generate": False},
    )
    room = _create_room(owner_client, "Worker room")
    item = _create_item(
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

    with SessionLocal() as db:
        household_id = uuid.UUID(payload["household_id"])
        assert manual_web.resolve_search_provider(db, household_id).kind == "none"
        assert item_image_search.resolve_image_search_provider(db, household_id).kind == "none"

    disabled = _save(
        owner_client,
        key="brave-shared-key",
        manual=False,
        reference=False,
        domains=["lg.com"],
    )
    assert disabled["has_api_key"] is True

    with SessionLocal() as db:
        household_id = uuid.UUID(payload["household_id"])
        manual = manual_web.resolve_search_provider(db, household_id)
        image = item_image_search.resolve_image_search_provider(db, household_id)
        assert manual.kind == "none" and manual.source == "household"
        assert image.kind == "none" and image.source == "household"

    assert run_new_item_job(payload) == {"status": "skipped"}

    enabled = _save(
        owner_client,
        manual=True,
        reference=True,
        domains=["lg.com"],
    )
    assert enabled["manual"]["configured"] is True
    assert enabled["reference"]["configured"] is True

    with SessionLocal() as db:
        household_id = uuid.UUID(payload["household_id"])
        manual = manual_web.resolve_search_provider(db, household_id)
        image = item_image_search.resolve_image_search_provider(db, household_id)
        assert manual.kind == "brave"
        assert image.kind == "brave"
        assert manual.brave_api_key == "brave-shared-key"
        assert image.api_key == "brave-shared-key"
        assert manual.source == image.source == "household"
        assert image.permitted_domains == frozenset({"lg.com"})

    monkeypatch.setattr(
        item_image_search,
        "_brave_image_results",
        lambda provider, query: [_lg_candidate()],
    )
    monkeypatch.setattr(
        item_image_search,
        "_download_candidate",
        lambda candidate, **kwargs: (
            _png_bytes(),
            candidate.image_url,
            "image",
        ),
    )
    assert run_new_item_job(payload) == {"status": "reference"}
    state = owner_client.get(f"/api/v1/items/{item['id']}/image")
    assert state.status_code == 200, state.text
    selected = state.json()["selected"]
    assert selected is not None
    assert selected["source_type"] == "reference"
    assert selected["source_page_url"] == "https://www.lg.com/us/tvs/oled-tv"


def test_manual_discovery_uses_the_household_brave_key_and_never_the_fallback(
    owner_client, monkeypatch
):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "environment-must-not-be-used")
    monkeypatch.setattr(settings, "manual_search_provider", "auto")
    monkeypatch.setattr(settings, "manual_search_url", "")
    _save(owner_client, key="brave-manual-household-key", manual=True)

    response = owner_client.post(
        "/api/v1/items",
        json={"name": "Cordless drill", "brand": "DeWalt", "model": "DCD791"},
    )
    assert response.status_code == 201, response.text
    item = response.json()["item"]
    profile = owner_client.put(
        f"/api/v1/items/{item['id']}/manual-profile",
        json={
            "manufacturer": "DeWalt",
            "model_identifier": "DCD791",
            "variant": "B",
            "confirmed": True,
        },
    )
    assert profile.status_code == 200, profile.text

    captured: list[manual_web.SearchProviderConfig] = []

    def fake_brave(provider, query, count):
        captured.append(provider)
        assert "DCD791" in query
        return [
            {
                "title": "DeWalt DCD791B cordless drill instruction manual",
                "url": "https://www.dewalt.com/support/DCD791B.pdf",
                "description": "Official DCD791B instruction manual.",
                "profile": {"name": "DeWalt", "long_name": "DeWalt"},
                "language": "en",
            }
        ]

    monkeypatch.setattr(manual_web, "_brave_search_results", fake_brave)
    searched = owner_client.post(f"/api/v1/items/{item['id']}/manual-search")
    assert searched.status_code == 200, searched.text
    assert searched.json()["candidates"][0]["title"].startswith("DeWalt DCD791B")
    assert captured
    assert captured[0].kind == "brave"
    assert captured[0].source == "household"
    assert captured[0].brave_api_key == "brave-manual-household-key"
    assert captured[0].brave_api_key != "environment-must-not-be-used"


def test_bounded_connection_test_is_confirmed_neutral_and_mocked(owner_client, monkeypatch):
    _save(
        owner_client,
        key="brave-connection-key",
        manual=True,
        reference=True,
        domains=["lg.com"],
    )
    calls: list[tuple[str, str]] = []

    def fake_manual(provider, query, count):
        calls.append(("manual", query))
        assert count == 1
        return []

    def fake_image(provider, query):
        calls.append(("reference", query))
        return []

    monkeypatch.setattr(manual_web, "_brave_search_results", fake_manual)
    monkeypatch.setattr(item_image_search, "_brave_image_results", fake_image)

    unconfirmed = owner_client.post(TEST_URL, json={"confirm": False})
    assert unconfirmed.status_code == 422
    assert unconfirmed.json()["detail"]["code"] == "online_search_test_confirmation_required"
    assert calls == []

    result = owner_client.post(TEST_URL, json={"confirm": True})
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["ok"] is True
    assert body["manual_ok"] is True
    assert body["reference_ok"] is True
    assert body["source"] == "household"
    assert calls == [
        ("manual", "Housetory connectivity test"),
        ("reference", "Housetory connectivity test"),
    ]
    serialized = str(body).lower()
    for forbidden in ("lg oled", "workshop", "brave-connection-key", "borrower"):
        assert forbidden not in serialized

    def failing_manual(provider, query, count):
        raise manual_web.ManualSearchUnavailable("Brave rejected the credential.")

    monkeypatch.setattr(manual_web, "_brave_search_results", failing_manual)
    failed = owner_client.post(TEST_URL, json={"confirm": True})
    assert failed.status_code == 200, failed.text
    failure = failed.json()
    assert failure["ok"] is False
    assert failure["manual_ok"] is False
    assert failure["reference_ok"] is True
    assert "Brave rejected the credential." in failure["message"]


def test_system_status_reports_source_settings_path_and_fail_closed(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "brave_search_api_key", "")
    monkeypatch.setattr(settings, "item_image_permitted_source_domains", "")

    _save(
        owner_client,
        key="brave-status-key",
        manual=True,
        reference=True,
        domains=["lg.com"],
    )
    status = owner_client.get("/api/v1/system/status")
    assert status.status_code == 200, status.text
    services = {entry["name"]: entry for entry in status.json()["external_services"]}
    manual = services["Online manual search"]
    reference = services["Reference-image search"]
    assert manual["configured"] is True
    assert manual["source"] == "household"
    assert manual["settings_path"] == "/settings#online-search"
    assert HOUSEHOLD_SETTINGS in manual["detail"]
    assert reference["configured"] is True
    assert reference["source"] == "household"
    assert reference["settings_path"] == "/settings#online-search"
    assert HOUSEHOLD_SETTINGS in reference["detail"]

    _save(owner_client, manual=False, reference=False, domains=["lg.com"])
    disabled = owner_client.get("/api/v1/system/status").json()
    services = {entry["name"]: entry for entry in disabled["external_services"]}
    assert services["Online manual search"]["configured"] is False
    assert services["Online manual search"]["source"] == "household"
    assert services["Reference-image search"]["configured"] is False
    assert services["Reference-image search"]["source"] == "household"


def test_credential_rotation_and_undecryptable_key_fail_closed(owner_client, monkeypatch):
    _save(owner_client, key="brave-rotation-key", manual=True)
    household_id = _household_id(owner_client)
    settings = get_settings()
    old_key = settings.ai_credential_key
    new_key = generate_key()
    try:
        monkeypatch.setattr(settings, "ai_credential_key", new_key)
        monkeypatch.setattr(settings, "ai_credential_key_previous", old_key)
        rotated = owner_client.post("/api/v1/ai/credentials/rotate")
        assert rotated.status_code == 200, rotated.text
        assert rotated.json() == {"rotated": 1, "failed": 0}
        with SessionLocal() as db:
            row = db.get(HouseholdOnlineSearchSettings, household_id)
            assert row is not None
            assert decrypt_secret(row.encrypted_api_key) == "brave-rotation-key"
            assert row.api_key_version == 2

        monkeypatch.setattr(settings, "ai_credential_key", "")
        monkeypatch.setattr(settings, "ai_credential_key_previous", "")
        state = owner_client.get(SETTINGS_URL)
        assert state.status_code == 200, state.text
        body = state.json()
        assert body["has_api_key"] is True
        assert body["manual"]["configured"] is False
        assert body["manual"]["source"] == "household"
        assert "cannot be decrypted" in (body["manual"]["reason"] or "")
        assert body["credential_storage_ready"] is False
    finally:
        settings.ai_credential_key = old_key
        settings.ai_credential_key_previous = ""
