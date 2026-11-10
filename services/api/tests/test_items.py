import uuid

from housetory_api.db import SessionLocal
from housetory_api.models import Item


def setup_taxonomy(client):
    room = client.post("/api/v1/rooms", json={"name": "Kitchen"}).json()
    location = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Pantry Shelf", "kind": "shelf"},
    ).json()
    category = client.post("/api/v1/categories", json={"name": "Pantry", "color": "#8B7355"}).json()
    tag = client.post("/api/v1/tags", json={"name": "staples"}).json()
    return room, location, category, tag


def test_item_summary_keeps_shared_purchase_without_members_or_document_scans(
    owner_client, sql_statements
):
    first = owner_client.post("/api/v1/items", json={"name": "First"}).json()["item"]
    second = owner_client.post("/api/v1/items", json={"name": "Second"}).json()["item"]
    purchase = owner_client.post("/api/v1/purchases", json={
        "item_ids": [first["id"], second["id"]], "price_cents": 2000, "currency": "SEK",
    })
    assert purchase.status_code == 201, purchase.text
    sql_statements.clear()
    response = owner_client.get("/api/v1/items", params={"representation": "summary"})
    assert response.status_code == 200, response.text
    assert not any("document_scan_pages" in statement for statement in sql_statements)
    for item in response.json()["items"]:
        assert item["purchase"]["is_shared"] is True
        assert item["purchase"]["item_count"] == 2
        assert item["purchase"]["price_cents"] == 2000
        assert "items" not in item["purchase"]
        assert "allocations" not in item["purchase"]
    full = owner_client.get("/api/v1/items").json()["items"][0]
    assert len(full["purchase"]["items"]) == 2
    detail = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    assert "allocations" in detail["purchase"]


def test_item_pagination_breaks_equal_sort_values_by_id(owner_client):
    ids = [
        owner_client.post("/api/v1/items", json={"name": "Same name"}).json()["item"]["id"]
        for _ in range(3)
    ]
    with SessionLocal() as db:
        items = [db.get(Item, uuid.UUID(item_id)) for item_id in ids]
        for item in items:
            item.created_at = items[0].created_at
        db.commit()
    for sort in ["name_asc", "name_desc", "created_asc", "created_desc"]:
        pages = [
            owner_client.get(
                "/api/v1/items", params={"sort": sort, "limit": 1, "offset": offset}
            ).json()["items"][0]["id"]
            for offset in range(3)
        ]
        assert pages == sorted(ids)


def test_search_and_filters_understand_room_location_hierarchy(owner_client):
    house = owner_client.post("/api/v1/rooms", json={"name": "House"}).json()
    kitchen = owner_client.post(
        "/api/v1/rooms", json={"name": "Kitchen", "parent_id": house["id"]}
    ).json()
    pantry = owner_client.post(
        "/api/v1/rooms", json={"name": "Pantry", "parent_id": kitchen["id"]}
    ).json()
    cabinet = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": kitchen["id"], "name": "Pantry Cabinet", "kind": "cabinet"},
    ).json()
    shelf = owner_client.post(
        "/api/v1/storage-locations",
        json={
            "room_id": kitchen["id"],
            "name": "Spice Shelf",
            "kind": "shelf",
            "parent_id": cabinet["id"],
        },
    ).json()
    category = owner_client.post("/api/v1/categories", json={"name": "Kitchenware"}).json()

    kitchen_item = owner_client.post(
        "/api/v1/items",
        json={"name": "Cast Iron Pan", "room_id": kitchen["id"], "category_id": category["id"]},
    ).json()["item"]
    pantry_item = owner_client.post(
        "/api/v1/items", json={"name": "Rice Jar", "room_id": pantry["id"]}
    ).json()["item"]
    shelf_item = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Saffron",
            "room_id": kitchen["id"],
            "storage_location_id": shelf["id"],
        },
    ).json()["item"]

    exact_room = owner_client.get("/api/v1/items", params={"room_id": kitchen["id"]}).json()
    assert exact_room["total"] == 2
    assert {item["id"] for item in exact_room["items"]} == {kitchen_item["id"], shelf_item["id"]}

    nested_room = owner_client.get(
        "/api/v1/items",
        params={"room_id": kitchen["id"], "include_descendants": "true"},
    ).json()
    assert nested_room["total"] == 3
    assert pantry_item["id"] in {item["id"] for item in nested_room["items"]}

    exact_location = owner_client.get("/api/v1/items", params={"location_id": cabinet["id"]}).json()
    assert exact_location["total"] == 0

    nested_location = owner_client.get(
        "/api/v1/items",
        params={"location_id": cabinet["id"], "include_descendants": "true"},
    ).json()
    assert nested_location["total"] == 1
    assert nested_location["items"][0]["id"] == shelf_item["id"]

    assert owner_client.get("/api/v1/items", params={"q": "Kitchen"}).json()["total"] == 3
    assert owner_client.get("/api/v1/items", params={"q": "Pantry Cabinet"}).json()["total"] == 1
    assert owner_client.get("/api/v1/items", params={"q": "Spice Shelf"}).json()["total"] == 1
    assert owner_client.get("/api/v1/items", params={"q": "Kitchenware"}).json()["total"] == 1
    assert owner_client.get("/api/v1/items", params={"q": "   "}).json()["total"] == 3


def test_create_item_with_purchase_warranty_and_tags(owner_client):
    room, location, category, tag = setup_taxonomy(owner_client)
    response = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Olive Oil",
            "description": "Cold pressed",
            "brand": "Frantoia",
            "model": "Barbera 1L",
            "serial_number": "OO-2026-001",
            "quantity": 3,
            "condition": "excellent",
            "room_id": room["id"],
            "storage_location_id": location["id"],
            "category_id": category["id"],
            "tag_ids": [tag["id"]],
            "purchase": {
                "vendor": "Market",
                "purchase_date": "2026-01-15",
                "price_cents": 2499,
                "currency": "EUR",
                "order_number": "ORD-42",
            },
            "warranty": {
                "provider": "Frantoia",
                "start_date": "2026-01-15",
                "end_date": "2027-01-15",
            },
        },
    )
    assert response.status_code == 201, response.text
    item = response.json()["item"]
    assert item["name"] == "Olive Oil"
    assert item["room"]["name"] == "Kitchen"
    assert item["location"]["name"] == "Pantry Shelf"
    assert item["category"]["color"] == "#8B7355"
    assert item["tags"][0]["name"] == "staples"
    assert item["purchase"]["price_cents"] == 2499
    assert item["purchase"]["currency"] == "EUR"
    assert item["warranty"]["end_date"] == "2027-01-15"
    assert item["primary_photo"] is None
    assert item["photos"] == []


def test_item_update_search_and_archive(owner_client):
    room, location, category, tag = setup_taxonomy(owner_client)
    first = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Espresso Machine",
            "brand": "La Marzocco",
            "quantity": 1,
            "room_id": room["id"],
            "tag_ids": [tag["id"]],
            "purchase": {"price_cents": 250000, "currency": "USD"},
        },
    ).json()["item"]
    second = owner_client.post(
        "/api/v1/items",
        json={"name": "Paper Towels", "room_id": room["id"], "quantity": 12},
    ).json()["item"]

    listing = owner_client.get("/api/v1/items").json()
    assert listing["total"] == 2
    assert listing["items"][0]["name"] == "Paper Towels"

    search = owner_client.get("/api/v1/items", params={"q": "marzocco"}).json()
    assert search["total"] == 1
    assert search["items"][0]["id"] == first["id"]

    by_tag = owner_client.get("/api/v1/items", params={"tag_id": tag["id"]}).json()
    assert by_tag["total"] == 1

    by_room = owner_client.get("/api/v1/items", params={"room_id": room["id"]}).json()
    assert by_room["total"] == 2

    update = owner_client.patch(
        f"/api/v1/items/{first['id']}",
        json={
            "name": "Espresso Machine Pro",
            "quantity": 2,
            "purchase": {"price_cents": 275000, "vendor": "La Marzocco"},
        },
    )
    assert update.status_code == 200, update.text
    updated = update.json()["item"]
    assert updated["name"] == "Espresso Machine Pro"
    assert updated["quantity"] == 2
    assert updated["purchase"]["price_cents"] == 275000
    assert updated["purchase"]["currency"] == "USD"
    assert updated["purchase"]["vendor"] == "La Marzocco"

    archived = owner_client.patch(f"/api/v1/items/{second['id']}", json={"is_archived": True})
    assert archived.status_code == 200
    assert owner_client.get("/api/v1/items").json()["total"] == 1
    assert owner_client.get("/api/v1/items", params={"include_archived": True}).json()["total"] == 2
    assert owner_client.get("/api/v1/overview").json()["item_count"] == 1


def test_item_validation_and_location_coherence(owner_client):
    kitchen = owner_client.post("/api/v1/rooms", json={"name": "Kitchen"}).json()
    garage = owner_client.post("/api/v1/rooms", json={"name": "Garage"}).json()
    garage_location = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": garage["id"], "name": "Workbench"},
    ).json()

    mismatch = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Drill",
            "room_id": kitchen["id"],
            "storage_location_id": garage_location["id"],
        },
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "location_room_mismatch"

    bad_warranty = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Drill",
            "warranty": {"start_date": "2026-05-01", "end_date": "2026-04-01"},
        },
    )
    assert bad_warranty.status_code == 422

    negative = owner_client.post("/api/v1/items", json={"name": "Drill", "quantity": -1})
    assert negative.status_code == 422

    inferred_room = owner_client.post(
        "/api/v1/items",
        json={"name": "Drill", "storage_location_id": garage_location["id"]},
    )
    assert inferred_room.status_code == 201
    assert inferred_room.json()["item"]["room"]["id"] == garage["id"]


def test_item_update_response_reflects_location_move(owner_client):
    room = owner_client.post("/api/v1/rooms", json={"name": "Workshop"}).json()
    first = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Bench", "kind": "shelf"},
    ).json()
    second = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Toolbox", "kind": "box"},
    ).json()
    item = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Drill",
            "room_id": room["id"],
            "storage_location_id": first["id"],
        },
    ).json()["item"]

    updated = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"storage_location_id": second["id"]},
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()["item"]
    assert body["location"]["id"] == second["id"]
    assert body["location"]["name"] == "Toolbox"

    refreshed = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert refreshed["location"]["id"] == second["id"]


def test_delete_item(owner_client):
    item = owner_client.post("/api/v1/items", json={"name": "Old Lamp"}).json()["item"]
    assert owner_client.delete(f"/api/v1/items/{item['id']}").status_code == 204
    assert owner_client.get(f"/api/v1/items/{item['id']}").status_code == 404
    assert owner_client.delete(f"/api/v1/items/{item['id']}").status_code == 404


def test_overview_totals(owner_client):
    room, location, category, tag = setup_taxonomy(owner_client)
    owner_client.post(
        "/api/v1/items",
        json={
            "name": "Coffee",
            "quantity": 2,
            "room_id": room["id"],
            "purchase": {"price_cents": 1500, "currency": "USD"},
            "warranty": {"provider": "Roaster", "end_date": "2099-01-01"},
        },
    )
    owner_client.post(
        "/api/v1/items",
        json={
            "name": "Beans",
            "quantity": 4,
            "room_id": room["id"],
            "purchase": {"price_cents": 2500, "currency": "USD"},
        },
    )
    overview = owner_client.get("/api/v1/overview").json()
    assert overview["room_count"] == 1
    assert overview["location_count"] == 1
    assert overview["item_count"] == 2
    assert overview["total_quantity"] == 6
    assert overview["value_by_currency"] == [{"currency": "USD", "total_cents": 4000}]
    assert overview["warranties_expiring_soon"] == 0

    recent = overview["recent_items"]
    assert len(recent) == 2
    assert recent[0]["purchase"]["currency"] == "USD"
