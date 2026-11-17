import uuid

from housetory_api.db import SessionLocal
from housetory_api.models import Item


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_borrowed(client, **overrides):
    payload = {
        "item_name": "Cable borrowed",
        "owner_name": "Ali",
        "quantity": 1,
        "borrowed_on": "2026-01-01",
        "due_on": "2026-01-10",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    response = client.post("/api/v1/borrowed", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_search_reports_exact_owned_total_and_separate_borrowed_records(owner_client):
    room = create_room(owner_client, "Cable room")
    for index in range(51):
        response = owner_client.post(
            "/api/v1/items",
            json={
                "name": f"Cable owned {index + 1:02d}",
                "room_id": room["id"],
                "quantity": 1,
            },
        )
        assert response.status_code == 201, response.text
    borrowed_one = create_borrowed(
        owner_client,
        item_name="Cable borrowed one",
        room_id=room["id"],
        quantity=2,
    )
    borrowed_two = create_borrowed(
        owner_client,
        item_name="Cable borrowed two",
        owner_name="Mina",
        room_id=room["id"],
        quantity=1,
        due_on=None,
    )

    searched = owner_client.get("/api/v1/search/items", params={"q": "Cable", "limit": 50})
    assert searched.status_code == 200, searched.text
    body = searched.json()
    assert body["total"] == 51
    assert len(body["items"]) == 50
    assert body["borrowed_total"] == 2
    assert {record["id"] for record in body["borrowed"]} == {
        borrowed_one["id"],
        borrowed_two["id"],
    }
    assert all(record["direction"] == "borrowed" for record in body["borrowed"])

    quick = owner_client.get("/api/v1/search/quick", params={"q": "Ali"}).json()
    borrowed_quick = [result for result in quick["results"] if result["kind"] == "borrowed"]
    assert len(borrowed_quick) == 1
    assert borrowed_quick[0]["id"] == borrowed_one["id"]
    assert borrowed_quick[0]["title"] == "Cable borrowed one"
    assert "Borrowed from Ali" in (borrowed_quick[0]["subtitle"] or "")
    assert borrowed_quick[0]["url"] == f"/borrowed/{borrowed_one['id']}"

    # Bounded structured search reports the exact match count and an explicit cap.
    bounded = owner_client.post(
        "/api/v1/search/query", json={"query": "List cable", "explicit_ask": True}
    )
    assert bounded.status_code == 200, bounded.text
    bounded_body = bounded.json()
    assert bounded_body["tool"] == "search_items"
    assert bounded_body["facts"]["partitions"][0]["total"] == 51
    assert bounded_body["facts"]["quantity_total"] == 51
    assert "Found 51 matching owned items" in bounded_body["answer"]
    assert "first 30 are listed" in bounded_body["answer"]

    natural_bounded = owner_client.post(
        "/api/v1/search/query", json={"query": "List cable", "limit": 30}
    )
    assert natural_bounded.status_code == 200, natural_bounded.text
    natural_body = natural_bounded.json()
    assert natural_body["facts"]["partitions"][0]["total"] == 51
    assert len(natural_body["items"]) == 30
    assert "Found 51 matching owned items" in (natural_body["answer"] or "")

    # Only the owned records count as owned units; borrowed quantity is separate.
    summary = owner_client.post(
        "/api/v1/search/query", json={"query": "How many cables do I have?", "explicit_ask": True}
    )
    assert summary.status_code == 200, summary.text
    summary_body = summary.json()
    assert summary_body["tool"] == "count_items"
    assert summary_body["facts"]["partitions"][0]["total"] == 51
    assert "51 units across 51 matching item records" in summary_body["answer"]
    assert summary_body["facts"]["quantity_total"] == 51
    assert summary_body["facts"]["borrowed_total"] == 2
    assert summary_body["facts"]["borrowed_outstanding_quantity"] == 3
    assert "Separately" in summary_body["answer"]
    assert "not owned stock" in summary_body["answer"]

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["total_quantity"] == 51
    assert overview["item_count"] == 51
    with SessionLocal() as db:
        assert db.query(Item).count() == 51


def test_deterministic_borrowed_questions_need_no_ai(owner_client):
    room = create_room(owner_client, "Hall")
    record = create_borrowed(
        owner_client,
        item_name="Borrowed ladder",
        brand="Werner",
        owner_name="Ali",
        quantity=2,
        room_id=room["id"],
    )
    owned = owner_client.post(
        "/api/v1/items",
        json={"name": "Borrowed ladder", "room_id": room["id"], "quantity": 1},
    )
    assert owned.status_code == 201, owned.text

    need_return = owner_client.post(
        "/api/v1/search/query", json={"query": "What do I need to return?", "explicit_ask": True}
    )
    assert need_return.status_code == 200, need_return.text
    return_body = need_return.json()
    assert return_body["ai_used"] is False
    assert return_body["tool"] == "list_borrowed_items"
    assert return_body["borrowed"][0]["id"] == record["id"]
    assert "belongs to Ali" in return_body["answer"]
    assert "Borrowed ladder" in return_body["answer"]
    assert "2 outstanding" in return_body["answer"]
    reference = next(ref for ref in return_body["references"] if ref["type"] == "borrowed")
    assert reference["url"] == f"/borrowed/{record['id']}"

    who_owns = owner_client.post(
        "/api/v1/search/query",
        json={"query": "Who owns the borrowed ladder?", "explicit_ask": True},
    )
    assert who_owns.status_code == 200, who_owns.text
    owner_body = who_owns.json()
    assert owner_body["ai_used"] is False
    assert owner_body["tool"] == "find_borrowed_owner"
    assert "Ali" in owner_body["answer"]
    assert "household also owns" in owner_body["answer"]
    assert owner_body["facts"]["borrowed_total"] == 1
    assert owner_body["facts"]["owned_item_total"] == 1

    natural = owner_client.post("/api/v1/search/query", json={"query": "What do I need to return?"})
    assert natural.status_code == 200, natural.text
    natural_body = natural.json()
    assert natural_body["tool"] == "list_borrowed_items"
    assert natural_body["borrowed_total"] == 1
    assert natural_body["borrowed"][0]["owner_name"] == "Ali"
    assert natural_body["ai_used"] is False

    keyword_ask = owner_client.post("/api/v1/search/query", json={"query": "Ali"})
    assert keyword_ask.status_code == 200, keyword_ask.text
    keyword_body = keyword_ask.json()
    assert keyword_body["borrowed_total"] == 1
    assert keyword_body["borrowed"][0]["id"] == record["id"]

    on_loan = owner_client.post(
        "/api/v1/search/query", json={"query": "What is on loan?", "explicit_ask": True}
    )
    assert on_loan.status_code == 200, on_loan.text
    on_loan_body = on_loan.json()
    assert on_loan_body["tool"] == "list_outstanding_loans"
    assert on_loan_body["borrowed"] == []
    assert "No items are currently recorded as on loan" in on_loan_body["answer"]
