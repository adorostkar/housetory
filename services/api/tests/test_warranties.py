import uuid
from datetime import date, timedelta

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from housetory_api.db import engine
from housetory_api.models import Document, Item
from housetory_api.services.warranty_dashboard import (
    build_dashboard,
    load_dashboard,
    load_warranties,
)


def iso(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def create_item(client, name, warranty=None):
    response = client.post("/api/v1/items", json={"name": name, "warranty": warranty or {}})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_warranty_duration_computes_calendar_expiration(owner_client):
    item = create_item(
        owner_client,
        "Espresso Machine",
        {
            "provider": "La Marzocco",
            "start_date": "2026-01-31",
            "duration_months": 1,
            "notes": "Two-year boiler coverage",
        },
    )
    assert item["warranty"]["duration_months"] == 1
    assert item["warranty"]["end_date"] == "2026-02-28"
    assert item["warranty"]["coverage_notes"] == "Two-year boiler coverage"
    assert item["warranty"]["status"] == "expired"

    update = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"warranty": {"start_date": "2026-02-01", "duration_months": 24}},
    )
    assert update.status_code == 200, update.text
    warranty = update.json()["item"]["warranty"]
    assert warranty["start_date"] == "2026-02-01"
    assert warranty["duration_months"] == 24
    assert warranty["end_date"] == "2028-02-01"


def test_warranty_duration_requires_start(owner_client):
    response = owner_client.post(
        "/api/v1/items",
        json={"name": "Drill", "warranty": {"duration_months": 12}},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "warranty_start_required"


def test_warranty_status_dashboard_and_configurable_reminders(owner_client):
    create_item(owner_client, "Active", {"end_date": iso(200)})
    create_item(owner_client, "Expiring", {"end_date": iso(20)})
    create_item(owner_client, "Expired", {"end_date": iso(-2)})
    create_item(owner_client, "Open-ended", {"provider": "Unknown"})

    listing = owner_client.get("/api/v1/warranties").json()
    assert listing["active_count"] == 1
    assert listing["expiring_count"] == 1
    assert listing["expired_count"] == 1
    assert listing["unknown_count"] == 1
    assert listing["reminder_days"] == 30

    overview = owner_client.get("/api/v1/overview").json()
    warranty_dashboard = overview["warranties"]
    assert warranty_dashboard["active_count"] == 1
    assert warranty_dashboard["expiring_count"] == 1
    assert warranty_dashboard["expired_count"] == 1
    assert warranty_dashboard["expiring_soon"][0]["item"]["name"] == "Expiring"
    assert warranty_dashboard["expired"][0]["item"]["name"] == "Expired"
    assert overview["warranties_expiring_soon"] == 1

    expiring = owner_client.get("/api/v1/warranties", params={"status": "expiring"}).json()
    assert [entry["item"]["name"] for entry in expiring["items"]] == ["Expiring"]

    household = owner_client.patch("/api/v1/household", json={"warranty_reminder_days": 5})
    assert household.status_code == 200, household.text
    assert household.json()["warranty_reminder_days"] == 5

    listing = owner_client.get("/api/v1/warranties").json()
    assert listing["active_count"] == 2
    assert listing["expiring_count"] == 0
    assert listing["reminder_days"] == 5


def test_warranty_document_association(owner_client, pdf_bytes):
    item = create_item(owner_client, "Camera")
    document = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("warranty.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Warranty certificate", "document_type": "warranty_certificate"},
    ).json()

    updated = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"warranty": {"provider": "Camera Co", "document_id": document["id"]}},
    )
    assert updated.status_code == 200, updated.text
    warranty = updated.json()["item"]["warranty"]
    assert warranty["document_id"] == document["id"]
    assert warranty["document"]["title"] == "Warranty certificate"
    assert warranty["status"] == "unknown"


def test_warranty_reminder_override(owner_client):
    item = create_item(
        owner_client,
        "Printer",
        {"end_date": iso(20), "reminder_days": 10},
    )
    assert item["warranty"]["status"] == "active"
    assert item["warranty"]["effective_reminder_days"] == 10

    update = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"warranty": {"reminder_days": 30}}
    )
    assert update.status_code == 200, update.text
    assert update.json()["item"]["warranty"]["status"] == "expiring"
    assert update.json()["item"]["warranty"]["effective_reminder_days"] == 30


def test_dashboard_bounds_rich_loading_with_equivalent_counts_and_previews(
    owner_client, pdf_bytes, sql_statements
):
    for index in range(7):
        create_item(owner_client, f"Active {index}", {"end_date": iso(100 + index)})
        create_item(owner_client, f"Expiring {index}", {"end_date": iso(index)})
        create_item(owner_client, f"Expired {index}", {"end_date": iso(-index - 1)})
    create_item(owner_client, "Unknown", {"provider": "Open-ended"})
    archived = create_item(owner_client, "Archived", {"end_date": iso(1)})
    owner_client.patch(f"/api/v1/items/{archived['id']}", json={"is_archived": True})
    item = create_item(owner_client, "Override", {"end_date": iso(20), "reminder_days": 10})
    document = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("warranty.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Certificate", "document_type": "warranty_certificate"},
    ).json()
    owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"warranty": {"document_id": document["id"]}},
    )
    with Session(engine) as db:
        household_id = db.scalar(select(Item.household_id).where(Item.id == uuid.UUID(item["id"])))
        db.get(Document, uuid.UUID(document["id"])).extracted_text = "Full OCR body " * 2000
        db.commit()
        expected = build_dashboard(load_warranties(db, household_id), 30, limit=5)

    loaded_items = []

    def record_item(item, _context):
        loaded_items.append(item.id)

    sql_statements.clear()
    event.listen(Item, "load", record_item)
    try:
        with Session(engine) as db:
            actual = load_dashboard(db, household_id, 30, limit=5)
        assert actual == expected
        assert actual.active_count == 8
        assert actual.expiring_count == 7
        assert actual.expired_count == 7
        assert actual.unknown_count == 1
        assert actual.active[0].document.title == "Certificate"
        assert len(loaded_items) == 15
        assert len(sql_statements) == 2
        assert all("extracted_text" not in statement for statement in sql_statements)
        with Session(engine) as db:
            empty = load_dashboard(db, uuid.uuid4(), 30, limit=5)
        assert empty.active_count == empty.expiring_count == empty.expired_count == 0
        assert empty.unknown_count == 0
        assert empty.active == empty.expiring_soon == empty.expired == []
    finally:
        event.remove(Item, "load", record_item)
