from io import BytesIO

from PIL import Image

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.services.auth import create_session


def _member_headers(role: str, email: str = "guest@example.com") -> dict[str, str]:
    """A second account in the owner's household, with the given role."""
    with SessionLocal() as db:
        household = db.query(Household).one()
        user = User(name="Guest", email=email, password_hash="not-used-in-this-test")
        db.add(user)
        db.flush()
        db.add(HouseholdMember(user_id=user.id, household_id=household.id, role=role))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="offline-test",
            ip_address="127.0.0.1",
            household_id=household.id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def _photo_bytes(size=(1200, 900)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, (120, 90, 60)).save(buffer, format="JPEG")
    return buffer.getvalue()


def _dataset(client) -> dict:
    room = client.post("/api/v1/rooms", json={"name": "Garage"}).json()
    shelf = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Top shelf", "kind": "shelf"},
    ).json()
    box = client.post(
        "/api/v1/containers",
        json={"room_id": room["id"], "parent_id": shelf["id"], "container_type": "box"},
    ).json()
    category = client.post("/api/v1/categories", json={"name": "Tools"}).json()
    tag = client.post("/api/v1/tags", json={"name": "power"}).json()
    drill = client.post(
        "/api/v1/items",
        json={
            "name": "Cordless drill",
            "serial_number": "SN-42",
            "quantity": 2,
            "room_id": room["id"],
            "storage_location_id": box["id"],
            "category_id": category["id"],
            "tag_ids": [tag["id"]],
        },
    ).json()["item"]
    archived = client.post("/api/v1/items", json={"name": "Old kettle"}).json()["item"]
    assert (
        client.patch(f"/api/v1/items/{archived['id']}", json={"is_archived": True}).status_code
        == 200
    )
    return {"room": room, "shelf": shelf, "box": box, "drill": drill, "archived": archived}


def test_snapshot_matches_the_routes_it_stands_in_for(owner_client, pdf_bytes):
    data = _dataset(owner_client)
    drill_id = data["drill"]["id"]
    document = owner_client.post(
        f"/api/v1/items/{drill_id}/documents",
        files={"file": ("manual.pdf", pdf_bytes, "application/pdf")},
    )
    assert document.status_code == 201, document.text
    loan = owner_client.post(
        "/api/v1/loans",
        json={
            "item_id": drill_id,
            "borrower_name": "Grace",
            "quantity": 1,
            "lent_on": "2026-11-01",
            "request_id": "0c0e9d9e-7a57-4f55-9d0e-6f3f2c5c8a11",
        },
    )
    assert loan.status_code == 201, loan.text

    response = owner_client.get("/api/v1/offline/snapshot")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    snapshot = response.json()

    # A device that has this content already is told so, until something changes.
    etag = response.headers["etag"]
    unchanged = owner_client.get("/api/v1/offline/snapshot", headers={"If-None-Match": etag})
    assert unchanged.status_code == 304
    assert unchanged.content == b""

    assert snapshot["version"] == 1
    assert snapshot["role"] == "owner"
    assert snapshot["household"]["offline_copy_policy"] == "members"
    assert snapshot["rooms"] == owner_client.get("/api/v1/rooms").json()
    assert snapshot["locations"] == owner_client.get("/api/v1/storage-locations").json()
    assert snapshot["categories"] == owner_client.get("/api/v1/categories").json()
    assert snapshot["tags"] == owner_client.get("/api/v1/tags").json()
    assert (
        snapshot["containers"]
        == owner_client.get(
            "/api/v1/containers?include_fixed=true&include_owned=true&limit=200"
        ).json()
    )
    assert [loan["borrower_name"] for loan in snapshot["loans"]["items"]] == ["Grace"]

    # Archived items are in the copy too, and each item is what its own page shows.
    by_id = {item["id"]: item for item in snapshot["items"]}
    assert set(by_id) == {drill_id, data["archived"]["id"]}
    detail = owner_client.get(f"/api/v1/items/{drill_id}").json()["item"]
    copied = by_id[drill_id]
    assert copied["on_loan_quantity"] == 1
    assert copied["serial_number"] == "SN-42"
    assert [entry["id"] for entry in copied["location_path"]] == [
        data["shelf"]["id"],
        data["box"]["id"],
    ]
    for document_out in (*copied["documents"], *detail["documents"]):
        document_out.pop("extracted_text")
        document_out.pop("extracted_metadata")
    assert copied == detail

    owner_client.patch(f"/api/v1/items/{drill_id}", json={"name": "Hammer drill"})
    changed = owner_client.get("/api/v1/offline/snapshot", headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag


def test_snapshot_leaves_out_document_text(owner_client, pdf_bytes):
    item = owner_client.post("/api/v1/items", json={"name": "Camera"}).json()["item"]
    document = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
    ).json()
    from housetory_api.models import Document

    with SessionLocal() as db:
        stored = db.get(Document, document["id"])
        stored.extracted_text = "PRIVATE RECEIPT TEXT"
        stored.extracted_metadata = {"total": "PRIVATE"}
        db.commit()

    snapshot = owner_client.get("/api/v1/offline/snapshot")
    assert "PRIVATE" not in snapshot.text
    assert snapshot.json()["items"][0]["documents"][0]["title"] == document["title"]


def test_policy_decides_who_gets_a_copy(owner_client, anon_client):
    member = _member_headers("member", "member@example.com")
    viewer = _member_headers("viewer", "viewer@example.com")

    def allowed(headers=None, client=owner_client):
        session = client.get("/api/v1/auth/session", headers=headers).json()
        status = client.get("/api/v1/offline/snapshot", headers=headers).status_code
        assert session["offline_copy_allowed"] is (status == 200)
        return status

    # Default: owners and members, not viewers.
    assert allowed() == 200
    assert allowed(member, anon_client) == 200
    assert allowed(viewer, anon_client) == 403

    everyone = owner_client.patch("/api/v1/household", json={"offline_copy_policy": "everyone"})
    assert everyone.status_code == 200
    assert everyone.json()["offline_copy_policy"] == "everyone"
    assert allowed(viewer, anon_client) == 200

    assert (
        owner_client.patch("/api/v1/household", json={"offline_copy_policy": "nobody"}).status_code
        == 200
    )
    assert allowed() == 403
    assert allowed(member, anon_client) == 403
    refused = anon_client.get("/api/v1/offline/snapshot", headers=viewer)
    assert refused.json()["detail"]["code"] == "offline_copy_not_allowed"

    # Only an owner can change the policy, and only to a known value.
    assert (
        anon_client.patch(
            "/api/v1/household", json={"offline_copy_policy": "everyone"}, headers=member
        ).status_code
        == 403
    )
    assert (
        owner_client.patch("/api/v1/household", json={"offline_copy_policy": "guests"}).status_code
        == 422
    )


def test_snapshot_needs_a_session_and_stays_in_its_household(owner_client, anon_client):
    _dataset(owner_client)
    assert anon_client.get("/api/v1/offline/snapshot").status_code == 401

    with SessionLocal() as db:
        other_user = User(name="Grace", email="grace@example.com", password_hash="unused")
        other_household = Household(name="Grace's Home")
        db.add_all([other_user, other_household])
        db.flush()
        db.add(
            HouseholdMember(user_id=other_user.id, household_id=other_household.id, role="owner")
        )
        token = create_session(
            db,
            user=other_user,
            settings=get_settings(),
            user_agent="offline-test",
            ip_address="127.0.0.1",
            household_id=other_household.id,
        )
        db.commit()
    headers = {"Cookie": f"housetory_session={token}"}
    snapshot = anon_client.get("/api/v1/offline/snapshot", headers=headers).json()
    assert snapshot["household"]["name"] == "Grace's Home"
    assert snapshot["items"] == []
    assert snapshot["rooms"]["items"] == []


def test_small_photo_is_small_and_guarded(owner_client, anon_client):
    item = owner_client.post("/api/v1/items", json={"name": "Camera"}).json()["item"]
    photo = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("front.jpg", _photo_bytes(), "image/jpeg"))],
    ).json()["items"][0]
    url = f"/api/v1/offline/photos/{photo['id']}"

    response = owner_client.get(url)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == "private, no-store"
    with Image.open(BytesIO(response.content)) as image:
        assert image.size == (480, 360)

    assert anon_client.get(url).status_code == 401
    viewer = _member_headers("viewer")
    assert anon_client.get(url, headers=viewer).status_code == 403
    owner_client.patch("/api/v1/household", json={"offline_copy_policy": "nobody"})
    assert owner_client.get(url).status_code == 403
