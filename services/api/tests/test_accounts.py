import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    Household,
    HouseholdInvitation,
    HouseholdMember,
    PasswordResetToken,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import email as email_service
from housetory_api.services.auth import create_session


@pytest.fixture(autouse=True)
def generous_auth_limits(monkeypatch):
    monkeypatch.setattr(get_settings(), "login_max_failures", 1000)


def _household_id(owner_client) -> uuid.UUID:
    return uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])


def _add_member(
    owner_client,
    *,
    email: str,
    role: str,
    password: str = "member-password-2026",
    household_id: uuid.UUID | None = None,
) -> tuple[str, uuid.UUID]:
    household_id = household_id or _household_id(owner_client)
    with SessionLocal() as db:
        household = db.get(Household, household_id)
        assert household is not None
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password(password),
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
            user_agent="accounts-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def _captured_token(path_prefix: str) -> str:
    pattern = re.compile(rf"http://testserver/{path_prefix}/([A-Za-z0-9_-]+)")
    for message in reversed(email_service.captured_messages()):
        match = pattern.search(message.text)
        if match:
            return match.group(1)
    raise AssertionError(f"No captured {path_prefix} token")


def _invite(owner_client, email: str, role: str = "member"):
    response = owner_client.post(
        "/api/v1/household/invitations",
        json={"email": email, "role": role},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_viewer_and_member_role_boundaries(owner_client, anon_client):
    viewer_token, _ = _add_member(owner_client, email="viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    assert anon_client.get("/api/v1/rooms", headers=viewer).status_code == 200
    assert anon_client.get("/api/v1/household/members", headers=viewer).status_code == 403
    blocked = anon_client.post("/api/v1/rooms", headers=viewer, json={"name": "Blocked"})
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "read_only_role"
    assert (
        anon_client.post("/api/v1/items", headers=viewer, json={"name": "Blocked item"}).status_code
        == 403
    )
    assert (
        anon_client.post(
            "/api/v1/labels/pdf",
            headers=viewer,
            json={"location_ids": [], "record": False},
        ).status_code
        == 403
    )
    assert anon_client.get("/api/v1/ai/settings", headers=viewer).status_code == 403
    assistant = anon_client.post(
        "/api/v1/assistant/query",
        headers=viewer,
        json={"question": "What is in my home?"},
    )
    assert assistant.status_code != 403

    member_token, _ = _add_member(owner_client, email="member@example.com", role="member")
    member = _headers(member_token)
    assert (
        anon_client.post("/api/v1/rooms", headers=member, json={"name": "Member Room"}).status_code
        == 201
    )
    assert (
        anon_client.patch(
            "/api/v1/household", headers=member, json={"name": "Member Rename"}
        ).status_code
        == 403
    )
    assert anon_client.get("/api/v1/household/members", headers=member).status_code == 403
    assert anon_client.get("/api/v1/account", headers=member).status_code == 200


def test_last_owner_cannot_be_demoted_or_removed(owner_client):
    session = owner_client.get("/api/v1/auth/session").json()
    owner_id = session["user"]["id"]
    demote = owner_client.patch(f"/api/v1/household/members/{owner_id}", json={"role": "viewer"})
    assert demote.status_code == 409
    assert demote.json()["detail"]["code"] == "last_owner"
    remove = owner_client.delete(f"/api/v1/household/members/{owner_id}")
    assert remove.status_code == 409
    assert remove.json()["detail"]["code"] == "last_owner"

    _, second_owner = _add_member(owner_client, email="second-owner@example.com", role="owner")
    promoted = owner_client.patch(
        f"/api/v1/household/members/{second_owner}", json={"role": "member"}
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "member"
    blocked = owner_client.patch(f"/api/v1/household/members/{owner_id}", json={"role": "member"})
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "last_owner"


def test_concurrent_last_owner_demotions_keep_one_owner(owner_client, anon_client):
    owner_session = owner_client.get("/api/v1/auth/session").json()
    owner_id = owner_session["user"]["id"]
    second_token, second_id = _add_member(
        owner_client, email="concurrent-owner@example.com", role="owner"
    )

    def demote(client, target_id: str, headers=None):
        return client.patch(
            f"/api/v1/household/members/{target_id}",
            json={"role": "member"},
            headers=headers,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(demote, owner_client, str(second_id)),
            pool.submit(demote, anon_client, str(owner_id), _headers(second_token)),
        ]
        results = [future.result() for future in futures]
    assert any(result.status_code == 200 for result in results)
    assert all(result.status_code != 500 for result in results)
    with SessionLocal() as db:
        owners = db.scalars(
            select(HouseholdMember).where(
                HouseholdMember.household_id == _household_id(owner_client),
                HouseholdMember.role == "owner",
            )
        ).all()
        assert len(owners) == 1


def test_member_removal_revokes_their_household_session(owner_client, anon_client):
    token, user_id = _add_member(owner_client, email="removed@example.com", role="member")
    assert anon_client.get("/api/v1/overview", headers=_headers(token)).status_code == 200
    removed = owner_client.delete(f"/api/v1/household/members/{user_id}")
    assert removed.status_code == 204
    assert anon_client.get("/api/v1/overview", headers=_headers(token)).status_code == 401


def test_invitation_new_account_acceptance_replay_and_hashing(owner_client, anon_client):
    invitation = _invite(owner_client, "new-viewer@example.com", "viewer")
    token = _captured_token("invitations")
    public = anon_client.get(f"/api/v1/invitations/{token}")
    assert public.status_code == 200, public.text
    body = public.json()
    assert body["email"] == "new-viewer@example.com"
    assert body["account_exists"] is False
    assert body["role"] == "viewer"

    accepted = anon_client.post(
        f"/api/v1/invitations/{token}/accept",
        json={"name": "New Viewer", "password": "new-viewer-password-2026"},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["role"] == "viewer"
    assert accepted.json()["household"]["id"] == str(_household_id(owner_client))
    assert anon_client.get("/api/v1/overview").status_code == 200
    assert anon_client.post("/api/v1/rooms", json={"name": "Nope"}).status_code == 403

    replay = anon_client.post(
        f"/api/v1/invitations/{token}/accept",
        json={"name": "New Viewer", "password": "new-viewer-password-2026"},
    )
    assert replay.status_code == 410
    assert replay.json()["detail"]["code"] == "invitation_used"

    with SessionLocal() as db:
        stored = db.get(HouseholdInvitation, invitation["id"])
        assert stored is not None
        assert stored.token_hash != token
        assert stored.accepted_at is not None


def test_invitation_existing_account_requires_login_and_correct_email(owner_client, anon_client):
    with SessionLocal() as db:
        existing = User(
            name="Existing Person",
            email="existing@example.com",
            password_hash=hash_password("existing-password-2026"),
        )
        wrong_user = User(
            name="Wrong Person",
            email="wrong@example.com",
            password_hash=hash_password("wrong-password-2026"),
        )
        wrong_household = Household(name="Wrong Home")
        db.add_all([existing, wrong_user, wrong_household])
        db.flush()
        db.add(
            HouseholdMember(
                household_id=wrong_household.id,
                user_id=wrong_user.id,
                role="owner",
            )
        )
        db.commit()
    _invite(owner_client, "existing@example.com", "member")
    token = _captured_token("invitations")

    public = anon_client.get(f"/api/v1/invitations/{token}")
    assert public.json()["account_exists"] is True
    unauthenticated = anon_client.post(f"/api/v1/invitations/{token}/accept", json={})
    assert unauthenticated.status_code == 401
    assert unauthenticated.json()["detail"]["code"] == "login_required"

    login = anon_client.post(
        "/api/v1/auth/login",
        json={"email": "existing@example.com", "password": "existing-password-2026"},
    )
    assert login.status_code == 200
    accepted = anon_client.post(f"/api/v1/invitations/{token}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["role"] == "member"

    _invite(owner_client, "other-invite@example.com", "viewer")
    other_token = _captured_token("invitations")
    from fastapi.testclient import TestClient

    from housetory_api.main import app

    with TestClient(app) as wrong_client:
        login_wrong = wrong_client.post(
            "/api/v1/auth/login",
            json={"email": "wrong@example.com", "password": "wrong-password-2026"},
        )
        assert login_wrong.status_code == 200
        wrong_account = wrong_client.post(f"/api/v1/invitations/{other_token}/accept", json={})
        assert wrong_account.status_code == 403
        assert wrong_account.json()["detail"]["code"] == "invitation_email_mismatch"


def test_invitation_expiry_revoke_duplicate_and_resend(owner_client, anon_client):
    _invite(owner_client, "expire@example.com", "member")
    token = _captured_token("invitations")
    with SessionLocal() as db:
        invitation = db.scalar(
            select(HouseholdInvitation).where(HouseholdInvitation.email == "expire@example.com")
        )
        assert invitation is not None
        invitation.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
    expired = anon_client.get(f"/api/v1/invitations/{token}")
    assert expired.status_code == 410
    assert expired.json()["detail"]["code"] == "invitation_expired"

    created = _invite(owner_client, "revoke@example.com", "viewer")
    revoked = owner_client.delete(f"/api/v1/household/invitations/{created['id']}")
    assert revoked.status_code == 204
    revoked_token = _captured_token("invitations")
    assert anon_client.get(f"/api/v1/invitations/{revoked_token}").status_code == 410

    _invite(owner_client, "resend@example.com", "member")
    first_token = _captured_token("invitations")
    pending = owner_client.get("/api/v1/household/invitations").json()["items"]
    invitation = next(item for item in pending if item["email"] == "resend@example.com")
    resent = owner_client.post(f"/api/v1/household/invitations/{invitation['id']}/resend")
    assert resent.status_code == 200, resent.text
    second_token = _captured_token("invitations")
    assert second_token != first_token
    assert anon_client.get(f"/api/v1/invitations/{first_token}").status_code == 404
    assert anon_client.get(f"/api/v1/invitations/{second_token}").status_code == 200

    duplicate = owner_client.post(
        "/api/v1/household/invitations",
        json={"email": "resend@example.com", "role": "member"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "invitation_exists"


def test_password_reset_is_uniform_and_revokes_sessions(owner_client, anon_client):
    original_cookie = owner_client.cookies.get("housetory_session")
    assert original_cookie
    known = anon_client.post(
        "/api/v1/auth/password-reset/request",
        json={"email": "ada@example.com"},
    )
    unknown = anon_client.post(
        "/api/v1/auth/password-reset/request",
        json={"email": "nobody@example.com"},
    )
    assert known.status_code == 200
    assert unknown.status_code == 200
    assert known.json() == unknown.json()
    token = _captured_token("reset-password")
    assert anon_client.get(f"/api/v1/auth/password-reset/{token}").json()["valid"] is True

    confirmed = anon_client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": token, "password": "new-reset-password-2026"},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert (
        anon_client.get(
            "/api/v1/overview",
            headers={"Cookie": f"housetory_session={original_cookie}"},
        ).status_code
        == 401
    )
    old_login = anon_client.post(
        "/api/v1/auth/login",
        json={"email": "ada@example.com", "password": "analytical-engine-1843"},
    )
    assert old_login.status_code == 401
    new_login = anon_client.post(
        "/api/v1/auth/login",
        json={"email": "ada@example.com", "password": "new-reset-password-2026"},
    )
    assert new_login.status_code == 200
    replay = anon_client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": token, "password": "another-reset-password-2026"},
    )
    assert replay.status_code == 400
    assert replay.json()["detail"]["code"] == "invalid_or_expired_token"


def test_new_password_reset_consumes_older_tokens(owner_client, anon_client):
    anon_client.post("/api/v1/auth/password-reset/request", json={"email": "ada@example.com"})
    first = _captured_token("reset-password")
    anon_client.post("/api/v1/auth/password-reset/request", json={"email": "ada@example.com"})
    second = _captured_token("reset-password")
    assert first != second
    first_attempt = anon_client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": first, "password": "new-password-first-2026"},
    )
    assert first_attempt.status_code == 400
    second_attempt = anon_client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": second, "password": "new-password-second-2026"},
    )
    assert second_attempt.status_code == 200


def test_email_unconfigured_and_delivery_failure_are_explicit(owner_client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "smtp_host", "")
    monkeypatch.setattr(settings, "smtp_from_address", "")
    unavailable = owner_client.post(
        "/api/v1/household/invitations",
        json={"email": "no-mail@example.com", "role": "member"},
    )
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "email_not_configured"

    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "smtp_host", "smtp.invalid")
    monkeypatch.setattr(settings, "smtp_from_address", "noreply@example.com")

    class FailingTransport:
        def send(self, message):
            raise email_service.EmailDeliveryError("failed")

    monkeypatch.setattr(email_service, "get_transport", lambda settings=None: FailingTransport())
    failed = owner_client.post(
        "/api/v1/household/invitations",
        json={"email": "failed@example.com", "role": "member"},
    )
    assert failed.status_code == 502
    assert failed.json()["detail"]["code"] == "email_delivery_failed"
    with SessionLocal() as db:
        invitation = db.scalar(
            select(HouseholdInvitation).where(HouseholdInvitation.email == "failed@example.com")
        )
        assert invitation is not None
        assert invitation.revoked_at is not None


def test_account_password_change_revokes_other_sessions(owner_client, anon_client):
    email = "ada@example.com"
    login = anon_client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "analytical-engine-1843"},
    )
    assert login.status_code == 200
    assert anon_client.get("/api/v1/overview").status_code == 200
    wrong = owner_client.post(
        "/api/v1/account/password",
        json={
            "current_password": "wrong-password",
            "new_password": "new-account-password-2026",
        },
    )
    assert wrong.status_code == 400
    changed = owner_client.post(
        "/api/v1/account/password",
        json={
            "current_password": "analytical-engine-1843",
            "new_password": "new-account-password-2026",
        },
    )
    assert changed.status_code == 204
    assert anon_client.get("/api/v1/overview").status_code == 401
    assert owner_client.get("/api/v1/overview").status_code == 200
    renamed = owner_client.patch("/api/v1/account", json={"name": "Ada L."})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Ada L."


def test_invite_and_reset_rate_limits(owner_client, anon_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "login_max_failures", 2)
    for _ in range(2):
        assert (
            owner_client.post(
                "/api/v1/household/invitations",
                json={"email": f"rate-{uuid.uuid4()}@example.com", "role": "viewer"},
            ).status_code
            == 201
        )
    blocked = owner_client.post(
        "/api/v1/household/invitations",
        json={"email": "rate-blocked@example.com", "role": "viewer"},
    )
    assert blocked.status_code == 429

    anon_client.post("/api/v1/auth/password-reset/request", json={"email": "ada@example.com"})
    anon_client.post("/api/v1/auth/password-reset/request", json={"email": "ada@example.com"})
    reset_blocked = anon_client.post(
        "/api/v1/auth/password-reset/request", json={"email": "ada@example.com"}
    )
    assert reset_blocked.status_code == 429


def test_invitation_tokens_are_not_plain_text(owner_client):
    invitation = _invite(owner_client, "hash@example.com", "member")
    token = _captured_token("invitations")
    with SessionLocal() as db:
        stored = db.get(HouseholdInvitation, invitation["id"])
        assert stored is not None
        assert stored.token_hash != token
    anon = owner_client
    anon.post("/api/v1/auth/password-reset/request", json={"email": "ada@example.com"})
    reset_token = _captured_token("reset-password")
    with SessionLocal() as db:
        stored_reset = db.scalar(
            select(PasswordResetToken).where(
                PasswordResetToken.user_id
                == uuid.UUID(owner_client.get("/api/v1/auth/session").json()["user"]["id"])
            )
        )
        assert stored_reset is not None
        assert stored_reset.token_hash != reset_token
