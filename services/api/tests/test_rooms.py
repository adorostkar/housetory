def create_room(client, name, **kwargs):
    response = client.post("/api/v1/rooms", json={"name": name, **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


def test_room_hierarchy_and_constraints(owner_client):
    kitchen = create_room(owner_client, "Kitchen")
    pantry = create_room(owner_client, "Pantry", parent_id=kitchen["id"])
    spices = create_room(owner_client, "Spices", parent_id=pantry["id"])

    listing = owner_client.get("/api/v1/rooms").json()["items"]
    assert [room["name"] for room in listing] == ["Kitchen", "Pantry", "Spices"]
    assert next(room for room in listing if room["name"] == "Kitchen")["parent_id"] is None
    assert next(room for room in listing if room["name"] == "Spices")["parent_id"] == pantry["id"]

    duplicate = owner_client.post("/api/v1/rooms", json={"name": "kitchen"})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "room_name_taken"

    cycle = owner_client.patch(f"/api/v1/rooms/{kitchen['id']}", json={"parent_id": spices["id"]})
    assert cycle.status_code == 422
    assert cycle.json()["detail"]["code"] == "room_cycle"

    self_parent = owner_client.patch(
        f"/api/v1/rooms/{kitchen['id']}", json={"parent_id": kitchen["id"]}
    )
    assert self_parent.status_code == 422

    not_empty = owner_client.delete(f"/api/v1/rooms/{kitchen['id']}")
    assert not_empty.status_code == 409
    assert not_empty.json()["detail"]["code"] == "room_not_empty"

    assert owner_client.delete(f"/api/v1/rooms/{spices['id']}").status_code == 204
    assert owner_client.delete(f"/api/v1/rooms/{pantry['id']}").status_code == 204
    assert owner_client.delete(f"/api/v1/rooms/{kitchen['id']}").status_code == 204


def test_room_update_moves_and_clears_description(owner_client):
    living = create_room(owner_client, "Living Room", description="Main room")
    den = create_room(owner_client, "Den")
    moved = owner_client.patch(
        f"/api/v1/rooms/{den['id']}",
        json={"parent_id": living["id"], "description": "Quiet corner"},
    )
    assert moved.status_code == 200
    assert moved.json()["parent_id"] == living["id"]
    assert moved.json()["description"] == "Quiet corner"

    cleared = owner_client.patch(f"/api/v1/rooms/{den['id']}", json={"description": None})
    assert cleared.status_code == 200
    assert cleared.json()["description"] is None
    assert cleared.json()["parent_id"] == living["id"]


def test_room_and_location_counts(owner_client):
    kitchen = create_room(owner_client, "Kitchen")
    location = owner_client.post(
        "/api/v1/storage-locations",
        json={"room_id": kitchen["id"], "name": "Pantry Cabinet", "kind": "cabinet"},
    )
    assert location.status_code == 201, location.text
    item = owner_client.post(
        "/api/v1/items",
        json={"name": "Olive Oil", "room_id": kitchen["id"], "quantity": 2},
    )
    assert item.status_code == 201, item.text

    rooms = owner_client.get("/api/v1/rooms").json()["items"]
    kitchen_out = next(room for room in rooms if room["id"] == kitchen["id"])
    assert kitchen_out["location_count"] == 1
    assert kitchen_out["item_count"] == 1

    locations = owner_client.get(f"/api/v1/storage-locations?room_id={kitchen['id']}").json()[
        "items"
    ]
    assert len(locations) == 1
    assert locations[0]["kind"] == "cabinet"
