import uuid

from housetory_api.db import SessionLocal
from housetory_api.models import AiProvider, AiTaskSetting
from housetory_api.schemas.ai import AiStatus
from housetory_api.services import ai as ai_module
from housetory_api.services.query_text import (
    clean_subject,
    looks_like_question,
    normalize_for_match,
)
from tests.test_multi_household import (
    add_membership,
    create_household,
    create_item,
    create_room,
    household_id,
    switch,
)


def create_room_simple(client, name: str) -> dict:
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item_simple(client, name: str, **extra) -> dict:
    response = client.post("/api/v1/items", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def create_loan_simple(
    client,
    item_id: str,
    *,
    borrower: str,
    quantity: int = 1,
    lent_on: str,
    due_on: str | None = None,
) -> dict:
    response = client.post(
        "/api/v1/loans",
        json={
            "item_id": item_id,
            "borrower_name": borrower,
            "quantity": quantity,
            "lent_on": lent_on,
            "due_on": due_on,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def return_loan_simple(client, loan_id: str, *, quantity: int, returned_on: str) -> dict:
    response = client.post(
        f"/api/v1/loans/{loan_id}/returns",
        json={
            "quantity": quantity,
            "returned_on": returned_on,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def query(client, payload: dict):
    response = client.post("/api/v1/search/query", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def fake_status() -> AiStatus:
    return AiStatus(
        provider="ollama",
        mode="local",
        model="test-model",
        configured=True,
        available=True,
        privacy_note="test local provider",
    )


def test_unicode_question_normalisation_preserves_script_and_zwnj():
    for value in (
        "دریل من کجاست؟",
        "دریل من کجاست",
        "دريل من كجاست؟",
        "دریل‌من کجاست",
        "أين دريل من؟",
    ):
        assert looks_like_question(value) is True
        assert "دریل" in clean_subject(value) or "دريل" in clean_subject(value)
    assert normalize_for_match("دریل‌من") == normalize_for_match("دریلمن")
    # A single non-Latin term is a cheap direct search, not automatically a
    # question. It still normalises variants for matching.
    assert looks_like_question("دریل") is False
    assert normalize_for_match("دريل") == normalize_for_match("دریل")


def test_direct_ps5_lookup_needs_no_model_call(owner_client, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("direct lookup must not call a provider")

    monkeypatch.setattr(ai_module, "complete_json", forbidden)
    monkeypatch.setattr(ai_module, "complete_text", forbidden)

    room = create_room_simple(owner_client, "Media room")
    item = create_item_simple(owner_client, "PS5 Slim", room_id=room["id"])
    body = query(owner_client, {"query": "PS5"})
    assert body["mode"] == "direct"
    assert body["ai_used"] is False
    assert body["items"][0]["id"] == item["id"]
    assert body["quick_results"][0]["id"] == item["id"]
    assert body["total"] >= 1


def test_persian_drill_question_uses_configured_ai_with_or_without_punctuation(
    owner_client, monkeypatch
):
    room = create_room_simple(owner_client, "Workshop")
    drill = create_item_simple(
        owner_client, "Heavy drill", room_id=room["id"], brand="Makita"
    )
    create_loan_simple(
        owner_client,
        drill["id"],
        borrower="Mohsen",
        lent_on="2026-10-01",
        due_on="2026-11-20",
    )
    calls = {"plan": 0, "answer": 0}

    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)

    def fake_plan(*_args, **_kwargs):
        calls["plan"] += 1
        return {"tool": "locate_item", "arguments": {"q": "heavy drill"}}

    def fake_answer(*_args, **_kwargs):
        calls["answer"] += 1
        return "دریل شما دست محسن است و تا ۲۰ نوامبر ۲۰۲۶ باید برگردد."

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(ai_module, "complete_text", fake_answer)

    for question in ("دریل من کجاست؟", "دریل من کجاست"):
        body = query(owner_client, {"query": question})
        assert body["mode"] == "ai"
        assert body["ai_used"] is True
        assert body["items"][0]["id"] == drill["id"]
        assert "محسن" in (body["answer"] or "")
        assert body["context"]["resolved_items"][0]["id"] == drill["id"]
        assert body["facts"]["whereabouts"]["on_loan_quantity"] == 1

    assert calls["plan"] == 2
    assert calls["answer"] == 2


def test_explicit_ask_bypasses_a_confident_direct_match(owner_client, monkeypatch):
    room = create_room_simple(owner_client, "Studio")
    item = create_item_simple(owner_client, "Monitor", room_id=room["id"])
    calls = {"plan": 0}
    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)

    def fake_plan(*_args, **_kwargs):
        calls["plan"] += 1
        return {"tool": "locate_item", "arguments": {"q": "Monitor"}}

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(ai_module, "complete_text", lambda *_a, **_k: "It is in the Studio.")

    body = query(owner_client, {"query": "Monitor", "explicit_ask": True})
    assert calls["plan"] == 1
    assert body["mode"] == "ai"
    assert body["items"][0]["id"] == item["id"]


def test_no_provider_fallback_is_honest_and_keeps_direct_results(owner_client):
    room = create_room_simple(owner_client, "Garage")
    create_item_simple(owner_client, "Heavy drill", room_id=room["id"])
    body = query(owner_client, {"query": "دریل من کجاست؟"})
    assert body["mode"] == "fallback"
    assert body["ai_used"] is False
    assert body["ai_attempted"] is False
    assert any("not a conclusive no-result" in notice for notice in body["notices"])
    assert "دریل" in body["query"]


def test_four_turn_dialogue_uses_context_and_fresh_loan_facts(owner_client, monkeypatch):
    room = create_room_simple(owner_client, "Workshop")
    drill = create_item_simple(
        owner_client,
        "Heavy drill",
        room_id=room["id"],
        quantity=2,
        brand="Makita",
        model="HP-2",
    )
    similar = create_item_simple(
        owner_client,
        "Impact drill",
        room_id=room["id"],
        brand="DeWalt",
        model="DCD999",
    )
    returned = create_loan_simple(
        owner_client,
        drill["id"],
        borrower="Mohsen",
        quantity=1,
        lent_on="2026-01-01",
    )
    return_loan_simple(
        owner_client,
        returned["id"],
        quantity=1,
        returned_on="2026-01-11",
    )
    create_loan_simple(
        owner_client,
        drill["id"],
        borrower="Sam",
        quantity=1,
        lent_on="2026-02-01",
        due_on="2026-11-30",
    )

    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)

    def fake_plan(_system, prompt, **_kwargs):
        current = prompt.rsplit("Question (untrusted data", 1)[-1]
        if "Did I loan it" in current:
            return {
                "tool": "get_loan_history",
                "arguments": {"item_ids": [drill["id"]], "include_returned": True},
            }
        if "another one" in current:
            return {"tool": "search_items", "arguments": {"q": "drill"}}
        if "Mohsen" in current:
            return {
                "tool": "get_loan_history",
                "arguments": {
                    "item_ids": [drill["id"], similar["id"]],
                    "borrower_name": "Mohsen",
                    "include_returned": True,
                },
            }
        return {"tool": "locate_item", "arguments": {"q": "heavy drill"}}

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(
        ai_module,
        "complete_text",
        lambda *_a, **_k: "Grounded answer from fresh records.",
    )

    first = query(owner_client, {"query": "Where is my heavy drill?"})
    assert first["items"][0]["id"] == drill["id"]
    context = first["context"]
    history = [{"role": "user", "content": "Where is my heavy drill?"}]
    if first["answer"]:
        history.append({"role": "assistant", "content": first["answer"]})

    second = query(
        owner_client,
        {
            "query": "Did I loan it to someone else before?",
            "history": history,
            "context": context,
        },
    )
    assert second["mode"] == "ai"
    assert second["ai_used"] is True
    loan_history = second["facts"]["loan_history"]
    assert {entry["borrower_name"] for entry in loan_history} == {"Mohsen", "Sam"}
    mohsen = next(entry for entry in loan_history if entry["borrower_name"] == "Mohsen")
    assert mohsen["returned_on"] == "2026-01-11"
    assert mohsen["duration_days"] == 10
    assert mohsen["open"] is False
    assert any(ref["type"] == "loan" for ref in second["references"])

    history += [
        {"role": "user", "content": "Did I loan it to someone else before?"},
        {"role": "assistant", "content": second["answer"] or ""},
    ]
    third = query(
        owner_client,
        {
            "query": "Do I have another one of it?",
            "history": history,
            "context": second["context"],
        },
    )
    assert third["mode"] == "ai"
    names = {item["name"] for item in third["items"]}
    assert "Heavy drill" in names
    assert "Impact drill" in names
    heavy = next(item for item in third["items"] if item["name"] == "Heavy drill")
    impact = next(item for item in third["items"] if item["name"] == "Impact drill")
    assert heavy["quantity"] == 2
    assert impact["model"] == "DCD999"

    history += [
        {"role": "user", "content": "Do I have another one of it?"},
        {"role": "assistant", "content": third["answer"] or ""},
    ]
    fourth = query(
        owner_client,
        {
            "query": "Check the one that Mohsen had and tell me how long he has had it.",
            "history": history,
            "context": third["context"],
        },
    )
    assert fourth["mode"] == "ai"
    entries = fourth["facts"]["loan_history"]
    assert len(entries) == 1
    assert entries[0]["borrower_name"] == "Mohsen"
    assert entries[0]["returned_on"] == "2026-01-11"
    assert entries[0]["duration_days"] == 10
    assert entries[0]["open"] is False
    assert fourth["context"]["loans"]


def test_multiple_mohsen_candidates_are_surfaced_not_guessed(owner_client, monkeypatch):
    room = create_room_simple(owner_client, "Shed")
    first = create_item_simple(
        owner_client, "Heavy drill Makita", room_id=room["id"], model="HP-2"
    )
    second = create_item_simple(
        owner_client, "Heavy drill DeWalt", room_id=room["id"], model="DCD999"
    )
    create_loan_simple(
        owner_client, first["id"], borrower="Mohsen", lent_on="2026-01-01"
    )
    create_loan_simple(
        owner_client, second["id"], borrower="Mohsen", lent_on="2026-02-01"
    )
    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)
    monkeypatch.setattr(
        ai_module,
        "complete_json",
        lambda *_a, **_k: {
            "tool": "get_loan_history",
            "arguments": {"q": "heavy drill", "borrower_name": "Mohsen"},
        },
    )
    monkeypatch.setattr(
        ai_module,
        "complete_text",
        lambda *_a, **_k: "Several drills match. Which one did you mean?",
    )
    body = query(
        owner_client,
        {"query": "Check the one that Mohsen had and tell me how long he has had it."},
    )
    assert body["mode"] == "ai"
    assert body["ambiguous"] is True
    assert body["needs_clarification"] is True
    assert len(body["facts"]["loan_history"]) == 2
    assert {entry["borrower_name"] for entry in body["facts"]["loan_history"]} == {
        "Mohsen"
    }
    assert "Which one" in (body["answer"] or "")


def _configure_provider(household_id_value: uuid.UUID, port: int, label: str) -> uuid.UUID:
    with SessionLocal() as db:
        provider = AiProvider(
            household_id=household_id_value,
            provider="ollama",
            display_name=label,
            base_url=f"http://127.0.0.1:{port}",
            default_model="llama3",
        )
        db.add(provider)
        db.flush()
        db.add(
            AiTaskSetting(
                household_id=household_id_value,
                task="assistant",
                provider_id=provider.id,
                enabled=True,
            )
        )
        db.commit()
        return provider.id


def test_all_places_ai_is_per_household_and_never_crosses_provider_boundaries(
    owner_client, monkeypatch
):
    first_id = household_id(owner_client)
    first_room = create_room(owner_client, "First workshop")
    first_item = create_item(owner_client, "A-only drill alpha", first_room["id"], 1)

    created = create_household(owner_client, "Cabin")
    second_id = uuid.UUID(created["household"]["id"])
    second_room = create_room(owner_client, "Second workshop")
    second_item = create_item(owner_client, "B-only drill beta", second_room["id"], 1)
    switch(owner_client, first_id)

    first_provider = _configure_provider(first_id, 11434, "First local")
    second_provider = _configure_provider(second_id, 11435, "Second local")
    captured: list[tuple[uuid.UUID | None, str]] = []

    def fake_plan(_system, prompt, *, config):
        captured.append((config.provider_id, prompt))
        q = "A-only drill alpha" if "A-only" in prompt else "B-only drill beta"
        return {"tool": "locate_item", "arguments": {"q": q}}

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(
        ai_module,
        "complete_text",
        lambda *_a, **_k: "Grounded answer in the user's language.",
    )

    body = query(owner_client, {"query": "دریل من کجاست؟"})
    assert body["mode"] == "ai"
    assert {item["id"] for item in body["items"]} == {first_item["id"], second_item["id"]}
    assert {provider_id for provider_id, _prompt in captured} == {
        first_provider,
        second_provider,
    }
    assert len(captured) == 2
    first_prompt = next(
        prompt for provider_id, prompt in captured if provider_id == first_provider
    )
    second_prompt = next(
        prompt for provider_id, prompt in captured if provider_id == second_provider
    )
    assert "A-only drill alpha" in first_prompt
    assert "B-only drill beta" not in first_prompt
    assert "B-only drill beta" in second_prompt
    assert "A-only drill alpha" not in second_prompt


def test_all_places_without_second_household_provider_does_not_fall_back(
    owner_client, monkeypatch
):
    first_id = household_id(owner_client)
    first_room = create_room(owner_client, "Provider workshop")
    create_item(owner_client, "دریل A alpha", first_room["id"], 1)
    create_household(owner_client, "Unconfigured cabin")
    second_room = create_room(owner_client, "Unconfigured workshop")
    create_item(owner_client, "دریل B beta", second_room["id"], 1)
    switch(owner_client, first_id)
    first_provider = _configure_provider(first_id, 11434, "Only local")
    captured: list[tuple[uuid.UUID | None, str]] = []

    def fake_plan(_system, prompt, *, config):
        captured.append((config.provider_id, prompt))
        return {"tool": "locate_item", "arguments": {"q": "دریل A alpha"}}

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(ai_module, "complete_text", lambda *_a, **_k: "Answer.")

    body = query(owner_client, {"query": "دریل من کجاست؟"})
    assert body["mode"] == "ai"
    assert [provider_id for provider_id, _prompt in captured] == [first_provider]
    assert "دریل B beta" not in captured[0][1]
    # The unconfigured household still returns authorised deterministic direct
    # results; it is never sent through the other household's provider.
    assert any(item["name"] == "دریل B beta" for item in body["items"])


def test_property_scoped_ai_respects_the_property_boundary(owner_client, monkeypatch):
    session = owner_client.get("/api/v1/auth/session").json()
    home_id = session["household"]["id"]
    home = owner_client.get("/api/v1/properties").json()["items"][0]
    annex = owner_client.post(
        "/api/v1/properties", json={"name": "Annex AI"}
    ).json()
    annex_room = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Annex workshop", "property_id": annex["id"]},
    ).json()
    annex_item = owner_client.post(
        "/api/v1/items",
        json={"name": "Annex-only drill", "room_id": annex_room["id"]},
    ).json()["item"]
    home_room = owner_client.post(
        "/api/v1/rooms",
        json={"name": "Home workshop", "property_id": home["id"]},
    ).json()
    owner_client.post(
        "/api/v1/items",
        json={"name": "Home-only drill", "room_id": home_room["id"]},
    )
    provider_id = _configure_provider(uuid.UUID(home_id), 11436, "Property local")
    captured: list[tuple[uuid.UUID | None, str]] = []

    def fake_plan(_system, prompt, *, config):
        captured.append((config.provider_id, prompt))
        return {"tool": "locate_item", "arguments": {"q": "Annex-only drill"}}

    monkeypatch.setattr(ai_module, "complete_json", fake_plan)
    monkeypatch.setattr(ai_module, "complete_text", lambda *_a, **_k: "Annex answer.")

    body = query(
        owner_client,
        {
            "query": "دریل من کجاست؟",
            "household_id": home_id,
            "property_id": annex["id"],
        },
    )
    assert body["mode"] == "ai"
    assert [item["id"] for item in body["items"]] == [annex_item["id"]]
    assert body["property"]["id"] == annex["id"]
    assert captured[0][0] == provider_id
    assert "Annex-only drill" in captured[0][1]
    assert "Home-only drill" not in captured[0][1]


def test_other_household_cannot_read_context_or_results(owner_client, anon_client):
    headers, _user, household_ids = add_membership(
        email="unified-stranger@example.com",
        household_names=[("Stranger home", "owner")],
    )
    room = create_room_simple(owner_client, "Private workshop")
    item = create_item_simple(owner_client, "Private drill", room_id=room["id"])
    other_id = household_ids[0]
    response = anon_client.post(
        "/api/v1/search/query",
        headers=headers,
        json={
            "query": "Private drill",
            "context": {
                "resolved_items": [{"id": item["id"], "name": "Private drill"}],
                "candidate_items": [{"id": item["id"], "name": "Private drill"}],
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"] == []
    assert all(
        entry.get("household", {}).get("id") != str(other_id)
        for entry in body["quick_results"]
    )
    assert item["id"] not in {entry["id"] for entry in body["quick_results"]}


def test_offline_context_followups_stay_useful_without_a_provider(owner_client):
    room = create_room_simple(owner_client, "Offline workshop")
    drill = create_item_simple(owner_client, "Heavy drill", room_id=room["id"])
    create_loan_simple(
        owner_client,
        drill["id"],
        borrower="Alex",
        lent_on="2026-10-01",
        due_on="2026-11-20",
    )
    first = query(owner_client, {"query": "Where is my heavy drill?"})
    assert first["mode"] == "direct"
    assert first["context"]["resolved_items"][0]["id"] == drill["id"]

    due = query(
        owner_client,
        {
            "query": "when is it due?",
            "context": first["context"],
            "history": [{"role": "user", "content": "Where is my heavy drill?"}],
        },
    )
    assert due["mode"] == "fallback"
    assert due["facts"]["whereabouts"]["loans"][0]["due_on"] == "2026-11-20"
    assert "20 Nov 2026" in (due["answer"] or "")

    history = query(
        owner_client,
        {
            "query": "Did I loan it before?",
            "context": first["context"],
        },
    )
    assert history["mode"] == "fallback"
    assert history["facts"]["loan_history"][0]["borrower_name"] == "Alex"
    assert history["facts"]["loan_history"][0]["open"] is True


def test_swedish_mixed_and_variant_names_match_without_a_provider(owner_client):
    room = create_room_simple(owner_client, "Language shelf")
    swedish = create_item_simple(
        owner_client, "Borrmaskin", room_id=room["id"], brand="Makita"
    )
    persian = create_item_simple(
        owner_client, "دریل برقی", room_id=room["id"], model="DCD791"
    )
    mixed = create_item_simple(
        owner_client, "Cordless DCD791", room_id=room["id"], model="DCD791"
    )
    swedish_body = query(owner_client, {"query": "Borrmaskin"})
    assert swedish_body["mode"] == "direct"
    assert swedish_body["items"][0]["id"] == swedish["id"]

    model_body = query(owner_client, {"query": "DCD791"})
    assert model_body["mode"] == "direct"
    assert {item["id"] for item in model_body["items"]} == {
        persian["id"],
        mixed["id"],
    }

    variant = query(owner_client, {"query": "دريل برقي"})
    assert variant["mode"] == "direct"
    assert any(item["id"] == persian["id"] for item in variant["items"])
    assert "دریل برقی" in {item["name"] for item in variant["items"]}


def test_provider_failure_and_genuine_missing_item_are_not_false_no_results(
    owner_client, monkeypatch
):
    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)

    def unavailable(*_args, **_kwargs):
        raise ai_module.AiUnavailable("provider down")

    monkeypatch.setattr(ai_module, "complete_json", unavailable)
    missing = query(owner_client, {"query": "rotary laser level"})
    assert missing["mode"] == "fallback"
    assert missing["ai_attempted"] is True
    assert any("could not interpret" in notice for notice in missing["notices"])
    assert "not a conclusive no-result" in (missing["answer"] or "")

    room = create_room_simple(owner_client, "Missing test room")
    create_item_simple(owner_client, "Heavy drill", room_id=room["id"])
    persian = query(owner_client, {"query": "دریل من کجاست؟"})
    assert persian["mode"] == "fallback"
    assert persian["ai_attempted"] is True
    assert "not a conclusive no-result" in (persian["answer"] or "")


def test_legacy_multilingual_assistant_and_natural_routes_share_the_flow(
    owner_client, monkeypatch
):
    room = create_room_simple(owner_client, "Legacy route room")
    drill = create_item_simple(owner_client, "Heavy drill", room_id=room["id"])
    monkeypatch.setattr(ai_module, "status_for", lambda *_a, **_k: fake_status())
    monkeypatch.setattr(ai_module, "config_for", lambda *_a, **_k: None)
    monkeypatch.setattr(
        ai_module,
        "complete_json",
        lambda *_a, **_k: {"tool": "locate_item", "arguments": {"q": "heavy drill"}},
    )
    monkeypatch.setattr(
        ai_module,
        "complete_text",
        lambda *_a, **_k: "دریل شما در کارگاه است.",
    )
    assistant = owner_client.post(
        "/api/v1/assistant/query", json={"question": "دریل من کجاست؟"}
    )
    assert assistant.status_code == 200, assistant.text
    assistant_body = assistant.json()
    assert assistant_body["mode"] == "ai"
    assert assistant_body["items"][0]["id"] == drill["id"]
    assert "دریل" in assistant_body["answer"]

    natural = owner_client.post(
        "/api/v1/search/natural", json={"question": "دریل من کجاست؟"}
    )
    assert natural.status_code == 200, natural.text
    natural_body = natural.json()
    assert natural_body["mode"] == "ai"
    assert natural_body["items"][0]["id"] == drill["id"]
    assert natural_body["answer"] == "دریل شما در کارگاه است."
