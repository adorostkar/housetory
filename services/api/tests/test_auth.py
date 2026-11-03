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

    state = client.get("/api/v1/auth/session").json()
    assert state["authenticated"] is True
    assert state["setup_required"] is False


def test_setup_can_only_run_once(owner_client):
    response = owner_client.post(
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


def test_login_logout_and_bad_credentials(owner_client):
    assert owner_client.post("/api/v1/auth/logout").status_code == 204
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

    allowed = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Kitchen"},
        headers={"Origin": "http://testserver"},
    )
    assert allowed.status_code == 201


def test_validation_errors_are_structured(owner_client):
    response = owner_client.post("/api/v1/rooms", json={"name": ""})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "validation_error"
    assert "name" in detail["fields"]
