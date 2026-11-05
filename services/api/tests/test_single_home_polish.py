import uuid
from datetime import date, timedelta

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.schemas.ai import AiStatus
from housetory_api.security import hash_password
from housetory_api.services.auth import create_session


def create_room(client, name: str):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name: str, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(client, item_id: str, *, quantity: int, borrower: str, due_on: str | None):
    response = client.post(
        "/api/v1/loans",
        json={
            "item_id": item_id,
            "borrower_name": borrower,
            "quantity": quantity,
            "lent_on": (date.today() - timedelta(days=10)).isoformat(),
            "due_on": due_on,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def return_loan(client, loan_id: str, quantity: int):
    response = client.post(
        f"/api/v1/loans/{loan_id}/returns",
        json={
            "quantity": quantity,
            "returned_on": date.today().isoformat(),
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def ask(client, question: str):
    response = client.post("/api/v1/assistant/query", json={"question": question})
    assert response.status_code == 200, response.text
    return response.json()


def natural_search(client, question: str):
    response = client.post("/api/v1/search/natural", json={"question": question})
    assert response.status_code == 200, response.text
    return response.json()


def _viewer_headers(owner_client) -> dict[str, str]:
    household_id = owner_client.get("/api/v1/auth/session").json()["household"]["id"]
    with SessionLocal() as db:
        user = User(
            name="Read Only",
            email=f"viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=uuid.UUID(household_id),
                user_id=user.id,
                role="viewer",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="single-home-test",
            ip_address="127.0.0.1",
            household_id=uuid.UUID(household_id),
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def _other_household_headers() -> dict[str, str]:
    with SessionLocal() as db:
        user = User(
            name="Other Owner",
            email=f"other-{uuid.uuid4()}@example.com",
            password_hash=hash_password("other-password-2026"),
        )
        household = Household(name="Other Home")
        db.add_all([user, household])
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household.id,
                user_id=user.id,
                role="owner",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="single-home-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def test_exact_heavy_drill_whereabouts_is_loan_first_and_quantity_accurate(owner_client):
    workshop = create_room(owner_client, "Workshop")
    toolbox = owner_client.post(
        "/api/v1/containers",
        json={"room_id": workshop["id"], "container_type": "box", "name": "Power tools"},
    ).json()
    drill = create_item(
        owner_client,
        "Heavy drill",
        brand="Makita",
        quantity=3,
        room_id=workshop["id"],
        storage_location_id=toolbox["id"],
    )
    loan = create_loan(
        owner_client,
        drill["id"],
        quantity=2,
        borrower="Alex",
        due_on=(date.today() + timedelta(days=8)).isoformat(),
    )

    body = ask(owner_client, "where is my heavy drill")
    assert body["tool"] == "locate_item"
    whereabouts = body["facts"]["whereabouts"]
    assert whereabouts["owned_quantity"] == 3
    assert whereabouts["on_loan_quantity"] == 2
    assert whereabouts["at_home_quantity"] == 1
    assert whereabouts["loans"][0]["borrower_name"] == "Alex"
    assert whereabouts["loans"][0]["outstanding_quantity"] == 2
    assert whereabouts["loans"][0]["due_on"] == loan["due_on"]
    assert "Alex has 2 of your 3 units of Makita Heavy drill." in body["answer"]
    assert "The other 1 is at home in Home → Workshop → BOX-001 · Power tools." in body["answer"]
    assert "On loan:" not in body["answer"]
    assert "guarantee of return" not in body["answer"]
    assert body["answer"].index("Alex has") < body["answer"].index("at home")
    assert body["items"][0]["on_loan_quantity"] == 2
    assert body["references"][0]["type"] == "item"
    assert any(reference["type"] == "loan" for reference in body["references"])

    search_body = natural_search(owner_client, "where is my heavy drill")
    assert search_body["tool"] == "locate_item"
    assert search_body["answer"] == body["answer"]
    assert search_body["items"][0]["id"] == drill["id"]
    assert search_body["facts"]["whereabouts"]["on_loan_quantity"] == 2

    followup = owner_client.post(
        "/api/v1/assistant/query",
        json={
            "question": "when is it due?",
            "history": [
                {"role": "user", "content": "where is my heavy drill"},
                {"role": "assistant", "content": body["answer"]},
            ],
        },
    )
    assert followup.status_code == 200, followup.text
    assert followup.json()["tool"] == "locate_item"
    due_date = date.fromisoformat(loan["due_on"])
    due_human = f"{due_date.day} {due_date.strftime('%b %Y')}"
    assert due_human in followup.json()["answer"]

    quick = owner_client.get("/api/v1/search/quick", params={"q": "where is my heavy drill"}).json()
    assert quick["question_like"] is True
    assert quick["effective_query"] == "heavy drill"
    result = next(entry for entry in quick["results"] if entry["kind"] == "item")
    assert result["title"] == "Heavy drill"
    assert result["loan"]["on_loan_quantity"] == 2
    assert result["loan"]["borrower_names"] == ["Alex"]
    assert result["loan"]["next_due_on"] == loan["due_on"]
    assert (
        "On loan to Alex" in result["context"]
        or "On loan to Alex" in result["subtitle"]
        or result["loan"]["borrower_names"] == ["Alex"]
    )


def test_multiple_borrowers_and_missing_location_are_phrased_accurately(owner_client):
    tent = create_item(owner_client, "Tent", quantity=3)
    create_loan(
        owner_client,
        tent["id"],
        quantity=1,
        borrower="Mohsen",
        due_on="2026-11-20",
    )
    create_loan(
        owner_client,
        tent["id"],
        quantity=1,
        borrower="Alex",
        due_on=None,
    )
    answer = ask(owner_client, "where is my tent?")
    text = answer["answer"]
    assert "2 of your 3 units of Tent are on loan" in text
    assert "Mohsen has 1 (due 20 Nov 2026)" in text
    assert "Alex has 1" in text
    assert "No home location is recorded for the other 1." in text
    assert "On loan:" not in text
    assert "guarantee of return" not in text
    assert answer["facts"]["whereabouts"]["at_home_quantity"] == 1


def test_fully_loaned_returned_no_due_date_and_ambiguous_whereabouts(owner_client):
    room = create_room(owner_client, "Garage")
    fully_loaned = create_item(owner_client, "Heavy drill", quantity=2, room_id=room["id"])
    create_loan(
        owner_client,
        fully_loaned["id"],
        quantity=2,
        borrower="Sam",
        due_on=None,
    )
    answer = ask(owner_client, "Where is my heavy drill?")
    assert answer["facts"]["whereabouts"]["at_home_quantity"] == 0
    assert "Sam has your Heavy drill." in answer["answer"]
    assert "No return date is set." in answer["answer"]
    assert "You normally keep it in Home → Garage." in answer["answer"]
    assert "fully on loan" not in answer["answer"]
    assert "not recorded there" not in answer["answer"]
    assert "is at home in" not in answer["answer"]

    returned = create_item(owner_client, "Heavy drill spare", quantity=1, room_id=room["id"])
    created = create_loan(
        owner_client,
        returned["id"],
        quantity=1,
        borrower="Jordan",
        due_on=None,
    )
    return_loan(owner_client, created["id"], 1)
    returned_answer = ask(owner_client, "Where is my heavy drill spare?")
    assert returned_answer["facts"]["whereabouts"]["on_loan_quantity"] == 0
    assert "recorded at home in Home → Garage" in returned_answer["answer"]
    assert "No open loan is recorded" in returned_answer["answer"]

    create_item(owner_client, "Cordless drill", quantity=1, room_id=room["id"])
    create_item(owner_client, "Drill press", quantity=1, room_id=room["id"])
    ambiguous = ask(owner_client, "where is my drill?")
    assert ambiguous["tool"] == "locate_item"
    assert ambiguous["facts"]["ambiguous"] is True
    assert "could match" in ambiguous["answer"]
    assert "Cordless drill" in ambiguous["answer"]
    assert "Drill press" in ambiguous["answer"]
    assert "Which one did you mean?" in ambiguous["answer"]
    assert ambiguous["facts"]["whereabouts"] is None

    missing = ask(owner_client, "where is my jetpack?")
    assert missing["facts"]["total"] == 0
    assert "couldn't find" in missing["answer"]
    assert missing["items"] == []


def test_whereabouts_and_unified_search_are_household_scoped_and_viewer_safe(owner_client):
    room = create_room(owner_client, "Workshop")
    drill = create_item(owner_client, "Heavy drill", quantity=2, room_id=room["id"])
    create_loan(
        owner_client,
        drill["id"],
        quantity=1,
        borrower="Alex",
        due_on=None,
    )

    other = _other_household_headers()
    other_answer = owner_client.post(
        "/api/v1/assistant/query",
        headers=other,
        json={"question": "where is my heavy drill"},
    ).json()
    assert other_answer["facts"]["total"] == 0
    assert "Heavy drill" not in other_answer["answer"]
    other_quick = owner_client.get(
        "/api/v1/search/quick",
        headers=other,
        params={"q": "where is my heavy drill"},
    ).json()
    assert other_quick["results"] == []

    viewer = _viewer_headers(owner_client)
    viewer_answer = owner_client.post(
        "/api/v1/assistant/query",
        headers=viewer,
        json={"question": "where is my heavy drill"},
    )
    assert viewer_answer.status_code == 200
    assert "Alex" in viewer_answer.json()["answer"]
    before = owner_client.get("/api/v1/items").json()["total"]
    assert (
        owner_client.get("/api/v1/search/quick", headers=viewer, params={"q": "drill"}).status_code
        == 200
    )
    assert owner_client.get("/api/v1/items", headers=viewer).json()["total"] == before


def test_purchase_information_states_are_explicit_and_consistent(owner_client):
    room = create_room(owner_client, "Office")

    recorded = create_item(
        owner_client,
        "Recorded camera",
        room_id=room["id"],
        purchase={
            "merchant": "Shop",
            "purchase_date": "2026-01-01",
            "price_cents": 10000,
            "currency": "USD",
        },
    )
    assert recorded["purchase_info_status"] == "recorded"
    assert recorded["purchase_info_missing_fields"] == []

    unknown = create_item(
        owner_client,
        "Unknown lamp",
        room_id=room["id"],
        purchase_info_status="unknown",
    )
    assert unknown["purchase_info_status"] == "unknown"

    not_applicable = create_item(
        owner_client,
        "Inherited table",
        room_id=room["id"],
        purchase_info_status="not_applicable",
    )
    assert not_applicable["purchase_info_status"] == "not_applicable"

    legacy = create_item(owner_client, "Legacy chair", room_id=room["id"])
    assert legacy["purchase_info_status"] == "unrecorded"

    date_only = create_item(
        owner_client,
        "Date only",
        room_id=room["id"],
        purchase={"purchase_date": "2026-02-01", "currency": "USD"},
    )
    assert date_only["purchase_info_status"] == "recorded"
    assert date_only["purchase_info_missing_fields"] == ["price"]

    price_only = create_item(
        owner_client,
        "Price only",
        room_id=room["id"],
        purchase={"price_cents": 5000, "currency": "USD"},
    )
    assert price_only["purchase_info_status"] == "recorded"
    assert price_only["purchase_info_missing_fields"] == ["date"]

    missing = owner_client.get("/api/v1/items", params={"purchase_info": "missing"}).json()
    names = {item["name"] for item in missing["items"]}
    assert names == {"Unknown lamp", "Legacy chair"}
    assert (
        owner_client.get("/api/v1/items", params={"purchase_info": "not_applicable"}).json()[
            "items"
        ][0]["name"]
        == "Inherited table"
    )
    assert (
        owner_client.get("/api/v1/items", params={"purchase_info": "missing_date"}).json()["items"][
            0
        ]["name"]
        == "Price only"
    )
    assert (
        owner_client.get("/api/v1/items", params={"purchase_info": "missing_price"}).json()[
            "items"
        ][0]["name"]
        == "Date only"
    )

    answer = ask(owner_client, "Which items have no purchase information?")
    answer_names = {item["name"] for item in answer["items"]}
    assert answer_names == {"Unknown lamp", "Legacy chair"}
    assert "Unknown lamp" in answer["answer"]
    assert "Inherited table" not in answer["answer"]

    search = natural_search(owner_client, "Which items have no purchase information?")
    assert search["filters"]["missing_purchase"] is True
    assert {item["name"] for item in search["items"]} == answer_names

    overview = owner_client.get("/api/v1/financial-overview").json()
    assert overview["items_missing_purchase_count"] == 2

    with_purchase = owner_client.patch(
        f"/api/v1/items/{unknown['id']}",
        json={
            "purchase_info_status": "not_applicable",
            "purchase": {
                "merchant": "Gift",
                "purchase_date": "2026-03-01",
                "price_cents": 1200,
                "currency": "USD",
            },
        },
    )
    assert with_purchase.status_code == 200, with_purchase.text
    changed = with_purchase.json()["item"]
    assert changed["purchase_info_status"] == "not_applicable"
    assert changed["purchase"]["price_cents"] == 1200
    assert changed["purchase_info_missing_fields"] == []
    assert (
        owner_client.get("/api/v1/items", params={"purchase_info": "missing"}).json()["total"] == 1
    )

    cleared = owner_client.patch(
        f"/api/v1/items/{unknown['id']}",
        json={"purchase_info_status": "auto"},
    ).json()["item"]
    assert cleared["purchase_info_status"] == "recorded"
    assert cleared["purchase"]["merchant"] == "Gift"

    inventory = owner_client.get("/api/v1/exports/inventory.csv").text
    assert "purchase_info_status" in inventory
    assert "not_applicable" in inventory


def test_natural_search_falls_back_cleanly_when_ai_output_is_invalid(owner_client, monkeypatch):
    from housetory_api.services import assistant as assistant_service

    room = create_room(owner_client, "Attic")
    create_item(owner_client, "Camera Body", room_id=room["id"])
    fake_status = AiStatus(
        provider="ollama",
        mode="local",
        model="search-model",
        configured=True,
        available=True,
        privacy_note="Local",
    )
    monkeypatch.setattr(assistant_service.ai, "status_for", lambda *args, **kwargs: fake_status)

    def invalid(*args, **kwargs):
        raise assistant_service.ai.AiInvalidOutput("not json")

    monkeypatch.setattr(assistant_service.ai, "complete_json", invalid)
    body = natural_search(owner_client, "Find camera")
    assert body["mode"] == "deterministic"
    assert "AI interpretation unavailable" in body["interpretation"]
    assert body["items"]
    assert body["answer"]
