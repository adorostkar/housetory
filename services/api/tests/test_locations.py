def make_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201
    return response.json()


def make_location(client, room_id, name, kind="shelf", parent_id=None):
    return client.post(
        "/api/v1/storage-locations",
        json={
            "room_id": room_id,
            "name": name,
            "kind": kind,
            "parent_id": parent_id,
        },
    )


def test_nested_storage_locations(owner_client):
    kitchen = make_room(owner_client, "Kitchen")
    garage = make_room(owner_client, "Garage")

    cabinet = make_location(owner_client, kitchen["id"], "Pantry Cabinet", "cabinet")
    assert cabinet.status_code == 201, cabinet.text
    cabinet_body = cabinet.json()

    shelf = make_location(
        owner_client, kitchen["id"], "Top Shelf", "shelf", parent_id=cabinet_body["id"]
    )
    assert shelf.status_code == 201, shelf.text
    assert shelf.json()["parent_id"] == cabinet_body["id"]

    duplicate = make_location(
        owner_client, kitchen["id"], "top shelf", "shelf", parent_id=cabinet_body["id"]
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "location_name_taken"

    cross_room = make_location(
        owner_client, garage["id"], "Wrong Shelf", parent_id=cabinet_body["id"]
    )
    assert cross_room.status_code == 422
    assert cross_room.json()["detail"]["code"] == "location_room_mismatch"

    cycle = owner_client.patch(
        f"/api/v1/storage-locations/{cabinet_body['id']}",
        json={"parent_id": shelf.json()["id"]},
    )
    assert cycle.status_code == 422
    assert cycle.json()["detail"]["code"] == "location_cycle"

    not_empty = owner_client.delete(f"/api/v1/storage-locations/{cabinet_body['id']}")
    assert not_empty.status_code == 409

    listing = owner_client.get(f"/api/v1/storage-locations?room_id={kitchen['id']}").json()["items"]
    assert len(listing) == 2
    assert owner_client.delete(f"/api/v1/storage-locations/{shelf.json()['id']}").status_code == 204
    assert owner_client.delete(f"/api/v1/storage-locations/{cabinet_body['id']}").status_code == 204


def test_location_with_item_cannot_be_deleted(owner_client):
    room = make_room(owner_client, "Office")
    location = make_location(owner_client, room["id"], "Desk Drawer", "drawer").json()
    item = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Stapler",
            "room_id": room["id"],
            "storage_location_id": location["id"],
        },
    )
    assert item.status_code == 201
    response = owner_client.delete(f"/api/v1/storage-locations/{location['id']}")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "location_not_empty"
