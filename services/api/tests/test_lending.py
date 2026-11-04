import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from housetory_api.api.errors import ApiError
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.schemas.lending import LoanCreate, LoanReturnCreate
from housetory_api.security import hash_password
from housetory_api.services import history, lending
from housetory_api.services.auth import create_session


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name, container_type="box"):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": container_type, "name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, location_id=None, quantity=1):
    payload = {"name": name, "room_id": room_id, "quantity": quantity}
    if location_id is not None:
        payload["storage_location_id"] = location_id
    response = client.post("/api/v1/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(client, item_id, **overrides):
    payload = {
        "item_id": item_id,
        "borrower_name": "Sam",
        "quantity": 1,
        "lent_on": "2026-01-01",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    return client.post("/api/v1/loans", json=payload)


def create_return(client, loan_id, **overrides):
    payload = {
        "quantity": 1,
        "returned_on": "2026-01-05",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    return client.post(f"/api/v1/loans/{loan_id}/returns", json=payload)


def household_id(client) -> uuid.UUID:
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def _add_member(owner_client, *, email: str, role: str) -> tuple[str, uuid.UUID]:
    household = household_id(owner_client)
    with SessionLocal() as db:
        user = User(
            name=f"{role.title()} Person",
            email=email,
            password_hash=hash_password("member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(HouseholdMember(household_id=household, user_id=user.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="lending-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def test_partial_and_multiple_returns_preserve_owned_quantity(owner_client):
    room = create_room(owner_client, "Office")
    box = create_container(owner_client, room["id"], "Box 2")
    item = create_item(owner_client, "Ethernet cable", room["id"], box["id"], quantity=5)

    created = create_loan(
        owner_client,
        item["id"],
        quantity=2,
        borrower_name="Alex",
        due_on="2026-01-10",
    )
    assert created.status_code == 201, created.text
    loan = created.json()
    assert loan["status"] == "outstanding"
    assert loan["outstanding_quantity"] == 2
    assert loan["item_name"] == "Ethernet cable"

    summary = owner_client.get(f"/api/v1/items/{item['id']}/loans").json()
    assert summary["owned_quantity"] == 5
    assert summary["on_loan_quantity"] == 2
    assert summary["available_quantity"] == 3

    first_return = create_return(owner_client, loan["id"], quantity=1)
    assert first_return.status_code == 200, first_return.text
    assert first_return.json()["status"] == "partially_returned"
    assert first_return.json()["returned_quantity"] == 1

    second_return = create_return(owner_client, loan["id"], quantity=1)
    assert second_return.status_code == 200, second_return.text
    assert second_return.json()["status"] == "returned"
    assert second_return.json()["returned_quantity"] == 2

    summary = owner_client.get(f"/api/v1/items/{item['id']}/loans").json()
    assert summary["owned_quantity"] == 5
    assert summary["on_loan_quantity"] == 0
    assert summary["available_quantity"] == 5
    assert summary["outstanding_loan_count"] == 0

    latest = owner_client.get(f"/api/v1/loans/{loan['id']}").json()
    assert [entry["quantity"] for entry in latest["returns"]] == [1, 1]
    assert latest["history"][0]["action"] == "loan.returned"
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["quantity"] == 5


def test_over_lending_and_over_returning_are_rejected(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Drill", room["id"], quantity=3)
    first = create_loan(owner_client, item["id"], quantity=2)
    assert first.status_code == 201

    too_many = create_loan(owner_client, item["id"], quantity=2)
    assert too_many.status_code == 409
    assert too_many.json()["detail"]["code"] == "insufficient_available_stock"

    too_many_return = create_return(owner_client, first.json()["id"], quantity=3)
    assert too_many_return.status_code == 409
    assert too_many_return.json()["detail"]["code"] == "return_exceeds_outstanding"

    invalid_dates = create_loan(
        owner_client,
        item["id"],
        quantity=1,
        lent_on="2026-02-01",
        due_on="2026-01-01",
    )
    assert invalid_dates.status_code == 422


def test_retries_are_idempotent(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Camera", room["id"], quantity=2)
    request_id = str(uuid.uuid4())
    first = create_loan(owner_client, item["id"], request_id=request_id)
    assert first.status_code == 201
    loan_id = first.json()["id"]
    repeated = create_loan(owner_client, item["id"], request_id=request_id)
    assert repeated.status_code == 201
    assert repeated.json()["id"] == loan_id

    return_request = str(uuid.uuid4())
    one = create_return(owner_client, loan_id, request_id=return_request)
    assert one.status_code == 200
    two = create_return(owner_client, loan_id, request_id=return_request)
    assert two.status_code == 200
    latest = owner_client.get(f"/api/v1/loans/{loan_id}").json()
    assert latest["returned_quantity"] == 1
    assert len(latest["returns"]) == 1

    second = create_loan(owner_client, item["id"], quantity=1)
    assert second.status_code == 201
    reused = create_return(
        owner_client,
        second.json()["id"],
        request_id=return_request,
    )
    assert reused.status_code == 409
    assert reused.json()["detail"]["code"] == "request_id_reused"


def test_concurrent_lending_and_returns_do_not_oversell(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Tent", room["id"], quantity=3)
    household = household_id(owner_client)

    def lend(request_id: str):
        with SessionLocal() as db:
            try:
                lending.create_loan(
                    db,
                    household,
                    LoanCreate(
                        item_id=uuid.UUID(item["id"]),
                        borrower_name="Thread",
                        quantity=2,
                        lent_on=date(2026, 1, 1),
                        request_id=uuid.UUID(request_id),
                    ),
                    actor_user_id=None,
                    actor_name="Test",
                )
                db.commit()
                return "ok"
            except ApiError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lend, [str(uuid.uuid4()), str(uuid.uuid4())]))
    assert sorted(results) == ["insufficient_available_stock", "ok"]
    summary = owner_client.get(f"/api/v1/items/{item['id']}/loans").json()
    assert summary["on_loan_quantity"] == 2

    loan_id = summary["loans"][0]["id"]

    def do_return():
        with SessionLocal() as db:
            try:
                lending.create_return(
                    db,
                    household,
                    uuid.UUID(loan_id),
                    LoanReturnCreate(
                        quantity=2,
                        returned_on=date(2026, 1, 5),
                        request_id=uuid.uuid4(),
                    ),
                    actor_user_id=None,
                    actor_name="Test",
                )
                db.commit()
                return "ok"
            except ApiError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        return_results = list(pool.map(lambda _value: do_return(), range(2)))
    assert sorted(return_results) == ["loan_not_open", "ok"]
    latest = owner_client.get(f"/api/v1/loans/{loan_id}").json()
    assert latest["returned_quantity"] == 2


def test_quantity_archive_and_delete_rules_with_open_loans(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Projector", room["id"], quantity=4)
    loan = create_loan(owner_client, item["id"], quantity=3)
    assert loan.status_code == 201

    too_low = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 2})
    assert too_low.status_code == 409
    assert too_low.json()["detail"]["code"] == "quantity_below_loans"

    archived = owner_client.patch(f"/api/v1/items/{item['id']}", json={"is_archived": True})
    assert archived.status_code == 409
    deleted = owner_client.delete(f"/api/v1/items/{item['id']}")
    assert deleted.status_code == 409

    allowed = owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    assert allowed.status_code == 200
    assert allowed.json()["item"]["quantity"] == 3

    assert create_return(owner_client, loan.json()["id"], quantity=3).status_code == 200
    archived = owner_client.patch(f"/api/v1/items/{item['id']}", json={"is_archived": True})
    assert archived.status_code == 200
    assert owner_client.delete(f"/api/v1/items/{item['id']}").status_code == 204


def test_move_history_snapshots_and_safe_undo(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    shelf = create_container(owner_client, office["id"], "Shelf", "other")
    item = create_item(owner_client, "Router", office["id"], shelf["id"], quantity=1)

    moved = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"room_id": garage["id"], "storage_location_id": None},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["item"]["room"]["id"] == garage["id"]

    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    event = history["items"][0]
    assert event["action"] == "item.moved"
    assert event["details"]["from"]["room_name"] == "Office"
    assert event["details"]["from"]["location_name"] == "Shelf"
    assert event["details"]["to"]["room_name"] == "Garage"
    assert event["can_undo"] is True

    undo_request = str(uuid.uuid4())
    undo = owner_client.post(
        f"/api/v1/history/{event['id']}/undo",
        json={"request_id": undo_request},
    )
    assert undo.status_code == 200, undo.text
    restored = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert restored["room"]["id"] == office["id"]
    assert restored["location"]["id"] == shelf["id"]
    assert undo.json()["event"]["action"] == "item.move_undone"

    repeated = owner_client.post(
        f"/api/v1/history/{event['id']}/undo",
        json={"request_id": undo_request},
    )
    assert repeated.status_code == 200
    different = owner_client.post(
        f"/api/v1/history/{event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert different.status_code == 409


def test_container_move_history_is_inherited_not_duplicated(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    container = create_container(owner_client, office["id"], "Camping box")
    item = create_item(owner_client, "Lantern", office["id"], container["id"], quantity=2)

    moved = owner_client.post(
        f"/api/v1/containers/{container['id']}/move",
        json={"room_id": garage["id"], "parent_id": None},
    )
    assert moved.status_code == 200, moved.text

    container_history = owner_client.get(f"/api/v1/containers/{container['id']}/history").json()
    assert len(container_history["items"]) == 1
    event = container_history["items"][0]
    assert event["action"] == "container.moved"
    assert event["details"]["affected_item_count"] == 1
    assert event["details"]["affected_quantity"] == 2
    assert event["details"]["from_room_name"] == "Office"
    assert event["details"]["to_room_name"] == "Garage"

    item_history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    assert item_history["items"] == []

    undo = owner_client.post(
        f"/api/v1/history/{event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undo.status_code == 200, undo.text
    assert (
        owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["room"]["id"] == office["id"]
    )


def test_loan_creation_and_return_undo(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Camera", room["id"], quantity=2)
    loan_response = create_loan(owner_client, item["id"], quantity=2)
    loan = loan_response.json()

    history = owner_client.get(f"/api/v1/loans/{loan['id']}").json()["history"]
    created_event = next(event for event in history if event["action"] == "loan.created")
    undo = owner_client.post(
        f"/api/v1/history/{created_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undo.status_code == 200, undo.text
    cancelled = owner_client.get(f"/api/v1/loans/{loan['id']}").json()
    assert cancelled["status"] == "cancelled"
    summary = owner_client.get(f"/api/v1/items/{item['id']}/loans").json()
    assert summary["on_loan_quantity"] == 0

    loan_response = create_loan(owner_client, item["id"], quantity=2)
    loan = loan_response.json()
    assert create_return(owner_client, loan["id"], quantity=1).status_code == 200
    history = owner_client.get(f"/api/v1/loans/{loan['id']}").json()["history"]
    returned_event = next(event for event in history if event["action"] == "loan.returned")
    undo_return = owner_client.post(
        f"/api/v1/history/{returned_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undo_return.status_code == 200, undo_return.text
    latest = owner_client.get(f"/api/v1/loans/{loan['id']}").json()
    assert latest["returned_quantity"] == 0
    assert latest["status"] == "outstanding"


def test_undo_is_blocked_after_intervening_changes(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    item = create_item(owner_client, "Ladder", office["id"], quantity=2)
    owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"room_id": garage["id"], "storage_location_id": None},
    )
    history = owner_client.get(f"/api/v1/items/{item['id']}/history").json()
    first_event = history["items"][0]
    assert first_event["can_undo"] is True

    owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"room_id": office["id"], "storage_location_id": None},
    )
    blocked = owner_client.post(
        f"/api/v1/history/{first_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "undo_not_safe"

    loan = create_loan(owner_client, item["id"], quantity=2).json()
    assert create_return(owner_client, loan["id"], quantity=1).status_code == 200
    latest_history = owner_client.get(f"/api/v1/loans/{loan['id']}").json()["history"]
    returned_event = next(event for event in latest_history if event["action"] == "loan.returned")
    assert returned_event["can_undo"] is True
    owner_client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 1})
    blocked_return = owner_client.post(
        f"/api/v1/history/{returned_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert blocked_return.status_code == 409
    assert blocked_return.json()["detail"]["code"] == "undo_not_safe"


def test_overdue_filter_and_history_after_rename(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Saw", room["id"], quantity=1)
    loan = create_loan(
        owner_client,
        item["id"],
        quantity=1,
        due_on="2026-01-10",
    ).json()
    overdue = owner_client.get("/api/v1/loans?status=open&overdue=true&on_date=2026-01-11").json()
    assert overdue["total"] == 1
    assert overdue["items"][0]["overdue"] is True
    not_overdue = owner_client.get(
        "/api/v1/loans?status=open&overdue=true&on_date=2026-01-10"
    ).json()
    assert not_overdue["total"] == 0

    owner_client.patch(f"/api/v1/rooms/{room['id']}", json={"name": "Renamed Office"})
    history = owner_client.get(f"/api/v1/loans/{loan['id']}").json()["history"]
    created = next(event for event in history if event["action"] == "loan.created")
    assert created["details"]["home_room_name"] == "Office"


def test_overview_and_assistant_read_outstanding_loans(owner_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Ethernet cable", room["id"], quantity=3)
    loan = create_loan(owner_client, item["id"], quantity=2, borrower_name="Sam").json()
    assert loan["status"] == "outstanding"

    overview = owner_client.get("/api/v1/overview").json()
    assert overview["outstanding_loan_count"] == 1
    assert overview["on_loan_quantity"] == 2

    answer = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "What is on loan?"},
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["tool"] == "list_outstanding_loans"
    assert "Sam" in body["answer"]
    assert "Ethernet cable" in body["answer"]


def test_concurrent_undo_is_single_winner(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    item = create_item(owner_client, "Tripod", office["id"], quantity=1)
    owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"room_id": garage["id"], "storage_location_id": None},
    )
    event = owner_client.get(f"/api/v1/items/{item['id']}/history").json()["items"][0]
    household = household_id(owner_client)

    def undo(request_id: str):
        with SessionLocal() as db:
            try:
                history.undo_event(
                    db,
                    household,
                    uuid.UUID(event["id"]),
                    actor_user_id=None,
                    actor_name="Test",
                    request_id=uuid.UUID(request_id),
                )
                db.commit()
                return "ok"
            except ApiError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(undo, [str(uuid.uuid4()), str(uuid.uuid4())]))
    assert sorted(results) == ["already_undone", "ok"]
    restored = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert restored["room"]["id"] == office["id"]


def test_lending_cross_household_and_viewer_isolation(owner_client, anon_client):
    room = create_room(owner_client, "Office")
    item = create_item(owner_client, "Tool", room["id"], quantity=1)
    loan = create_loan(owner_client, item["id"]).json()

    viewer_token, _ = _add_member(owner_client, email="lending-viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    assert anon_client.get("/api/v1/loans", headers=viewer).status_code == 200
    forbidden = anon_client.post(
        "/api/v1/loans",
        headers=viewer,
        json={
            "item_id": item["id"],
            "borrower_name": "Blocked",
            "quantity": 1,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert forbidden.status_code == 403

    with SessionLocal() as db:
        other = Household(name="Other Home")
        user = User(
            name="Other Owner",
            email="other-lending@example.com",
            password_hash=hash_password("other-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="lending-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
    other_headers = _headers(token)
    assert anon_client.get(f"/api/v1/loans/{loan['id']}", headers=other_headers).status_code == 404
    assert (
        anon_client.get(f"/api/v1/items/{item['id']}/loans", headers=other_headers).status_code
        == 404
    )
    assert (
        anon_client.post(
            f"/api/v1/loans/{loan['id']}/returns",
            headers=other_headers,
            json={
                "quantity": 1,
                "returned_on": "2026-01-05",
                "request_id": str(uuid.uuid4()),
            },
        ).status_code
        == 404
    )
    event_id = owner_client.get(f"/api/v1/loans/{loan['id']}").json()["history"][0]["id"]
    assert (
        anon_client.post(
            f"/api/v1/history/{event_id}/undo",
            headers=other_headers,
            json={"request_id": str(uuid.uuid4())},
        ).status_code
        == 404
    )
