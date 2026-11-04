def create_item(client, name, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_shared_purchase_links_multiple_items_without_duplication(owner_client):
    first = create_item(owner_client, "Espresso Machine")
    second = create_item(owner_client, "Coffee Grinder")
    response = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "La Marzocco Boutique",
            "purchase_date": "2026-02-14",
            "price_cents": 700000,
            "currency": "USD",
            "order_number": "ORDER-42",
            "notes": "Bought together",
            "item_ids": [first["id"], second["id"]],
        },
    )
    assert response.status_code == 201, response.text
    purchase = response.json()["purchase"]
    assert purchase["merchant"] == "La Marzocco Boutique"
    assert purchase["vendor"] == "La Marzocco Boutique"
    assert purchase["item_count"] == 2
    assert purchase["is_shared"] is True
    assert {item["id"] for item in purchase["items"]} == {first["id"], second["id"]}

    first_detail = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    second_detail = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert first_detail["purchase"]["price_cents"] == 700000
    assert second_detail["purchase"]["price_cents"] == 700000
    assert first_detail["purchase"]["item_count"] == 2
    assert first_detail["purchase"]["is_shared"] is True

    listing = owner_client.get("/api/v1/purchases").json()
    assert listing["total"] == 1
    assert listing["items"][0]["id"] == purchase["id"]

    filtered = owner_client.get("/api/v1/purchases", params={"q": "Grinder"}).json()
    assert filtered["total"] == 1
    filtered = owner_client.get("/api/v1/purchases", params={"item_id": second["id"]}).json()
    assert filtered["total"] == 1

    # Remove one item from the shared purchase; the other keeps the record.
    update = owner_client.patch(
        f"/api/v1/purchases/{purchase['id']}",
        json={"item_ids": [first["id"]], "price_cents": 650000},
    )
    assert update.status_code == 200, update.text
    assert update.json()["purchase"]["item_count"] == 1
    assert update.json()["purchase"]["is_shared"] is False
    second_detail = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert second_detail["purchase"] is None
    first_detail = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    assert first_detail["purchase"]["price_cents"] == 650000


def test_purchase_filter_by_currency_and_date(owner_client):
    first = create_item(owner_client, "Lamp")
    second = create_item(owner_client, "Desk Lamp")
    for item, merchant, currency, purchased in [
        (first, "Brass & Co", "EUR", "2026-01-10"),
        (second, "Local Store", "USD", "2026-03-20"),
    ]:
        response = owner_client.post(
            "/api/v1/purchases",
            json={
                "merchant": merchant,
                "purchase_date": purchased,
                "price_cents": 12500,
                "currency": currency,
                "item_ids": [item["id"]],
            },
        )
        assert response.status_code == 201, response.text

    assert owner_client.get("/api/v1/purchases").json()["total"] == 2
    by_currency = owner_client.get("/api/v1/purchases", params={"currency": "EUR"}).json()
    assert by_currency["total"] == 1
    by_date = owner_client.get(
        "/api/v1/purchases",
        params={"date_from": "2026-03-01", "date_to": "2026-03-31"},
    ).json()
    assert by_date["total"] == 1
    assert by_date["items"][0]["merchant"] == "Local Store"


def test_deleting_purchase_detaches_items_without_deleting_them(owner_client):
    item = create_item(owner_client, "Desk")
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={"merchant": "Workshop", "price_cents": 20000, "item_ids": [item["id"]]},
    ).json()["purchase"]
    assert owner_client.delete(f"/api/v1/purchases/{purchase['id']}").status_code == 204
    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["name"] == "Desk"
    assert detail["purchase"] is None


def test_deleting_one_item_keeps_shared_purchase_for_the_other(owner_client):
    first = create_item(owner_client, "Lens")
    second = create_item(owner_client, "Camera Body")
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "Camera Shop",
            "price_cents": 150000,
            "item_ids": [first["id"], second["id"]],
        },
    ).json()["purchase"]
    assert owner_client.delete(f"/api/v1/items/{first['id']}").status_code == 204
    detail = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert detail["purchase"]["id"] == purchase["id"]
    listing = owner_client.get("/api/v1/purchases").json()
    assert listing["total"] == 1
    assert listing["items"][0]["item_count"] == 1


def test_item_can_attach_existing_shared_purchase(owner_client):
    first = create_item(owner_client, "Monitor")
    second = create_item(owner_client, "Monitor Stand")
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={"merchant": "Studio", "price_cents": 90000, "item_ids": [first["id"]]},
    ).json()["purchase"]
    updated = owner_client.patch(
        f"/api/v1/items/{second['id']}", json={"purchase_id": purchase["id"]}
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["item"]["purchase"]["item_count"] == 2

    detached = owner_client.patch(f"/api/v1/items/{second['id']}", json={"purchase_id": None})
    assert detached.status_code == 200, detached.text
    assert detached.json()["item"]["purchase"] is None
    assert owner_client.get(f"/api/v1/purchases/{purchase['id']}").json()["item_count"] == 1


def test_purchase_item_ids_must_belong_to_household(owner_client):
    response = owner_client.post(
        "/api/v1/purchases",
        json={"price_cents": 100, "item_ids": ["00000000-0000-0000-0000-000000000000"]},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "item_not_found"

    missing_item = owner_client.post("/api/v1/purchases", json={"price_cents": 100})
    assert missing_item.status_code == 422
