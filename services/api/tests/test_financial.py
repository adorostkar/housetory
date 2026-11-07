import csv
import io
import uuid

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, Item, User
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
    assert by_currency["USD"]["current_value_total_cents"] == 190000
    assert by_currency["USD"]["purchase_item_count"] == 3
    assert by_currency["EUR"]["purchase_total_cents"] == 50000
    assert by_currency["EUR"]["current_value_total_cents"] == 0
    assert financial["exchange_rates_configured"] is False
    assert "separately" in financial["conversion_note"]

    furniture_rows = [
        row
        for row in financial["value_by_category"]
        if row["name"] == "Furniture" and row["currency"] == "USD"
    ]
    assert len(furniture_rows) == 1
    # The legacy shared 900.00 purchase is counted once in the overall total, but
    # no historical per-item split is fabricated without persisted allocations.
    assert furniture_rows[0]["purchase_total_cents"] == 0
    assert furniture_rows[0]["current_value_total_cents"] == 80000
    assert furniture_rows[0]["item_count"] == 2

    living_rows = [
        row
        for row in financial["value_by_room"]
        if row["name"] == "Living Room" and row["currency"] == "USD"
    ]
    assert living_rows[0]["current_value_total_cents"] == 110000

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
            "current_value_total_cents": 12345,
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
    assert inventory[0]["current_value_unit_cents"] == "40000"
    assert inventory[0]["current_value_quantity"] == "1"
    assert inventory[0]["current_value_total_cents"] == "40000"
    assert inventory[0]["current_value_basis"] == "per_unit"
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


def test_per_unit_value_multiplies_owned_quantity_including_loaned_units(owner_client):
    room = owner_client.post("/api/v1/rooms", json={"name": "Value room"}).json()
    item = create_item(
        owner_client,
        "Camera kit",
        room_id=room["id"],
        quantity=2,
        current_value_cents=4000,
        current_value_currency="USD",
        purchase={
            "merchant": "Camera Shop",
            "price_cents": 10000,
            "currency": "USD",
        },
    )
    loan = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": item["id"],
            "borrower_name": "Private Borrower",
            "quantity": 1,
            "lent_on": "2026-02-10",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert loan.status_code == 201, loan.text
    borrowed = owner_client.post(
        "/api/v1/borrowed",
        json={
            "item_name": "Borrowed grinder",
            "owner_name": "External Owner",
            "quantity": 5,
            "borrowed_on": "2026-01-01",
            "room_id": room["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert borrowed.status_code == 201, borrowed.text

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["quantity"] == 2
    assert detail["on_loan_quantity"] == 1
    assert detail["current_value_cents"] == 4000
    assert detail["current_value_basis"] == "per_unit"
    assert detail["current_value_total_cents"] == 8000
    assert detail["current_value_estimated_at"] is not None

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["current_value_by_currency"] == [{"currency": "USD", "total_cents": 8000}]
    assert overview["value_by_currency"] == [{"currency": "USD", "total_cents": 10000}]

    financial = owner_client.get("/api/v1/financial-overview").json()
    by_currency = {entry["currency"]: entry for entry in financial["currency_totals"]}
    assert by_currency["USD"]["purchase_total_cents"] == 10000
    assert by_currency["USD"]["current_value_total_cents"] == 8000
    assert by_currency["USD"]["current_value_item_count"] == 1

    inventory = parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    row = inventory[0]
    assert row["purchase_total_cents"] == "10000"
    assert row["current_value_unit_cents"] == "4000"
    assert row["current_value_quantity"] == "2"
    assert row["current_value_total_cents"] == "8000"
    assert row["current_value_currency"] == "USD"
    assert row["current_value_basis"] == "per_unit"

    updated = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    assert updated.status_code == 200, updated.text
    detail = updated.json()["item"]
    assert detail["current_value_cents"] == 4000
    assert detail["current_value_total_cents"] == 12000
    assert detail["current_value_basis"] == "per_unit"


def test_legacy_record_total_is_not_multiplied_and_conversion_is_audited(owner_client):
    item = create_item(owner_client, "Legacy camera", quantity=2)
    with SessionLocal() as db:
        stored = db.get(Item, uuid.UUID(item["id"]))
        assert stored is not None
        stored.current_value_cents = 8000
        stored.current_value_basis = "legacy_record_total"
        stored.current_value_currency = "USD"
        db.commit()

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["current_value_cents"] == 8000
    assert detail["current_value_basis"] == "legacy_record_total"
    assert detail["current_value_total_cents"] == 8000
    assert detail["current_value_estimated_at"] is None

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["current_value_by_currency"] == [{"currency": "USD", "total_cents": 8000}]

    inventory = parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    row = inventory[0]
    assert row["current_value_unit_cents"] == ""
    assert row["current_value_quantity"] == "2"
    assert row["current_value_total_cents"] == "8000"
    assert row["current_value_basis"] == "legacy_record_total"

    quantity_change = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    assert quantity_change.status_code == 200, quantity_change.text
    detail = quantity_change.json()["item"]
    assert detail["current_value_total_cents"] == 8000
    assert detail["current_value_basis"] == "legacy_record_total"

    restored_quantity = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 2})
    assert restored_quantity.status_code == 200, restored_quantity.text

    ambiguous = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"current_value_basis": "per_unit"}
    )
    assert ambiguous.status_code == 422, ambiguous.text
    assert ambiguous.json()["detail"]["code"] == "current_value_unit_required"

    converted = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"current_value_cents": 4000, "current_value_basis": "per_unit"},
    )
    assert converted.status_code == 200, converted.text
    detail = converted.json()["item"]
    assert detail["current_value_cents"] == 4000
    assert detail["current_value_basis"] == "per_unit"
    assert detail["current_value_total_cents"] == 8000
    assert detail["current_value_estimated_at"] is not None

    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    conversion = next(
        event for event in history["items"] if event["action"] == "item.value_updated"
    )
    assert conversion["details"]["from"]["basis"] == "legacy_record_total"
    assert conversion["details"]["to"]["basis"] == "per_unit"

    quantity_again = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    assert quantity_again.status_code == 200, quantity_again.text
    detail = quantity_again.json()["item"]
    assert detail["current_value_cents"] == 4000
    assert detail["current_value_total_cents"] == 12000
    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    assert (
        len([event for event in history["items"] if event["action"] == "item.value_updated"]) == 1
    )


def test_current_value_validation_multicurrency_missing_and_zero_quantity(owner_client):
    usd = create_item(
        owner_client,
        "USD item",
        quantity=2,
        current_value_cents=4000,
        current_value_currency="USD",
    )
    eur = create_item(
        owner_client,
        "EUR item",
        quantity=3,
        current_value_cents=1000,
        current_value_currency="EUR",
    )
    empty = create_item(
        owner_client,
        "Zero quantity item",
        quantity=0,
        current_value_cents=5000,
        current_value_currency="USD",
    )
    missing = create_item(owner_client, "Missing value item")

    assert (
        owner_client.get(f"/api/v1/items/{usd['id']}").json()["item"]["current_value_total_cents"]
        == 8000
    )
    assert (
        owner_client.get(f"/api/v1/items/{eur['id']}").json()["item"]["current_value_total_cents"]
        == 3000
    )
    assert (
        owner_client.get(f"/api/v1/items/{empty['id']}").json()["item"]["current_value_total_cents"]
        == 0
    )
    assert (
        owner_client.get(f"/api/v1/items/{missing['id']}").json()["item"][
            "current_value_total_cents"
        ]
        is None
    )

    financial = owner_client.get("/api/v1/financial-overview").json()
    by_currency = {entry["currency"]: entry for entry in financial["currency_totals"]}
    assert by_currency["USD"]["current_value_total_cents"] == 8000
    assert by_currency["EUR"]["current_value_total_cents"] == 3000
    assert financial["exchange_rates_configured"] is False

    negative = owner_client.post(
        "/api/v1/items", json={"name": "Negative value", "current_value_cents": -1}
    )
    assert negative.status_code == 422
    overflow = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Overflow value",
            "quantity": 1_000_000,
            "current_value_cents": 1_000_000_000_000,
        },
    )
    assert overflow.status_code == 422, overflow.text
    assert overflow.json()["detail"]["code"] == "current_value_total_too_large"

    high_unit = create_item(
        owner_client,
        "High unit value",
        quantity=1,
        current_value_cents=1_000_000_000_000,
        current_value_currency="USD",
    )
    quantity_overflow = owner_client.patch(
        f"/api/v1/items/{high_unit['id']}", json={"quantity": 10_000}
    )
    assert quantity_overflow.status_code == 422, quantity_overflow.text
    assert quantity_overflow.json()["detail"]["code"] == "current_value_total_too_large"


def test_shared_purchase_total_is_counted_once_and_stays_separate_from_unit_values(owner_client):
    first = create_item(
        owner_client,
        "Shared sofa",
        quantity=2,
        current_value_cents=4000,
        current_value_currency="USD",
    )
    second = create_item(
        owner_client,
        "Shared chair",
        quantity=1,
        current_value_cents=1000,
        current_value_currency="USD",
    )
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={
            "merchant": "Furniture Studio",
            "purchase_date": "2026-03-01",
            "price_cents": 9000,
            "currency": "USD",
            "item_ids": [first["id"], second["id"]],
        },
    )
    assert purchase.status_code == 201, purchase.text

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["value_by_currency"] == [{"currency": "USD", "total_cents": 9000}]
    assert overview["current_value_by_currency"] == [{"currency": "USD", "total_cents": 9000}]

    financial = owner_client.get("/api/v1/financial-overview").json()
    by_currency = {entry["currency"]: entry for entry in financial["currency_totals"]}
    assert by_currency["USD"]["purchase_total_cents"] == 9000
    assert by_currency["USD"]["current_value_total_cents"] == 9000

    inventory = parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    by_name = {row["item"]: row for row in inventory}
    assert by_name["Shared sofa"]["purchase_total_cents"] == "9000"
    assert by_name["Shared sofa"]["purchase_total_scope"].startswith("purchase transaction total")
    assert by_name["Shared sofa"]["current_value_unit_cents"] == "4000"
    assert by_name["Shared sofa"]["current_value_total_cents"] == "8000"
    assert by_name["Shared chair"]["current_value_total_cents"] == "1000"
