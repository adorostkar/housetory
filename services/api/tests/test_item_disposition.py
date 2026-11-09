from housetory_api.domain import ActivityAction
from housetory_api.services.history import ACTION_LABELS


def create_item(client, name="Camera"):
    response = client.post("/api/v1/items", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def disposition_events(client, item_id):
    history = client.get(f"/api/v1/items/{item_id}/history")
    assert history.status_code == 200, history.text
    return [
        event
        for event in history.json()["items"]
        if event["action"] == ActivityAction.ITEM_DISPOSITION_CHANGED.value
    ]


def test_disposition_archive_metadata_responses_restore_and_history(owner_client):
    item = create_item(owner_client)
    assert item["disposition"] is None
    assert item["disposed_on"] is None
    assert item["disposition_note"] is None

    archived = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={
            "is_archived": True,
            "disposition": "sold",
            "disposed_on": "2026-11-01",
            "disposition_note": "Sold at the neighbourhood market.",
        },
    )
    assert archived.status_code == 200, archived.text
    body = archived.json()["item"]
    assert body["is_archived"] is True
    assert body["disposition"] == "sold"
    assert body["disposed_on"] == "2026-11-01"
    assert body["disposition_note"] == "Sold at the neighbourhood market."

    fetched = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert fetched["disposition"] == "sold"
    assert fetched["disposed_on"] == "2026-11-01"
    assert fetched["disposition_note"] == "Sold at the neighbourhood market."
    listing = owner_client.get("/api/v1/items", params={"include_archived": True}).json()
    assert listing["items"][0]["disposition"] == "sold"
    assert listing["items"][0]["disposed_on"] == "2026-11-01"
    assert listing["items"][0]["disposition_note"] == "Sold at the neighbourhood market."

    events = disposition_events(owner_client, item["id"])
    assert len(events) == 1
    assert events[0]["details"] == {
        "from": {
            "is_archived": False,
            "disposition": None,
            "disposed_on": None,
            "disposition_note": None,
        },
        "to": {
            "is_archived": True,
            "disposition": "sold",
            "disposed_on": "2026-11-01",
            "disposition_note": "Sold at the neighbourhood market.",
        },
    }
    assert ACTION_LABELS[ActivityAction.ITEM_DISPOSITION_CHANGED.value] == (
        "Item disposition changed"
    )

    no_op = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={
            "is_archived": True,
            "disposition": "sold",
            "disposed_on": "2026-11-01",
            "disposition_note": "Sold at the neighbourhood market.",
        },
    )
    assert no_op.status_code == 200, no_op.text
    assert len(disposition_events(owner_client, item["id"])) == 1

    edited = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"disposition": "donated", "disposition_note": "Donated to a charity shop."},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["item"]["disposition"] == "donated"
    assert edited.json()["item"]["disposed_on"] == "2026-11-01"
    assert edited.json()["item"]["disposition_note"] == "Donated to a charity shop."
    events = disposition_events(owner_client, item["id"])
    assert len(events) == 2
    assert events[0]["details"]["from"]["disposition"] == "sold"
    assert events[0]["details"]["to"] == {
        "is_archived": True,
        "disposition": "donated",
        "disposed_on": "2026-11-01",
        "disposition_note": "Donated to a charity shop.",
    }

    restored = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={
            "is_archived": False,
            "disposition": "other",
            "disposed_on": "2026-11-02",
            "disposition_note": "Restore always clears disposition metadata.",
        },
    )
    assert restored.status_code == 200, restored.text
    restored_item = restored.json()["item"]
    assert restored_item["is_archived"] is False
    assert restored_item["disposition"] is None
    assert restored_item["disposed_on"] is None
    assert restored_item["disposition_note"] is None
    events = disposition_events(owner_client, item["id"])
    assert len(events) == 3
    assert events[0]["details"]["from"]["disposition"] == "donated"
    assert events[0]["details"]["to"] == {
        "is_archived": False,
        "disposition": None,
        "disposed_on": None,
        "disposition_note": None,
    }


def test_disposition_rejects_active_metadata_and_details_without_reason(owner_client):
    item = create_item(owner_client, "Invalid disposition")

    active = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"disposition": "sold"}
    )
    assert active.status_code == 422
    assert active.json()["detail"]["code"] == "disposition_requires_archive"

    active_restore = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"is_archived": False, "disposition": "sold"},
    )
    assert active_restore.status_code == 422
    assert active_restore.json()["detail"]["code"] == "disposition_requires_archive"

    date_without_reason = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"is_archived": True, "disposed_on": "2026-11-01"},
    )
    assert date_without_reason.status_code == 422
    assert date_without_reason.json()["detail"]["code"] == "disposition_reason_required"

    unchanged = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert unchanged["is_archived"] is False
    assert unchanged["disposition"] is None
    assert unchanged["disposed_on"] is None
    assert unchanged["disposition_note"] is None

    legacy_archived = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"is_archived": True}
    )
    assert legacy_archived.status_code == 200, legacy_archived.text
    note_without_reason = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"disposition_note": "No reason yet."}
    )
    assert note_without_reason.status_code == 422
    assert note_without_reason.json()["detail"]["code"] == "disposition_reason_required"

    too_long = owner_client.patch(
        f"/api/v1/items/{item['id']}",
        json={"disposition": "other", "disposition_note": "x" * 2001},
    )
    assert too_long.status_code == 422
    invalid_reason = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"disposition": "recycled"}
    )
    assert invalid_reason.status_code == 422
    assert len(disposition_events(owner_client, item["id"])) == 1


def test_legacy_archive_and_restore_remain_generic(owner_client):
    item = create_item(owner_client, "Legacy archive")

    archived = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"is_archived": True}
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["item"]["disposition"] is None
    assert archived.json()["item"]["disposed_on"] is None
    assert archived.json()["item"]["disposition_note"] is None

    restored = owner_client.patch(
        f"/api/v1/items/{item['id']}", json={"is_archived": False}
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["item"]["disposition"] is None
    assert restored.json()["item"]["disposed_on"] is None
    assert restored.json()["item"]["disposition_note"] is None
    assert len(disposition_events(owner_client, item["id"])) == 2
