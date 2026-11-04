from housetory_api.db import SessionLocal
from housetory_api.models import StorageLocation


def _create_quick_search_data(client):
    room = client.post("/api/v1/rooms", json={"name": "Office"}).json()
    container = client.post(
        "/api/v1/containers",
        json={
            "room_id": room["id"],
            "container_type": "box",
            "name": "Cables",
        },
    ).json()
    shelf = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Top shelf", "kind": "shelf"},
    ).json()
    camera = client.post(
        "/api/v1/items",
        json={
            "name": "Camera Body",
            "brand": "Acme",
            "model": "C-1",
            "room_id": room["id"],
            "storage_location_id": container["id"],
        },
    ).json()["item"]
    passport = client.post(
        "/api/v1/items",
        json={
            "name": "Passport",
            "room_id": room["id"],
            "storage_location_id": shelf["id"],
        },
    ).json()["item"]
    with SessionLocal() as db:
        stored = db.get(StorageLocation, container["id"])
        assert stored is not None
        stored.legacy_identifier = "STO-03"
        stored.aliases = ["old-blue-box"]
        db.commit()
    return {
        "room": room,
        "container": container,
        "shelf": shelf,
        "camera": camera,
        "passport": passport,
    }


def test_quick_search_returns_items_containers_and_locations(owner_client):
    data = _create_quick_search_data(owner_client)

    response = owner_client.get("/api/v1/search/quick", params={"q": "Camera"})
    assert response.status_code == 200, response.text
    body = response.json()
    item = next(result for result in body["results"] if result["kind"] == "item")
    assert item["id"] == data["camera"]["id"]
    assert item["title"] == "Camera Body"
    assert item["subtitle"] == "Acme · C-1"
    assert item["url"] == f"/items/{data['camera']['id']}"
    assert "Office" in item["context"]
    assert data["container"]["identifier"] in item["context"]

    response = owner_client.get(
        "/api/v1/search/quick", params={"q": data["container"]["identifier"]}
    )
    container = next(
        result for result in response.json()["results"] if result["kind"] == "container"
    )
    assert container["title"] == data["container"]["identifier"]
    assert container["subtitle"].startswith("Cables")
    assert "old-blue-box" in container["subtitle"]
    assert container["url"] == f"/containers/{data['container']['id']}"

    for query in ("STO-03", "old-blue-box", "sto-03"):
        response = owner_client.get("/api/v1/search/quick", params={"q": query})
        assert response.status_code == 200, response.text
        container = next(
            result
            for result in response.json()["results"]
            if result["kind"] == "container" and result["id"] == data["container"]["id"]
        )
        assert container["title"] == data["container"]["identifier"]

    response = owner_client.get("/api/v1/search/quick", params={"q": "Top shelf"})
    location = next(result for result in response.json()["results"] if result["kind"] == "location")
    assert location["id"] == data["shelf"]["id"]
    assert location["url"] == (f"/rooms/{data['room']['id']}?location_id={data['shelf']['id']}")
    assert "Office" in location["context"]

    limited = owner_client.get("/api/v1/search/quick", params={"q": "o", "limit": 20})
    assert limited.status_code == 422


def test_quick_search_is_household_scoped(owner_client, anon_client):
    from tests.test_cross_household import _other_household_headers

    _create_quick_search_data(owner_client)
    other = _other_household_headers()
    response = owner_client.get(
        "/api/v1/search/quick",
        params={"q": "Camera"},
        headers=other["headers"],
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"] == []
    assert anon_client.get("/api/v1/search/quick", params={"q": "Camera"}).status_code == 401
