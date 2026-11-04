import csv
import io

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.services.auth import create_session


def create_item(client, name, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_financial_overview_separates_currencies_and_purchase_from_current(owner_client):
    kitchen = owner_client.post("/api/v1/rooms", json={"name": "Kitchen"}).json()
    living = owner_client.post("/api/v1/rooms", json={"name": "Living Room"}).json()
    appliances = owner_client.post("/api/v1/categories", json={"name": "Appliances"}).json()
    furniture = owner_client.post("/api/v1/categories", json={"name": "Furniture"}).json()

    create_item(
        owner_client,
        "Espresso Machine",
        room_id=kitchen["id"],
        category_id=appliances["id"],
        purchase={"merchant": "Boutique", "price_cents": 100000, "currency": "USD"},
        current_value_cents=80000,
        current_value_currency="USD",
    )
    create_item(
        owner_client,
        "Italian Lamp",
        room_id=living["id"],
        category_id=appliances["id"],
        purchase={"merchant": "Milano", "price_cents": 50000, "currency": "EUR"},
        current_value_cents=30000,
        current_value_currency="USD",
    )
    sofa = create_item(
        owner_client,
        "Sofa",
        room_id=living["id"],
        category_id=furniture["id"],
        current_value_cents=60000,
        current_value_currency="USD",
    )
    chair = create_item(
        owner_client,
        "Chair",
        room_id=living["id"],
        category_id=furniture["id"],
        current_value_cents=20000,
        current_value_currency="USD",
    )
    create_item(owner_client, "Old Keys")

    shared = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "Furniture Studio",
            "purchase_date": "2026-03-01",
            "price_cents": 90000,
            "currency": "USD",
            "item_ids": [sofa["id"], chair["id"]],
        },
    )
    assert shared.status_code == 201, shared.text

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["value_by_currency"] == [
        {"currency": "EUR", "total_cents": 50000},
        {"currency": "USD", "total_cents": 190000},
    ]
    assert overview["current_value_by_currency"] == [{"currency": "USD", "total_cents": 190000}]
    assert overview["items_missing_purchase_count"] == 1

    financial = owner_client.get("/api/v1/financial-overview").json()
    by_currency = {entry["currency"]: entry for entry in financial["currency_totals"]}
    assert by_currency["USD"]["purchase_total_cents"] == 190000
    assert by_currency["USD"]["current_value_cents"] == 190000
    assert by_currency["USD"]["purchase_item_count"] == 3
    assert by_currency["EUR"]["purchase_total_cents"] == 50000
    assert by_currency["EUR"]["current_value_cents"] == 0
    assert financial["exchange_rates_configured"] is False
    assert "separately" in financial["conversion_note"]

    furniture_rows = [
        row
        for row in financial["value_by_category"]
        if row["name"] == "Furniture" and row["currency"] == "USD"
    ]
    assert len(furniture_rows) == 1
    # The shared 900.00 purchase is counted once and split 450/450.
    assert furniture_rows[0]["purchase_total_cents"] == 90000
    assert furniture_rows[0]["current_value_cents"] == 80000
    assert furniture_rows[0]["item_count"] == 2

    living_rows = [
        row
        for row in financial["value_by_room"]
        if row["name"] == "Living Room" and row["currency"] == "USD"
    ]
    assert living_rows[0]["current_value_cents"] == 110000

    assert financial["items_with_purchase_count"] == 4
    assert financial["items_missing_purchase_count"] == 1
    assert [item["name"] for item in financial["missing_purchase_items"]] == ["Old Keys"]
    assert financial["most_valuable_items"][0]["item"]["name"] == "Espresso Machine"
    assert financial["most_valuable_items"][0]["value_kind"] == "current"


def test_inventory_current_value_is_optional_and_separate(owner_client):
    create_item(owner_client, "No values")
    create_item(
        owner_client,
        "Estimated",
        current_value_cents=12345,
        current_value_currency="GBP",
    )
    overview = owner_client.get("/api/v1/overview").json()
    assert overview["value_by_currency"] == []
    assert overview["current_value_by_currency"] == [{"currency": "GBP", "total_cents": 12345}]
    financial = owner_client.get("/api/v1/financial-overview").json()
    assert financial["currency_totals"] == [
        {
            "currency": "GBP",
            "purchase_total_cents": 0,
            "current_value_cents": 12345,
            "purchase_item_count": 0,
            "current_value_item_count": 1,
        }
    ]
    assert financial["items_missing_purchase_count"] == 2


def parse_csv(response) -> list[dict[str, str]]:
    text = response.content.decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def test_csv_exports_cover_documents_purchases_warranties_and_inventory(owner_client, pdf_bytes):
    item = create_item(
        owner_client,
        "Camera",
        room_id=None,
        purchase={"merchant": "Camera Shop", "price_cents": 50000, "currency": "EUR"},
        warranty={"provider": "Camera Co", "end_date": "2099-01-01"},
        current_value_cents=40000,
        current_value_currency="EUR",
    )
    document = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Camera receipt", "document_type": "receipt", "item_ids": [item["id"]]},
    ).json()

    documents = owner_client.get("/api/v1/exports/documents.csv")
    assert documents.status_code == 200
    assert documents.headers["content-type"].startswith("text/csv")
    assert 'filename="housetory-documents-' in documents.headers["content-disposition"]
    document_rows = parse_csv(documents)
    assert document_rows[0]["title"] == "Camera receipt"
    assert document_rows[0]["items"] == "Camera"
    assert document["id"] in document_rows[0]["download_url"]

    purchases = parse_csv(owner_client.get("/api/v1/exports/purchases.csv"))
    assert purchases[0]["merchant"] == "Camera Shop"
    assert purchases[0]["currency"] == "EUR"
    assert purchases[0]["items"] == "Camera"

    warranties = parse_csv(owner_client.get("/api/v1/exports/warranties.csv"))
    assert warranties[0]["item"] == "Camera"
    assert warranties[0]["provider"] == "Camera Co"
    assert warranties[0]["status"] == "active"

    inventory = parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    assert inventory[0]["item"] == "Camera"
    assert inventory[0]["purchase_total_cents"] == "50000"
    assert inventory[0]["current_value_cents"] == "40000"
    assert inventory[0]["missing_purchase_information"] == "no"


def other_household_headers(email: str = "exports-other@example.com") -> dict:
    with SessionLocal() as db:
        user = User(name="Other Exporter", email=email, password_hash="not-used")
        household = Household(name="Other Export Home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(user_id=user.id, household_id=household.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="export-test",
            ip_address="127.0.0.1",
        )
        db.commit()
        return {"Cookie": f"housetory_session={token}"}


def test_exports_are_household_scoped(owner_client, anon_client, pdf_bytes):
    item = create_item(owner_client, "Private item")
    owner_client.post(
        "/api/v1/documents",
        files={"file": ("private.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Private receipt", "item_ids": [item["id"]]},
    )
    other = other_household_headers()
    for path in [
        "/api/v1/exports/documents.csv",
        "/api/v1/exports/purchases.csv",
        "/api/v1/exports/warranties.csv",
        "/api/v1/exports/inventory.csv",
    ]:
        response = anon_client.get(path, headers=other)
        assert response.status_code == 200
        assert len(response.content.decode("utf-8").strip().splitlines()) == 1


def test_csv_exports_neutralize_spreadsheet_formulas(owner_client):
    create_item(owner_client, '=HYPERLINK("https://example.invalid")')
    inventory = parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    assert inventory[0]["item"].startswith("'=")
