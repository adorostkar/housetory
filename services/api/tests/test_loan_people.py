import uuid

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import HouseholdMember, User
from housetory_api.security import hash_password
from housetory_api.services.auth import create_session
from tests.test_cross_household import _other_household_headers


def create_room(client, name, headers=None):
    response = client.post("/api/v1/rooms", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, headers=None, quantity=10):
    response = client.post(
        "/api/v1/items",
        json={"name": name, "room_id": room_id, "quantity": quantity},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(client, item_id, borrower="Sam", **overrides):
    payload = {
        "item_id": item_id,
        "borrower_name": borrower,
        "quantity": 1,
        "lent_on": "2026-01-01",
        "due_on": "2026-01-10",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    response = client.post("/api/v1/loans", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def return_loan(client, loan_id, quantity=1):
    response = client.post(
        f"/api/v1/loans/{loan_id}/returns",
        json={
            "quantity": quantity,
            "returned_on": "2026-02-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def cancel_loan(client, loan_id):
    response = client.post(
        f"/api/v1/loans/{loan_id}/cancel",
        json={"reason": "Test cleanup", "request_id": str(uuid.uuid4())},
    )
    assert response.status_code == 200, response.text
    return response.json()


def create_borrowed(client, owner="Ali", **overrides):
    payload = {
        "item_name": "Borrowed tool",
        "owner_name": owner,
        "quantity": 1,
        "borrowed_on": "2026-01-01",
        "due_on": "2026-01-10",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    response = client.post("/api/v1/borrowed", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def return_borrowed(client, record_id, quantity=1):
    response = client.post(
        f"/api/v1/borrowed/{record_id}/returns",
        json={
            "quantity": quantity,
            "returned_on": "2026-02-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def cancel_borrowed(client, record_id):
    response = client.post(
        f"/api/v1/borrowed/{record_id}/cancel",
        json={"reason": "Test cleanup", "request_id": str(uuid.uuid4())},
    )
    assert response.status_code == 200, response.text
    return response.json()


def suggestions(client, query="", headers=None):
    response = client.get(
        "/api/v1/loans/people",
        params={"q": query} if query else {},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def household_id(client):
    return client.get("/api/v1/auth/session").json()["household"]["id"]


def _viewer_headers(owner_client):
    with SessionLocal() as db:
        user = User(
            name="Viewer Person",
            email="loan-people-viewer@example.com",
            password_hash=hash_password("viewer-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=uuid.UUID(household_id(owner_client)),
                user_id=user.id,
                role="viewer",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="loan-people-test",
            ip_address="127.0.0.1",
            household_id=uuid.UUID(household_id(owner_client)),
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def test_name_suggestions_include_both_directions_and_exclude_cancelled_phantoms(
    owner_client,
):
    room = create_room(owner_client, "Loan names room")
    item = create_item(owner_client, "Shared drill", room["id"])
    outstanding = create_loan(owner_client, item["id"], borrower="Jack", quantity=2)
    returned = create_loan(owner_client, item["id"], borrower="Jack")
    return_loan(owner_client, returned["id"])
    create_loan(owner_client, item["id"], borrower="John")

    borrowed_open = create_borrowed(owner_client, owner="Jack")
    borrowed_returned = create_borrowed(owner_client, owner="Jack")
    return_borrowed(owner_client, borrowed_returned["id"])
    create_borrowed(owner_client, owner="John")

    ghost = create_loan(owner_client, item["id"], borrower="Ghost")
    cancel_loan(owner_client, ghost["id"])
    ghost_borrowed = create_borrowed(owner_client, owner="Ghost")
    cancel_borrowed(owner_client, ghost_borrowed["id"])

    body = suggestions(owner_client, "J")
    assert body["total"] == 2
    people = {entry["name"]: entry for entry in body["items"]}
    assert set(people) == {"Jack", "John"}
    assert people["Jack"] == {
        "name": "Jack",
        "lent_open": 1,
        "borrowed_open": 1,
        "lent_total": 2,
        "borrowed_total": 2,
        "last_activity_on": "2026-01-01",
    }
    assert people["John"]["lent_open"] == 1
    assert people["John"]["borrowed_open"] == 1
    assert people["John"]["lent_total"] == 1
    assert people["John"]["borrowed_total"] == 1

    assert suggestions(owner_client, "Gh")["items"] == []
    explicit_cancelled = owner_client.get(
        "/api/v1/loans",
        params={"status": "cancelled", "person": "Ghost"},
    )
    assert explicit_cancelled.status_code == 200, explicit_cancelled.text
    assert [entry["id"] for entry in explicit_cancelled.json()["items"]] == [
        ghost["id"]
    ]

    # Recent names are available even before typing.
    all_names = suggestions(owner_client)
    assert all_names["total"] >= 2
    assert {"Jack", "John"} <= {entry["name"] for entry in all_names["items"]}

    # Sanity: the IDs above are stable API records.
    assert outstanding["borrower_name"] == "Jack"
    assert borrowed_open["owner_name"] == "Jack"


def test_names_are_trimmed_and_case_variants_group_for_filtering(owner_client):
    room = create_room(owner_client, "Trim room")
    item = create_item(owner_client, "Trim item", room["id"])
    spaced = create_loan(owner_client, item["id"], borrower="  Jack  ")
    lower = create_loan(owner_client, item["id"], borrower="jack")
    assert spaced["borrower_name"] == "Jack"

    body = suggestions(owner_client, "JAC")
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Jack"
    assert body["items"][0]["lent_open"] == 2

    filtered = owner_client.get(
        "/api/v1/loans", params={"status": "all", "person": "  jAcK  "}
    )
    assert {entry["id"] for entry in filtered.json()["items"]} == {
        spaced["id"],
        lower["id"],
    }
    assert {entry["borrower_name"] for entry in filtered.json()["items"]} == {
        "Jack",
        "jack",
    }


def test_person_filter_composes_with_direction_status_and_past_due(owner_client):
    room = create_room(owner_client, "Filter room")
    item = create_item(owner_client, "Filter item", room["id"])
    jack_open = create_loan(owner_client, item["id"], borrower="Jack", quantity=2)
    jack_returned = create_loan(owner_client, item["id"], borrower="jack")
    return_loan(owner_client, jack_returned["id"])
    john = create_loan(owner_client, item["id"], borrower="John")
    jackie = create_loan(owner_client, item["id"], borrower="Jackie")

    borrowed_open = create_borrowed(owner_client, owner="Jack")
    borrowed_returned = create_borrowed(owner_client, owner="JACK")
    return_borrowed(owner_client, borrowed_returned["id"])
    create_borrowed(owner_client, owner="John")

    all_jack = owner_client.get(
        "/api/v1/loans", params={"status": "all", "person": "Jack"}
    )
    assert all_jack.status_code == 200, all_jack.text
    assert {entry["id"] for entry in all_jack.json()["items"]} == {
        jack_open["id"],
        jack_returned["id"],
    }

    returned_jack = owner_client.get(
        "/api/v1/loans", params={"status": "returned", "person": "jack"}
    )
    assert [entry["id"] for entry in returned_jack.json()["items"]] == [
        jack_returned["id"]
    ]

    overdue_jack = owner_client.get(
        "/api/v1/loans",
        params={"status": "open", "person": "Jack", "overdue": "true"},
    )
    assert [entry["id"] for entry in overdue_jack.json()["items"]] == [
        jack_open["id"]
    ]

    all_borrowed = owner_client.get(
        "/api/v1/borrowed", params={"status": "all", "person": "Jack"}
    )
    assert {entry["id"] for entry in all_borrowed.json()["items"]} == {
        borrowed_open["id"],
        borrowed_returned["id"],
    }
    returned_borrowed = owner_client.get(
        "/api/v1/borrowed", params={"status": "returned", "person": "JACK"}
    )
    assert [entry["id"] for entry in returned_borrowed.json()["items"]] == [
        borrowed_returned["id"]
    ]

    # Exact names win over a longer prefix: filtering Jack must not absorb Jackie.
    assert jackie["id"] not in {
        entry["id"] for entry in all_jack.json()["items"]
    }
    assert john["id"] not in {
        entry["id"] for entry in all_jack.json()["items"]
    }

    partial = owner_client.get(
        "/api/v1/loans", params={"status": "all", "person": "Jac"}
    )
    assert {entry["id"] for entry in partial.json()["items"]} == {
        jack_open["id"],
        jack_returned["id"],
        jackie["id"],
    }


def test_unicode_name_variants_group_without_rewriting_stored_spellings(owner_client):
    room = create_room(owner_client, "Unicode room")
    item = create_item(owner_client, "Unicode item", room["id"])
    arabic_yeh = create_loan(owner_client, item["id"], borrower="ياسمين")
    persian_yeh = create_loan(owner_client, item["id"], borrower="یاسمین")
    create_loan(owner_client, item["id"], borrower="Jack")
    create_loan(owner_client, item["id"], borrower="jack")

    yasmin = suggestions(owner_client, "یاس")
    assert yasmin["total"] == 1
    assert yasmin["items"][0]["lent_open"] == 2
    assert yasmin["items"][0]["name"] in {"ياسمين", "یاسمین"}

    filtered = owner_client.get(
        "/api/v1/loans", params={"status": "all", "person": "ياسمين"}
    )
    assert filtered.status_code == 200, filtered.text
    stored = [entry["borrower_name"] for entry in filtered.json()["items"]]
    assert set(stored) == {"ياسمين", "یاسمین"}
    assert {entry["id"] for entry in filtered.json()["items"]} == {
        arabic_yeh["id"],
        persian_yeh["id"],
    }

    jack = suggestions(owner_client, "JA")
    jack_people = [entry for entry in jack["items"] if entry["name"].casefold() == "jack"]
    assert len(jack_people) == 1
    assert jack_people[0]["lent_open"] == 2


def test_individual_contract_name_edits_do_not_rename_other_records(owner_client):
    room = create_room(owner_client, "Correction room")
    item = create_item(owner_client, "Correction item", room["id"])
    first = create_loan(owner_client, item["id"], borrower="Jamie")
    second = create_loan(owner_client, item["id"], borrower="Jamie")
    borrowed_first = create_borrowed(owner_client, owner="Jamie")
    borrowed_second = create_borrowed(owner_client, owner="Jamie")

    corrected = owner_client.patch(
        f"/api/v1/loans/{first['id']}",
        json={"borrower_name": "Jamie Chen", "request_id": str(uuid.uuid4())},
    )
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["borrower_name"] == "Jamie Chen"
    unchanged = owner_client.get(f"/api/v1/loans/{second['id']}").json()
    assert unchanged["borrower_name"] == "Jamie"

    corrected_borrowed = owner_client.patch(
        f"/api/v1/borrowed/{borrowed_first['id']}",
        json={"owner_name": "Jamie Chen", "request_id": str(uuid.uuid4())},
    )
    assert corrected_borrowed.status_code == 200, corrected_borrowed.text
    assert corrected_borrowed.json()["owner_name"] == "Jamie Chen"
    unchanged_borrowed = owner_client.get(
        f"/api/v1/borrowed/{borrowed_second['id']}"
    ).json()
    assert unchanged_borrowed["owner_name"] == "Jamie"

    people = {entry["name"]: entry for entry in suggestions(owner_client, "Jamie")["items"]}
    assert set(people) == {"Jamie", "Jamie Chen"}
    assert people["Jamie"]["lent_total"] == 1
    assert people["Jamie"]["borrowed_total"] == 1
    assert people["Jamie Chen"]["lent_total"] == 1
    assert people["Jamie Chen"]["borrowed_total"] == 1

    history = corrected.json()["history"]
    correction = next(event for event in history if event["action"] == "loan.corrected")
    assert correction["actor_name"] == "Ada Lovelace"
    assert correction["details"]["before"]["borrower_name"] == "Jamie"
    assert correction["details"]["after"]["borrower_name"] == "Jamie Chen"
    untouched_history = owner_client.get(f"/api/v1/loans/{second['id']}").json()["history"]
    assert all(event["action"] != "loan.corrected" for event in untouched_history)
    borrowed_history = corrected_borrowed.json()["history"]
    borrowed_correction = next(
        event for event in borrowed_history if event["action"] == "borrowed.corrected"
    )
    assert borrowed_correction["actor_name"] == "Ada Lovelace"
    assert borrowed_correction["details"]["before"]["owner_name"] == "Jamie"
    assert borrowed_correction["details"]["owner_name"] == "Jamie Chen"


def test_name_suggestions_and_person_filters_are_household_and_role_scoped(
    owner_client, anon_client
):
    room = create_room(owner_client, "Scoped room")
    item = create_item(owner_client, "Scoped item", room["id"])
    create_loan(owner_client, item["id"], borrower="Household Jack")
    create_borrowed(owner_client, owner="Household Jack")

    other = _other_household_headers("loan-people-other@example.com", "Other Owner")
    other_room = create_room(owner_client, "Other room", other["headers"])
    other_item = create_item(
        owner_client, "Other item", other_room["id"], other["headers"]
    )
    other_loan = owner_client.post(
        "/api/v1/loans",
        headers=other["headers"],
        json={
            "item_id": other_item["id"],
            "borrower_name": "Zed Other",
            "quantity": 1,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert other_loan.status_code == 201, other_loan.text

    assert suggestions(owner_client, "Zed")["items"] == []
    assert owner_client.get(
        "/api/v1/loans", params={"status": "all", "person": "Zed"}
    ).json()["total"] == 0
    assert suggestions(owner_client, "Household")["items"][0]["name"] == "Household Jack"

    viewer = _viewer_headers(owner_client)
    assert suggestions(owner_client, "Household", headers=viewer)["total"] == 1
    assert anon_client.get("/api/v1/loans/people").status_code == 401
