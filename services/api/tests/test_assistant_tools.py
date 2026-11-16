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
    for _ in range(2):
        response = client.post(
            f"/api/v1/assistant/actions/proposals/{proposal_id}/apply",
            json={"request_id": proposal_id},
        )
        assert response.status_code == 200, response.text
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


def test_required_review_request_uses_existing_background_review_and_explicit_approval(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services.assistant_tools import review_jobs

    client = owner_client
    _, item = seed(client, "  Validation drill  ")
    responses = iter(
        [
            call("start_inventory_review", scope_type="items", item_ids=[item["id"]]),
            {
                "kind": "answer",
                "message": "Local review is running. Enable AI suggestions for categorization.",
            },
        ]
    )
    monkeypatch.setattr(ai, "complete_json", lambda *a, **k: next(responses))
    run = start(client, "Do a review and categorise the items.")
    work(run)
    result = read(client, run)
    review = result["steps"][0]["result"]["review"]
    assert review["background_active"]
    assert review["scope_item_ids"] == [item["id"]]
    with SessionLocal() as db:
        from housetory_api.models import InventoryReviewRun

        root = db.get(InventoryReviewRun, uuid.UUID(review["id"]))
        job = db.get(Job, uuid.UUID(root.progress_json["background_job_id"]))
        payload = job.payload
    review_jobs.run_job(payload)
    current = client.get(f"/api/v1/inventory-review/runs/{review['id']}").json()
    assert current["batch_state"] == "completed", current
    assert current["item_count_scanned"] == 1
    assert current["ai_reviewed_count"] == 0
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["category"] is None
    queued = client.get(f"/api/v1/inventory-review/suggestions?review_run_id={review['id']}").json()
    assert all(suggestion["item"]["id"] == item["id"] for suggestion in queued["items"])
    ai_review = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "request_id": str(uuid.uuid4()),
            "scope_type": "items",
            "item_ids": [item["id"]],
            "include_ai": True,
            "background": True,
            "assistant_run_id": run["id"],
            "assistant_review_id": review["id"],
        },
    )
    assert ai_review.status_code == 200, ai_review.text
    active = ai_review.json()
    assert read(client, run)["steps"][0]["result"]["review"]["id"] == active["id"]
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "tools"}],
                    "confidence": "high",
                    "reason": "Synthetic tool review",
                }
            ],
        },
    )
    with SessionLocal() as db:
        root = db.get(InventoryReviewRun, uuid.UUID(active["id"]))
        payload = db.get(Job, uuid.UUID(root.progress_json["background_job_id"])).payload
    review_jobs.run_job(payload)
    queue = client.get(f"/api/v1/inventory-review/suggestions?review_run_id={active['id']}").json()
    organisation = next(
        suggestion for suggestion in queue["items"] if suggestion["type"] == "organisation"
    )
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["tags"] == []
    approved = client.post(
        f"/api/v1/inventory-review/suggestions/{organisation['id']}/accept",
        json={},
    )
    assert approved.status_code == 200, approved.text
    saved = client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert [tag["name"] for tag in saved["tags"]] == ["tools"]


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
