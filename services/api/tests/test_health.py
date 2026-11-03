def test_live_health(client):
    response = client.get("/api/v1/health/live")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "housetory-api"


def test_ready_health_checks_database_and_storage(client):
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["components"]["database"]["status"] == "ok"
    assert body["components"]["storage"]["status"] == "ok"


def test_unversioned_container_health(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_protected_routes_require_authentication(anon_client):
    for path in [
        "/api/v1/overview",
        "/api/v1/rooms",
        "/api/v1/items",
        "/api/v1/categories",
        "/api/v1/tags",
        "/api/v1/storage-locations",
        "/api/v1/documents",
    ]:
        response = anon_client.get(path)
        assert response.status_code == 401, path
        assert response.json()["detail"]["code"] == "not_authenticated"


def test_request_id_header(client):
    response = client.get("/healthz", headers={"X-Request-ID": "test-request-id"})
    assert response.headers["x-request-id"] == "test-request-id"
    assert response.headers["x-content-type-options"] == "nosniff"
