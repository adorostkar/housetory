import uuid

from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, StorageLocation, User
from housetory_api.services.auth import create_session


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, **extra):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, **extra):
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_borrowed(client, **overrides):
    payload = {
        "item_name": "Borrowed cable",
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


def other_household_headers(email="grace@example.com", name="Grace Hopper"):
    from housetory_api.config import get_settings

    with SessionLocal() as db:
        user = User(name=name, email=email, password_hash="not-used-in-this-test")
        household = Household(name=f"{name}'s Home")
        db.add_all([user, household])
        db.flush()
        db.add(HouseholdMember(user_id=user.id, household_id=household.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="security-test",
            ip_address="127.0.0.1",
        )
        db.commit()
        return {"Cookie": f"housetory_session={token}"}


def enable_storage(client, item_id, **body):
    response = client.post(f"/api/v1/items/{item_id}/storage", json=body)
    assert response.status_code == 200, response.text
    return response.json()["item"]


def test_item_storage_enable_idempotent_retains_ownership_and_counts_once(owner_client):
    room = create_room(owner_client, "Workshop")
    toolbox = create_item(
        owner_client,
        "Toolbox",
        room_id=room["id"],
        quantity=1,
        purchase={"vendor": "Hardware Co", "price_cents": 10000, "currency": "USD"},
        warranty={"provider": "Tool warranty", "end_date": "2030-01-01"},
        current_value_cents=5000,
        current_value_currency="USD",
    )
    enabled = enable_storage(owner_client, toolbox["id"])
    storage = enabled["storage"]
    assert storage["active"] is True
    assert storage["identifier"].startswith("CONT-")
    assert enabled["purchase"]["price_cents"] == 10000
    assert enabled["warranty"]["provider"] == "Tool warranty"
    assert enabled["current_value_cents"] == 5000

    again = enable_storage(owner_client, toolbox["id"])
    assert again["storage"]["location_id"] == storage["location_id"]
    with SessionLocal() as db:
        count = (
            db.query(StorageLocation)
            .filter(StorageLocation.owner_item_id == uuid.UUID(toolbox["id"]))
            .count()
        )
    assert count == 1

    child = create_item(
        owner_client,
        "Screwdriver set",
        room_id=room["id"],
        storage_location_id=storage["location_id"],
        quantity=1,
        current_value_cents=2500,
        current_value_currency="USD",
    )
    detail = owner_client.get(f"/api/v1/items/{toolbox['id']}").json()["item"]
    assert detail["storage"]["item_count"] == 1
    assert detail["storage"]["total_quantity"] == 1
    assert detail["storage"]["direct_item_count"] == 1
    assert detail["storage"]["categories"][0]["name"] == "Uncategorised"

    container = owner_client.get(f"/api/v1/containers/{storage['location_id']}").json()
    assert container["owner_item"]["id"] == toolbox["id"]
    assert container["owner_item_detail"]["warranty"]["provider"] == "Tool warranty"
    assert container["items"][0]["id"] == child["id"]

    financial = owner_client.get("/api/v1/financial-overview").json()
    assert financial["item_count"] == 2
    total = next(row for row in financial["currency_totals"] if row["currency"] == "USD")
    assert total["current_value_total_cents"] == 7500
    assert total["purchase_total_cents"] == 10000


def test_existing_container_ownership_create_link_and_unlink(owner_client):
    room = create_room(owner_client, "Lounge")
    tv_box = create_container(owner_client, room["id"], name="TV box")
    created = owner_client.post(
        f"/api/v1/containers/{tv_box['id']}/ownership",
        json={"name": "TV stand"},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["owner_item"]["name"] == "TV stand"
    owner_id = body["owner_item"]["id"]
    item = owner_client.get(f"/api/v1/items/{owner_id}").json()["item"]
    assert item["quantity"] == 1
    assert item["storage"]["location_id"] == tv_box["id"]
    assert item["storage"]["active"] is True

    second = create_container(owner_client, room["id"], name="Second box")
    conflict = owner_client.post(
        f"/api/v1/containers/{second['id']}/ownership",
        json={"item_id": owner_id},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "item_already_provides_storage"

    unlinked = owner_client.delete(f"/api/v1/containers/{tv_box['id']}/ownership")
    assert unlinked.status_code == 200, unlinked.text
    assert unlinked.json()["owner_item"] is None
    # The owned item remains an ordinary inventory item.
    remains = owner_client.get(f"/api/v1/items/{owner_id}")
    assert remains.status_code == 200
    assert remains.json()["item"]["storage"] is None

    # A deliberate link to an existing item is possible when it is co-located.
    item2 = create_item(owner_client, "TV stand second", room_id=room["id"])
    linked = owner_client.post(
        f"/api/v1/containers/{second['id']}/ownership",
        json={"item_id": item2["id"]},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["owner_item"]["id"] == item2["id"]

    renamed_item = owner_client.patch(
        f"/api/v1/items/{item2['id']}", json={"name": "TV stand renamed"}
    )
    assert renamed_item.status_code == 200, renamed_item.text
    assert (
        owner_client.get(f"/api/v1/containers/{second['id']}").json()["name"] == "TV stand renamed"
    )
    renamed_container = owner_client.patch(
        f"/api/v1/containers/{second['id']}", json={"name": "TV stand container renamed"}
    )
    assert renamed_container.status_code == 200, renamed_container.text
    assert (
        owner_client.get(f"/api/v1/items/{item2['id']}").json()["item"]["name"]
        == "TV stand container renamed"
    )


def test_item_storage_moves_with_item_bulk_and_rejects_cycles(owner_client):
    room_one = create_room(owner_client, "Room one")
    room_two = create_room(owner_client, "Room two")
    host = create_item(owner_client, "Rolling toolbox", room_id=room_one["id"])
    host = enable_storage(owner_client, host["id"])
    storage_id = host["storage"]["location_id"]
    child = create_item(
        owner_client,
        "Socket set",
        room_id=room_one["id"],
        storage_location_id=storage_id,
    )

    moved = owner_client.patch(
        f"/api/v1/items/{host['id']}",
        json={"room_id": room_two["id"], "storage_location_id": None},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["item"]["room"]["id"] == room_two["id"]
    assert moved.json()["item"]["storage"]["room_id"] == room_two["id"]
    child_detail = owner_client.get(f"/api/v1/items/{child['id']}").json()["item"]
    assert child_detail["room"]["id"] == room_two["id"]

    inside_self = owner_client.patch(
        f"/api/v1/items/{host['id']}",
        json={"room_id": room_two["id"], "storage_location_id": storage_id},
    )
    assert inside_self.status_code == 422
    assert inside_self.json()["detail"]["code"] == "storage_host_inside_itself"

    second = create_item(owner_client, "Second toolbox", room_id=room_two["id"])
    second = enable_storage(owner_client, second["id"])
    into_second = owner_client.patch(
        f"/api/v1/items/{host['id']}",
        json={"room_id": room_two["id"], "storage_location_id": second["storage"]["location_id"]},
    )
    assert into_second.status_code == 200, into_second.text
    cycle = owner_client.patch(
        f"/api/v1/items/{second['id']}",
        json={"room_id": room_two["id"], "storage_location_id": storage_id},
    )
    assert cycle.status_code == 422
    assert cycle.json()["detail"]["code"] == "storage_host_inside_itself"

    container_move = owner_client.post(
        f"/api/v1/containers/{storage_id}/move",
        json={"room_id": room_one["id"], "parent_id": None},
    )
    assert container_move.status_code == 409
    assert container_move.json()["detail"]["code"] == "owned_container_move_requires_item"

    bulk = owner_client.post(
        "/api/v1/items/bulk/move",
        json={
            "item_ids": [host["id"]],
            "room_id": room_one["id"],
            "storage_location_id": None,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert bulk.status_code == 200, bulk.text
    bulk_detail = owner_client.get(f"/api/v1/containers/{storage_id}").json()
    assert bulk_detail["room_id"] == room_one["id"]
    assert bulk_detail["total_item_count"] == 1
    child_after_bulk = owner_client.get(f"/api/v1/items/{child['id']}").json()["item"]
    assert child_after_bulk["room"]["id"] == room_one["id"]

    second_property = owner_client.post(
        "/api/v1/properties", json={"name": "Second property"}
    ).json()
    second_room = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Second property room", "property_id": second_property["id"]},
    ).json()
    cross_property = owner_client.patch(
        f"/api/v1/items/{host['id']}",
        json={"room_id": second_room["id"], "storage_location_id": None},
    )
    assert cross_property.status_code == 200, cross_property.text
    cross_container = owner_client.get(f"/api/v1/containers/{storage_id}").json()
    assert cross_container["property"]["id"] == second_property["id"]
    assert cross_container["room_id"] == second_room["id"]
    cross_child = owner_client.get(f"/api/v1/items/{child['id']}").json()["item"]
    assert cross_child["property"]["id"] == second_property["id"]


def test_storage_quantity_archive_delete_and_remove_guards(owner_client):
    room = create_room(owner_client, "Attic")
    host = create_item(owner_client, "Storage chest", room_id=room["id"])
    host = enable_storage(owner_client, host["id"])
    storage_id = host["storage"]["location_id"]
    child = create_item(
        owner_client,
        "Blankets",
        room_id=room["id"],
        storage_location_id=storage_id,
    )

    quantity = owner_client.patch(f"/api/v1/items/{host['id']}", json={"quantity": 2})
    assert quantity.status_code == 422
    assert quantity.json()["detail"]["code"] == "storage_item_quantity_required"
    archived = owner_client.patch(f"/api/v1/items/{host['id']}", json={"is_archived": True})
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "item_provides_storage"
    deleted = owner_client.delete(f"/api/v1/items/{host['id']}")
    assert deleted.status_code == 409
    assert deleted.json()["detail"]["code"] == "item_provides_storage"
    removed = owner_client.delete(f"/api/v1/items/{host['id']}/storage")
    assert removed.status_code == 409
    assert removed.json()["detail"]["code"] == "storage_not_empty"
    container_delete = owner_client.delete(f"/api/v1/containers/{storage_id}")
    assert container_delete.status_code == 409
    assert container_delete.json()["detail"]["code"] == "owned_location_delete_blocked"

    moved_child = owner_client.patch(
        f"/api/v1/items/{child['id']}",
        json={"storage_location_id": None},
    )
    assert moved_child.status_code == 200, moved_child.text
    removed = owner_client.delete(f"/api/v1/items/{host['id']}/storage")
    assert removed.status_code == 200, removed.text
    assert removed.json()["item"]["storage"]["active"] is False
    assert owner_client.get(f"/api/v1/containers/{storage_id}").status_code == 410
    restored = enable_storage(owner_client, host["id"])
    assert restored["storage"]["location_id"] == storage_id
    assert restored["storage"]["active"] is True


def test_lending_parent_only_and_included_contents_are_independent(owner_client):
    room = create_room(owner_client, "Garage")
    host = create_item(owner_client, "Toolbox", room_id=room["id"])
    host = enable_storage(owner_client, host["id"])
    storage_id = host["storage"]["location_id"]
    drill = create_item(
        owner_client,
        "Cordless drill",
        room_id=room["id"],
        storage_location_id=storage_id,
        quantity=2,
    )
    create_item(
        owner_client,
        "Drill bits",
        room_id=room["id"],
        storage_location_id=storage_id,
    )
    create_borrowed(
        owner_client,
        item_name="Neighbour borrowed sander",
        storage_location_id=storage_id,
    )

    options = owner_client.get(f"/api/v1/items/{host['id']}/loan-options").json()
    assert options["has_contents"] is True
    assert {entry["item_name"] for entry in options["contents_items"]} == {
        "Cordless drill",
        "Drill bits",
    }
    assert options["contents_available_quantity"] == 3
    assert any(
        entry["item_name"] == "Neighbour borrowed sander"
        and "Borrowed from another owner" in entry["reason"]
        for entry in options["excluded_items"]
    )

    parent_only = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": host["id"],
            "borrower_name": "Jo",
            "quantity": 1,
            "lent_on": "2026-02-01",
            "due_on": "2026-02-10",
            "include_contents": False,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert parent_only.status_code == 201, parent_only.text
    assert parent_only.json()["includes_contents"] is False
    assert parent_only.json()["contents_loans"] == []
    assert owner_client.get(f"/api/v1/items/{drill['id']}/loans").json()["on_loan_quantity"] == 0

    returned = owner_client.post(
        f"/api/v1/loans/{parent_only.json()['id']}/returns",
        json={
            "quantity": 1,
            "returned_on": "2026-02-11",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert returned.status_code == 200, returned.text

    # A partially loaned child contributes only its at-home units to the plan.
    child_loan = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": drill["id"],
            "borrower_name": "Sam",
            "quantity": 1,
            "lent_on": "2026-02-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert child_loan.status_code == 201, child_loan.text
    options = owner_client.get(f"/api/v1/items/{host['id']}/loan-options").json()
    drill_option = next(
        entry for entry in options["contents_items"] if entry["item_id"] == drill["id"]
    )
    assert drill_option["available_quantity"] == 1
    assert options["contents_available_quantity"] == 2

    included_request_id = str(uuid.uuid4())
    included = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": host["id"],
            "borrower_name": "Jo",
            "quantity": 1,
            "lent_on": "2026-03-01",
            "due_on": "2026-03-10",
            "include_contents": True,
            "request_id": included_request_id,
        },
    )
    assert included.status_code == 201, included.text
    included_body = included.json()
    assert included_body["includes_contents"] is True
    assert len(included_body["contents_loans"]) == 2
    assert {child["borrower_name"] for child in included_body["contents_loans"]} == {"Jo"}
    assert {child["due_on"] for child in included_body["contents_loans"]} == {"2026-03-10"}
    quantities = {
        child["item_name"]: child["quantity"] for child in included_body["contents_loans"]
    }
    assert quantities == {"Cordless drill": 1, "Drill bits": 1}

    parent_correct = owner_client.patch(
        f"/api/v1/loans/{included_body['id']}",
        json={
            "borrower_name": "Different",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert parent_correct.status_code == 409
    assert parent_correct.json()["detail"]["code"] == "loan_has_contents"
    parent_cancel = owner_client.post(
        f"/api/v1/loans/{included_body['id']}/cancel",
        json={"request_id": str(uuid.uuid4())},
    )
    assert parent_cancel.status_code == 409
    assert parent_cancel.json()["detail"]["code"] == "loan_has_contents"

    parent_return = owner_client.post(
        f"/api/v1/loans/{included_body['id']}/returns",
        json={
            "quantity": 1,
            "returned_on": "2026-03-05",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert parent_return.status_code == 200, parent_return.text
    assert parent_return.json()["outstanding_quantity"] == 0
    for child in included_body["contents_loans"]:
        child_detail = owner_client.get(f"/api/v1/loans/{child['id']}").json()
        assert child_detail["outstanding_quantity"] == 1

    # Request replay returns the same parent and does not duplicate child loans.
    replay = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": host["id"],
            "borrower_name": "Jo",
            "quantity": 1,
            "lent_on": "2026-03-01",
            "due_on": "2026-03-10",
            "include_contents": True,
            "request_id": included_request_id,
        },
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == included_body["id"]
    assert (
        len(owner_client.get(f"/api/v1/loans/{included_body['id']}").json()["contents_loans"]) == 2
    )


def test_item_move_undo_moves_storage_and_child_room(owner_client):
    room_one = create_room(owner_client, "Undo one")
    room_two = create_room(owner_client, "Undo two")
    host = create_item(owner_client, "Undo toolbox", room_id=room_one["id"])
    host = enable_storage(owner_client, host["id"])
    storage_id = host["storage"]["location_id"]
    child = create_item(
        owner_client,
        "Undo contents",
        room_id=room_one["id"],
        storage_location_id=storage_id,
    )
    moved = owner_client.patch(
        f"/api/v1/items/{host['id']}",
        json={"room_id": room_two["id"], "storage_location_id": None},
    )
    assert moved.status_code == 200, moved.text
    history = owner_client.get(f"/api/v1/items/{host['id']}/history").json()
    event = next(entry for entry in history["items"] if entry["action"] == "item.moved")
    undone = owner_client.post(
        f"/api/v1/history/{event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undone.status_code == 200, undone.text
    host_after = owner_client.get(f"/api/v1/items/{host['id']}").json()["item"]
    assert host_after["room"]["id"] == room_one["id"]
    container_after = owner_client.get(f"/api/v1/containers/{storage_id}").json()
    assert container_after["room_id"] == room_one["id"]
    child_after = owner_client.get(f"/api/v1/items/{child['id']}").json()["item"]
    assert child_after["room"]["id"] == room_one["id"]


def test_container_evidence_scope_includes_owner_item_once(owner_client):
    room = create_room(owner_client, "Evidence room")
    host = create_item(owner_client, "Evidence toolbox", room_id=room["id"])
    host = enable_storage(owner_client, host["id"])
    child = create_item(
        owner_client,
        "Evidence contents",
        room_id=room["id"],
        storage_location_id=host["storage"]["location_id"],
    )
    preview = owner_client.post(
        "/api/v1/evidence-exports/preview",
        json={
            "scope": {"container_ids": [host["storage"]["location_id"]]},
            "include_archived": False,
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["item_count"] == 2
    assert {entry["id"] for entry in body["items"]} == {host["id"], child["id"]}


def test_owned_container_cannot_be_deleted_through_place_transfer(owner_client):
    room = create_room(owner_client, "Place guard")
    destination = create_room(owner_client, "Place guard destination")
    host = create_item(owner_client, "Guard box item", room_id=room["id"])
    host = enable_storage(owner_client, host["id"])
    storage_id = host["storage"]["location_id"]
    preview = owner_client.get(
        f"/api/v1/place-management/locations/{storage_id}/preview",
        params={"destination_room_id": destination["id"]},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert any("owned item" in warning for warning in body["warnings"])
    blocked = owner_client.post(
        f"/api/v1/place-management/locations/{storage_id}/transfer",
        json={
            "destination_room_id": destination["id"],
            "destination_location_id": None,
            "delete_source": True,
            "expected_fingerprint": body["fingerprint"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"]["code"] == "owned_location_delete_blocked"


def test_storage_routes_are_household_scoped(owner_client, anon_client):
    room = create_room(owner_client, "Private room")
    host = create_item(owner_client, "Private box", room_id=room["id"])
    headers = other_household_headers()
    response = anon_client.post(
        f"/api/v1/items/{host['id']}/storage",
        json={},
        headers=headers,
    )
    assert response.status_code == 404
    container = create_container(owner_client, room["id"], name="Private container")
    linked = anon_client.post(
        f"/api/v1/containers/{container['id']}/ownership",
        json={"item_id": host["id"]},
        headers=headers,
    )
    assert linked.status_code == 404
