import uuid

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.security import hash_password
from housetory_api.services import voice as voice_service
from housetory_api.services.ai_runtime import AiRuntimeConfig
from housetory_api.services.auth import create_session
from housetory_api.services.voice import build_voice_suggestions


def create_room(client, name):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_location(client, room_id, name, kind="box"):
    response = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_id, "name": name, "kind": kind},
    )
    assert response.status_code == 201, response.text
    return response.json()


def household_id(client) -> uuid.UUID:
    return uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])


def runtime_config(
    task: str,
    *,
    provider: str = "openai",
    model: str = "whisper-1",
    mode: str = "cloud",
) -> AiRuntimeConfig:
    return AiRuntimeConfig(
        provider=provider,
        base_url="https://api.openai.com/v1",
        api_key="test-key",
        model=model,
        task=task,
        provider_id=uuid.uuid4(),
        display_name="Test provider",
        mode=mode,
        source="database",
        enabled=True,
        cloud_consent=True,
        configured=True,
    )


def patch_voice_config(monkeypatch):
    def config_for(_db, _household_id, task):
        if task == "transcription":
            return runtime_config("transcription")
        return runtime_config("imports", model="gpt-4o-mini")

    monkeypatch.setattr(voice_service.ai, "config_for", config_for)


def mention(
    name,
    *,
    evidence,
    quantity=None,
    room=None,
    box=None,
    variant=None,
    role="item",
    target=None,
):
    return {
        "name": name,
        "evidence": evidence,
        "quantity": quantity,
        "room": room,
        "storage_location": box,
        "variant": variant,
        "role": role,
        "target": target,
    }


def upload_voice(client, monkeypatch, *, transcript="voice note", duration=12):
    patch_voice_config(monkeypatch)
    response = client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
        data={"duration_seconds": str(duration)},
    )
    assert response.status_code == 201, response.text
    return response.json()


def interpret_note(client, monkeypatch, note_id, result, transcript="voice note"):
    patch_voice_config(monkeypatch)
    monkeypatch.setattr(voice_service.ai, "complete_json", lambda *args, **kwargs: result)
    response = client.post(
        f"/api/v1/voice/{note_id}/interpret",
        json={"transcript": transcript},
    )
    assert response.status_code == 200, response.text
    voice_service.process_interpretation(note_id)
    return client.get(f"/api/v1/voice/{note_id}").json()


def suggestion_entry(suggestion, **overrides):
    entry = {
        "id": suggestion["id"],
        "name": suggestion["name"],
        "description": suggestion.get("description"),
        "quantity": suggestion["quantity"],
        "variant": suggestion.get("variant"),
        "category": suggestion.get("category"),
        "brand": suggestion.get("brand"),
        "model": suggestion.get("model"),
        "serial_number": suggestion.get("serial_number"),
        "tags": suggestion.get("tags") or [],
        "notes": suggestion.get("notes"),
        "room": suggestion.get("room"),
        "storage_location": suggestion.get("storage_location"),
        "confidence": suggestion.get("confidence"),
        "split_of": None,
        "action": "import",
    }
    entry.update(overrides)
    return entry


def test_repeated_mentions_become_one_suggestion_with_quantity_three(owner_client):
    room = create_room(owner_client, "Office")
    box = create_location(owner_client, room["id"], "Box 2")
    transcript = "Box 2 has ethernet cable, ethernet cable, another ethernet cable."
    result = {
        "mentions": [
            mention("Ethernet cable", evidence="ethernet cable", room="Office", box="Box 2"),
            mention("Ethernet cable", evidence="ethernet cable", room="Office", box="Box 2"),
            mention(
                "Ethernet cable",
                evidence="another ethernet cable",
                room="Office",
                box="Box 2",
            ),
        ],
        "moves": [],
        "warnings": [],
    }
    with SessionLocal() as db:
        suggestions, warnings = build_voice_suggestions(
            db,
            household_id(owner_client),
            transcript,
            voice_service.AiVoiceResult.model_validate(result),
        )
    assert warnings == []
    assert len(suggestions) == 1
    suggestion = suggestions[0]
    assert suggestion.name == "Ethernet cable"
    assert suggestion.quantity == 3
    assert suggestion.mention_count == 3
    assert len(suggestion.sources) == 3
    assert suggestion.quantity_explicit is False
    assert suggestion.room.status == "matched"
    assert suggestion.room.matched_id == uuid.UUID(room["id"])
    assert suggestion.storage_location.status == "matched"
    assert suggestion.storage_location.matched_id == uuid.UUID(box["id"])


def test_explicit_count_correction_and_summary_do_not_double_count(owner_client):
    room = create_room(owner_client, "Office")
    create_location(owner_client, room["id"], "Box 2")
    transcript = (
        "Three ethernet cables in box two, actually four. "
        "So that's four ethernet cables in box two."
    )
    result = {
        "mentions": [
            mention(
                "Ethernet cable",
                evidence="Three ethernet cables",
                quantity=3,
                room="Office",
                box="box two",
            ),
            mention(
                None,
                evidence="actually four",
                quantity=4,
                room="Office",
                box="box two",
                role="correction",
                target="Ethernet cable",
            ),
            mention(
                "Ethernet cable",
                evidence="four ethernet cables in box two",
                quantity=4,
                room="Office",
                box="box two",
                role="summary",
                target="Ethernet cable",
            ),
        ],
        "moves": [],
        "warnings": [],
    }
    with SessionLocal() as db:
        suggestions, _warnings = build_voice_suggestions(
            db,
            household_id(owner_client),
            transcript,
            voice_service.AiVoiceResult.model_validate(result),
        )
    assert len(suggestions) == 1
    suggestion = suggestions[0]
    assert suggestion.quantity == 4
    assert suggestion.mention_count == 1
    assert suggestion.quantity_explicit is True
    assert [source.role for source in suggestion.sources] == [
        "item",
        "correction",
        "summary",
    ]


def test_variants_and_locations_are_separate_groups(owner_client):
    room = create_room(owner_client, "Office")
    box_two = create_location(owner_client, room["id"], "Box 2")
    box_three = create_location(owner_client, room["id"], "Box 3")
    transcript = (
        "One 1-metre ethernet cable in box 2, one 5-metre ethernet cable in box 2, "
        "and an HDMI cable in box 3."
    )
    result = {
        "mentions": [
            mention(
                "Ethernet cable",
                evidence="One 1-metre ethernet cable",
                quantity=1,
                variant="1 metre",
                room="Office",
                box="box 2",
            ),
            mention(
                "Ethernet cable",
                evidence="one 5-metre ethernet cable",
                quantity=1,
                variant="5 metres",
                room="Office",
                box="box 2",
            ),
            mention(
                "HDMI cable",
                evidence="an HDMI cable",
                quantity=1,
                room="Office",
                box="box 3",
            ),
        ],
        "moves": [],
        "warnings": [],
    }
    with SessionLocal() as db:
        suggestions, _warnings = build_voice_suggestions(
            db,
            household_id(owner_client),
            transcript,
            voice_service.AiVoiceResult.model_validate(result),
        )
    assert len(suggestions) == 3
    by_name = {suggestion.name: suggestion for suggestion in suggestions}
    assert by_name["Ethernet cable (1 metre)"].quantity == 1
    assert by_name["Ethernet cable (5 metres)"].quantity == 1
    assert by_name["HDMI cable"].quantity == 1
    assert by_name["HDMI cable"].storage_location.matched_id == uuid.UUID(box_three["id"])
    assert by_name["Ethernet cable (1 metre)"].storage_location.matched_id == uuid.UUID(
        box_two["id"]
    )


def test_move_statements_are_not_inventory(owner_client):
    transcript = "Move the drill from box two to box six."
    result = {
        "mentions": [],
        "moves": [
            {
                "text": "Move the drill from box two to box six",
                "item": "drill",
                "from_location": "box two",
                "to_location": "box six",
            }
        ],
        "warnings": [],
    }
    with SessionLocal() as db:
        suggestions, warnings = build_voice_suggestions(
            db,
            household_id(owner_client),
            transcript,
            voice_service.AiVoiceResult.model_validate(result),
        )
    assert suggestions == []
    assert any(warning["type"] == "unsupported_move" for warning in warnings)


def test_same_box_name_in_multiple_rooms_is_ambiguous(owner_client):
    first = create_room(owner_client, "Office")
    second = create_room(owner_client, "Garage")
    create_location(owner_client, first["id"], "Box 2")
    create_location(owner_client, second["id"], "Box 2")
    result = {
        "mentions": [
            mention("Ethernet cable", evidence="ethernet cable", box="box two"),
        ],
        "moves": [],
        "warnings": [],
    }
    with SessionLocal() as db:
        suggestions, _warnings = build_voice_suggestions(
            db,
            household_id(owner_client),
            "ethernet cable in box two",
            voice_service.AiVoiceResult.model_validate(result),
        )
    assert len(suggestions) == 1
    assert suggestions[0].storage_location.status == "ambiguous"
    assert len(suggestions[0].storage_location.candidates) == 2


def test_upload_transcribe_interpret_confirm_is_idempotent(owner_client, monkeypatch, imports_root):
    room = create_room(owner_client, "Office")
    box = create_location(owner_client, room["id"], "Box 2")
    note = upload_voice(owner_client, monkeypatch)
    note_id = note["id"]
    assert note["status"] == "queued"
    assert note["audio_retained"] is True
    voice_files = list(imports_root.rglob("*.webm"))
    assert len(voice_files) == 1

    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: (
            "Box two has ethernet cable, ethernet cable, another ethernet cable."
        ),
    )
    voice_service.process_transcription(note_id)
    transcribed = owner_client.get(f"/api/v1/voice/{note_id}").json()
    assert transcribed["status"] == "transcribed"
    assert "ethernet cable" in transcribed["transcript"]
    assert transcribed["audio_retained"] is False
    assert list(imports_root.rglob("*.webm")) == []
    assert owner_client.get("/api/v1/items").json()["total"] == 0

    interpreted = interpret_note(
        owner_client,
        monkeypatch,
        note_id,
        {
            "mentions": [
                mention(
                    "Ethernet cable",
                    evidence="ethernet cable",
                    room="Office",
                    box="Box 2",
                ),
                mention(
                    "Ethernet cable",
                    evidence="ethernet cable",
                    room="Office",
                    box="Box 2",
                ),
                mention(
                    "Ethernet cable",
                    evidence="another ethernet cable",
                    room="Office",
                    box="Box 2",
                ),
            ],
            "moves": [],
            "warnings": [],
        },
    )
    assert interpreted["status"] == "review"
    assert len(interpreted["suggestions"]) == 1
    suggestion = interpreted["suggestions"][0]
    assert suggestion["quantity"] == 3
    assert owner_client.get("/api/v1/items").json()["total"] == 0

    payload = {"entries": [suggestion_entry(suggestion)]}
    confirmed = owner_client.post(f"/api/v1/voice/{note_id}/confirm", json=payload)
    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    assert body["created"] == 1
    assert body["note"]["status"] == "confirmed"
    items = owner_client.get("/api/v1/items").json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "Ethernet cable"
    assert items[0]["quantity"] == 3
    assert items[0]["room"]["id"] == room["id"]
    assert items[0]["location"]["id"] == box["id"]

    repeated = owner_client.post(f"/api/v1/voice/{note_id}/confirm", json=payload)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["created"] == 1
    assert owner_client.get("/api/v1/items").json()["total"] == 1


def test_invalid_ai_output_does_not_write_inventory(owner_client, monkeypatch):
    note = upload_voice(owner_client, monkeypatch)
    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: "a drill in the office",
    )
    voice_service.process_transcription(note["id"])
    patch_voice_config(monkeypatch)
    monkeypatch.setattr(
        voice_service.ai,
        "complete_json",
        lambda *args, **kwargs: {"mentions": [{"name": "Drill"}]},
    )
    response = owner_client.post(
        f"/api/v1/voice/{note['id']}/interpret",
        json={"transcript": "a drill in the office"},
    )
    assert response.status_code == 200
    voice_service.process_interpretation(note["id"])
    body = owner_client.get(f"/api/v1/voice/{note['id']}").json()
    assert body["status"] == "transcribed"
    assert body["interpretation_error"]
    assert body["suggestions"] == []
    assert owner_client.get("/api/v1/items").json()["total"] == 0


def test_voice_upload_rejects_non_audio_and_small_audio(owner_client, monkeypatch):
    patch_voice_config(monkeypatch)
    text = owner_client.post(
        "/api/v1/voice",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert text.status_code == 422
    assert text.json()["detail"]["code"] == "unsupported_audio_type"
    tiny = owner_client.post(
        "/api/v1/voice",
        files={"file": ("empty.webm", b"\x1aE\xdf\xa3", "audio/webm")},
    )
    assert tiny.status_code == 422
    assert tiny.json()["detail"]["code"] == "empty_audio"


def test_cancel_deletes_retained_audio(owner_client, monkeypatch, imports_root):
    note = upload_voice(owner_client, monkeypatch)
    assert list(imports_root.rglob("*.webm"))
    response = owner_client.post(f"/api/v1/voice/{note['id']}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert response.json()["audio_retained"] is False
    assert list(imports_root.rglob("*.webm")) == []


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
            user_agent="voice-test",
            ip_address="127.0.0.1",
            household_id=household,
        )
        db.commit()
        return token, user.id


def _headers(token: str) -> dict[str, str]:
    return {"Cookie": f"housetory_session={token}"}


def test_viewer_cannot_create_or_confirm_voice_notes(owner_client, anon_client, monkeypatch):
    viewer_token, _ = _add_member(owner_client, email="voice-viewer@example.com", role="viewer")
    viewer = _headers(viewer_token)
    response = anon_client.post(
        "/api/v1/voice",
        headers=viewer,
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "read_only_role"


def test_viewer_cannot_confirm_or_cancel_voice_notes(owner_client, anon_client, monkeypatch):
    viewer_token, _ = _add_member(owner_client, email="voice-viewer-2@example.com", role="viewer")
    viewer = _headers(viewer_token)
    note = upload_voice(owner_client, monkeypatch)
    assert (
        anon_client.post(
            f"/api/v1/voice/{note['id']}/confirm",
            headers=viewer,
            json={"entries": []},
        ).status_code
        == 403
    )
    assert anon_client.post(f"/api/v1/voice/{note['id']}/cancel", headers=viewer).status_code == 403


def test_voice_note_is_scoped_to_household(owner_client, anon_client, monkeypatch):
    note = upload_voice(owner_client, monkeypatch)
    with SessionLocal() as db:
        other = Household(name="Other Home")
        user = User(
            name="Other Owner",
            email="other-voice@example.com",
            password_hash=hash_password("other-password-2026"),
        )
        db.add_all([other, user])
        db.flush()
        db.add(HouseholdMember(household_id=other.id, user_id=user.id, role="owner"))
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="voice-test",
            ip_address="127.0.0.1",
            household_id=other.id,
        )
        db.commit()
    headers = _headers(token)
    assert anon_client.get(f"/api/v1/voice/{note['id']}", headers=headers).status_code == 404
    assert anon_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        headers=headers,
        json={"entries": []},
    ).status_code in {404, 422}
    assert (
        anon_client.post(f"/api/v1/voice/{note['id']}/cancel", headers=headers).status_code == 404
    )


def test_duplicate_resolution_is_required_and_add_quantity_is_explicit(owner_client, monkeypatch):
    room = create_room(owner_client, "Office")
    box = create_location(owner_client, room["id"], "Box 2")
    existing = owner_client.post(
        "/api/v1/items",
        json={
            "name": "Ethernet cable",
            "quantity": 2,
            "room_id": room["id"],
            "storage_location_id": box["id"],
        },
    ).json()["item"]
    note = upload_voice(owner_client, monkeypatch)
    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: "one ethernet cable in box two",
    )
    voice_service.process_transcription(note["id"])
    interpreted = interpret_note(
        owner_client,
        monkeypatch,
        note["id"],
        {
            "mentions": [
                mention(
                    "Ethernet cable",
                    evidence="one ethernet cable",
                    quantity=1,
                    room="Office",
                    box="Box 2",
                )
            ],
            "moves": [],
            "warnings": [],
        },
        transcript="one ethernet cable in box two",
    )
    suggestion = interpreted["suggestions"][0]
    assert any(candidate["score"] >= 55 for candidate in suggestion["duplicate_candidates"])

    unresolved = owner_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        json={"entries": [suggestion_entry(suggestion)]},
    )
    assert unresolved.status_code == 200, unresolved.text
    assert unresolved.json()["failed"] == 1
    assert unresolved.json()["note"]["status"] == "review"
    assert "possible existing item" in unresolved.json()["failures"][0]["message"].lower()
    assert owner_client.get("/api/v1/items").json()["total"] == 1

    add_quantity = owner_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        json={
            "entries": [
                suggestion_entry(
                    suggestion,
                    duplicate_resolution="add_quantity",
                    merge_item_id=existing["id"],
                )
            ]
        },
    )
    assert add_quantity.status_code == 200, add_quantity.text
    body = add_quantity.json()
    assert body["added_quantity"] == 1
    assert body["note"]["status"] == "confirmed"
    items = owner_client.get("/api/v1/items").json()["items"]
    assert len(items) == 1
    assert items[0]["quantity"] == 3


def test_duplicate_can_be_created_anyway_or_skipped(owner_client, monkeypatch):
    room = create_room(owner_client, "Office")
    box = create_location(owner_client, room["id"], "Box 2")
    owner_client.post(
        "/api/v1/items",
        json={
            "name": "Ethernet cable",
            "room_id": room["id"],
            "storage_location_id": box["id"],
        },
    )
    note = upload_voice(owner_client, monkeypatch)
    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: "ethernet cable in box two",
    )
    voice_service.process_transcription(note["id"])
    interpreted = interpret_note(
        owner_client,
        monkeypatch,
        note["id"],
        {
            "mentions": [
                mention(
                    "Ethernet cable",
                    evidence="ethernet cable",
                    room="Office",
                    box="Box 2",
                )
            ],
            "moves": [],
            "warnings": [],
        },
        transcript="ethernet cable in box two",
    )
    suggestion = interpreted["suggestions"][0]
    created = owner_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        json={"entries": [suggestion_entry(suggestion, duplicate_resolution="new")]},
    )
    assert created.status_code == 200, created.text
    assert created.json()["created"] == 1
    assert owner_client.get("/api/v1/items").json()["total"] == 2


def test_split_suggestions_apply_once_with_separate_ids(owner_client, monkeypatch):
    note = upload_voice(owner_client, monkeypatch)
    monkeypatch.setattr(
        voice_service.transcription,
        "transcribe_audio",
        lambda *args, **kwargs: "two drills in the office",
    )
    voice_service.process_transcription(note["id"])
    room = create_room(owner_client, "Office")
    interpreted = interpret_note(
        owner_client,
        monkeypatch,
        note["id"],
        {
            "mentions": [
                mention(
                    "Drill",
                    evidence="two drills",
                    quantity=2,
                    room="Office",
                )
            ],
            "moves": [],
            "warnings": [],
        },
        transcript="two drills in the office",
    )
    suggestion = interpreted["suggestions"][0]
    child_id = str(uuid.uuid4())
    first = suggestion_entry(
        suggestion,
        id=child_id,
        split_of=suggestion["id"],
        quantity=1,
        name="Drill",
        room={
            **suggestion["room"],
            "matched_id": room["id"],
            "room_id": room["id"],
            "name": "Office",
            "status": "matched",
        },
    )
    second = suggestion_entry(suggestion, quantity=1)
    response = owner_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        json={"entries": [second, first]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 2
    items = owner_client.get("/api/v1/items").json()["items"]
    assert len(items) == 2
    assert {item["quantity"] for item in items} == {1}
    # A repeated confirm with both ids is a no-op.
    repeated = owner_client.post(
        f"/api/v1/voice/{note['id']}/confirm",
        json={"entries": [second, first]},
    )
    assert repeated.status_code == 200, repeated.text
    assert owner_client.get("/api/v1/items").json()["total"] == 2


def test_upload_requires_configured_transcription_and_duration_limit(owner_client, monkeypatch):
    unconfigured = owner_client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
    )
    assert unconfigured.status_code == 422
    assert unconfigured.json()["detail"]["code"] == "transcription_not_configured"

    patch_voice_config(monkeypatch)
    too_long = owner_client.post(
        "/api/v1/voice",
        files={"file": ("note.webm", b"\x1aE\xdf\xa3" + b"\x00" * 512, "audio/webm")},
        data={"duration_seconds": "9999"},
    )
    assert too_long.status_code == 422
    assert too_long.json()["detail"]["code"] == "audio_too_long"


def test_transcription_adapters_call_only_configured_provider(tmp_path, monkeypatch):
    from housetory_api.services import transcription

    path = tmp_path / "note.webm"
    path.write_bytes(b"\x1aE\xdf\xa3" + b"\x00" * 512)
    openai_config = runtime_config("transcription")
    captured: dict[str, object] = {}

    def openai_request(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return {"text": "  a drill in the office  "}

    monkeypatch.setattr(transcription.ai, "request_multipart_json", openai_request)
    text = transcription.transcribe_audio(
        openai_config,
        path=path,
        content_type="audio/webm",
        filename="note.webm",
    )
    assert text == "a drill in the office"
    assert str(captured["url"]).endswith("/audio/transcriptions")
    assert captured["fields"] == {"model": "whisper-1", "response_format": "json"}

    gemini_config = runtime_config("transcription", provider="gemini", model="gemini-2.5-flash")

    def gemini_request(url, payload, **kwargs):
        captured["gemini_url"] = url
        captured["gemini_payload"] = payload
        return {"candidates": [{"content": {"parts": [{"text": "a drill"}]}}]}

    monkeypatch.setattr(transcription.ai, "_request_json", gemini_request)
    assert (
        transcription.transcribe_audio(
            gemini_config,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a drill"
    )
    assert "generateContent" in str(captured["gemini_url"])
    inline = captured["gemini_payload"]["contents"][0]["parts"][1]["inline_data"]
    assert inline["mime_type"] == "audio/webm"

    unsupported = runtime_config("transcription", provider="anthropic", model="claude-sonnet")
    try:
        transcription.transcribe_audio(
            unsupported,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiUnavailable as exc:
        assert "does not support audio transcription" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("Unsupported transcription provider was accepted.")


def test_openrouter_transcription_uses_stt_and_chat_audio_contracts(tmp_path, monkeypatch):
    import base64
    from dataclasses import replace

    from housetory_api.services import transcription
    from housetory_api.services.ai import DiscoveredModel

    path = tmp_path / "note.webm"
    path.write_bytes(b"\x1aE\xdf\xa3" + b"\x00" * 512)
    config = replace(
        runtime_config(
            "transcription",
            provider="openrouter",
            model="openai/whisper-test",
        ),
        base_url="https://openrouter.ai/api/v1",
    )

    stt_metadata = DiscoveredModel(
        id="openai/whisper-test",
        display_name="Whisper Test",
        kind="speech",
        capabilities=("audio",),
        capability_source="provider_metadata",
        endpoints=("/api/v1/audio/transcriptions",),
        input_modalities=("audio",),
        output_modalities=("transcription",),
    )
    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: stt_metadata,
    )
    captured: dict[str, object] = {}

    def stt_request(url, payload, **kwargs):
        captured["url"] = url
        captured["payload"] = payload
        return {"text": "  a drill in the office  ", "usage": {"seconds": 2.1}}

    monkeypatch.setattr(transcription.ai, "_request_json", stt_request)
    assert (
        transcription.transcribe_audio(
            config,
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a drill in the office"
    )
    assert str(captured["url"]).endswith("/audio/transcriptions")
    stt_payload = captured["payload"]
    assert isinstance(stt_payload, dict)
    assert stt_payload["model"] == "openai/whisper-test"
    assert stt_payload["response_format"] == "json"
    input_audio = stt_payload["input_audio"]
    assert input_audio["format"] == "webm"
    assert not input_audio["data"].startswith("data:")
    assert base64.b64decode(input_audio["data"]) == path.read_bytes()

    chat_metadata = DiscoveredModel(
        id="openai/audio-chat",
        display_name="Audio Chat",
        kind="chat",
        capabilities=("text", "audio"),
        capability_source="provider_metadata",
        endpoints=("/api/v1/chat/completions",),
        input_modalities=("text", "audio"),
        output_modalities=("text",),
    )
    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: chat_metadata,
    )

    def chat_request(url, payload, **kwargs):
        captured["chat_url"] = url
        captured["chat_payload"] = payload
        return {
            "choices": [
                {
                    "message": {"content": "a saw in the garage"},
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(transcription.ai, "_request_json", chat_request)
    assert (
        transcription.transcribe_audio(
            replace(config, model="openai/audio-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
        == "a saw in the garage"
    )
    assert str(captured["chat_url"]).endswith("/chat/completions")
    chat_payload = captured["chat_payload"]
    assert isinstance(chat_payload, dict)
    parts = chat_payload["messages"][1]["content"]
    assert parts[0]["type"] == "text"
    assert parts[1]["type"] == "input_audio"
    assert parts[1]["input_audio"]["format"] == "webm"
    assert not parts[1]["input_audio"]["data"].startswith("data:")

    monkeypatch.setattr(
        transcription.ai,
        "_request_json",
        lambda *_args, **_kwargs: {
            "choices": [
                {
                    "message": {"content": None, "refusal": "cannot transcribe"},
                    "finish_reason": "stop",
                }
            ]
        },
    )
    try:
        transcription.transcribe_audio(
            replace(config, model="openai/audio-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiInvalidOutput as exc:
        assert "refused" in str(exc).lower()
    else:  # pragma: no cover - defensive
        raise AssertionError("A refusal was accepted as a transcript.")

    monkeypatch.setattr(
        transcription.ai,
        "openrouter_model_metadata",
        lambda _config: DiscoveredModel(
            id="openai/text-chat",
            display_name="Text Chat",
            kind="chat",
            capabilities=("text",),
            capability_source="provider_metadata",
            endpoints=("/api/v1/chat/completions",),
            input_modalities=("text",),
            output_modalities=("text",),
        ),
    )
    monkeypatch.setattr(
        transcription.ai,
        "_request_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Unsupported audio model must not receive household audio.")
        ),
    )
    try:
        transcription.transcribe_audio(
            replace(config, model="openai/text-chat"),
            path=path,
            content_type="audio/webm",
            filename="note.webm",
        )
    except voice_service.ai.AiUnavailable as exc:
        assert "does not advertise" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("Text-only OpenRouter model was accepted for transcription.")
