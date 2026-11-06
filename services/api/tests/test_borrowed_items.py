import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from PIL import Image

from housetory_api.api.errors import ApiError
from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    BorrowedRecord,
    Household,
    HouseholdMember,
    Item,
    Property,
    User,
)
from housetory_api.schemas.borrowed import BorrowedCreate, BorrowedReturnCreate
from housetory_api.security import hash_password
from housetory_api.services import borrowed as borrowed_service
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


def create_item(client, name, room_id, location_id=None, quantity=1):
    payload = {"name": name, "room_id": room_id, "quantity": quantity}
    if location_id is not None:
        payload["storage_location_id"] = location_id
    response = client.post("/api/v1/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_borrowed(client, room_id=None, container_id=None, **overrides):
    payload = {
        "item_name": "Borrowed drill",
        "brand": "DeWalt",
        "model": "DCD-900",
        "owner_name": "Ali",
        "quantity": 3,
        "borrowed_on": "2026-01-01",
        "due_on": "2026-01-10",
        "room_id": room_id,
        "storage_location_id": container_id,
        "notes": "Handle carefully; Ali's spare set.",
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    response = client.post("/api/v1/borrowed", json=payload)
    return response


def create_return(client, record_id, **overrides):
    payload = {
        "quantity": 1,
        "returned_on": "2026-01-05",
        "notes": None,
        "request_id": str(uuid.uuid4()),
        **overrides,
    }
    return client.post(f"/api/v1/borrowed/{record_id}/returns", json=payload)


def household_id(client) -> uuid.UUID:
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def _add_member(client, *, email: str, role: str) -> tuple[str, uuid.UUID]:
    household = household_id(client)
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
            user_agent="borrowed-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def _other_household_headers(email: str) -> dict[str, str]:
    with SessionLocal() as db:
        other = Household(name=f"Other Home {email}")
        user = User(
            name="Other Owner",
            email=email,
            password_hash=hash_password("other-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(Property(household_id=other.id, name="Other Home property"))
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="borrowed-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
    return _headers(token)


def _png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (48, 48), (90, 120, 150)).save(output, format="PNG")
    return output.getvalue()


def test_borrowed_record_is_not_owned_stock_and_partial_returns_are_append_only(owner_client):
    room = create_room(owner_client, "Workshop")
    container = create_container(owner_client, room["id"], "Shelf box")
    owned_item = create_item(owner_client, "Owned drill", room["id"], container["id"], quantity=2)

    before_items = owner_client.get("/api/v1/items").json()
    before_overview = owner_client.get("/api/v1/overview").json()

    created = create_borrowed(owner_client, room["id"], container["id"])
    assert created.status_code == 201, created.text
    record = created.json()
    assert record["item_name"] == "Borrowed drill"
    assert record["brand"] == "DeWalt"
    assert record["owner_name"] == "Ali"
    assert record["quantity"] == 3
    assert record["outstanding_quantity"] == 3
    assert record["physically_held_quantity"] == 3
    assert record["returned_quantity"] == 0
    assert record["status"] == "outstanding"
    assert record["room_name"] == "Workshop"
    assert record["storage_location_name"] == "Shelf box"
    assert record["direction"] == "borrowed"
    assert record["photo"] is None

    after_items = owner_client.get("/api/v1/items").json()
    after_overview = owner_client.get("/api/v1/overview").json()
    assert after_items["total"] == before_items["total"] == 1
    assert {item["id"] for item in after_items["items"]} == {owned_item["id"]}
    assert after_overview["total_quantity"] == before_overview["total_quantity"] == 2
    with SessionLocal() as db:
        assert db.query(Item).count() == 1
        assert db.query(BorrowedRecord).count() == 1

    listed = owner_client.get("/api/v1/borrowed", params={"status": "open"}).json()
    assert listed["total"] == 1
    assert listed["open_count"] == 1
    assert listed["total_borrowed_quantity"] == 3
    assert listed["returned_quantity"] == 0
    assert listed["outstanding_quantity"] == 3
    assert listed["physically_held_quantity"] == 3

    return_request_id = str(uuid.uuid4())
    first = create_return(owner_client, record["id"], quantity=1, request_id=return_request_id)
    assert first.status_code == 200, first.text
    partial = first.json()
    assert partial["status"] == "partially_returned"
    assert partial["returned_quantity"] == 1
    assert partial["outstanding_quantity"] == 2
    assert partial["physically_held_quantity"] == 2
    assert len(partial["returns"]) == 1

    replay = create_return(
        owner_client,
        record["id"],
        quantity=1,
        request_id=return_request_id,
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["returned_quantity"] == 1

    mismatched_replay = create_return(
        owner_client,
        record["id"],
        quantity=2,
        request_id=return_request_id,
    )
    assert mismatched_replay.status_code == 409
    assert mismatched_replay.json()["detail"]["code"] == "request_id_payload_mismatch"

    too_many = create_return(owner_client, record["id"], quantity=5)
    assert too_many.status_code == 409
    assert too_many.json()["detail"]["code"] == "return_exceeds_outstanding"

    before_lent = create_return(owner_client, record["id"], quantity=1, returned_on="2025-12-31")
    assert before_lent.status_code == 422
    assert before_lent.json()["detail"]["code"] == "return_before_borrowed"

    final = create_return(owner_client, record["id"], quantity=2)
    assert final.status_code == 200, final.text
    assert final.json()["status"] == "returned"
    assert final.json()["outstanding_quantity"] == 0
    assert len(final.json()["returns"]) == 2

    history = owner_client.get(f"/api/v1/borrowed/{record['id']}/history").json()
    assert [event["action"] for event in history].count("borrowed.created") == 1
    assert [event["action"] for event in history].count("borrowed.returned") == 2

    # A fully returned record keeps a historical location, not a phantom current
    # physical whereabouts, in search and deterministic assistant output.
    returned_quick = owner_client.get("/api/v1/search/quick", params={"q": "Borrowed drill"}).json()
    returned_result = next(
        result for result in returned_quick["results"] if result["kind"] == "borrowed"
    )
    assert "previously kept at" in (returned_result["context"] or "")
    assert "kept at" not in (returned_result["context"] or "").replace("previously kept at", "")
    returned_owner = owner_client.post(
        "/api/v1/assistant/query", json={"question": "Who owns the Borrowed drill?"}
    ).json()
    assert returned_owner["tool"] == "find_borrowed_owner"
    assert "previously kept at" in returned_owner["answer"]
    assert " · kept at " not in returned_owner["answer"]

    # Owned records and reports still contain only the owned item.
    assert owner_client.get("/api/v1/items").json()["total"] == 1
    assert owner_client.get("/api/v1/overview").json()["total_quantity"] == 2
    room_detail = owner_client.get(f"/api/v1/rooms/{room['id']}").json()
    assert room_detail["total_item_count"] == 1
    container_detail = owner_client.get(f"/api/v1/containers/{container['id']}").json()
    assert [item["id"] for item in container_detail["items"]] == [owned_item["id"]]
    assert container_detail["total_quantity"] == 2


def test_borrowed_request_payload_binding_corrections_and_cancellation(owner_client):
    room = create_room(owner_client, "Hall")
    create_payload = {
        "item_name": "Ladder",
        "brand": "Werner",
        "owner_name": "Mina",
        "quantity": 2,
        "borrowed_on": "2026-02-01",
        "due_on": "2026-02-20",
        "room_id": room["id"],
        "request_id": str(uuid.uuid4()),
    }
    created = owner_client.post("/api/v1/borrowed", json=create_payload)
    assert created.status_code == 201, created.text
    record = created.json()

    replay = owner_client.post("/api/v1/borrowed", json=create_payload)
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == record["id"]

    mismatched = owner_client.post(
        "/api/v1/borrowed", json={**create_payload, "owner_name": "Someone else"}
    )
    assert mismatched.status_code == 409
    assert mismatched.json()["detail"]["code"] == "request_id_payload_mismatch"

    correction_payload = {
        "owner_name": "Mina H.",
        "brand": None,
        "quantity": 4,
        "borrowed_on": "2026-02-02",
        "due_on": None,
        "property_id": None,
        "room_id": room["id"],
        "storage_location_id": None,
        "notes": "Corrected after checking the label.",
        "request_id": str(uuid.uuid4()),
    }
    corrected = owner_client.patch(f"/api/v1/borrowed/{record['id']}", json=correction_payload)
    assert corrected.status_code == 200, corrected.text
    corrected_body = corrected.json()
    assert corrected_body["owner_name"] == "Mina H."
    assert corrected_body["brand"] is None
    assert corrected_body["quantity"] == 4
    assert corrected_body["due_on"] is None
    assert corrected_body["notes"].startswith("Corrected")
    assert len(corrected_body["history"]) == 2

    correction_replay = owner_client.patch(
        f"/api/v1/borrowed/{record['id']}", json=correction_payload
    )
    assert correction_replay.status_code == 200, correction_replay.text
    assert len(correction_replay.json()["history"]) == 2

    correction_mismatch = owner_client.patch(
        f"/api/v1/borrowed/{record['id']}",
        json={**correction_payload, "owner_name": "Different"},
    )
    assert correction_mismatch.status_code == 409
    assert correction_mismatch.json()["detail"]["code"] == "request_id_reused"

    impossible_date = owner_client.patch(
        f"/api/v1/borrowed/{record['id']}",
        json={"due_on": "2026-01-01", "request_id": str(uuid.uuid4())},
    )
    assert impossible_date.status_code == 422
    assert impossible_date.json()["detail"]["code"] == "invalid_borrowed_dates"

    first_return = create_return(owner_client, record["id"], quantity=2, returned_on="2026-02-05")
    assert first_return.status_code == 200, first_return.text
    below_returned = owner_client.patch(
        f"/api/v1/borrowed/{record['id']}",
        json={"quantity": 1, "request_id": str(uuid.uuid4())},
    )
    assert below_returned.status_code == 409
    assert below_returned.json()["detail"]["code"] == "quantity_below_returned"

    date_after_return = owner_client.patch(
        f"/api/v1/borrowed/{record['id']}",
        json={"borrowed_on": "2026-02-06", "request_id": str(uuid.uuid4())},
    )
    assert date_after_return.status_code == 422
    assert date_after_return.json()["detail"]["code"] == "borrowed_date_after_return"

    blocked_cancel = owner_client.post(
        f"/api/v1/borrowed/{record['id']}/cancel",
        json={"reason": "No longer needed", "request_id": str(uuid.uuid4())},
    )
    assert blocked_cancel.status_code == 409
    assert blocked_cancel.json()["detail"]["code"] == "borrowed_record_has_returns"

    cancellable = create_borrowed(
        owner_client,
        room["id"],
        item_name="Folding table",
        owner_name="Roya",
        quantity=1,
    ).json()
    cancel_payload = {
        "reason": "Recorded by mistake",
        "request_id": str(uuid.uuid4()),
    }
    cancelled = owner_client.post(
        f"/api/v1/borrowed/{cancellable['id']}/cancel", json=cancel_payload
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["outstanding_quantity"] == 0
    replay_cancel = owner_client.post(
        f"/api/v1/borrowed/{cancellable['id']}/cancel", json=cancel_payload
    )
    assert replay_cancel.status_code == 200
    changed_cancel = owner_client.post(
        f"/api/v1/borrowed/{cancellable['id']}/cancel",
        json={**cancel_payload, "reason": "Different reason"},
    )
    assert changed_cancel.status_code == 409

    totals = owner_client.get("/api/v1/borrowed", params={"status": "all"}).json()
    assert totals["total"] == 2
    assert totals["open_count"] == 1
    assert totals["total_borrowed_quantity"] == 4
    assert totals["outstanding_quantity"] == 2
    assert totals["returned_quantity"] == 2


def test_borrowed_dates_validation_concurrency_and_household_isolation(owner_client, anon_client):
    room = create_room(owner_client, "Garage")
    invalid = create_borrowed(
        owner_client, room["id"], borrowed_on="2026-03-10", due_on="2026-03-01"
    )
    assert invalid.status_code == 422

    created = create_borrowed(
        owner_client, room["id"], item_name="Pressure washer", owner_name="Omid", quantity=3
    )
    assert created.status_code == 201, created.text
    record = created.json()
    household = household_id(owner_client)

    def do_return(_index: int) -> str:
        with SessionLocal() as db:
            try:
                borrowed_service.create_return(
                    db,
                    household,
                    uuid.UUID(record["id"]),
                    BorrowedReturnCreate(
                        quantity=2,
                        returned_on=date(2026, 1, 6),
                        request_id=uuid.uuid4(),
                    ),
                    actor_user_id=None,
                    actor_name="Concurrency Test",
                )
                db.commit()
                return "ok"
            except ApiError as exc:
                db.rollback()
                return exc.code

    shared_create = BorrowedCreate(
        item_name="Shared request fixture",
        owner_name="Roya",
        quantity=1,
        borrowed_on=date(2026, 1, 1),
        request_id=uuid.uuid4(),
    )

    def do_create(_index: int) -> str:
        with SessionLocal() as db:
            try:
                detail = borrowed_service.create_record(
                    db,
                    household,
                    shared_create,
                    actor_user_id=None,
                    actor_name="Concurrency Test",
                )
                db.commit()
                return str(detail.id)
            except ApiError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        created_ids = list(pool.map(do_create, range(2)))
    assert len(set(created_ids)) == 1
    with SessionLocal() as db:
        assert (
            db.query(BorrowedRecord)
            .filter(BorrowedRecord.request_id == shared_create.request_id)
            .count()
            == 1
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(do_return, range(2)))
    assert sorted(results) == ["ok", "return_exceeds_outstanding"]
    detail = owner_client.get(f"/api/v1/borrowed/{record['id']}").json()
    assert detail["returned_quantity"] == 2
    assert detail["outstanding_quantity"] == 1
    remaining = create_return(owner_client, record["id"], quantity=1, returned_on="2026-01-07")
    assert remaining.status_code == 200, remaining.text
    assert remaining.json()["status"] == "returned"

    viewer_token, _ = _add_member(owner_client, email="borrowed-viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    assert anon_client.get("/api/v1/borrowed", headers=viewer).status_code == 200
    assert anon_client.get(f"/api/v1/borrowed/{record['id']}", headers=viewer).status_code == 200
    assert (
        anon_client.post(
            f"/api/v1/borrowed/{record['id']}/returns",
            headers=viewer,
            json={
                "quantity": 1,
                "returned_on": "2026-01-07",
                "request_id": str(uuid.uuid4()),
            },
        ).status_code
        == 403
    )
    assert (
        anon_client.patch(
            f"/api/v1/borrowed/{record['id']}",
            headers=viewer,
            json={"owner_name": "Blocked", "request_id": str(uuid.uuid4())},
        ).status_code
        == 403
    )
    assert (
        anon_client.post(
            f"/api/v1/borrowed/{record['id']}/cancel",
            headers=viewer,
            json={"request_id": str(uuid.uuid4())},
        ).status_code
        == 403
    )

    other = _other_household_headers("borrowed-other@example.com")
    assert anon_client.get("/api/v1/borrowed", headers=other).json()["total"] == 0
    for method, path, body in [
        ("get", f"/api/v1/borrowed/{record['id']}", None),
        (
            "patch",
            f"/api/v1/borrowed/{record['id']}",
            {"owner_name": "Nope", "request_id": str(uuid.uuid4())},
        ),
        (
            "post",
            f"/api/v1/borrowed/{record['id']}/returns",
            {
                "quantity": 1,
                "returned_on": "2026-01-07",
                "request_id": str(uuid.uuid4()),
            },
        ),
        (
            "post",
            f"/api/v1/borrowed/{record['id']}/cancel",
            {"request_id": str(uuid.uuid4())},
        ),
        ("get", f"/api/v1/borrowed/{record['id']}/history", None),
        ("get", f"/api/v1/borrowed/{record['id']}/photo/file", None),
    ]:
        response = (
            getattr(anon_client, method)(path, headers=other, json=body)
            if body is not None
            else getattr(anon_client, method)(path, headers=other)
        )
        assert response.status_code == 404, (method, path, response.text)

    # Cross-household keeping-place IDs are rejected for new records.
    other_room = anon_client.post(
        "/api/v1/rooms", headers=other, json={"name": "Other garage"}
    ).json()
    cross_place = create_borrowed(owner_client, other_room["id"])
    assert cross_place.status_code == 404


def test_borrowed_photos_are_private_scoped_and_removable(owner_client, anon_client, upload_root):
    room = create_room(owner_client, "Study")
    record = create_borrowed(owner_client, room["id"], item_name="Borrowed camera").json()

    uploaded = owner_client.post(
        f"/api/v1/borrowed/{record['id']}/photo",
        files={"file": ("camera.png", _png_bytes(), "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    photo = uploaded.json()["photo"]
    assert photo is not None
    assert photo["url"].endswith(f"/borrowed/{record['id']}/photo/file")
    assert photo["thumbnail_url"].endswith(f"/borrowed/{record['id']}/photo/thumbnail")

    original = owner_client.get(photo["url"])
    thumbnail = owner_client.get(photo["thumbnail_url"])
    assert original.status_code == 200
    assert original.headers["cache-control"] == "private, no-store"
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"].startswith("image/")

    viewer_token, _ = _add_member(
        owner_client, email="borrowed-photo-viewer@example.com", role="viewer"
    )
    viewer = _headers(viewer_token)
    assert anon_client.get(photo["url"], headers=viewer).status_code == 200
    forbidden = anon_client.post(
        f"/api/v1/borrowed/{record['id']}/photo",
        headers=viewer,
        files={"file": ("blocked.png", _png_bytes(), "image/png")},
    )
    assert forbidden.status_code == 403

    other = _other_household_headers("borrowed-photo-other@example.com")
    assert anon_client.get(photo["url"], headers=other).status_code == 404
    assert (
        anon_client.delete(f"/api/v1/borrowed/{record['id']}/photo", headers=other).status_code
        == 404
    )

    # The private borrowed photo is not part of the item/room photo stores or
    # evidence packages.
    files = list((upload_root / "borrowed" / record["id"] / "photos").iterdir())
    assert len(files) == 2
    assert not (upload_root / "items").exists()

    removed = owner_client.delete(f"/api/v1/borrowed/{record['id']}/photo")
    assert removed.status_code == 200, removed.text
    assert removed.json()["photo"] is None
    assert owner_client.get(photo["url"]).status_code == 404
    assert not (upload_root / "borrowed" / record["id"] / "photos").exists()


def test_borrowed_records_are_outside_stocktake_and_evidence_totals(owner_client):
    room = create_room(owner_client, "Loft")
    container = create_container(owner_client, room["id"], "Loft crate")
    item = create_item(owner_client, "Owned tent", room["id"], container["id"], quantity=2)
    record = create_borrowed(owner_client, room["id"], container["id"], quantity=7).json()
    assert record["quantity"] == 7

    session = owner_client.post(
        "/api/v1/stocktake/sessions",
        json={
            "room_ids": [room["id"]],
            "container_ids": [],
            "include_descendants": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert session.status_code == 201, session.text
    session_body = session.json()
    assert session_body["expected_item_count"] == 1
    assert session_body["expected_unit_count"] == 2
    session_detail = owner_client.get(f"/api/v1/stocktake/sessions/{session_body['id']}").json()
    assert [row["item_id"] for row in session_detail["items"]] == [item["id"]]

    preview = owner_client.post(
        "/api/v1/evidence-exports/preview",
        json={
            "scope": {"room_ids": [room["id"]], "include_home": False},
            "options": {},
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["item_count"] == 1
    assert body["unit_count"] == 2
    assert [entry["name"] for entry in body["items"]] == ["Owned tent"]
    assert "Ali" not in preview.text
    assert "Borrowed drill" not in preview.text
