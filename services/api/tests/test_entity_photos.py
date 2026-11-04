import io

from PIL import Image


def make_jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (80, 60), (70, 90, 60)).save(buffer, format="JPEG")
    return buffer.getvalue()


def create_room(client, name="Photo Room"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_location(client, room_id, name="Photo Shelf"):
    response = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_id, "name": name, "kind": "shelf"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_room_and_location_photo_management(owner_client):
    room = create_room(owner_client)
    location = create_location(owner_client, room["id"])
    data = make_jpeg()

    room_upload = owner_client.post(
        f"/api/v1/rooms/{room['id']}/photos",
        files={"files": ("room.jpg", data, "image/jpeg")},
    )
    assert room_upload.status_code == 201, room_upload.text
    room_photo = room_upload.json()["items"][0]
    assert room_photo["url"].startswith("/api/v1/room-photos/")
    assert room_photo["thumbnail_url"].endswith("/thumbnail")
    assert owner_client.get(room_photo["url"]).status_code == 200
    assert owner_client.get(room_photo["thumbnail_url"]).status_code == 200

    second = owner_client.post(
        f"/api/v1/rooms/{room['id']}/photos",
        files={"files": ("room2.jpg", data, "image/jpeg")},
    ).json()["items"][0]
    reordered = owner_client.put(
        f"/api/v1/rooms/{room['id']}/photos/order",
        json={"photo_ids": [second["id"], room_photo["id"]]},
    )
    assert reordered.status_code == 200, reordered.text
    assert [photo["id"] for photo in reordered.json()["items"]] == [
        second["id"],
        room_photo["id"],
    ]
    assert reordered.json()["items"][0]["sort_order"] == 0
    invalid = owner_client.put(
        f"/api/v1/rooms/{room['id']}/photos/order",
        json={"photo_ids": [second["id"]]},
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "invalid_photo_order"
    primary = owner_client.post(f"/api/v1/rooms/{room['id']}/photos/{second['id']}/primary")
    assert primary.status_code == 200, primary.text
    assert primary.json()["items"][0]["id"] == second["id"]

    location_upload = owner_client.post(
        f"/api/v1/locations/{location['id']}/photos",
        files={"files": ("shelf.jpg", data, "image/jpeg")},
    )
    assert location_upload.status_code == 201, location_upload.text
    location_photo = location_upload.json()["items"][0]
    assert owner_client.get(location_photo["url"]).status_code == 200
    assert owner_client.get(location_photo["thumbnail_url"]).status_code == 200
    assert (
        owner_client.post(
            f"/api/v1/locations/{location['id']}/photos/{location_photo['id']}/primary"
        ).status_code
        == 200
    )

    delete_room = owner_client.delete(f"/api/v1/room-photos/{room_photo['id']}")
    assert delete_room.status_code == 204
    assert owner_client.get(room_photo["url"]).status_code == 404
    delete_location = owner_client.delete(f"/api/v1/location-photos/{location_photo['id']}")
    assert delete_location.status_code == 204


def test_entity_photo_cross_household_and_invalid_file(owner_client, anon_client):
    room = create_room(owner_client)
    location = create_location(owner_client, room["id"])
    photo = owner_client.post(
        f"/api/v1/rooms/{room['id']}/photos",
        files={"files": ("room.jpg", make_jpeg(), "image/jpeg")},
    ).json()["items"][0]
    assert anon_client.get(photo["url"]).status_code == 401
    assert anon_client.get(f"/api/v1/rooms/{room['id']}/photos").status_code == 401
    assert (
        owner_client.post(
            f"/api/v1/locations/{location['id']}/photos",
            files={"files": ("bad.jpg", b"not an image", "image/jpeg")},
        ).status_code
        == 422
    )
