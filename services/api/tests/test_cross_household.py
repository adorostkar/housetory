import uuid

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.services.auth import create_session


def _other_household_headers(email: str = "grace@example.com", name: str = "Grace Hopper"):
    with SessionLocal() as db:
        user = User(name=name, email=email, password_hash="not-used-in-this-test")
        household = Household(name=f"{name}'s Home")
        db.add_all([user, household])
        db.flush()
        db.add(
            HouseholdMember(
                user_id=user.id,
                household_id=household.id,
                role="owner",
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="security-test",
            ip_address="127.0.0.1",
        )
        db.commit()
        return {
            "headers": {"Cookie": f"housetory_session={token}"},
            "user_id": user.id,
            "household_id": household.id,
            "token": token,
        }


def _owner_dataset(owner_client, pdf_bytes):
    room = owner_client.post("/api/v1/rooms", json={"name": "Private Room"}).json()
    child_room = owner_client.post(
        "/api/v1/rooms", json={"name": "Private Child", "parent_id": room["id"]}
    ).json()
    location = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": room["id"], "name": "Private Drawer", "kind": "drawer"},
    ).json()
    category = owner_client.post("/api/v1/categories", json={"name": "Private Category"}).json()
    tag = owner_client.post("/api/v1/tags", json={"name": "private-tag"}).json()
    item = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Private Item",
            "room_id": room["id"],
            "storage_location_id": location["id"],
            "category_id": category["id"],
            "tag_ids": [tag["id"]],
        },
    ).json()["item"]
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (64, 48), (80, 90, 100)).save(buffer, format="JPEG")
    photo = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("private.jpg", buffer.getvalue(), "image/jpeg"))],
    ).json()["items"][0]
    document = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("private.pdf", pdf_bytes, "application/pdf")},
    ).json()
    return {
        "room": room,
        "child_room": child_room,
        "location": location,
        "category": category,
        "tag": tag,
        "item": item,
        "photo": photo,
        "document": document,
    }


def test_every_household_endpoint_rejects_cross_household_access(
    owner_client, anon_client, pdf_bytes
):
    data = _owner_dataset(owner_client, pdf_bytes)
    other = _other_household_headers()
    headers = other["headers"]

    session = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert session["household"]["id"] == str(other["household_id"])

    household = anon_client.get("/api/v1/household", headers=headers).json()
    assert household["id"] == str(other["household_id"])
    rename = anon_client.patch(
        "/api/v1/household", headers=headers, json={"name": "Grace's Renamed Home"}
    )
    assert rename.status_code == 200
    assert rename.json()["id"] == str(other["household_id"])
    owner_household = owner_client.get("/api/v1/household").json()
    assert owner_household["name"] == "Ada's Home"

    # Collections contain only the caller's household.
    assert anon_client.get("/api/v1/rooms", headers=headers).json()["items"] == []
    assert anon_client.get("/api/v1/storage-locations", headers=headers).json()["items"] == []
    assert anon_client.get("/api/v1/categories", headers=headers).json()["items"] == []
    assert anon_client.get("/api/v1/tags", headers=headers).json()["items"] == []
    assert anon_client.get("/api/v1/items", headers=headers).json()["total"] == 0
    assert anon_client.get("/api/v1/documents", headers=headers).json()["items"] == []
    overview = anon_client.get("/api/v1/overview", headers=headers).json()
    assert overview["room_count"] == 0
    assert overview["item_count"] == 0
    assert overview["document_count"] == 0

    # Direct object IDs all resolve as not found.
    object_paths = [
        ("GET", f"/api/v1/rooms/{data['room']['id']}"),
        ("GET", f"/api/v1/rooms/{data['child_room']['id']}"),
        ("GET", f"/api/v1/storage-locations/{data['location']['id']}"),
        ("GET", f"/api/v1/items/{data['item']['id']}"),
        ("GET", f"/api/v1/items/{data['item']['id']}/photos"),
        ("GET", f"/api/v1/photos/{data['photo']['id']}/file"),
        ("GET", f"/api/v1/photos/{data['photo']['id']}/thumbnail"),
        ("GET", f"/api/v1/documents/{data['document']['id']}/file"),
    ]
    for method, path in object_paths:
        response = anon_client.request(method, path, headers=headers)
        assert response.status_code == 404, (method, path, response.text)

    write_paths = [
        ("PATCH", f"/api/v1/rooms/{data['room']['id']}", {"name": "Stolen"}),
        ("DELETE", f"/api/v1/rooms/{data['room']['id']}", None),
        ("PATCH", f"/api/v1/storage-locations/{data['location']['id']}", {"name": "Stolen"}),
        ("DELETE", f"/api/v1/storage-locations/{data['location']['id']}", None),
        ("PATCH", f"/api/v1/categories/{data['category']['id']}", {"name": "Stolen"}),
        ("DELETE", f"/api/v1/categories/{data['category']['id']}", None),
        ("PATCH", f"/api/v1/tags/{data['tag']['id']}", {"name": "stolen"}),
        ("DELETE", f"/api/v1/tags/{data['tag']['id']}", None),
        ("PATCH", f"/api/v1/items/{data['item']['id']}", {"name": "Stolen"}),
        ("DELETE", f"/api/v1/items/{data['item']['id']}", None),
        ("DELETE", f"/api/v1/photos/{data['photo']['id']}", None),
        (
            "POST",
            f"/api/v1/items/{data['item']['id']}/photos/{data['photo']['id']}/primary",
            None,
        ),
        ("DELETE", f"/api/v1/documents/{data['document']['id']}", None),
        (
            "POST",
            f"/api/v1/items/{data['item']['id']}/photos",
            "multipart",
        ),
        (
            "POST",
            f"/api/v1/items/{data['item']['id']}/documents",
            "multipart",
        ),
        ("GET", f"/api/v1/storage-locations?room_id={data['room']['id']}", None),
        ("GET", f"/api/v1/documents?item_id={data['item']['id']}", None),
    ]
    for method, path, payload in write_paths:
        kwargs = {"headers": headers}
        if payload == "multipart":
            files = {"file": ("stolen.jpg", b"x", "image/jpeg")}
            if path.endswith("/photos"):
                files = {"files": ("stolen.jpg", b"x", "image/jpeg")}
            response = anon_client.request(method, path, files=files, **kwargs)
        elif payload is not None:
            response = anon_client.request(method, path, json=payload, **kwargs)
        else:
            response = anon_client.request(method, path, **kwargs)
        assert response.status_code in {404, 422}, (
            method,
            path,
            response.status_code,
            response.text,
        )

    # Owner data still exists and is unchanged.
    item = owner_client.get(f"/api/v1/items/{data['item']['id']}").json()["item"]
    assert item["name"] == "Private Item"
    assert len(item["photos"]) == 1
    assert len(item["documents"]) == 1


def test_cross_household_ids_cannot_be_attached_to_new_records(
    owner_client, anon_client, pdf_bytes
):
    data = _owner_dataset(owner_client, pdf_bytes)
    other = _other_household_headers(email="other@example.com", name="Other Person")
    headers = other["headers"]

    room_parent = anon_client.post(
        "/api/v1/rooms", headers=headers, json={"name": "Nested", "parent_id": data["room"]["id"]}
    )
    assert room_parent.status_code == 404

    location_room = anon_client.post(
        "/api/v1/storage-locations",
        headers=headers,
        json={"room_id": data["room"]["id"], "name": "Stolen Place"},
    )
    assert location_room.status_code == 404

    category_parent = anon_client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "Nested", "parent_id": data["category"]["id"]},
    )
    assert category_parent.status_code == 404

    for payload, code in [
        ({"name": "Leak", "room_id": data["room"]["id"]}, "room_not_found"),
        (
            {"name": "Leak", "storage_location_id": data["location"]["id"]},
            "location_not_found",
        ),
        ({"name": "Leak", "category_id": data["category"]["id"]}, "category_not_found"),
        ({"name": "Leak", "tag_ids": [data["tag"]["id"]]}, "tag_not_found"),
    ]:
        response = anon_client.post("/api/v1/items", headers=headers, json=payload)
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == code

    other_room = anon_client.post(
        "/api/v1/rooms", headers=headers, json={"name": "Grace's Room"}
    ).json()
    other_location = anon_client.post(
        "/api/v1/storage-locations",
        headers=headers,
        json={"room_id": other_room["id"], "name": "Grace's Shelf"},
    ).json()
    other_category = anon_client.post(
        "/api/v1/categories", headers=headers, json={"name": "Grace's Category"}
    ).json()
    assert (
        anon_client.patch(
            f"/api/v1/rooms/{other_room['id']}",
            headers=headers,
            json={"parent_id": data["room"]["id"]},
        ).status_code
        == 404
    )
    assert (
        anon_client.patch(
            f"/api/v1/storage-locations/{other_location['id']}",
            headers=headers,
            json={"parent_id": data["location"]["id"]},
        ).status_code
        == 404
    )
    assert (
        anon_client.patch(
            f"/api/v1/categories/{other_category['id']}",
            headers=headers,
            json={"parent_id": data["category"]["id"]},
        ).status_code
        == 404
    )

    assert (
        anon_client.get(
            "/api/v1/items", headers=headers, params={"room_id": data["room"]["id"]}
        ).status_code
        == 422
    )
    assert (
        anon_client.get(
            "/api/v1/items", headers=headers, params={"location_id": data["location"]["id"]}
        ).status_code
        == 422
    )
    assert (
        anon_client.get(
            "/api/v1/items", headers=headers, params={"category_id": data["category"]["id"]}
        ).status_code
        == 422
    )
    assert (
        anon_client.get(
            "/api/v1/items", headers=headers, params={"tag_id": data["tag"]["id"]}
        ).json()["total"]
        == 0
    )

    assert anon_client.get("/api/v1/items", headers=headers).json()["total"] == 0
    assert (
        anon_client.get("/api/v1/items", headers=headers, params={"q": "Private Room"}).json()[
            "total"
        ]
        == 0
    )
    assert (
        anon_client.get("/api/v1/items", headers=headers, params={"q": "Private Category"}).json()[
            "total"
        ]
        == 0
    )


def test_unauthenticated_files_and_sensitive_routes_are_rejected(anon_client):
    random_id = uuid.uuid4()
    paths = [
        f"/api/v1/photos/{random_id}/file",
        f"/api/v1/photos/{random_id}/thumbnail",
        f"/api/v1/documents/{random_id}/file",
        f"/api/v1/items/{random_id}",
        f"/api/v1/items/{random_id}/photos",
        f"/api/v1/rooms/{random_id}",
        f"/api/v1/storage-locations/{random_id}",
        "/api/v1/categories",
        "/api/v1/tags",
        "/api/v1/documents",
        "/api/v1/household",
        "/api/v1/overview",
    ]
    for path in paths:
        response = anon_client.get(path)
        assert response.status_code == 401, (path, response.status_code, response.text)

    primary = anon_client.post(f"/api/v1/items/{random_id}/photos/{random_id}/primary")
    assert primary.status_code == 401


def test_member_cannot_change_household_settings(owner_client, anon_client):
    with SessionLocal() as db:
        from sqlalchemy import select

        household = db.scalar(select(Household).where(Household.name == "Ada's Home"))
        member = User(
            name="Member User",
            email="member@example.com",
            password_hash="not-used-in-this-test",
        )
        db.add(member)
        db.flush()
        db.add(
            HouseholdMember(
                user_id=member.id,
                household_id=household.id,
                role="member",
            )
        )
        token = create_session(
            db,
            user=member,
            settings=get_settings(),
            user_agent="security-test",
            ip_address="127.0.0.1",
        )
        db.commit()

    headers = {"Cookie": f"housetory_session={token}"}
    assert owner_client.get("/api/v1/household").status_code == 200
    response = anon_client.patch(
        "/api/v1/household", headers=headers, json={"name": "Member Rename"}
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "owner_required"
