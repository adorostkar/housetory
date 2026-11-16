import csv
import io
import uuid

from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    Household,
    HouseholdMember,
    Item,
    Purchase,
    PurchaseAllocation,
    User,
)
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
    home = owner_client.get("/api/v1/overview", params={"include_financial": True}).json()
    assert home["financial"] == financial
    assert home["value_by_currency"] == overview["value_by_currency"]
    assert home["current_value_by_currency"] == overview["current_value_by_currency"]
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
            "purchase_allocated_cents": 0,
            "purchase_unallocated_cents": 0,
            "purchase_unallocated_count": 0,
            "purchase_over_allocated_cents": 0,
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


def purchase_allocations(client, purchase_id) -> list[dict]:
    response = client.get(f"/api/v1/purchases/{purchase_id}")
    assert response.status_code == 200, response.text
    return response.json()["allocations"]


def reconciled_totals(client) -> dict[str, dict]:
    """Per-currency totals, after checking they reconcile with both breakdowns."""
    financial = client.get("/api/v1/financial-overview").json()
    totals = {entry["currency"]: entry for entry in financial["currency_totals"]}
    for currency, entry in totals.items():
        assert entry["purchase_total_cents"] == (
            entry["purchase_allocated_cents"]
            - entry["purchase_over_allocated_cents"]
            + entry["purchase_unallocated_cents"]
        )
        for breakdown in ("value_by_room", "value_by_category"):
            shown = sum(
                row["purchase_total_cents"]
                for row in financial[breakdown]
                if row["currency"] == currency
            )
            assert shown == entry["purchase_allocated_cents"]
    return totals


def add_reviewed_allocation(purchase_id, item_id, line_id, cents) -> None:
    with SessionLocal() as db:
        purchase = db.get(Purchase, uuid.UUID(purchase_id))
        db.add(
            PurchaseAllocation(
                household_id=purchase.household_id,
                purchase_id=purchase.id,
                item_id=uuid.UUID(item_id),
                source_line_id=line_id,
                description="Reviewed line",
                quantity=1,
                line_total_cents=cents,
                allocated_cents=cents,
                currency=purchase.currency,
            )
        )
        db.commit()


def test_single_item_purchase_is_allocated_in_full_and_follows_its_price(owner_client):
    lamp = create_item(owner_client, "Lamp", purchase={"price_cents": 5000, "currency": "USD"})
    purchase_id = lamp["purchase"]["id"]
    [allocation] = purchase_allocations(owner_client, purchase_id)
    assert allocation["item_id"] == lamp["id"]
    assert allocation["source_line_id"] == "single-item"
    assert allocation["allocated_cents"] == 5000

    desk = create_item(owner_client, "Desk")
    created = owner_client.post(
        "/api/v1/purchases",
        json={"price_cents": 20000, "currency": "USD", "item_ids": [desk["id"]]},
    )
    assert created.status_code == 201, created.text
    assert [entry["allocated_cents"] for entry in created.json()["purchase"]["allocations"]] == [
        20000
    ]

    totals = reconciled_totals(owner_client)
    assert totals["USD"]["purchase_total_cents"] == 25000
    assert totals["USD"]["purchase_unallocated_cents"] == 0
    assert totals["USD"]["purchase_unallocated_count"] == 0

    edited = owner_client.patch(
        f"/api/v1/items/{lamp['id']}",
        json={"purchase": {"price_cents": 6000, "currency": "EUR"}},
    )
    assert edited.status_code == 200, edited.text
    [allocation] = purchase_allocations(owner_client, purchase_id)
    assert (allocation["allocated_cents"], allocation["currency"]) == (6000, "EUR")
    totals = reconciled_totals(owner_client)
    assert totals["EUR"]["purchase_allocated_cents"] == 6000
    assert totals["USD"]["purchase_allocated_cents"] == 20000


def test_editing_shared_purchase_through_one_item_keeps_reviewed_allocations(owner_client):
    sofa = create_item(owner_client, "Sofa")
    chair = create_item(owner_client, "Chair")
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={"price_cents": 9000, "currency": "USD", "item_ids": [sofa["id"], chair["id"]]},
    ).json()["purchase"]
    assert purchase["allocations"] == []
    add_reviewed_allocation(purchase["id"], sofa["id"], "line-1", 3000)
    add_reviewed_allocation(purchase["id"], chair["id"], "line-2", 4000)

    edited = owner_client.patch(
        f"/api/v1/items/{sofa['id']}", json={"purchase": {"price_cents": 10000}}
    )
    assert edited.status_code == 200, edited.text

    allocations = purchase_allocations(owner_client, purchase["id"])
    assert {entry["source_line_id"]: entry["allocated_cents"] for entry in allocations} == {
        "line-1": 3000,
        "line-2": 4000,
    }
    totals = reconciled_totals(owner_client)
    assert totals["USD"]["purchase_total_cents"] == 10000
    assert totals["USD"]["purchase_allocated_cents"] == 7000
    assert totals["USD"]["purchase_unallocated_cents"] == 3000


def test_shared_purchase_is_not_reassigned_when_one_item_is_archived(owner_client):
    sofa = create_item(owner_client, "Sofa")
    chair = create_item(owner_client, "Chair")
    purchase = owner_client.post(
        "/api/v1/purchases",
        json={"price_cents": 9000, "currency": "USD", "item_ids": [sofa["id"], chair["id"]]},
    ).json()["purchase"]
    archived = owner_client.patch(f"/api/v1/items/{chair['id']}", json={"is_archived": True})
    assert archived.status_code == 200, archived.text
    edited = owner_client.patch(
        f"/api/v1/items/{sofa['id']}", json={"purchase": {"price_cents": 9500}}
    )
    assert edited.status_code == 200, edited.text

    assert purchase_allocations(owner_client, purchase["id"]) == []
    totals = reconciled_totals(owner_client)
    assert totals["USD"]["purchase_total_cents"] == 9500
    assert totals["USD"]["purchase_allocated_cents"] == 0
    assert totals["USD"]["purchase_unallocated_cents"] == 9500
    assert totals["USD"]["purchase_unallocated_count"] == 1


def test_purchase_that_was_ever_shared_is_not_assumed_single_item_again(owner_client):
    def shared_then_single(release):
        lamp = create_item(owner_client, "Lamp", purchase={"price_cents": 5000, "currency": "USD"})
        purchase_id = lamp["purchase"]["id"]
        assert len(purchase_allocations(owner_client, purchase_id)) == 1
        shade = create_item(owner_client, "Shade", purchase_id=purchase_id)
        assert purchase_allocations(owner_client, purchase_id) == []
        release(shade)
        edited = owner_client.patch(
            f"/api/v1/items/{lamp['id']}", json={"purchase": {"price_cents": 5500}}
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["item"]["purchase"]["item_count"] == 1
        assert purchase_allocations(owner_client, purchase_id) == []

    def delete_link(shade):
        assert owner_client.delete(f"/api/v1/items/{shade['id']}").status_code == 204

    def relink(shade):
        other = create_item(owner_client, "Bulb", purchase={"price_cents": 700, "currency": "USD"})
        moved = owner_client.patch(
            f"/api/v1/items/{shade['id']}", json={"purchase_id": other["purchase"]["id"]}
        )
        assert moved.status_code == 200, moved.text
        # The purchase the link moved to is shared now, so it loses its own too.
        assert purchase_allocations(owner_client, other["purchase"]["id"]) == []

    shared_then_single(delete_link)
    shared_then_single(relink)

    totals = reconciled_totals(owner_client)
    assert totals["USD"]["purchase_total_cents"] == 5500 + 5500 + 700
    assert totals["USD"]["purchase_allocated_cents"] == 0
    assert totals["USD"]["purchase_unallocated_count"] == 3


def test_legacy_purchase_without_allocation_history_is_reported_unallocated(owner_client):
    lamp = create_item(owner_client, "Lamp", purchase={"price_cents": 5000, "currency": "USD"})
    create_item(owner_client, "Vase", purchase={"price_cents": 1200, "currency": "EUR"})
    create_item(owner_client, "Desk", purchase={"price_cents": 20000, "currency": "USD"})
    # Purchases recorded before allocations were written have no row at all.
    with SessionLocal() as db:
        for allocation in db.scalars(
            select(PurchaseAllocation).where(
                PurchaseAllocation.item_id == uuid.UUID(lamp["id"]),
            )
        ).all():
            db.delete(allocation)
        db.commit()

    edited = owner_client.patch(
        f"/api/v1/items/{lamp['id']}", json={"purchase": {"price_cents": 5100}}
    )
    assert edited.status_code == 200, edited.text
    assert purchase_allocations(owner_client, lamp["purchase"]["id"]) == []

    totals = reconciled_totals(owner_client)
    assert totals["USD"]["purchase_total_cents"] == 25100
    assert totals["USD"]["purchase_allocated_cents"] == 20000
    assert totals["USD"]["purchase_unallocated_cents"] == 5100
    assert totals["USD"]["purchase_unallocated_count"] == 1
    assert totals["EUR"]["purchase_unallocated_cents"] == 0

    inventory = {
        row["item"]: row for row in parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    }
    assert inventory["Lamp"]["purchase_allocation_status"] == "unallocated"
    assert inventory["Lamp"]["purchase_allocated_cents"] == ""
    assert inventory["Desk"]["purchase_allocation_status"] == "allocated"
    assert inventory["Desk"]["purchase_allocated_cents"] == "20000"


def representative_purchases(client) -> None:
    """Synthetic household covering every allocation state in two currencies.

    USD: two single-item purchases (5,000 + 20,000), a reviewed shared purchase
    (9,000 with 7,000 reviewed), a legacy purchase with no allocation (12,000),
    a shared purchase with an archived member (8,000) and an over-allocated
    reviewed purchase (10,000 with 11,500 reviewed).
    EUR: a single-item purchase (1,200), a legacy purchase (3,400) and a reviewed
    shared purchase (6,000) whose second reviewed line belongs to an archived item.
    """

    def single(name, cents, currency):
        return create_item(client, name, purchase={"price_cents": cents, "currency": currency})

    def shared(names, cents, currency, reviewed=()):
        items = [create_item(client, name) for name in names]
        response = client.post(
            "/api/v1/purchases",
            json={
                "price_cents": cents,
                "currency": currency,
                "item_ids": [item["id"] for item in items],
            },
        )
        assert response.status_code == 201, response.text
        purchase_id = response.json()["purchase"]["id"]
        for line, (item, line_cents) in enumerate(zip(items, reviewed, strict=False)):
            add_reviewed_allocation(purchase_id, item["id"], f"line-{line}", line_cents)
        return items

    def archive(item):
        response = client.patch(f"/api/v1/items/{item['id']}", json={"is_archived": True})
        assert response.status_code == 200, response.text

    def forget_allocation(item):
        # A purchase recorded before allocations were written has no row at all.
        with SessionLocal() as db:
            for allocation in db.scalars(
                select(PurchaseAllocation).where(
                    PurchaseAllocation.item_id == uuid.UUID(item["id"])
                )
            ).all():
                db.delete(allocation)
            db.commit()

    single("Lamp", 5000, "USD")
    single("Desk", 20000, "USD")
    shared(["Sofa", "Chair"], 9000, "USD", reviewed=(3000, 4000))
    forget_allocation(single("Rug", 12000, "USD"))
    archive(shared(["Table", "Bench"], 8000, "USD")[1])
    shared(["Mixer", "Bowl"], 10000, "USD", reviewed=(6000, 5500))

    single("Vase", 1200, "EUR")
    forget_allocation(single("Clock", 3400, "EUR"))
    archive(shared(["Plates", "Cups"], 6000, "EUR", reviewed=(2500, 2500))[1])


def test_representative_fixture_reconciles_per_currency_across_overview_and_export(owner_client):
    representative_purchases(owner_client)

    totals = reconciled_totals(owner_client)
    coverage = {
        currency: (
            entry["purchase_total_cents"],
            entry["purchase_allocated_cents"],
            entry["purchase_over_allocated_cents"],
            entry["purchase_unallocated_cents"],
            entry["purchase_unallocated_count"],
        )
        for currency, entry in totals.items()
    }
    assert coverage == {
        #       total, allocated, over-allocated, unallocated, unallocated purchases
        "USD": (64000, 43500, 1500, 22000, 3),
        "EUR": (10600, 3700, 0, 6900, 2),
    }
    for total, allocated, over_allocated, unallocated, _count in coverage.values():
        assert total == allocated - over_allocated + unallocated

    # The headline totals on the Overview are the same purchase totals.
    overview = owner_client.get("/api/v1/overview").json()
    assert {entry["currency"]: entry["total_cents"] for entry in overview["value_by_currency"]} == {
        "USD": 64000,
        "EUR": 10600,
    }

    # The inventory export allocates exactly what the Overview breakdowns show.
    rows = {
        row["item"]: row for row in parse_csv(owner_client.get("/api/v1/exports/inventory.csv"))
    }
    assert "Bench" not in rows and "Cups" not in rows
    exported: dict[str, int] = {}
    for row in rows.values():
        if row["purchase_allocated_cents"]:
            assert row["purchase_allocation_status"] == "allocated"
            exported[row["purchase_currency"]] = exported.get(row["purchase_currency"], 0) + int(
                row["purchase_allocated_cents"]
            )
    assert exported == {"USD": 43500, "EUR": 3700}
    assert {
        name: (row["purchase_allocation_status"], row["purchase_allocated_cents"])
        for name, row in rows.items()
    } == {
        "Lamp": ("allocated", "5000"),
        "Desk": ("allocated", "20000"),
        "Sofa": ("allocated", "3000"),
        "Chair": ("allocated", "4000"),
        "Rug": ("unallocated", ""),
        "Table": ("unallocated", ""),
        "Mixer": ("allocated", "6000"),
        "Bowl": ("allocated", "5500"),
        "Vase": ("allocated", "1200"),
        "Clock": ("unallocated", ""),
        "Plates": ("allocated", "2500"),
    }
