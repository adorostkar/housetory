import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import func, select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.domain import ActivityAction
from housetory_api.models import (
    ActivityEvent,
    Category,
    Household,
    HouseholdMember,
    Room,
    Tag,
    User,
)
from housetory_api.schemas.bulk import BulkMoveRequest
from housetory_api.security import hash_password
from housetory_api.services import bulk as bulk_service
from housetory_api.services.auth import create_session


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_container(client, room_id, name):
    response = client.post(
        "/api/v1/containers",
        json={"room_id": room_id, "container_type": "box", "name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id=None, location_id=None, quantity=1):
    payload = {"name": name, "quantity": quantity}
    if room_id:
        payload["room_id"] = room_id
    if location_id:
        payload["storage_location_id"] = location_id
    response = client.post("/api/v1/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_tag(client, name):
    response = client.post("/api/v1/tags", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_category(client, name):
    response = client.post("/api/v1/categories", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_loan(client, item_id, quantity=1):
    response = client.post(
        "/api/v1/loans",
        json={
            "item_id": item_id,
            "borrower_name": "Bulk Borrower",
            "quantity": quantity,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def household_id(client) -> uuid.UUID:
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def bulk_move(client, item_ids, room_id, location_id=None, request_id=None):
    return client.post(
        "/api/v1/items/bulk/move",
        json={
            "item_ids": item_ids,
            "room_id": room_id,
            "storage_location_id": location_id,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def bulk_tags(client, item_ids, tag_ids, mode="add", request_id=None):
    return client.post(
        "/api/v1/items/bulk/tags",
        json={
            "item_ids": item_ids,
            "tag_ids": tag_ids,
            "mode": mode,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def bulk_category(client, item_ids, mode="set", category_id=None, request_id=None):
    return client.post(
        "/api/v1/items/bulk/category",
        json={
            "item_ids": item_ids,
            "mode": mode,
            "category_id": category_id,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


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
            user_agent="bulk-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def test_bulk_move_is_atomic_preserves_loans_and_records_batch_history(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    first_box = create_container(owner_client, office["id"], "Box one")
    second_box = create_container(owner_client, garage["id"], "Box two")
    first = create_item(owner_client, "Camera", office["id"], first_box["id"], 2)
    second = create_item(owner_client, "Tent", office["id"], None, 3)
    untouched = create_item(owner_client, "Lamp", garage["id"], None, 1)
    loan = create_loan(owner_client, first["id"], 1)

    request_id = str(uuid.uuid4())
    moved = bulk_move(
        owner_client,
        [first["id"], second["id"]],
        garage["id"],
        second_box["id"],
        request_id=request_id,
    )
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["selected_count"] == 2
    assert body["moved_count"] == 2
    assert body["selected_unit_count"] == 5
    assert body["on_loan_quantity"] == 1
    assert body["destination"]["room_id"] == garage["id"]
    assert body["destination"]["storage_location_id"] == second_box["id"]

    first_after = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    second_after = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    untouched_after = owner_client.get(f"/api/v1/items/{untouched['id']}").json()["item"]
    assert first_after["quantity"] == 2
    assert second_after["quantity"] == 3
    assert first_after["room"]["id"] == garage["id"]
    assert first_after["location"]["id"] == second_box["id"]
    assert second_after["location"]["id"] == second_box["id"]
    assert untouched_after["room"]["id"] == garage["id"]

    loan_after = owner_client.get(f"/api/v1/loans/{loan['id']}").json()
    assert loan_after["status"] == "outstanding"
    assert loan_after["outstanding_quantity"] == 1
    assert loan_after["home_room_name_snapshot"] == "Office"
    assert loan_after["home_location_name_snapshot"] == "Box one"

    history = owner_client.get(f"/api/v1/items/{first['id']}/history").json()
    move_event = next(event for event in history["items"] if event["action"] == "item.moved")
    assert move_event["details"]["batch"]["batch_id"] == body["batch_id"]
    assert move_event["details"]["batch"]["batch_action"] == ActivityAction.ITEMS_BULK_MOVED.value

    with SessionLocal() as db:
        batch_event = db.scalar(
            select(ActivityEvent).where(
                ActivityEvent.id == uuid.UUID(body["history_event_id"]),
                ActivityEvent.entity_type == "batch",
            )
        )
        assert batch_event is not None
        assert batch_event.action == ActivityAction.ITEMS_BULK_MOVED.value
        assert batch_event.details["moved_count"] == 2
        assert batch_event.details["result"]["batch_id"] == body["batch_id"]

    events_before = len(history["items"])
    repeated = bulk_move(
        owner_client,
        [first["id"], second["id"]],
        garage["id"],
        second_box["id"],
        request_id=request_id,
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["batch_id"] == body["batch_id"]
    history_repeated = owner_client.get(f"/api/v1/items/{first['id']}/history").json()
    assert len(history_repeated["items"]) == events_before
    with SessionLocal() as db:
        batch_count = int(
            db.scalar(
                select(func.count(ActivityEvent.id)).where(
                    ActivityEvent.request_id == uuid.UUID(request_id)
                )
            )
            or 0
        )
    assert batch_count == 1


def test_bulk_move_noop_mixed_and_atomic_validation(owner_client, anon_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    first = create_item(owner_client, "Camera", office["id"], None, 2)
    second = create_item(owner_client, "Tent", office["id"], None, 3)
    archived = create_item(owner_client, "Old Lamp", office["id"], None, 1)
    assert (
        owner_client.patch(
            f"/api/v1/items/{archived['id']}", json={"is_archived": True}
        ).status_code
        == 200
    )

    same = bulk_move(owner_client, [first["id"]], office["id"], None)
    assert same.status_code == 409
    assert same.json()["detail"]["code"] == "bulk_noop"

    partial = bulk_move(owner_client, [first["id"], second["id"]], garage["id"], None)
    assert partial.status_code == 200, partial.text
    assert partial.json()["moved_count"] == 2

    mixed_item = create_item(owner_client, "Mixed item", office["id"], None, 1)
    mixed = bulk_move(
        owner_client,
        [first["id"], mixed_item["id"]],
        garage["id"],
        None,
    )
    assert mixed.status_code == 200, mixed.text
    assert mixed.json()["moved_count"] == 1
    assert mixed.json()["unchanged_count"] == 1

    before = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    blocked = bulk_move(
        owner_client,
        [first["id"], archived["id"]],
        office["id"],
        None,
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "bulk_items_archived"
    after = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    assert after["room"]["id"] == before["room"]["id"]

    missing = bulk_move(
        owner_client,
        [first["id"], str(uuid.uuid4())],
        office["id"],
        None,
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "bulk_items_unavailable"
    assert (
        owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]["room"]["id"]
        == garage["id"]
    )

    duplicate = bulk_move(
        owner_client,
        [first["id"], first["id"]],
        office["id"],
        None,
    )
    assert duplicate.status_code == 422

    oversized = bulk_move(
        owner_client,
        [str(uuid.uuid4()) for _ in range(101)],
        office["id"],
        None,
    )
    assert oversized.status_code == 422

    viewer_token, _ = _add_member(owner_client, email="bulk-viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    forbidden = anon_client.post(
        "/api/v1/items/bulk/move",
        headers=viewer,
        json={
            "item_ids": [first["id"]],
            "room_id": office["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert forbidden.status_code == 403


def test_bulk_tags_add_remove_preserve_other_tags_and_are_idempotent(owner_client):
    office = create_room(owner_client, "Office")
    first = create_item(owner_client, "Camera", office["id"], None, 1)
    second = create_item(owner_client, "Lens", office["id"], None, 2)
    tag_one = create_tag(owner_client, "Fragile")
    tag_two = create_tag(owner_client, "Travel")
    tag_three = create_tag(owner_client, "Electronics")

    owner_client.patch(
        f"/api/v1/items/{first['id']}",
        json={"tag_ids": [tag_one["id"]]},
    )
    owner_client.patch(
        f"/api/v1/items/{second['id']}",
        json={"tag_ids": [tag_two["id"]]},
    )

    request_id = str(uuid.uuid4())
    added = bulk_tags(
        owner_client,
        [first["id"], second["id"]],
        [tag_two["id"], tag_three["id"], tag_three["id"]],
        request_id=request_id,
    )
    assert added.status_code == 200, added.text
    assert added.json()["updated_count"] == 2
    assert sorted(added.json()["tag_ids"]) == sorted([tag_two["id"], tag_three["id"]])
    first_after = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    second_after = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert {tag["id"] for tag in first_after["tags"]} == {
        tag_one["id"],
        tag_two["id"],
        tag_three["id"],
    }
    assert {tag["id"] for tag in second_after["tags"]} == {
        tag_two["id"],
        tag_three["id"],
    }

    repeated = bulk_tags(
        owner_client,
        [first["id"], second["id"]],
        [tag_three["id"], tag_two["id"]],
        request_id=request_id,
    )
    assert repeated.status_code == 200
    assert repeated.json()["batch_id"] == added.json()["batch_id"]

    removed = bulk_tags(
        owner_client,
        [first["id"], second["id"]],
        [tag_one["id"], tag_three["id"]],
        mode="remove",
    )
    assert removed.status_code == 200, removed.text
    first_after = owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]
    second_after = owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]
    assert {tag["id"] for tag in first_after["tags"]} == {tag_two["id"]}
    assert {tag["id"] for tag in second_after["tags"]} == {tag_two["id"]}

    noop = bulk_tags(owner_client, [first["id"]], [tag_two["id"]])
    assert noop.status_code == 409
    assert noop.json()["detail"]["code"] == "bulk_noop"

    empty = bulk_tags(owner_client, [first["id"]], [])
    assert empty.status_code == 422

    with SessionLocal() as db:
        batch_events = int(
            db.scalar(
                select(func.count(ActivityEvent.id)).where(
                    ActivityEvent.action == ActivityAction.ITEMS_BULK_TAGGED.value
                )
            )
            or 0
        )
    assert batch_events == 2


def test_bulk_category_set_clear_and_validation(owner_client):
    office = create_room(owner_client, "Office")
    first = create_item(owner_client, "Camera", office["id"], None, 1)
    second = create_item(owner_client, "Lens", office["id"], None, 1)
    one = create_category(owner_client, "Electronics")
    two = create_category(owner_client, "Photography")
    owner_client.patch(f"/api/v1/items/{first['id']}", json={"category_id": one["id"]})

    set_result = bulk_category(
        owner_client,
        [first["id"], second["id"]],
        category_id=two["id"],
    )
    assert set_result.status_code == 200, set_result.text
    assert set_result.json()["updated_count"] == 2
    assert (
        owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]["category"]["id"]
        == two["id"]
    )
    assert (
        owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]["category"]["id"]
        == two["id"]
    )

    noop = bulk_category(owner_client, [first["id"], second["id"]], category_id=two["id"])
    assert noop.status_code == 409

    cleared = bulk_category(owner_client, [first["id"], second["id"]], mode="clear")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["updated_count"] == 2
    assert owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]["category"] is None

    noop_clear = bulk_category(owner_client, [first["id"]], mode="clear")
    assert noop_clear.status_code == 409

    missing = bulk_category(owner_client, [first["id"]], category_id=str(uuid.uuid4()))
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "bulk_category_unavailable"

    invalid = bulk_category(owner_client, [first["id"]], mode="set")
    assert invalid.status_code == 422
    invalid_clear = bulk_category(
        owner_client,
        [first["id"]],
        mode="clear",
        category_id=one["id"],
    )
    assert invalid_clear.status_code == 422


def test_bulk_request_id_reuse_and_cross_household_isolation(owner_client, anon_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    item = create_item(owner_client, "Camera", office["id"], None, 1)
    tag = create_tag(owner_client, "Fragile")
    request_id = str(uuid.uuid4())
    moved = bulk_move(owner_client, [item["id"]], garage["id"], None, request_id=request_id)
    assert moved.status_code == 200, moved.text

    first = bulk_tags(owner_client, [item["id"]], [tag["id"]], request_id=request_id)
    assert first.status_code == 409
    assert first.json()["detail"]["code"] == "request_id_reused"

    with SessionLocal() as db:
        other = Household(name="Other Bulk Home")
        user = User(
            name="Other Bulk Owner",
            email="other-bulk@example.com",
            password_hash=hash_password("other-bulk-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="bulk-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        other_room = Room(household_id=other.id, name="Other Room")
        other_tag = Tag(household_id=other.id, name="Other Tag")
        other_category = Category(household_id=other.id, name="Other Category")
        db.add_all([other_room, other_tag, other_category])
        db.commit()
        other_room_id = str(other_room.id)
        other_tag_id = str(other_tag.id)
        other_category_id = str(other_category.id)
    headers = _headers(token)
    cross_move = anon_client.post(
        "/api/v1/items/bulk/move",
        headers=headers,
        json={
            "item_ids": [item["id"]],
            "room_id": other_room_id,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_move.status_code == 404
    cross_tag = anon_client.post(
        "/api/v1/items/bulk/tags",
        headers=headers,
        json={
            "item_ids": [item["id"]],
            "tag_ids": [other_tag_id],
            "mode": "add",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_tag.status_code == 404
    cross_category = anon_client.post(
        "/api/v1/items/bulk/category",
        headers=headers,
        json={
            "item_ids": [item["id"]],
            "mode": "set",
            "category_id": other_category_id,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_category.status_code == 404

    # The owner must not be able to use another household's destination or taxonomy.
    assert bulk_move(owner_client, [item["id"]], other_room_id, None).status_code == 404
    assert bulk_tags(owner_client, [item["id"]], [other_tag_id]).status_code == 404
    assert (
        bulk_category(
            owner_client,
            [item["id"]],
            category_id=other_category_id,
        ).status_code
        == 404
    )


def test_bulk_move_batch_undo_is_per_item_and_batch_not_undoable(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    first = create_item(owner_client, "Camera", office["id"], None, 1)
    second = create_item(owner_client, "Lens", office["id"], None, 1)
    moved = bulk_move(owner_client, [first["id"], second["id"]], garage["id"], None)
    assert moved.status_code == 200

    first_history = owner_client.get(f"/api/v1/items/{first['id']}/history").json()
    move_event = next(event for event in first_history["items"] if event["action"] == "item.moved")
    assert move_event["can_undo"] is True
    undone = owner_client.post(
        f"/api/v1/history/{move_event['id']}/undo",
        json={"request_id": str(uuid.uuid4())},
    )
    assert undone.status_code == 200, undone.text
    assert (
        owner_client.get(f"/api/v1/items/{first['id']}").json()["item"]["room"]["id"]
        == office["id"]
    )
    assert (
        owner_client.get(f"/api/v1/items/{second['id']}").json()["item"]["room"]["id"]
        == garage["id"]
    )

    with SessionLocal() as db:
        batch_event = db.get(ActivityEvent, uuid.UUID(moved.json()["history_event_id"]))
        assert batch_event is not None
        assert batch_event.entity_type == "batch"
        assert batch_event.undoes_event_id is None
        count_before = int(
            db.scalar(
                select(func.count(ActivityEvent.id)).where(
                    ActivityEvent.undoes_event_id == batch_event.id
                )
            )
            or 0
        )
    assert count_before == 0


def test_concurrent_same_request_bulk_move_is_single_winner(owner_client):
    office = create_room(owner_client, "Office")
    garage = create_room(owner_client, "Garage")
    first = create_item(owner_client, "Camera", office["id"], None, 1)
    second = create_item(owner_client, "Lens", office["id"], None, 1)
    household = household_id(owner_client)
    request_id = uuid.uuid4()

    def move():
        with SessionLocal() as db:
            result = bulk_service.bulk_move(
                db,
                household,
                BulkMoveRequest(
                    item_ids=[uuid.UUID(first["id"]), uuid.UUID(second["id"])],
                    room_id=uuid.UUID(garage["id"]),
                    storage_location_id=None,
                    request_id=request_id,
                ),
                actor_user_id=None,
                actor_name="Test",
            )
            db.commit()
            return result.batch_id

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _value: move(), range(2)))
    assert results[0] == results[1]
    with SessionLocal() as db:
        batch_count = int(
            db.scalar(
                select(func.count(ActivityEvent.id)).where(
                    ActivityEvent.request_id == request_id,
                    ActivityEvent.action == ActivityAction.ITEMS_BULK_MOVED.value,
                )
            )
            or 0
        )
    assert batch_count == 1
