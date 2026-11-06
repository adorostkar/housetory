import uuid

import pytest
from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    AiProvider,
    AiTaskSetting,
    Household,
    HouseholdMember,
    Property,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services.auth import create_session


def household_id(client, headers: dict[str, str] | None = None) -> uuid.UUID:
    state = client.get("/api/v1/auth/session", headers=headers).json()
    return uuid.UUID(state["household"]["id"])


def current_headers(client, headers: dict[str, str] | None = None) -> dict[str, str]:
    return {**(headers or {}), "X-Household-Id": str(household_id(client, headers))}


def create_household(client, name: str, property_name: str = "Home") -> dict:
    response = client.post(
        "/api/v1/households",
        json={"name": name, "property_name": property_name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def switch(client, target: uuid.UUID, headers: dict[str, str] | None = None) -> dict:
    response = client.post(f"/api/v1/households/{target}/select", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def create_room(
    client,
    name: str,
    headers: dict[str, str] | None = None,
    *,
    property_id: str | None = None,
) -> dict:
    payload = {"name": name}
    if property_id is not None:
        payload["property_id"] = property_id
    response = client.post(
        "/api/v1/rooms",
        headers=current_headers(client, headers),
        json=payload,
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_property(client, name: str) -> dict:
    response = client.post(
        "/api/v1/properties",
        headers=current_headers(client),
        json={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(
    client,
    name: str,
    room_id: str,
    quantity: int = 1,
    headers: dict[str, str] | None = None,
) -> dict:
    response = client.post(
        "/api/v1/items",
        headers=current_headers(client, headers),
        json={"name": name, "room_id": room_id, "quantity": quantity},
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan(
    client,
    item_id: str,
    borrower: str = "Alex",
    quantity: int = 1,
    headers: dict[str, str] | None = None,
) -> dict:
    response = client.post(
        "/api/v1/loans",
        headers=current_headers(client, headers),
        json={
            "item_id": item_id,
            "borrower_name": borrower,
            "quantity": quantity,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def add_membership(
    *,
    email: str,
    household_names: list[tuple[str, str]],
) -> tuple[dict[str, str], User, list[uuid.UUID]]:
    with SessionLocal() as db:
        user = User(
            name=email.split("@")[0],
            email=email,
            password_hash=hash_password("multi-household-password-2026"),
        )
        db.add(user)
        db.flush()
        household_ids: list[uuid.UUID] = []
        for name, role in household_names:
            household = Household(name=name)
            db.add(household)
            db.flush()
            db.add(
                HouseholdMember(
                    household_id=household.id,
                    user_id=user.id,
                    role=role,
                )
            )
            household_ids.append(household.id)
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="multi-household-test",
            ip_address="127.0.0.1",
            household_id=household_ids[0],
        )
        db.commit()
        return {"Cookie": f"housetory_session={token}"}, user, household_ids


def test_household_listing_creation_switching_and_explicit_mutation_context(owner_client):
    initial = owner_client.get("/api/v1/auth/session").json()
    first_id = uuid.UUID(initial["household"]["id"])
    assert [entry["name"] for entry in initial["households"]] == ["Ada's Home"]

    created = create_household(owner_client, "Summer house", "Cabin")
    assert created["household"]["name"] == "Summer house"
    assert created["role"] == "owner"
    assert {entry["name"] for entry in created["households"]} == {
        "Ada's Home",
        "Summer house",
    }
    second_id = uuid.UUID(created["household"]["id"])
    properties = owner_client.get("/api/v1/properties").json()["items"]
    assert [entry["name"] for entry in properties] == ["Cabin"]

    # With two memberships a mutation must name the selected household.
    missing = owner_client.post("/api/v1/rooms", json={"name": "Loft"})
    assert missing.status_code == 409
    assert missing.json()["detail"]["code"] == "household_context_required"
    stale = owner_client.post(
        "/api/v1/rooms",
        headers={"X-Household-Id": str(first_id)},
        json={"name": "Loft"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "household_context_changed"
    room = create_room(owner_client, "Loft")
    assert room["property"]["name"] == "Cabin"

    switched = switch(owner_client, first_id)
    assert switched["household"]["id"] == str(first_id)
    assert switched["role"] == "owner"
    assert [entry["name"] for entry in switched["households"]] == [
        "Ada's Home",
        "Summer house",
    ]
    stale_after_switch = owner_client.post(
        "/api/v1/rooms",
        headers={"X-Household-Id": str(second_id)},
        json={"name": "Old tab room"},
    )
    assert stale_after_switch.status_code == 409
    assert stale_after_switch.json()["detail"]["code"] == "household_context_changed"
    assert create_room(owner_client, "Home office")["property"]["name"] == "Home"

    unauthorized = owner_client.post(f"/api/v1/households/{uuid.uuid4()}/select")
    assert unauthorized.status_code == 404
    assert unauthorized.json()["detail"]["code"] == "household_not_found"


def test_same_account_can_have_different_roles_in_different_households(owner_client, anon_client):
    headers, user, household_ids = add_membership(
        email="different-roles@example.com",
        household_names=[("Shared home", "viewer")],
    )
    shared_id = household_ids[0]
    with SessionLocal() as db:
        second = Household(name="Owned studio")
        db.add(second)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=second.id,
                user_id=user.id,
                role="owner",
            )
        )
        db.add(Property(household_id=second.id, name="Home", sort_order=0))
        db.commit()
        second_id = second.id

    state = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert state["household"]["id"] == str(shared_id)
    assert state["role"] == "viewer"
    blocked = anon_client.post(
        "/api/v1/rooms",
        headers={**headers, "X-Household-Id": str(shared_id)},
        json={"name": "No"},
    )
    assert blocked.status_code == 403

    switched = anon_client.post(f"/api/v1/households/{second_id}/select", headers=headers)
    assert switched.status_code == 200, switched.text
    assert switched.json()["role"] == "owner"
    created = anon_client.post(
        "/api/v1/rooms",
        headers={**headers, "X-Household-Id": str(second_id)},
        json={"name": "Studio room"},
    )
    assert created.status_code == 201, created.text


def test_revoked_membership_falls_back_or_enters_no_household_state(anon_client):
    headers, user, household_ids = add_membership(
        email="revoked@example.com",
        household_names=[("Keep home", "member"), ("Remove home", "viewer")],
    )
    keep_id, remove_id = household_ids
    selected = anon_client.post(f"/api/v1/households/{remove_id}/select", headers=headers)
    assert selected.status_code == 200
    assert selected.json()["household"]["id"] == str(remove_id)

    with SessionLocal() as db:
        membership = db.scalar(
            select(HouseholdMember).where(
                HouseholdMember.user_id == user.id,
                HouseholdMember.household_id == remove_id,
            )
        )
        assert membership is not None
        db.delete(membership)
        db.commit()

    state = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert state["household"]["id"] == str(keep_id)
    assert state["role"] == "member"
    assert [entry["id"] for entry in state["households"]] == [str(keep_id)]

    with SessionLocal() as db:
        membership = db.scalar(select(HouseholdMember).where(HouseholdMember.user_id == user.id))
        assert membership is not None
        db.delete(membership)
        db.commit()
    state = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert state["authenticated"] is True
    assert state["household"] is None
    assert state["role"] is None
    assert state["households"] == []


def test_all_my_places_search_returns_authorised_households_with_full_labels(
    owner_client, anon_client
):
    first_id = household_id(owner_client)
    first_room = create_room(owner_client, "Workshop")
    first_item = create_item(owner_client, "Cordless drill", first_room["id"], 2)
    create_loan(owner_client, first_item["id"], borrower="Alex")

    created = create_household(owner_client, "Cabin", "Cabin property")
    second_id = uuid.UUID(created["household"]["id"])
    second_room = create_room(owner_client, "Workshop")
    second_item = create_item(owner_client, "Cordless drill", second_room["id"], 1)

    search = owner_client.get("/api/v1/search/quick?q=Cordless%20drill")
    assert search.status_code == 200, search.text
    body = search.json()
    assert body["scope_label"] == "All my places"
    assert {entry["household"]["id"] for entry in body["results"]} == {
        str(first_id),
        str(second_id),
    }
    assert {entry["household"]["name"] for entry in body["results"]} == {
        "Ada's Home",
        "Cabin",
    }
    assert any(
        entry["loan"] and entry["loan"]["borrower_names"] == ["Alex"] for entry in body["results"]
    )

    scoped = owner_client.get(
        f"/api/v1/search/quick?q=Cordless%20drill&household_id={second_id}"
    ).json()
    assert [entry["id"] for entry in scoped["results"]] == [second_item["id"]]
    assert scoped["scope_label"] == "Cabin"

    items = owner_client.get("/api/v1/search/items?q=Cordless%20drill").json()
    assert items["total"] == 2
    assert {item["household"]["name"] for item in items["items"]} == {
        "Ada's Home",
        "Cabin",
    }
    assert {item["property"]["name"] for item in items["items"]} == {
        "Home",
        "Cabin property",
    }
    page_one = owner_client.get("/api/v1/search/items?q=Cordless%20drill&limit=1&offset=0").json()
    page_two = owner_client.get("/api/v1/search/items?q=Cordless%20drill&limit=1&offset=1").json()
    assert page_one["total"] == 2 and page_two["total"] == 2
    assert page_one["items"] and page_two["items"]
    assert page_one["items"][0]["id"] != page_two["items"][0]["id"]

    stranger_headers, _stranger, stranger_households = add_membership(
        email="stranger-search@example.com",
        household_names=[("Stranger home", "owner")],
    )
    assert (
        owner_client.get(
            f"/api/v1/search/quick?q=Cordless&household_id={stranger_households[0]}"
        ).status_code
        == 404
    )
    assert (
        owner_client.get(f"/api/v1/search/items?q=Cordless&household_id={uuid.uuid4()}").status_code
        == 404
    )
    assert (
        anon_client.get(
            f"/api/v1/search/items?q=Cordless&household_id={first_id}",
            headers=stranger_headers,
        ).status_code
        == 404
    )


def test_all_places_assistant_answers_loans_counts_and_cross_household_ambiguity_without_ai(
    owner_client, monkeypatch
):
    import housetory_api.services.assistant as assistant_service

    def forbidden(*_args, **_kwargs):
        raise AssertionError("All-my-places assistant must not call an AI provider")

    monkeypatch.setattr(assistant_service, "_ai_plan", forbidden)

    first_id = household_id(owner_client)
    first_room = create_room(owner_client, "Garage")
    drill = create_item(owner_client, "Heavy drill", first_room["id"], 2)
    create_loan(owner_client, drill["id"], borrower="Sam", quantity=1)
    unique = create_item(owner_client, "Tile cutter", first_room["id"], 3)
    create_loan(owner_client, unique["id"], borrower="Morgan", quantity=2)

    create_household(owner_client, "Cabin")
    cabin_room = create_room(owner_client, "Garage")
    create_item(owner_client, "Heavy drill", cabin_room["id"], 1)

    answer = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "Where is my heavy drill?", "history": []},
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["mode"] == "deterministic"
    assert body["facts"]["ambiguous"] is True
    assert "Cabin" in body["answer"] and "Ada's Home" in body["answer"]
    assert "Which one" in body["answer"]
    assert {item["household"]["name"] for item in body["items"]} == {
        "Ada's Home",
        "Cabin",
    }

    # A unique item still reports borrower and household-qualified home path.
    switch(owner_client, first_id)
    whereabouts = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "Where is my tile cutter?", "history": []},
    ).json()
    assert whereabouts["mode"] == "deterministic"
    assert "Morgan has 2 of your 3 units" in whereabouts["answer"]
    assert "Ada's Home / Home → Garage" in whereabouts["answer"]
    assert whereabouts["facts"]["whereabouts"]["household_name"] == "Ada's Home"

    count = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "How many heavy drills do I own?", "history": []},
    ).json()
    assert count["mode"] == "deterministic"
    assert count["facts"]["quantity_total"] == 3
    assert "3 units" in count["answer"]

    loans = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "What is on loan?", "history": []},
    ).json()
    assert loans["mode"] == "deterministic"
    assert loans["facts"]["outstanding_count"] >= 1
    assert "Morgan" in loans["answer"]

    natural = owner_client.post(
        "/api/v1/search/natural",
        json={"question": "Where is my heavy drill?", "limit": 20},
    ).json()
    assert natural["mode"] == "deterministic"
    assert natural["facts"]["ambiguous"] is True
    assert natural["households"]


def test_single_household_assistant_uses_only_that_households_provider(owner_client, monkeypatch):
    import housetory_api.services.assistant as assistant_service

    first_id = household_id(owner_client)
    created = create_household(owner_client, "Cabin")
    second_id = uuid.UUID(created["household"]["id"])
    with SessionLocal() as db:
        first_provider = AiProvider(
            household_id=first_id,
            provider="ollama",
            display_name="First local",
            base_url="http://127.0.0.1:11434",
            default_model="llama3",
        )
        second_provider = AiProvider(
            household_id=second_id,
            provider="ollama",
            display_name="Second local",
            base_url="http://127.0.0.1:11435",
            default_model="llama3",
        )
        db.add_all([first_provider, second_provider])
        db.flush()
        db.add_all(
            [
                AiTaskSetting(
                    household_id=first_id,
                    task="assistant",
                    provider_id=first_provider.id,
                    enabled=True,
                ),
                AiTaskSetting(
                    household_id=second_id,
                    task="assistant",
                    provider_id=second_provider.id,
                    enabled=True,
                ),
            ]
        )
        db.commit()
        first_provider_id = first_provider.id
        second_provider_id = second_provider.id

    captured = []

    def fake_complete_json(_system, _prompt, *, config):
        captured.append(config.provider_id)
        return {"tool": "get_inventory_summary", "arguments": {}, "rationale": "test"}

    monkeypatch.setattr(assistant_service.ai, "complete_json", fake_complete_json)
    monkeypatch.setattr(
        assistant_service.ai, "complete_text", lambda *_args, **_kwargs: "Grounded answer."
    )
    response = owner_client.post(
        "/api/v1/assistant/query",
        json={
            "question": "What should I consider for the balcony setup?",
            "history": [],
            "household_id": str(second_id),
        },
    )
    assert response.status_code == 200, response.text
    assert captured == [second_provider_id]

    switch(owner_client, first_id)
    captured.clear()
    response = owner_client.post(
        "/api/v1/assistant/query",
        json={
            "question": "What should I consider for the balcony setup?",
            "history": [],
            "household_id": str(first_id),
        },
    )
    assert response.status_code == 200, response.text
    assert captured == [first_provider_id]

    # All-my-places deliberately stays deterministic and does not call either.
    captured.clear()
    monkeypatch.setattr(assistant_service, "_ai_plan", lambda *_args, **_kwargs: None)
    response = owner_client.post(
        "/api/v1/assistant/query",
        json={"question": "What should I consider for the balcony setup?", "history": []},
    )
    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "deterministic"
    assert captured == []


def test_no_membership_account_can_create_first_household(anon_client):
    with SessionLocal() as db:
        user = User(
            name="No House",
            email="no-house@example.com",
            password_hash=hash_password("no-house-password-2026"),
        )
        db.add(user)
        db.flush()
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="no-house-test",
            ip_address="127.0.0.1",
        )
        db.commit()
    headers = {"Cookie": f"housetory_session={token}"}
    state = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert state["authenticated"] is True
    assert state["household"] is None
    assert state["households"] == []

    created = anon_client.post(
        "/api/v1/households",
        headers=headers,
        json={"name": "Fresh home", "property_name": "Main"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["household"]["name"] == "Fresh home"
    assert body["role"] == "owner"
    properties = anon_client.get("/api/v1/properties", headers=headers).json()["items"]
    assert [entry["name"] for entry in properties] == ["Main"]


@pytest.mark.parametrize("member_role", ["member", "viewer"])
def test_cross_household_search_is_limited_to_current_memberships(
    owner_client, anon_client, member_role
):
    first_id = household_id(owner_client)
    other_room = create_room(owner_client, "Secret room")
    other_item = create_item(owner_client, "Secret camera", other_room["id"])
    headers, _user, household_ids = add_membership(
        email=f"limited-{member_role}@example.com",
        household_names=[("Other private home", member_role)],
    )
    other_id = household_ids[0]

    result = anon_client.get(
        f"/api/v1/search/quick?q=Secret&household_id={first_id}", headers=headers
    )
    assert result.status_code == 404
    own = anon_client.get("/api/v1/search/quick?q=Secret", headers=headers).json()
    assert own["households"][0]["id"] == str(other_id)
    assert all(entry["household"]["id"] == str(other_id) for entry in own["results"])
    assert other_item["id"] not in {entry["id"] for entry in own["results"]}


def test_property_scoped_search_and_assistant_do_not_leak_other_properties(owner_client):
    session = owner_client.get("/api/v1/auth/session").json()
    home_id = session["household"]["id"]
    home = owner_client.get("/api/v1/properties").json()["items"][0]
    annex = create_property(owner_client, "Annex")
    home_room = create_room(owner_client, "Pantry", property_id=home["id"])
    annex_room = create_room(owner_client, "Pantry", property_id=annex["id"])
    create_item(owner_client, "Home snack", home_room["id"], 1)
    cabin_snack = create_item(owner_client, "Cabin snack", annex_room["id"], 2)

    quick = owner_client.get(
        f"/api/v1/search/quick?q=Cabin%20snack&household_id={home_id}&property_id={annex['id']}"
    ).json()
    assert [entry["id"] for entry in quick["results"]] == [cabin_snack["id"]]
    assert quick["property"]["name"] == "Annex"
    wrong_property = owner_client.get(
        f"/api/v1/search/quick?q=Cabin%20snack&household_id={home_id}&property_id={home['id']}"
    ).json()
    assert wrong_property["results"] == []

    leak_check = owner_client.post(
        "/api/v1/assistant/query",
        json={
            "question": "Where is my cabin snack?",
            "history": [],
            "household_id": home_id,
            "property_id": home["id"],
        },
    ).json()
    assert leak_check["mode"] == "deterministic"
    assert leak_check["items"] == []
    assert "couldn't find" in leak_check["answer"].lower()
    assert "Annex" not in leak_check["answer"]

    found = owner_client.post(
        "/api/v1/assistant/query",
        json={
            "question": "Where is my cabin snack?",
            "history": [],
            "household_id": home_id,
            "property_id": annex["id"],
        },
    ).json()
    assert found["items"][0]["id"] == cabin_snack["id"]
    assert "Annex" in found["answer"]
    assert found["property"]["name"] == "Annex"

    natural = owner_client.post(
        "/api/v1/search/natural",
        json={
            "question": "Where is my cabin snack?",
            "limit": 20,
            "household_id": home_id,
            "property_id": home["id"],
        },
    ).json()
    assert natural["items"] == []
    assert "Annex" not in str(natural["facts"])
