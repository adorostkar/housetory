import pytest


def test_household_defaults_to_usd(owner_client):
    response = owner_client.get("/api/v1/household")
    assert response.status_code == 200, response.text
    assert response.json()["default_currency"] == "USD"

    session = owner_client.get("/api/v1/auth/session").json()
    assert session["household"]["default_currency"] == "USD"
    assert session["households"][0]["default_currency"] == "USD"


def test_household_default_currency_is_used_for_new_item_and_purchase_records(owner_client):
    assert owner_client.patch(
        "/api/v1/household", json={"default_currency": "SEK"}
    ).status_code == 200
    room = owner_client.post("/api/v1/rooms", json={"name": "Currency room"}).json()
    created = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Currency camera",
            "room_id": room["id"],
            "current_value_cents": 12000,
            "purchase": {"price_cents": 10000},
        },
    )
    assert created.status_code == 201, created.text
    item = created.json()["item"]
    assert item["current_value_currency"] == "SEK"
    assert item["purchase"]["currency"] == "SEK"

    second = owner_client.post(
        "/api/v1/items",
        json={"name": "Currency lens", "room_id": room["id"]},
    ).json()["item"]
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={"item_ids": [second["id"]], "price_cents": 5000},
    )
    assert purchase.status_code == 201, purchase.text
    assert purchase.json()["purchase"]["currency"] == "SEK"


def test_household_can_be_renamed(owner_client):
    response = owner_client.patch("/api/v1/household", json={"name": "The Lovelace Home"})
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "The Lovelace Home"

    session = owner_client.get("/api/v1/auth/session").json()
    assert session["household"]["name"] == "The Lovelace Home"

    empty = owner_client.patch("/api/v1/household", json={"name": "  "})
    assert empty.status_code == 422


def test_household_default_currency_update_persists(owner_client):
    response = owner_client.patch("/api/v1/household", json={"default_currency": "EUR"})
    assert response.status_code == 200, response.text
    assert response.json()["default_currency"] == "EUR"

    stored = owner_client.get("/api/v1/household")
    assert stored.status_code == 200, stored.text
    assert stored.json()["default_currency"] == "EUR"

    session = owner_client.get("/api/v1/auth/session").json()
    assert session["household"]["default_currency"] == "EUR"
    assert session["households"][0]["default_currency"] == "EUR"


@pytest.mark.parametrize("currency", ["usd", "US", "USDD", "U$D", "U1D", "", 123])
def test_household_rejects_invalid_default_currency(owner_client, currency):
    response = owner_client.patch(
        "/api/v1/household",
        json={"default_currency": currency},
    )
    assert response.status_code == 422, response.text

    session = owner_client.get("/api/v1/auth/session").json()
    assert session["household"]["default_currency"] == "USD"
