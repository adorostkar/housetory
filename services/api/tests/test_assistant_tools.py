import json
import uuid
from dataclasses import replace

import pytest
from sqlalchemy import text

from housetory_api.db import SessionLocal, engine
from housetory_api.models import AssistantRun, Job
from housetory_api.services import ai, assistant_tools


def seed(client, name="Validation drill"):
    room = client.post("/api/v1/rooms", json={"name": "Tool Storage"}).json()
    item = client.post("/api/v1/items", json={"name": name, "room_id": room["id"]}).json()["item"]
    return room, item


def start(client, query, **fields):
    response = client.post(
        "/api/v1/assistant/runs",
        json={
            "request_id": str(uuid.uuid4()),
            "query": query,
            **fields,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def work(run):
    with SessionLocal() as db:
        row = db.get(AssistantRun, uuid.UUID(run["id"]))
        payload = db.get(Job, row.job_id).payload
    assistant_tools.run_job(payload)


def read(client, run):
    response = client.get(f"/api/v1/assistant/runs/{run['id']}")
    assert response.status_code == 200, response.text
    return response.json()


def call(name, **arguments):
    return {"kind": "tool", "call": {"name": name, "arguments": arguments}}


def test_tool_loop_observes_results_follows_references_and_releases_model_transaction(
    owner_client,
    configured_ai,
    monkeypatch,
):
    _, item = seed(owner_client)
    prompts = []
    responses = iter(
        [
            call("search_items", q="Validation drill"),
            call("get_item_details", item_id=item["id"]),
            {"kind": "answer", "message": "Your drill is in Tool Storage."},
            call("get_item_history", item_id=item["id"]),
            {"kind": "answer", "message": "Here is its recorded history."},
        ]
    )

    def complete(system, prompt, **kwargs):
        with engine.connect() as connection:
            active = connection.execute(
                text(
                    "SELECT state, query, backend_type FROM pg_stat_activity "
                    "WHERE datname=current_database() AND backend_type='client backend' "
                    "AND pid<>pg_backend_pid() AND xact_start IS NOT NULL"
                )
            ).all()
            assert active == []
        prompts.append(json.loads(prompt))
        return next(responses)

    monkeypatch.setattr(ai, "complete_json", complete)
    run = start(owner_client, "Where's that messy validation drill thing")
    work(run)
    result = read(owner_client, run)
    assert result["state"] == "completed", result
    assert [step["call"]["name"] for step in result["steps"]] == [
        "search_items",
        "get_item_details",
    ]
    assert "Tool Storage" in prompts[1]["observations"][0]["result"]["summary"]
    follow = start(owner_client, "What happened to it", parent_id=run["id"])
    work(follow)
    assert read(owner_client, follow)["state"] == "completed"
    assert item["id"] in json.dumps(prompts[-2]["context_newest_first"])
    fresh = start(owner_client, "A fresh question")
    with SessionLocal() as db:
        prompt = assistant_tools._prompt(db, db.get(AssistantRun, uuid.UUID(fresh["id"])))
        assert json.loads(prompt)["context_newest_first"] == []


def test_registry_schemas_and_unknown_tool_recovery_do_not_write_inventory(
    owner_client,
    configured_ai,
    monkeypatch,
):
    _, item = seed(owner_client)
    registry = owner_client.get("/api/v1/assistant/tools").json()
    definitions = {tool["name"]: tool for tool in registry["tools"]}
    assert definitions["prepare_action"]["permission"] == "writer"
    assert "Apply" in definitions["prepare_action"]["confirmation"]
    assert definitions["get_item_details"]["input_schema"]["required"] == ["item_id"]
    responses = iter(
        [
            call("http", url="/items/delete-all"),
            call("get_item_details", item_id=item["id"]),
            {
                "kind": "unsupported",
                "message": "Deletion is unsupported. Your inventory is unchanged.",
            },
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(owner_client, "Look at the drill; do not delete it")
    work(run)
    result = read(owner_client, run)
    assert result["state"] == "completed"
    assert result["steps"][0]["result"]["error"] == "unknown_tool"
    assert owner_client.get(f"/api/v1/items/{item['id']}").status_code == 200


def test_tool_proposal_is_editable_authoritative_and_applied_exactly_once(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, item = seed(client)
    action = call(
        "prepare_action",
        action={
            "kind": "edit_item",
            "item_id": item["id"],
            "changes": {"name": "Cordless drill"},
        },
    )
    responses = iter(
        [
            call("get_item_details", item_id=item["id"]),
            action,
            action,
            {"kind": "answer", "message": "Please review the proposed name."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, "Could you tidy up that drill's name?")
    work(run)
    result = read(client, run)
    assert result["state"] == "awaiting_approval", result
    proposals = [
        step["result"]["proposal"] for step in result["steps"] if step["result"]["proposal"]
    ]
    assert len(proposals) == 2
    assert proposals[0]["id"] == proposals[1]["id"]
    proposal_id = proposals[0]["id"]
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == item["name"]
    edited = client.patch(
        f"/api/v1/assistant/actions/proposals/{proposal_id}",
        json={
            "changes": {"name": "Reviewed drill"},
        },
    )
    assert edited.status_code == 200, edited.text
    assert read(client, run)["steps"][1]["result"]["proposal"]["changes"] == {
        "name": "Reviewed drill"
    }
    household = client.get("/api/v1/auth/session").json()["household"]["id"]
    pending = f"/api/v1/assistant/actions/proposals/pending?household_id={household}"
    waiting = client.get(pending).json()
    assert waiting["total"] == 1
    assert [(entry["id"], entry["changes"]) for entry in waiting["items"]] == [
        (proposal_id, {"name": "Reviewed drill"})
    ]
    for _ in range(2):
        response = client.post(
            f"/api/v1/assistant/actions/proposals/{proposal_id}/apply",
            json={"request_id": proposal_id},
        )
        assert response.status_code == 200, response.text
    assert client.get(pending).json()["total"] == 0
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == "Reviewed drill"
    events = client.get(f"/api/v1/items/{item['id']}/history").json()["items"]
    assert sum(event["action"] == "item.updated" for event in events) == 1
    assert read(client, run)["steps"][1]["result"]["proposal"]["state"] == "applied"


@pytest.mark.parametrize("interrupt", ["cancel", "configuration", "failure", "invalid"])
def test_interrupted_inference_cannot_publish_late_proposals_and_retry_recovers(
    owner_client,
    configured_ai,
    monkeypatch,
    interrupt,
):
    client = owner_client
    _, item = seed(client)
    run = start(client, "Give the drill a clearer name")
    changes = {"kind": "edit_item", "item_id": item["id"], "changes": {"name": "Unsafe late name"}}

    def interrupted(*a, **k):
        if interrupt == "cancel":
            assert client.post(f"/api/v1/assistant/runs/{run['id']}/cancel").status_code == 200
        elif interrupt == "configuration":
            monkeypatch.setattr(
                ai, "config_for", lambda *a, **k: replace(configured_ai, model="changed")
            )
        elif interrupt == "failure":
            raise ai.AiError("Synthetic provider failure")
        else:
            return {"kind": "run_arbitrary_code"}
        return call("prepare_action", action=changes)

    monkeypatch.setattr(ai, "complete_json", interrupted)
    work(run)
    result = read(client, run)
    assert result["state"] == ("cancelled" if interrupt == "cancel" else "needs_attention")
    assert result["steps"] == []
    assert result["can_retry"]
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == item["name"]
    response = client.post(f"/api/v1/assistant/runs/{run['id']}/retry")
    assert response.status_code == 200, response.text
    responses = iter(
        [
            call("get_item_details", item_id=item["id"]),
            {"kind": "answer", "message": "Your drill is unchanged."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    work(response.json())
    assert read(client, run)["state"] == "completed"
    assert read(client, run)["generation"] > run["generation"]


def test_failed_worker_reconciles_and_request_replay_is_idempotent(
    owner_client,
    configured_ai,
):
    client = owner_client
    request_id = str(uuid.uuid4())
    run = start(client, "Where is my drill?", request_id=request_id)
    duplicate = start(client, "Where is my drill?", request_id=request_id)
    assert duplicate["id"] == run["id"]
    with SessionLocal() as db:
        row = db.get(AssistantRun, uuid.UUID(run["id"]))
        db.get(Job, row.job_id).status = "failed"
        db.commit()
    result = read(client, run)
    assert result["state"] == "needs_attention"
    assert result["can_retry"]
    invalid = client.post(
        "/api/v1/assistant/runs",
        json={
            "request_id": request_id,
            "query": "Different request",
        },
    )
    assert invalid.status_code == 409


def _review_job(review_id):
    from housetory_api.models import InventoryReviewRun
    from housetory_api.services.assistant_tools import review_jobs

    with SessionLocal() as db:
        root = db.get(InventoryReviewRun, uuid.UUID(review_id))
        payload = db.get(Job, uuid.UUID(root.progress_json["background_job_id"])).payload
    review_jobs.run_job(payload)


def _tagging(prompts=None):
    def complete(system, prompt, **kwargs):
        if prompts is not None:
            prompts.append(prompt)
        items = json.loads(prompt.split("Items: ")[1].split("\nReturn ")[0])
        return {
            "suggestions": [
                {
                    "index": entry["index"],
                    "tags": [{"name": "tools"}],
                    "confidence": "high",
                    "reason": "Synthetic tool review",
                }
                for entry in items
            ]
        }

    return complete


def test_review_request_runs_ai_analysis_directly_and_keeps_explicit_approval(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, item = seed(client, "Validation drill")
    prompts = []
    responses = iter(
        [
            call("start_inventory_review", scope_type="items", item_ids=[item["id"]]),
            {"kind": "answer", "message": "I'm analysing your items; suggestions appear below."},
        ]
    )

    def planner(system, prompt, **kwargs):
        prompts.append(json.loads(prompt))
        return next(responses)

    monkeypatch.setattr(ai, "complete_json", planner)
    run = start(client, "Review my items and suggest categories.")
    work(run)
    result = read(client, run)
    step = result["steps"][0]["result"]
    review = step["review"]
    # The tool started the AI analysis itself: no separate enable-AI request.
    assert step["facts"]["review_analysis"]["mode"] == "ai"
    assert review["include_ai"] and review["background_active"]
    # The assistant steps aside while the small analysis runs instead of answering early.
    assert result["state"] == "queued" and len(prompts) == 1

    sent = []
    monkeypatch.setattr(ai, "complete_json", _tagging(sent))
    _review_job(review["id"])
    monkeypatch.setattr(ai, "complete_json", planner)
    work(run)
    result = read(client, run)
    assert result["state"] == "awaiting_approval"
    assert [entry["call"]["name"] for entry in result["steps"]] == [
        "start_inventory_review",
        "get_inventory_review",
    ]
    # Its final answer is written with the finished results in front of it.
    seen = prompts[-1]["observations"]
    assert "Do not ask the user to enable AI" in seen[0]["result"]["summary"]
    assert seen[1]["result"]["summary"].startswith("Analysis finished: 1 of 1 items checked")
    assert seen[1]["result"]["facts"]["items"][0]["waiting_for_approval"][0]["tags"] == ["tools"]
    current = client.get(f"/api/v1/inventory-review/runs/{review['id']}").json()
    assert current["batch_state"] == "completed", current
    assert current["ai_reviewed_count"] == 1 and len(sent) == 1
    queue = client.get(f"/api/v1/inventory-review/suggestions?review_run_id={review['id']}").json()
    organisation = next(entry for entry in queue["items"] if entry["type"] == "organisation")
    # Analysis finished is not a change.
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []

    responses = iter(
        [
            call("get_inventory_review", review_run_id=review["id"]),
            {"kind": "answer", "message": "One suggestion: tag the drill as tools."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", planner)
    follow = start(client, "What did you find?", parent_id=run["id"])
    work(follow)
    followed = read(client, follow)
    # Reading results is an answer, not new work awaiting approval.
    assert followed["state"] == "completed"
    observed = followed["steps"][0]["result"]
    assert observed["summary"].startswith("Analysis finished: 1 of 1 items checked")
    assert "AI analysed 1 of 1 eligible items" in observed["summary"]
    assert "not applied changes" in observed["summary"]
    assert observed["facts"]["waiting_for_approval_total"] >= 1
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []

    # Unchanged, already analysed information is not sent to the provider again.
    responses = iter(
        [
            call("start_inventory_review", scope_type="items", item_ids=[item["id"]]),
            {"kind": "answer", "message": "Nothing new to suggest."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", planner)
    again = start(client, "Review my items and suggest categories.")
    work(again)
    second = read(client, again)["steps"][0]["result"]["review"]
    resent = []
    monkeypatch.setattr(ai, "complete_json", _tagging(resent))
    _review_job(second["id"])
    assert resent == []
    monkeypatch.setattr(ai, "complete_json", planner)
    work(again)
    unchanged = read(client, again)["steps"][1]["result"]["facts"]["items"][0]
    # The record says why nothing new was produced; the model need not guess.
    assert unchanged["analysis_result"] == {
        "result": "unchanged_since_last_analysis",
        "not_shown_as_new": "already_pending",
    }

    approved = client.post(
        f"/api/v1/inventory-review/suggestions/{organisation['id']}/accept", json={}
    )
    assert approved.status_code == 200, approved.text
    saved = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert [tag["name"] for tag in saved["tags"]] == ["tools"]


def test_review_tool_confirms_large_scopes_once_and_falls_back_honestly(
    owner_client,
    anon_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services.assistant_tools import registry
    from tests.test_lending import _add_member, _headers

    client = owner_client
    room, first = seed(client, "Validation drill")
    second = client.post(
        "/api/v1/items", json={"name": "Validation saw", "room_id": room["id"]}
    ).json()["item"]
    monkeypatch.setattr(registry, "AI_REVIEW_AUTO_ITEMS", 1)

    def ask(http, headers, *steps):
        responses = iter(steps)
        monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
        response = http.post(
            "/api/v1/assistant/runs",
            json={"request_id": str(uuid.uuid4()), "query": "Review and categorise everything"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        run = response.json()
        work(run)
        current = http.get(f"/api/v1/assistant/runs/{run['id']}", headers=headers)
        return run, current.json()["steps"][0]["result"]

    done = {"kind": "answer", "message": "Started."}
    run, large = ask(client, {}, call("start_inventory_review"), done)
    analysis = large["facts"]["review_analysis"]
    assert (analysis["mode"], analysis["item_count"]) == ("ai_needs_confirmation", 2)
    assert not large["review"]["include_ai"]
    assert "AI analysis has not started" in large["summary"]
    # Local checks need no provider and no confirmation.
    sent = []
    monkeypatch.setattr(ai, "complete_json", _tagging(sent))
    _review_job(large["review"]["id"])
    assert sent == []
    # The single confirmation is the existing owner-only review request.
    confirmed = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "request_id": str(uuid.uuid4()),
            "scope_type": "household",
            "include_ai": True,
            "background": True,
            "assistant_run_id": run["id"],
            "assistant_review_id": large["review"]["id"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    _review_job(confirmed.json()["id"])
    assert len(sent) == 1
    ai_run = client.get(f"/api/v1/inventory-review/runs/{confirmed.json()['id']}").json()
    assert ai_run["ai_reviewed_count"] == 2
    for item in (first, second):
        assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []

    _, local = ask(client, {}, call("start_inventory_review", analysis="local"), done)
    assert local["facts"]["review_analysis"]["mode"] == "local"
    assert not local["review"]["include_ai"]

    # A member may review, but only the owner can spend on AI analysis.
    token, _ = _add_member(client, email="member@example.com", role="member")
    _, member = ask(anon_client, _headers(token), call("start_inventory_review"), done)
    assert member["facts"]["review_analysis"]["mode"] == "local"
    assert "Only the household owner" in member["summary"]
    assert not member["review"]["include_ai"]


def test_detached_review_has_no_transaction_and_cancelled_inference_does_not_publish(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, item = seed(client, "Camping kit")
    pending = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "request_id": str(uuid.uuid4()),
            "scope_type": "items",
            "item_ids": [item["id"]],
            "include_ai": True,
            "background": True,
        },
    )
    assert pending.status_code == 200, pending.text
    review = pending.json()

    def complete(*a, **k):
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() "
                        "AND backend_type='client backend' AND pid<>pg_backend_pid() "
                        "AND xact_start IS NOT NULL"
                    )
                ).all()
                == []
            )
        cancelled = client.post(
            f"/api/v1/inventory-review/runs/{review['id']}/cancel",
            json={"version": review["batch_version"]},
        )
        assert cancelled.status_code == 200
        return {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "outdoors"}],
                    "confidence": "high",
                    "reason": "Synthetic",
                }
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    from housetory_api.models import InventoryReviewRun
    from housetory_api.services.assistant_tools import review_jobs

    with SessionLocal() as db:
        root = db.get(InventoryReviewRun, uuid.UUID(review["id"]))
        payload = db.get(Job, uuid.UUID(root.progress_json["background_job_id"])).payload
    review_jobs.run_job(payload)
    result = client.get(f"/api/v1/inventory-review/runs/{review['id']}").json()
    assert result["batch_state"] == "cancelled"
    assert not result["background_active"]
    assert result["ai_reviewed_count"] == 0
    queued = client.get(f"/api/v1/inventory-review/suggestions?review_run_id={review['id']}").json()
    assert queued["total"] == 0
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []


@pytest.mark.parametrize("change", ["configuration", "item", "permission", "concurrent"])
def test_background_review_revalidates_inputs_and_prevents_overlapping_inference(
    owner_client,
    configured_ai,
    monkeypatch,
    change,
):
    from sqlalchemy import select

    from housetory_api.api.errors import ApiError
    from housetory_api.models import HouseholdMember, InventoryReviewRun
    from housetory_api.services.assistant_tools import review_jobs

    client = owner_client
    _, item = seed(client)
    review = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "request_id": str(uuid.uuid4()),
            "scope_type": "items",
            "item_ids": [item["id"]],
            "include_ai": True,
            "background": True,
        },
    ).json()
    calls = []

    def complete(*a, **k):
        calls.append(True)
        if change == "configuration":
            monkeypatch.setattr(
                ai, "config_for", lambda *a, **k: replace(configured_ai, model="changed")
            )
        elif change == "item":
            edited = client.patch(f"/api/v1/items/{item['id']}", json={"name": "Changed drill"})
            assert edited.status_code == 200
        elif change == "permission":
            with SessionLocal() as db:
                db.scalar(select(HouseholdMember)).role = "viewer"
                db.commit()
        else:
            duplicate = client.post(
                f"/api/v1/inventory-review/runs/{review['id']}/continue",
                json={"version": review["batch_version"]},
            )
            assert duplicate.status_code == 409, duplicate.text
        return {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "tools"}],
                    "confidence": "high",
                    "reason": "Synthetic review",
                }
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    with SessionLocal() as db:
        root = db.get(InventoryReviewRun, uuid.UUID(review["id"]))
        job_id = uuid.UUID(root.progress_json["background_job_id"])
        payload = db.get(Job, job_id).payload
    if change == "concurrent":
        review_jobs.run_job(payload)
    else:
        with pytest.raises(ApiError):
            review_jobs.run_job(payload)
        with SessionLocal() as db:
            db.get(Job, job_id).status = "failed"
            db.commit()
    result = client.get(f"/api/v1/inventory-review/runs/{review['id']}").json()
    assert len(calls) == 1
    assert result["ai_reviewed_count"] == (1 if change == "concurrent" else 0)
    assert not result["background_active"]
    if change != "concurrent":
        assert result["batch_state"] == "paused"
        assert result["remaining_item_count"] == 1
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []


@pytest.mark.parametrize("contextual", [False, True])
def test_tool_creation_reuses_capture_extraction_and_only_saves_reviewed_records(
    owner_client,
    configured_ai,
    monkeypatch,
    contextual,
):
    from housetory_api.services.enrichment import run_enhancement
    from housetory_api.services.import_pipeline import process_import_batch

    client = owner_client
    room = client.post("/api/v1/rooms", json={"name": "Kitchen"}).json()
    query = (
        "دوتا از اون هدفون‌ها رو در Kitchen ثبت کن"
        if contextual
        else ("Please register two Validation Headphones in Kitchen")
    )
    description = "Register two Validation Headphones in Kitchen"
    responses = iter(
        [
            call("prepare_item_capture", **({"description": description} if contextual else {})),
            call("prepare_item_capture", description="Repeated interpretation of the same request"),
            {"kind": "answer", "message": "Review the extracted items here before saving."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, query)
    work(run)
    result = read(client, run)
    capture = result["steps"][0]["result"]["capture"]
    assert result["steps"][1]["result"]["capture"] == capture
    assert capture["kind"] == "items"
    process_import_batch(capture["id"])
    batch = client.get(f"/api/v1/imports/{capture['id']}").json()
    assert batch["status"] == "processing"
    prompts = []

    def extract(system, prompt, **kwargs):
        prompts.append(prompt)
        return {
            "refinements": [],
            "items": [
                {"name": "Validation Headphones", "quantity": 2, "room": "Kitchen"},
            ],
            "warnings": [],
        }

    monkeypatch.setattr(ai, "complete_json", extract)
    with SessionLocal() as db:
        payload = db.get(Job, uuid.UUID(batch["enhancement"]["job_id"])).payload
    assert run_enhancement(payload)["status"] == "ready"
    detail = client.get(f"/api/v1/imports/{capture['id']}").json()
    assert query in prompts[0]
    if contextual:
        assert "<untrusted_reference_resolution>" in prompts[0]
        assert description in prompts[0]
    assert detail["metadata"]["ai_used"] is True
    proposed = detail["entries"][0]["proposed"]
    assert proposed["name"] == "Validation Headphones"
    assert proposed["quantity"] == 2
    assert proposed["room"]["matched_id"] == room["id"]
    assert client.get("/api/v1/items").json()["total"] == 0
    for _ in range(2):
        applied = client.post(
            f"/api/v1/imports/{capture['id']}/apply",
            json={
                "entries": [
                    {
                        "id": detail["entries"][0]["id"],
                        "action": "import",
                        "proposed": proposed,
                    }
                ]
            },
        )
        assert applied.status_code == 200, applied.text
    saved = client.get("/api/v1/items").json()
    assert saved["total"] == 1
    assert saved["items"][0]["quantity"] == 2
    assert saved["items"][0]["room"]["id"] == room["id"]
    follow_prompts = []

    def follow_up(system, prompt, **kwargs):
        follow_prompts.append(json.loads(prompt))
        return {"kind": "answer", "message": "Your reviewed capture is retained."}

    monkeypatch.setattr(ai, "complete_json", follow_up)
    follow = start(client, "Where is that capture?", capture_context=[capture])
    work(follow)
    assert read(client, follow)["state"] == "completed"
    assert follow_prompts[0]["capture_context"][0]["capture"] == capture
    fresh = start(client, "Fresh independent request")
    work(fresh)
    assert follow_prompts[-1]["capture_context"] == []


def test_tool_property_scope_filters_reads_and_blocks_cross_property_writes(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, outside = seed(client, "Private drill")
    property_response = client.post("/api/v1/properties", json={"name": "Scoped property"})
    assert property_response.status_code == 201, property_response.text
    property_id = property_response.json()["id"]
    responses = iter(
        [
            call("find_borrowed_owner", q="Private drill"),
            call("get_item_details", item_id=outside["id"]),
            call(
                "prepare_action",
                action={
                    "kind": "edit_item",
                    "item_id": outside["id"],
                    "changes": {"name": "Forbidden"},
                },
            ),
            {
                "kind": "answer",
                "message": "That item is outside this property. No change was prepared.",
            },
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, "Find and rename my private drill", property_id=property_id)
    work(run)
    result = read(client, run)
    assert result["steps"][0]["result"]["facts"]["owned_items"] == []
    assert result["steps"][0]["result"]["references"] == []
    assert result["steps"][1]["result"]["error"] == "item_not_found"
    assert result["steps"][2]["result"]["proposal"] is None
    assert client.get(f"/api/v1/items/{outside['id']}").json()["item"]["name"] == "Private drill"


def test_tool_call_budget_is_bounded_and_preserves_results_for_explicit_retry(
    owner_client,
    configured_ai,
    monkeypatch,
):
    _, item = seed(owner_client)
    calls = []

    def complete(*a, **k):
        calls.append(True)
        return call("get_item_details", item_id=item["id"])

    monkeypatch.setattr(ai, "complete_json", complete)
    run = start(owner_client, "Inspect this drill carefully")
    work(run)
    result = read(owner_client, run)
    assert len(calls) == 8
    assert result["state"] == "needs_attention"
    assert result["can_retry"]
    assert len(result["steps"]) == 8
    assert "call limit" in result["message"]


def test_refreshed_tool_proposal_remains_reviewable_after_reload(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, item = seed(client)
    responses = iter(
        [
            call(
                "prepare_action",
                action={
                    "kind": "edit_item",
                    "item_id": item["id"],
                    "changes": {"name": "Reviewed drill"},
                },
            ),
            {"kind": "answer", "message": "Review the proposed rename."},
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, "Please rename this drill")
    work(run)
    proposal_id = read(client, run)["steps"][0]["result"]["proposal"]["id"]
    assert client.patch(f"/api/v1/items/{item['id']}", json={"brand": "Makita"}).status_code == 200
    stale = client.post(
        f"/api/v1/assistant/actions/proposals/{proposal_id}/apply", json={"request_id": proposal_id}
    )
    assert stale.status_code == 409
    refreshed = client.post(f"/api/v1/assistant/actions/proposals/{proposal_id}/refresh")
    assert refreshed.status_code == 201, refreshed.text
    current = read(client, run)["steps"][0]["result"]["proposal"]
    assert current["id"] == refreshed.json()["id"]
    assert current["state"] == "ready"
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == item["name"]
    applied = client.post(
        f"/api/v1/assistant/actions/proposals/{current['id']}/apply",
        json={"request_id": current["id"]},
    )
    assert applied.status_code == 200, applied.text
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == "Reviewed drill"


def test_lending_borrowing_returns_and_moves_use_shared_reviewed_actions(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    room, item = seed(client)
    parent = None

    def prepare(query, action):
        nonlocal parent
        responses = iter(
            [
                call("prepare_action", action=action),
                {"kind": "answer", "message": "Review the prepared action."},
            ]
        )
        monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
        run = start(client, query, **({"parent_id": parent} if parent else {}))
        work(run)
        result = read(client, run)
        assert result["state"] == "awaiting_approval", result
        parent = run["id"]
        return result["steps"][0]["result"]["proposal"]["id"]

    def approve(proposal_id):
        for _ in range(2):
            response = client.post(
                f"/api/v1/assistant/actions/proposals/{proposal_id}/apply",
                json={"request_id": proposal_id},
            )
            assert response.status_code == 200, response.text

    proposal = prepare(
        "The drill, let Mohsen borrow it",
        {
            "kind": "lend",
            "item_id": item["id"],
            "borrower_name": "Mohsen",
            "quantity": 1,
            "lent_on": "2026-01-03",
        },
    )
    assert client.get("/api/v1/loans").json()["total"] == 0
    approve(proposal)
    loans = client.get("/api/v1/loans").json()
    assert loans["total"] == 1
    loan = loans["items"][0]
    assert loan["borrower_name"] == "Mohsen"
    proposal = prepare(
        "He brought it back",
        {
            "kind": "return_loan",
            "loan_id": loan["id"],
            "quantity": 1,
            "returned_on": "2026-01-04",
        },
    )
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["on_loan_quantity"] == 1
    approve(proposal)
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["on_loan_quantity"] == 0
    proposal = prepare(
        "A camera I'm holding for Sara",
        {
            "kind": "borrow",
            "item_name": "Camera",
            "owner_name": "Sara",
            "quantity": 1,
            "borrowed_on": "2026-01-03",
            "room_id": room["id"],
        },
    )
    assert client.get("/api/v1/borrowed").json()["total"] == 0
    approve(proposal)
    record = client.get("/api/v1/borrowed").json()["items"][0]
    proposal = prepare(
        "I returned her camera",
        {
            "kind": "return_borrowed",
            "record_id": record["id"],
            "quantity": 1,
            "returned_on": "2026-01-04",
        },
    )
    approve(proposal)
    assert client.get(f"/api/v1/borrowed/{record['id']}").json()["returned_quantity"] == 1
    destination = client.post("/api/v1/rooms", json={"name": "Kitchen"}).json()
    proposal = prepare(
        "Put that drill in Kitchen now",
        {
            "kind": "move_items",
            "item_ids": [item["id"]],
            "room_id": destination["id"],
        },
    )
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["room"]["id"] == room["id"]
    approve(proposal)
    saved = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert saved["room"]["id"] == destination["id"]


def test_prepared_work_keeps_every_other_part_of_the_answer(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    _, item = seed(client)
    loan = client.post(
        "/api/v1/loans",
        json={
            "item_id": item["id"],
            "borrower_name": "Validation Borrower",
            "quantity": 1,
            "lent_on": "2026-01-01",
            "request_id": str(uuid.uuid4()),
        },
    ).json()
    prompts = []

    def ask(query, *steps, parent=None):
        responses = iter(steps)

        def complete(system, prompt, **kwargs):
            prompts.append((system, json.loads(prompt)))
            return next(responses)

        monkeypatch.setattr(ai, "complete_json", complete)
        run = start(client, query, **({"parent_id": parent} if parent else {}))
        work(run)
        return read(client, run)

    returned = {"kind": "return_loan", "loan_id": loan["id"], "quantity": 1}
    mixed = ask(
        "How long have they had it? Prepare a return for today.",
        call("get_item_history", item_id=item["id"]),
        call("prepare_action", action={**returned, "returned_on": "2026-01-04"}),
        {
            "kind": "answer",
            "message": "Validation Borrower has had it for 3 days.",
            "prepared_note": "Return of 1 on 2026-01-04 is ready.",
        },
    )
    assert mixed["state"] == "awaiting_approval"
    assert mixed["answer"] == "Validation Borrower has had it for 3 days."
    assert mixed["steps"][-1]["result"]["proposal"]["kind"] == "return_loan"
    # The remark about the card stays out of the user-facing answer but in the record.
    assert "ready" in mixed["message"] and "ready" not in mixed["answer"]
    assert client.get(f"/api/v1/loans/{loan['id']}").json()["returned_quantity"] == 0
    system, prompt = prompts[-1]
    assert "prepared_note" in system
    assert "prepared_note" in json.dumps(prompt["step_schema"])

    limited = ask(
        "Return it and delete the old manual",
        call("prepare_action", action={**returned, "returned_on": "2026-01-05"}),
        {"kind": "unsupported", "message": "I can't delete documents; use the Documents page."},
        parent=mixed["id"],
    )
    assert limited["state"] == "awaiting_approval"
    assert limited["answer"] == "I can't delete documents; use the Documents page."
    # Follow-ups still see what was said, including the earlier answer.
    assert "3 days" in json.dumps(prompts[-1][1]["context_newest_first"])

    only_action = ask(
        "He brought it back",
        call("prepare_action", action={**returned, "returned_on": "2026-01-06"}),
        {"kind": "answer", "message": "", "prepared_note": "Proposal prepared."},
    )
    assert only_action["state"] == "awaiting_approval"
    assert only_action["answer"] == ""

    empty = ask(
        "Where is the drill?",
        call("search_items", q="Validation drill"),
        {"kind": "answer", "message": " ", "prepared_note": "Nothing prepared."},
    )
    assert empty["state"] == "needs_attention"
    assert empty["answer"] is None and empty["can_retry"]
    responses = iter([{"kind": "answer", "message": "It is in Tool Storage."}])
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    assert client.post(f"/api/v1/assistant/runs/{empty['id']}/retry", json={}).status_code == 200
    work(empty)
    recovered = read(client, empty)
    assert recovered["state"] == "completed"
    assert recovered["answer"] == "It is in Tool Storage."


def test_category_requests_get_a_category_or_a_recorded_reason_and_stay_compact(
    owner_client,
    configured_ai,
    monkeypatch,
):
    client = owner_client
    room, monitor = seed(client, "Validation Monitor")
    drill = client.post(
        "/api/v1/items",
        json={"name": "Heavy drill", "brand": "Dewalt", "room_id": room["id"]},
    ).json()["item"]
    for index in range(30):
        client.post("/api/v1/items", json={"name": f"Filler {index}", "room_id": room["id"]})
    review_prompts = []
    plans = []

    def analysis(system, prompt, **kwargs):
        review_prompts.append((system, prompt))
        items = json.loads(prompt.split("Items: ")[1].split("\nReturn ")[0])
        decisions = []
        for entry in items:
            if entry["name"] == "Validation Monitor":
                decisions.append(
                    {
                        "index": entry["index"],
                        "category": {"name": "Electronics"},
                        "reason": "A monitor.",
                    }
                )
            elif entry["name"] == "Heavy drill":
                # Tags only: must not pass as a category.
                decisions.append({"index": entry["index"], "tags": [{"name": "DIY"}]})
        return {"suggestions": decisions}

    def turn(query, steps, parent=None):
        responses = iter(steps)

        def planner(system, prompt, **kwargs):
            plans.append(prompt)
            return next(responses)

        monkeypatch.setattr(ai, "complete_json", planner)
        run = start(client, query, **({"parent_id": parent} if parent else {}))
        work(run)
        current = read(client, run)
        if current["state"] == "queued":
            monkeypatch.setattr(ai, "complete_json", analysis)
            _review_job(current["steps"][-1]["result"]["review"]["id"])
            monkeypatch.setattr(ai, "complete_json", planner)
            work(run)
            current = read(client, run)
        assert current["state"] in {"completed", "awaiting_approval"}, current
        return current

    answer = {"kind": "answer", "message": "Done."}
    both = [monitor["id"], drill["id"]]
    first = turn(
        "Review these and suggest categories",
        [call("start_inventory_review", scope_type="items", item_ids=both), answer],
    )
    system, prompt = review_prompts[0]
    assert "exactly one entry for every item" in prompt and "tags never replace" in system
    facts = {entry["item"]: entry for entry in first["steps"][1]["result"]["facts"]["items"]}
    assert facts["Validation Monitor"]["analysis_result"] == {
        "result": "category",
        "category": "Electronics",
    }
    assert facts["Validation Monitor"]["waiting_for_approval"][0]["category"] == "Electronics"
    # Tags were proposed, but the record is explicit that no category was.
    assert facts["Heavy drill"]["analysis_result"] == {
        "result": "no_category",
        "tags": ["DIY"],
        "reason": "The model gave no reason.",
    }
    assert "category" not in facts["Heavy drill"]["waiting_for_approval"][0]
    for item in (monitor, drill):
        assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["category"] is None

    # Re-review keeps its intent, and an identical proposal is reported as already pending.
    again = turn(
        "Review Validation Monitor again with AI and suggest a category for it.",
        [
            call(
                "start_inventory_review",
                scope_type="items",
                item_ids=[monitor["id"]],
                review_again=True,
            ),
            answer,
        ],
        parent=first["id"],
    )
    assert again["steps"][0]["result"]["review"]["review_again"] is True
    assert len(review_prompts) == 2
    repeated = again["steps"][1]["result"]["facts"]["items"][0]
    assert repeated["analysis_result"] == {
        "result": "category",
        "category": "Electronics",
        "not_shown_as_new": "already_pending",
    }

    # Ordinary follow-ups stay small however long the conversation gets.
    parent = again["id"]
    for index in range(6):
        current = turn(
            f"What category did you suggest for Validation Monitor? ({index})",
            [
                call(
                    "get_inventory_review",
                    review_run_id=again["steps"][0]["result"]["review"]["id"],
                    item_ids=both,
                ),
                answer,
            ],
            parent=parent,
        )
        parent = current["id"]
    assert max(len(prompt) for prompt in plans) < 40_000
    last = json.loads(plans[-1])
    assert len(last["context_newest_first"]) == 4
    assert "scope_item_ids" not in plans[-1]
    asked = {entry["item"]: entry for entry in last["observations"][0]["result"]["facts"]["items"]}
    assert asked["Heavy drill"]["in_this_review"] is False
    assert asked["Validation Monitor"]["analysis_result"]["category"] == "Electronics"

    # A one-batch room review is followed through to its results as well.
    wide = turn(
        "Review the whole room",
        [call("start_inventory_review", scope_type="room", scope_id=room["id"]), answer],
    )
    assert [entry["call"]["name"] for entry in wide["steps"]][:2] == [
        "start_inventory_review",
        "get_inventory_review",
    ]


def two_homes(client):
    """Two properties that each have a Kitchen with a Spice shelf holding one item."""
    homes = {}
    for label in ("Town house", "Lake cabin"):
        home = client.post("/api/v1/properties", json={"name": label}).json()

        def room(name, home=home):
            response = client.post("/api/v1/rooms", json={"name": name, "property_id": home["id"]})
            assert response.status_code == 201, response.text
            return response.json()

        def shelf(name, room_id):
            response = client.post(
                "/api/v1/storage-locations", json={"name": name, "room_id": room_id}
            )
            assert response.status_code == 201, response.text
            return response.json()

        kitchen = room("Kitchen")
        spices = shelf("Spice shelf", kitchen["id"])
        item = client.post(
            "/api/v1/items",
            json={
                "name": f"{label} pepper mill",
                "room_id": kitchen["id"],
                "storage_location_id": spices["id"],
            },
        ).json()["item"]
        homes[label] = {
            "id": home["id"],
            "kitchen": kitchen,
            "spices": spices,
            "item": item,
            "room": room,
            "shelf": shelf,
        }
    return homes


def tool_results(client, monkeypatch, calls, **fields):
    responses = iter([*calls, {"kind": "answer", "message": "Done."}])
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, "Look in the kitchen", **fields)
    work(run)
    steps = read(client, run)["steps"]
    assert len(steps) == len(calls)
    return [step["result"] for step in steps]


def candidate_paths(result, kind):
    facts = result["facts"]
    assert result["error"] is None
    assert facts["ambiguous"] is True
    assert {entry["kind"] for entry in facts["candidates"]} == {kind}
    return {entry["id"]: entry["path"] for entry in facts["candidates"]}


def test_same_named_places_in_two_properties_are_reported_as_ambiguous(
    owner_client, configured_ai, monkeypatch
):
    homes = two_homes(owner_client)
    town, cabin = homes["Town house"], homes["Lake cabin"]
    kitchens = {
        town["kitchen"]["id"]: "Town house / Kitchen",
        cabin["kitchen"]["id"]: "Lake cabin / Kitchen",
    }
    shelves = {
        town["spices"]["id"]: "Town house / Kitchen / Spice shelf",
        cabin["spices"]["id"]: "Lake cabin / Kitchen / Spice shelf",
    }
    listed, searched, opened, placed, by_room, by_shelf = tool_results(
        owner_client,
        monkeypatch,
        [
            call("list_room_contents", room_name="kitchen"),
            call("search_items", room_name="Kitchen"),
            call("get_container_contents", container_name="spice shelf"),
            call("search_items", location_name="Spice shelf"),
            call("search_items", room_id=cabin["kitchen"]["id"]),
            call("get_container_contents", container_id=town["spices"]["id"]),
        ],
    )
    assert candidate_paths(listed, "room") == kitchens
    assert candidate_paths(searched, "room") == kitchens
    assert candidate_paths(opened, "location") == shelves
    assert candidate_paths(placed, "location") == shelves
    for result in (listed, searched, opened, placed):
        assert result["facts"]["total"] == 0
        assert "Which one did you mean?" in result["summary"]
        assert "Town house" in result["summary"] and "Lake cabin" in result["summary"]
        assert {ref["id"] for ref in result["references"]} == set(
            candidate_paths(result, result["facts"]["candidates"][0]["kind"])
        )
    # The listed ids let the model retry without guessing.
    assert [ref["title"] for ref in by_room["references"]] == ["Lake cabin pepper mill"]
    assert by_shelf["facts"]["container_id"] == town["spices"]["id"]


def test_property_scope_is_applied_before_place_names_are_resolved(
    owner_client, configured_ai, monkeypatch
):
    homes = two_homes(owner_client)
    for label, home in homes.items():
        listed, searched, opened, placed = tool_results(
            owner_client,
            monkeypatch,
            [
                call("list_room_contents", room_name="Kitchen"),
                call("search_items", room_name="Kitchen"),
                call("get_container_contents", container_name="Spice shelf"),
                call("search_items", location_name="Spice shelf"),
            ],
            property_id=home["id"],
        )
        assert listed["error"] is None and opened["error"] is None
        assert listed["facts"]["room_id"] == home["kitchen"]["id"]
        assert opened["facts"]["container_id"] == home["spices"]["id"]
        for result in (searched, placed):
            assert result["facts"]["total"] == 1
            assert [ref["title"] for ref in result["references"]] == [f"{label} pepper mill"]


def test_exact_place_names_win_over_substring_matches(owner_client, configured_ai, monkeypatch):
    homes = two_homes(owner_client)
    town = homes["Town house"]
    pantry = town["room"]("Kitchen pantry")
    annex = town["shelf"]("Spice shelf annex", pantry["id"])
    exact_room, exact_shelf, only_room, only_shelf, many_rooms, many_shelves, searched = (
        tool_results(
            owner_client,
            monkeypatch,
            [
                call("list_room_contents", room_name="Kitchen"),
                call("get_container_contents", container_name="Spice shelf"),
                call("list_room_contents", room_name="pantry"),
                call("get_container_contents", container_name="annex"),
                call("list_room_contents", room_name="Kitch"),
                call("get_container_contents", container_name="Spice"),
                call("search_items", room_name="Kitchen", location_name="Spice shelf"),
            ],
            property_id=town["id"],
        )
    )
    assert exact_room["facts"]["room_id"] == town["kitchen"]["id"]
    assert exact_shelf["facts"]["container_id"] == town["spices"]["id"]
    assert only_room["facts"]["room_id"] == pantry["id"]
    assert only_shelf["facts"]["container_id"] == annex["id"]
    assert candidate_paths(many_rooms, "room") == {
        town["kitchen"]["id"]: "Town house / Kitchen",
        pantry["id"]: "Town house / Kitchen pantry",
    }
    assert candidate_paths(many_shelves, "location") == {
        town["spices"]["id"]: "Town house / Kitchen / Spice shelf",
        annex["id"]: "Town house / Kitchen pantry / Spice shelf annex",
    }
    assert [ref["title"] for ref in searched["references"]] == ["Town house pepper mill"]


def test_missing_place_returns_nothing_instead_of_searching_elsewhere(
    owner_client, configured_ai, monkeypatch
):
    from housetory_api.schemas.ai import NaturalSearchFilters
    from housetory_api.services.ai_tools.inventory_query import inventory_totals, search_inventory

    homes = two_homes(owner_client)
    town, cabin = homes["Town house"], homes["Lake cabin"]
    garage = cabin["room"]("Garage")
    cabin["shelf"]("Tool chest", garage["id"])

    no_room, no_shelf, with_text, listed, opened = tool_results(
        owner_client,
        monkeypatch,
        [
            # Both places exist, but only in the other property.
            call("search_items", room_name="Garage"),
            call("search_items", location_name="Tool chest"),
            call("search_items", q="pepper", room_name="Cellar"),
            call("list_room_contents", room_name="Garage"),
            call("get_container_contents", container_name="Tool chest"),
        ],
        property_id=town["id"],
    )
    for result, field in (
        (no_room, "room_name"),
        (no_shelf, "location_name"),
        (with_text, "room_name"),
    ):
        assert result["error"] is None
        assert result["facts"]["place_not_found"] is True
        assert result["facts"]["not_found_field"] == field
        assert result["facts"]["total"] == 0
        assert result["references"] == []
        assert "was found" in result["summary"] and "No " in result["summary"]
    for result in (listed, opened):
        assert result["error"] == "tool_validation"
        assert result["references"] == []

    household = uuid.UUID(owner_client.get("/api/v1/auth/session").json()["household"]["id"])
    with SessionLocal() as db:
        for filters in (
            NaturalSearchFilters(room_name="Cellar"),
            NaturalSearchFilters(location_name="Wine rack"),
            NaturalSearchFilters(q="pepper", room_name="Cellar"),
            NaturalSearchFilters(room_name="Garage", property_id=town["id"]),
            NaturalSearchFilters(room_name="Kitchen", location_name="Wine rack"),
        ):
            assert search_inventory(db, household, filters, household_reminder_days=30) == ([], 0)
            assert inventory_totals(db, household, filters, household_reminder_days=30) == (0, 0)
        # The same search without the missing place does find inventory.
        _rows, total = search_inventory(
            db, household, NaturalSearchFilters(q="pepper"), household_reminder_days=30
        )
        assert total == 2


def test_place_names_are_matched_literally_not_as_wildcards(
    owner_client, configured_ai, monkeypatch
):
    town = two_homes(owner_client)["Town house"]
    underscore = town["room"]("A_B room")
    town["room"]("AXB room")
    percent = town["room"]("Sale 50% rack")
    decoy = town["room"]("Sale 500 rack")
    slash = town["room"]("In/Out tray")
    box = town["shelf"]("Box_1", underscore["id"])
    town["shelf"]("BoxA1", underscore["id"])
    crate = town["shelf"]("Crate 10%", percent["id"])
    town["shelf"]("Crate 100", decoy["id"])
    for name, room, shelf in (("Scarf", percent, crate["id"]), ("Gloves", decoy, None)):
        created = owner_client.post(
            "/api/v1/items",
            json={"name": name, "room_id": room["id"], "storage_location_id": shelf},
        )
        assert created.status_code == 201, created.text

    results = tool_results(
        owner_client,
        monkeypatch,
        [
            call("list_room_contents", room_name="A_B"),
            call("list_room_contents", room_name="_"),
            call("list_room_contents", room_name="50%"),
            call("list_room_contents", room_name="%"),
            call("list_room_contents", room_name="n/O"),
            call("list_room_contents", room_name="\\"),
        ],
        property_id=town["id"],
    ) + tool_results(
        owner_client,
        monkeypatch,
        [
            call("get_container_contents", container_name="x_1"),
            call("get_container_contents", container_name="10%"),
            call("search_items", room_name="50%"),
            call("search_items", location_name="10%"),
            call("search_items", q="50%"),
            call("search_items", q="e 10%"),
        ],
        property_id=town["id"],
    )
    by_underscore, only_underscore, by_percent, only_percent, by_slash, backslash = results[:6]
    assert by_underscore["facts"]["room_id"] == underscore["id"]
    assert only_underscore["facts"]["room_id"] == underscore["id"]
    assert by_percent["facts"]["room_id"] == percent["id"]
    assert only_percent["facts"]["room_id"] == percent["id"]
    assert by_slash["facts"]["room_id"] == slash["id"]
    assert backslash["error"] == "tool_validation"
    assert results[6]["facts"]["container_id"] == box["id"]
    assert results[7]["facts"]["container_id"] == crate["id"]
    for result in results[8:]:
        assert result["error"] is None
        assert [ref["title"] for ref in result["references"]] == ["Scarf"]
