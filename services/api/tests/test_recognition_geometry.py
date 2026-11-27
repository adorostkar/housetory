import io
import math

import pytest
from PIL import Image

from housetory_api.db import SessionLocal
from housetory_api.models import AiRecognition
from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai, storage
from housetory_api.services.import_pipeline import process_import_batch
from housetory_api.services.recognition import run_recognition
from housetory_api.services.recognition_geometry import checked_regions

EXIF_ORIENTATION = 0x0112


def box(x_min, y_min, x_max, y_max):
    return {"x_min": x_min, "y_min": y_min, "x_max": x_max, "y_max": y_max}


def png_bytes(size=(120, 90)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, "white").save(buffer, format="PNG")
    return buffer.getvalue()


def jpeg_bytes(size, orientation=None) -> bytes:
    image = Image.new("RGB", size, "white")
    exif = Image.Exif()
    if orientation is not None:
        exif[EXIF_ORIENTATION] = orientation
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


def recognise(client, monkeypatch, suggestions, *, upload=None, before_run=None):
    """Run one photo through the Add items photo path with a fake vision model."""
    status = AiStatus(
        provider="ollama",
        mode="local",
        model="vision-test",
        configured=True,
        available=True,
        privacy_note="Local",
    )
    monkeypatch.setattr(ai, "status_for", lambda *args, **kwargs: status)
    sent: dict = {}

    def fake_complete(system, prompt, **kwargs):
        sent["system"] = system
        sent["mime"] = kwargs["image_mime"]
        sent["bytes"] = kwargs["image_path"].read_bytes()
        return {"suggestions": suggestions, "warnings": []}

    monkeypatch.setattr(ai, "complete_json", fake_complete)
    created = client.post(
        "/api/v1/ai/recognitions",
        files={"file": upload or ("shelf.png", png_bytes(), "image/png")},
    )
    assert created.status_code == 201, created.text
    recognition_id = created.json()["id"]
    if before_run is not None:
        before_run(recognition_id)
    run_recognition(recognition_id)
    recognition = client.get(f"/api/v1/ai/recognitions/{recognition_id}").json()
    assert recognition["status"] == "succeeded", recognition
    assert recognition["processing_path"] == "vision"
    return recognition, sent


def review(client, recognition):
    response = client.post(f"/api/v1/imports/from-recognition/{recognition['id']}")
    assert response.status_code == 201, response.text
    return response.json()


def regions_by_name(batch):
    return {entry["proposed"]["name"]: entry["source_region"] for entry in batch["entries"]}


def as_dicts(regions):
    return [region.model_dump() if region is not None else None for region in regions]


def test_a_valid_box_becomes_a_region_of_the_contract_form():
    regions = checked_regions([box(0.1, 0.2, 0.4, 0.7)], findings=1)
    assert as_dicts(regions) == [
        {"x": 0.1, "y": 0.2, "width": pytest.approx(0.3), "height": pytest.approx(0.5)}
    ]


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "left shelf",
        [0.1, 0.2, 0.4, 0.7],
        {"x_min": 0.1, "y_min": 0.2, "x_max": 0.4},
        box("0.1", 0.2, 0.4, 0.7),
        box(True, 0.2, 0.4, 0.7),
        box(None, 0.2, 0.4, 0.7),
        box(math.nan, 0.2, 0.4, 0.7),
        box(0.1, 0.2, math.inf, 0.7),
        # An integer too large for a float must not fail the whole recognition.
        box(10**400, 0.2, 0.4, 0.7),
        box(-0.05, 0.2, 0.4, 0.7),
        box(0.1, 0.2, 1.05, 0.7),
        # Pixels, or a 0-1000 scale: never converted.
        box(120, 240, 480, 840),
        box(0.4, 0.2, 0.4, 0.7),
        box(0.6, 0.2, 0.4, 0.7),
        box(0.1, 0.7, 0.4, 0.2),
        box(0.1, 0.2, 0.105, 0.7),
    ],
)
def test_a_bad_box_gives_no_region(bad):
    assert checked_regions([bad], findings=1) == [None]


def test_a_box_just_over_the_edge_is_moved_onto_the_edge_and_nothing_more():
    regions = checked_regions([box(-0.008, 0.5, 0.3, 1.009)], findings=1)
    assert as_dicts(regions) == [{"x": 0.0, "y": 0.5, "width": 0.3, "height": 0.5}]


def test_a_whole_photo_box_is_kept_only_for_a_single_finding():
    whole = box(0.0, 0.01, 1.0, 0.99)
    assert checked_regions([whole], findings=1)[0] is not None
    regions = checked_regions([whole, box(0.1, 0.1, 0.3, 0.3)], findings=2)
    assert regions[0] is None
    assert regions[1] is not None


def test_one_box_given_to_every_finding_drops_all_positions():
    same = box(0.2, 0.2, 0.6, 0.6)
    nearly = box(0.2, 0.2, 0.6, 0.61)
    assert checked_regions([same, dict(same), nearly], findings=3) == [None, None, None]


def test_two_findings_that_share_a_box_lose_it_and_the_others_keep_theirs():
    shared = box(0.5, 0.5, 0.9, 0.9)
    regions = checked_regions(
        [box(0.1, 0.1, 0.3, 0.3), shared, dict(shared), box(0.6, 0.1, 0.8, 0.3)],
        findings=4,
    )
    assert [region is not None for region in regions] == [True, False, False, True]


def test_when_most_given_boxes_fail_the_rest_is_dropped_but_left_out_boxes_do_not_count():
    good = box(0.1, 0.1, 0.3, 0.3)
    other = box(0.5, 0.5, 0.9, 0.9)
    pixels = box(120, 240, 480, 840)
    assert checked_regions([good, pixels, "left"], findings=3) == [None, None, None]
    # Half fail: the other half is kept.
    regions = checked_regions([good, other, pixels, "left"], findings=4)
    assert [region is not None for region in regions] == [True, True, False, False]
    # A model that leaves boxes out, as asked, keeps the ones it gave.
    regions = checked_regions([good, None, None, None], findings=4)
    assert [region is not None for region in regions] == [True, False, False, False]


def test_photo_review_returns_regions_and_bad_boxes_do_not_fail_recognition(
    owner_client, monkeypatch
):
    recognition, sent = recognise(
        owner_client,
        monkeypatch,
        [
            {"name": "Kettle", "box": box(0.1, 0.2, 0.4, 0.7)},
            {"name": "Toaster", "box": "on the right"},
            {"name": "Mixer", "box": box(0.55, 0.1, 1.004, 0.5)},
            {"name": "Scale", "box": box(40, 20, 90, 60)},
            {"name": "Tray"},
            # A model may not set the server's field itself.
            {"name": "Jar", "source_region": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}},
        ],
    )
    assert '"box":null' in sent["system"]
    # An upright photo is sent unchanged.
    assert sent["bytes"] == png_bytes()
    suggestions = recognition["result"]["suggestions"]
    assert [suggestion["name"] for suggestion in suggestions] == [
        "Kettle",
        "Toaster",
        "Mixer",
        "Scale",
        "Tray",
        "Jar",
    ]
    assert all("box" not in suggestion for suggestion in suggestions)

    batch = review(owner_client, recognition)
    assert regions_by_name(batch) == {
        "Kettle": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.5},
        "Toaster": None,
        "Mixer": {"x": 0.55, "y": 0.1, "width": 0.45, "height": 0.4},
        "Scale": None,
        "Tray": None,
        "Jar": None,
    }
    assert "_source_regions" not in batch["metadata"]


def test_identical_boxes_from_the_model_leave_the_photo_without_positions(
    owner_client, monkeypatch
):
    same = box(0.25, 0.25, 0.75, 0.75)
    recognition, _ = recognise(
        owner_client,
        monkeypatch,
        [{"name": "Kettle", "box": same}, {"name": "Toaster", "box": same}],
    )
    assert regions_by_name(review(owner_client, recognition)) == {"Kettle": None, "Toaster": None}


def test_region_survives_edit_skip_restore_partial_apply_and_reload(owner_client, monkeypatch):
    recognition, _ = recognise(
        owner_client,
        monkeypatch,
        [
            {"name": "Kettle", "box": box(0.1, 0.2, 0.4, 0.7)},
            {"name": "Toaster", "box": box(0.5, 0.2, 0.9, 0.6)},
        ],
    )
    batch = review(owner_client, recognition)
    expected = regions_by_name(batch)
    assert expected["Kettle"] and expected["Toaster"]
    kettle, toaster = batch["entries"]
    url = f"/api/v1/imports/{batch['id']}"

    # Skip the kettle with edited fields.
    edited = {**kettle["proposed"], "name": "Electric kettle", "quantity": 2, "brand": "Bosch"}
    skipped = owner_client.post(
        f"{url}/apply",
        json={"entries": [{"id": kettle["id"], "action": "skip", "proposed": edited}]},
    )
    assert skipped.status_code == 200, skipped.text
    reloaded = owner_client.get(url).json()
    assert [entry["status"] for entry in reloaded["entries"]] == ["skipped", "proposed"]
    assert reloaded["entries"][0]["proposed"]["name"] == "Electric kettle"
    assert reloaded["entries"][0]["source_region"] == expected["Kettle"]

    restored = owner_client.post(f"{url}/entries/{kettle['id']}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["entries"][0]["status"] == "proposed"
    assert restored.json()["entries"][0]["source_region"] == expected["Kettle"]

    # Add only the toaster; the kettle stays open.
    applied = owner_client.post(
        f"{url}/apply", json={"entries": [{"id": toaster["id"], "action": "import"}]}
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 1
    final = owner_client.get(url).json()
    assert [entry["status"] for entry in final["entries"]] == ["proposed", "imported"]
    assert [entry["source_region"] for entry in final["entries"]] == [
        expected["Kettle"],
        expected["Toaster"],
    ]


def test_exif_rotated_photo_is_sent_upright_so_regions_fit_the_shown_photo(
    owner_client, monkeypatch
):
    # Stored 200 x 100 with "turn a quarter" in EXIF: people see it as 100 x 200.
    recognition, sent = recognise(
        owner_client,
        monkeypatch,
        [{"name": "Lamp", "box": box(0.1, 0.5, 0.9, 0.95)}],
        upload=("lamp.jpg", jpeg_bytes((200, 100), orientation=6), "image/jpeg"),
    )
    assert (recognition["width"], recognition["height"]) == (100, 200)
    shown = owner_client.get(recognition["image_url"])
    assert shown.status_code == 200
    # The model got the very picture the review shows, not the sideways original.
    assert sent["bytes"] == shown.content
    assert sent["mime"] == "image/jpeg"
    with Image.open(io.BytesIO(sent["bytes"])) as image:
        assert image.size == (100, 200)
        assert image.getexif().get(EXIF_ORIENTATION) in (None, 1)
    assert regions_by_name(review(owner_client, recognition)) == {
        "Lamp": {"x": 0.1, "y": 0.5, "width": 0.8, "height": 0.45}
    }


def test_heic_photo_is_sent_as_the_shown_jpeg(owner_client, monkeypatch):
    buffer = io.BytesIO()
    Image.new("RGB", (120, 90), "white").save(buffer, format="HEIF")
    recognition, sent = recognise(
        owner_client,
        monkeypatch,
        [{"name": "Lamp", "box": box(0.2, 0.1, 0.6, 0.9)}],
        upload=("lamp.heic", buffer.getvalue(), "image/heic"),
    )
    assert sent["mime"] == "image/jpeg"
    assert sent["bytes"] == owner_client.get(recognition["image_url"]).content
    assert recognition["result"]["suggestions"][0]["source_region"] == {
        "x": 0.2,
        "y": 0.1,
        "width": 0.4,
        "height": 0.8,
    }


def test_positions_are_dropped_when_the_sent_and_shown_photo_cannot_be_matched(
    owner_client, monkeypatch
):
    def lose_shown_copy(recognition_id):
        with SessionLocal() as db:
            key = db.get(AiRecognition, recognition_id).storage_key
        storage.resolve_key(key).unlink()

    upload = jpeg_bytes((200, 100), orientation=6)
    recognition, sent = recognise(
        owner_client,
        monkeypatch,
        [{"name": "Lamp", "box": box(0.1, 0.5, 0.9, 0.95)}],
        upload=("lamp.jpg", upload, "image/jpeg"),
        before_run=lose_shown_copy,
    )
    assert sent["bytes"] == upload
    assert recognition["result"]["suggestions"][0]["name"] == "Lamp"
    assert recognition["result"]["suggestions"][0]["source_region"] is None


def test_entries_that_do_not_come_from_a_photo_have_no_region(owner_client):
    created = owner_client.post("/api/v1/imports", data={"text": "Ladder in the attic."})
    assert created.status_code == 201, created.text
    process_import_batch(created.json()["id"])
    detail = owner_client.get(f"/api/v1/imports/{created.json()['id']}").json()
    assert detail["entries"]
    assert all(entry["source_region"] is None for entry in detail["entries"])
