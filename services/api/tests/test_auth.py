def test_first_run_setup_and_session(client):
    state = client.get("/api/v1/auth/session").json()
    assert state == {
        "authenticated": False,
        "setup_required": True,
        "user": None,
        "household": None,
        "role": None,
    }

    response = client.post(
        "/api/v1/auth/setup",
        json={
            "name": "Ada Lovelace",
            "email": "ADA@example.com",
            "password": "analytical-engine-1843",
            "household_name": "Ada's Home",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["authenticated"] is True
    assert body["setup_required"] is False
    assert body["user"]["email"] == "ada@example.com"
    assert body["household"]["name"] == "Ada's Home"
    assert body["role"] == "owner"
    assert "housetory_session" in client.cookies

    cookie = response.headers.get("set-cookie", "")
    assert "httponly" in cookie.lower()
    assert "samesite=lax" in cookie.lower()
    assert "path=/" in cookie.lower()
    assert "secure" not in cookie.lower().replace("httponly", "")

    state = client.get("/api/v1/auth/session").json()
    assert state["authenticated"] is True
    assert state["setup_required"] is False


def test_setup_can_only_run_once(owner_client, anon_client):
    response = anon_client.post(
        "/api/v1/auth/setup",
        json={
            "name": "Another",
            "email": "other@example.com",
            "password": "another-long-password",
            "household_name": "Other Home",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "setup_complete"
    assert anon_client.get("/api/v1/auth/session").json()["authenticated"] is False
    assert anon_client.get("/api/v1/overview").status_code == 401


def test_login_logout_and_bad_credentials(owner_client, anon_client):
    token = owner_client.cookies.get("housetory_session")
    logout = owner_client.post("/api/v1/auth/logout")
    assert logout.status_code == 204
    cookie = logout.headers.get("set-cookie", "")
    assert "housetory_session=" in cookie
    assert "max-age=0" in cookie.lower()
    assert "httponly" in cookie.lower()
    assert owner_client.get("/api/v1/auth/session").json()["authenticated"] is False

    bad = owner_client.post(
        "/api/v1/auth/login", json={"email": "ada@example.com", "password": "wrong"}
    )
    assert bad.status_code == 401
    assert bad.json()["detail"]["code"] == "invalid_credentials"

    good = owner_client.post(
        "/api/v1/auth/login",
        json={"email": "ADA@EXAMPLE.COM", "password": "analytical-engine-1843"},
    )
    assert good.status_code == 200
    assert good.json()["authenticated"] is True

    assert owner_client.get("/api/v1/overview").status_code == 200

    # The revoked token must not work as a replay even outside the browser.
    replay = anon_client.get("/api/v1/overview", headers={"Cookie": f"housetory_session={token}"})
    assert replay.status_code == 401


def test_session_tokens_and_passwords_are_hashed_at_rest(owner_client):
    from sqlalchemy import select

    from housetory_api.db import SessionLocal
    from housetory_api.models import AuthSession, User
    from housetory_api.security import hash_session_token

    token = owner_client.cookies.get("housetory_session")
    assert token
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "ada@example.com"))
        auth_session = db.scalar(select(AuthSession).where(AuthSession.user_id == user.id))
        assert user.password_hash.startswith("$argon2id$")
        assert "analytical-engine-1843" not in user.password_hash
        assert auth_session.token_hash != token
        assert auth_session.token_hash == hash_session_token(token)


def test_login_is_rate_limited(owner_client, monkeypatch):
    from housetory_api.config import get_settings

    monkeypatch.setattr(get_settings(), "login_max_failures", 3)
    for _ in range(3):
        response = owner_client.post(
            "/api/v1/auth/login",
            json={"email": "ada@example.com", "password": "definitely-wrong"},
        )
        assert response.status_code == 401

    blocked = owner_client.post(
        "/api/v1/auth/login",
        json={"email": "ada@example.com", "password": "analytical-engine-1843"},
    )
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "too_many_attempts"
    assert int(blocked.headers["retry-after"]) > 0


def test_deactivated_user_session_is_rejected(owner_client):
    from sqlalchemy import select

    from housetory_api.db import SessionLocal
    from housetory_api.models import User

    token = owner_client.cookies.get("housetory_session")
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "ada@example.com"))
        user.is_active = False
        db.commit()

    response = owner_client.get(
        "/api/v1/overview", headers={"Cookie": f"housetory_session={token}"}
    )
    assert response.status_code == 401


def test_password_policy_is_enforced(client):
    response = client.post(
        "/api/v1/auth/setup",
        json={
            "name": "Ada",
            "email": "ada@example.com",
            "password": "short",
            "household_name": "Home",
        },
    )
    assert response.status_code == 422
    body = response.json()["detail"]
    assert body["code"] == "validation_error"
    assert "password" in body["fields"]
    assert client.get("/api/v1/auth/session").json()["setup_required"] is True


def test_cross_site_mutation_is_rejected(owner_client):
    response = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Kitchen"},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "origin_not_allowed"

    referer = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Kitchen"},
        headers={"Referer": "https://evil.example/attack"},
    )
    assert referer.status_code == 403
    assert referer.json()["detail"]["code"] == "origin_not_allowed"

    allowed = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Kitchen"},
        headers={"Origin": "http://testserver"},
    )
    assert allowed.status_code == 201

    allowed_referer = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Pantry"},
        headers={"Referer": "http://testserver/rooms"},
    )
    assert allowed_referer.status_code == 201


def test_api_responses_are_not_cached(owner_client, anon_client):
    authenticated = owner_client.get("/api/v1/overview")
    assert authenticated.headers["cache-control"] == "no-store"
    unauthenticated = anon_client.get("/api/v1/items")
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["cache-control"] == "no-store"
    assert unauthenticated.headers["x-content-type-options"] == "nosniff"
    assert unauthenticated.headers["x-permitted-cross-domain-policies"] == "none"


def test_no_cors_permission_is_granted(owner_client):
    response = owner_client.options(
        "/api/v1/items",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in response.headers


def test_validation_errors_are_structured(owner_client):
    response = owner_client.post("/api/v1/rooms", json={"name": ""})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "validation_error"
    assert "name" in detail["fields"]
