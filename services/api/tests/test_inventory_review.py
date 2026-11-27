import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from sqlalchemy import select

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import (
    ActivityEvent,
    Category,
    HouseholdMember,
    InventoryReviewSuggestion,
    Item,
    Tag,
    User,
)
from housetory_api.security import hash_password
from housetory_api.services import inventory_review
from housetory_api.services.auth import create_session


def seed_review_items(client, count):
    room = create_room(client, "Batch room")
    household = client.get("/api/v1/auth/session").json()["household"]["id"]
    with SessionLocal() as db:
        db.add_all(
            [
                Item(
                    household_id=uuid.UUID(household),
                    room_id=uuid.UUID(room["id"]),
                    name=f"Batch object {index:04}",
                    quantity=1,
                )
                for index in range(count)
            ]
        )
        db.commit()
    return room


def sent_items(prompt):
    return json.loads(prompt.split("Items: ", 1)[1].split("\nReturn ", 1)[0])


def decline_all(_system, prompt, **_kwargs):
    """A complete model answer: one reasoned decline per item sent."""
    return {
        "suggestions": [
            {"index": record["index"], "no_category_reason": "The record does not say what it is."}
            for record in sent_items(prompt)
        ]
    }


def test_empty_ai_response_covers_nothing_and_a_later_review_sends_every_item_again(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 2)
    calls = []

    def complete(_system, prompt, **_kwargs):
        calls.append(sent_items(prompt))
        return {}

    monkeypatch.setattr(ai, "complete_json", complete)
    empty = run_review(owner_client, include_ai=True).json()
    assert (empty["ai_item_count"], empty["ai_reviewed_count"]) == (2, 0)
    assert empty["ai_unanswered_count"] == 2
    assert empty["status"] == "partial"
    assert empty["ai_error"] is None
    assert "no usable answer for 2" in empty["partial_reason"]
    assert empty["remaining_item_count"] == 0

    monkeypatch.setattr(
        ai, "complete_json", lambda *a, **k: calls.append(sent_items(a[1])) or decline_all(*a, **k)
    )
    later = run_review(owner_client, include_ai=True).json()
    assert len(calls[-1]) == 2
    assert (later["ai_reused_count"], later["ai_reviewed_count"]) == (0, 2)
    assert later["ai_unanswered_count"] == 0
    assert later["status"] == "completed"
    assert later["partial_reason"] is None


def test_partial_ai_response_covers_only_answered_items_and_reports_the_rest(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 4)
    calls = []

    def complete(_system, prompt, **_kwargs):
        records = sent_items(prompt)
        calls.append([record["name"] for record in records])
        if len(calls) > 1:
            return decline_all(_system, prompt)
        return {
            "suggestions": [
                {"index": 0, "category": {"name": "Camping"}, "reason": "Named as camping gear."},
                {"index": 1, "no_category_reason": "The name does not say what it is."},
                # An entry with neither a proposal nor a reason is not an answer.
                {"index": 2},
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    partial = run_review(owner_client, include_ai=True).json()
    assert (partial["ai_item_count"], partial["ai_reviewed_count"]) == (4, 2)
    assert partial["ai_unanswered_count"] == 2
    assert partial["status"] == "partial"
    assert partial["ai_error"] is None
    assert "no usable answer for 2" in partial["partial_reason"]
    assert len(organisation_suggestions(owner_client)) == 1

    later = run_review(owner_client, include_ai=True).json()
    assert calls[1] == calls[0][2:]
    assert (later["ai_reused_count"], later["ai_reviewed_count"]) == (2, 2)
    assert later["ai_unanswered_count"] == 0
    assert later["status"] == "completed"
    # The answered item's proposal survives the later review untouched.
    assert len(organisation_suggestions(owner_client)) == 1


def test_invalid_ai_entries_do_not_discard_valid_ones_or_count_as_coverage(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 6)
    calls = []
    decline = {"index": 4, "no_category_reason": "The name does not say what it is."}

    def complete(_system, prompt, **_kwargs):
        calls.append([record["name"] for record in sent_items(prompt)])
        if len(calls) > 1:
            return decline_all(_system, prompt)
        return {
            "suggestions": [
                {"index": 0, "category": {"name": "Camping"}, "reason": "Named as camping gear."},
                {"index": 1, "category": {"id": str(uuid.uuid4())}},
                "not an entry",
                {"index": 7, "category": {"name": "Camping"}},
                {"index": -1, "category": {"name": "Camping"}},
                # An invalid duplicate must not suppress the valid answer after it.
                {"index": 2, "tags": [{"id": str(uuid.uuid4())}]},
                {"index": 2, "no_category_reason": "The name does not say what it is."},
                # Conflicting duplicates: neither answer is recorded.
                {"index": 3, "category": {"name": "Tools"}},
                {"index": 3, "category": {"name": "Garden"}},
                # Agreeing duplicates are one answer.
                decline,
                decline,
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    partial = run_review(owner_client, include_ai=True).json()
    assert partial["ai_error"] is None
    assert partial["status"] == "partial"
    assert (partial["ai_item_count"], partial["ai_reviewed_count"]) == (6, 3)
    assert partial["ai_unanswered_count"] == 3
    reason = partial["partial_reason"]
    assert "no usable answer for 3" in reason
    assert "6 invalid AI entries were ignored" in reason
    assert "entry 1: unknown existing category id" in reason
    [suggestion] = organisation_suggestions(owner_client)
    assert suggestion["after"]["category_name"] == "Camping"

    later = run_review(owner_client, include_ai=True).json()
    names = calls[0]
    assert calls[1] == [names[1], names[3], names[5]]
    assert (later["ai_reused_count"], later["ai_reviewed_count"]) == (3, 3)
    assert later["status"] == "completed"


@pytest.mark.parametrize("response", ["not json", ["index", 0], {"suggestions": "none"}])
def test_unparseable_ai_response_leaves_the_batch_uncovered_with_an_error(
    owner_client, configured_ai, monkeypatch, response
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 2)
    calls = []
    monkeypatch.setattr(
        ai, "complete_json", lambda _system, prompt, **_k: calls.append(prompt) or response
    )
    failed = run_review(owner_client, include_ai=True).json()
    assert "AI organisation review failed" in failed["ai_error"]
    assert failed["status"] == "partial"
    assert failed["ai_reviewed_count"] == 0
    assert organisation_suggestions(owner_client) == []

    monkeypatch.setattr(
        ai, "complete_json", lambda *a, **k: calls.append(a[1]) or decline_all(*a, **k)
    )
    later = run_review(owner_client, include_ai=True).json()
    assert len(sent_items(calls[-1])) == 2
    assert (later["ai_reused_count"], later["ai_reviewed_count"]) == (0, 2)


def test_fully_answered_ai_response_covers_every_item_and_reports_completion(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 2)
    calls = []

    def complete(_system, prompt, **_kwargs):
        calls.append(prompt)
        return {
            "suggestions": [
                {"index": 0, "category": {"name": "Camping"}, "reason": "Named as camping gear."},
                {"index": 1, "no_category_reason": "The name does not say what it is."},
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    full = run_review(owner_client, include_ai=True).json()
    assert (full["ai_item_count"], full["ai_reviewed_count"]) == (2, 2)
    assert full["ai_unanswered_count"] == 0
    assert full["status"] == "completed"
    assert full["partial_reason"] is None
    later = run_review(owner_client, include_ai=True).json()
    assert len(calls) == 1
    assert (later["ai_reused_count"], later["ai_reviewed_count"]) == (2, 0)


def test_successful_ai_coverage_reuses_unchanged_inputs_but_not_relevant_edits(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    item = create_item(client, "Coverage tent", room["id"], description="Two-person tent")
    create_item(client, "Unchanged camera", room["id"])
    calls = []

    def complete(*args, **kwargs):
        calls.append(args)
        return decline_all(*args, **kwargs)

    monkeypatch.setattr(ai, "complete_json", complete)
    first = run_review(client, include_ai=True).json()
    assert first["ai_reviewed_count"] == 2
    second = run_review(client, include_ai=True).json()
    assert len(calls) == 1
    assert second["ai_reused_count"] == 2
    assert second["ai_reviewed_count"] == 0
    assert client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3}).status_code == 200
    run_review(client, include_ai=True)
    assert len(calls) == 1
    assert (
        client.patch(
            f"/api/v1/items/{item['id']}", json={"description": "Portable camping stove"}
        ).status_code
        == 200
    )
    changed = run_review(client, include_ai=True).json()
    assert len(calls) == 2
    assert changed["ai_reviewed_count"] == 1
    assert changed["ai_reused_count"] == 1
    records = json.loads(calls[-1][1].split("Items: ", 1)[1].split("\nReturn ", 1)[0])
    assert [row["name"] for row in records] == ["Coverage tent"]


def test_review_again_preserves_semantic_decisions_and_explicit_reconsideration_history(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    item = create_item(client, "Camping kit", room["id"])
    calls = []

    def complete(*args, **kwargs):
        calls.append(args)
        tags = [{"name": "camping"}, {"name": "outdoors"}]
        return {
            "suggestions": [
                {
                    "index": 0,
                    "tags": tags if len(calls) % 2 else list(reversed(tags)),
                    "confidence": "high" if len(calls) % 2 else "medium",
                    "reason": f"Different explanation wording number {len(calls)}",
                }
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    assert run_review(client, include_ai=True).status_code == 200
    original = organisation_suggestions(client)[0]
    assert (
        client.post(f"/api/v1/inventory-review/suggestions/{original['id']}/dismiss").status_code
        == 200
    )
    run_review(client, include_ai=True)
    assert len(calls) == 1
    assert organisation_suggestions(client) == []

    again = run_review(client, include_ai=True, review_again=True).json()
    assert len(calls) == 2
    assert again["suppressed_suggestion_count"] == 1
    assert organisation_suggestions(client) == []
    assert suggestions(client, "dismissed")["items"][0]["id"] == original["id"]

    create_tag(client, "camping")
    create_tag(client, "outdoors")
    run_review(client, include_ai=True, review_again=True)
    assert organisation_suggestions(client) == []

    reconsidered = run_review(
        client,
        include_ai=True,
        review_again=True,
        reconsider_dismissed=True,
    )
    assert reconsidered.status_code == 200
    pending = organisation_suggestions(client)
    assert len(pending) == 1
    assert pending[0]["id"] != original["id"]
    run_review(client, include_ai=True, review_again=True, reconsider_dismissed=True)
    assert [row["id"] for row in organisation_suggestions(client)] == [pending[0]["id"]]
    assert suggestions(client, "dismissed")["items"][0]["id"] == original["id"]
    assert item_state(client, item["id"])["tags"] == []
    approved = client.post(
        f"/api/v1/inventory-review/suggestions/{pending[0]['id']}/accept", json={}
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "applied"
    assert {tag["name"] for tag in item_state(client, item["id"])["tags"]} == {
        "camping",
        "outdoors",
    }
    assert suggestions(client, "accepted")["items"][0]["id"] == pending[0]["id"]


def test_legacy_dismissal_survives_incidental_evidence_but_new_proposals_remain_eligible(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    item = create_item(client, "Legacy tent", room["id"], description="Portable shelter")
    proposed = "camping"
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": proposed}],
                    "confidence": "high",
                    "reason": "Synthetic evidence",
                }
            ]
        },
    )
    run_review(client, include_ai=True)
    original = organisation_suggestions(client)[0]
    client.post(f"/api/v1/inventory-review/suggestions/{original['id']}/dismiss")
    with SessionLocal() as db:
        legacy = db.get(InventoryReviewSuggestion, uuid.UUID(original["id"]))
        legacy.evidence_json = {
            key: value for key, value in legacy.evidence_json.items() if key != "review_input"
        }
        legacy.fingerprint = "a" * 64
        db.commit()
    assert client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 4}).status_code == 200
    run_review(client, include_ai=True, review_again=True)
    assert organisation_suggestions(client) == []
    proposed = "travel"
    run_review(client, include_ai=True, review_again=True)
    assert len(organisation_suggestions(client)) == 1
    assert suggestions(client, "dismissed")["items"][0]["id"] == original["id"]


def test_cached_pending_proposal_can_be_reviewed_and_applied_after_unrelated_edit(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    item = create_item(client, "Cached tent", room["id"])
    calls = []

    def complete(*args, **kwargs):
        calls.append(args)
        return {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "camping"}],
                    "confidence": "high",
                    "reason": "Synthetic shelter",
                }
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    run_review(client, include_ai=True)
    original = organisation_suggestions(client)[0]
    client.patch(f"/api/v1/items/{item['id']}", json={"quantity": 3})
    reused = run_review(client, include_ai=True).json()
    assert reused["ai_reused_count"] == 1
    assert len(calls) == 1
    pending = organisation_suggestions(client)
    assert len(pending) == 1
    assert pending[0]["id"] != original["id"]
    assert suggestions(client, "stale")["items"][0]["id"] == original["id"]
    approved = client.post(
        f"/api/v1/inventory-review/suggestions/{pending[0]['id']}/accept", json={}
    )
    assert approved.json()["status"] == "applied"
    saved = item_state(client, item["id"])
    assert saved["quantity"] == 3
    assert saved["tags"][0]["name"] == "camping"


def test_dismissal_does_not_block_other_review_types_or_meaningfully_new_evidence(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    item = create_item(client, "Portable tent", room["id"], description="Two-person shelter")
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "camping"}],
                    "confidence": "high",
                    "reason": "Synthetic shelter",
                }
            ]
        },
    )
    run_review(client, include_ai=True)
    original = organisation_suggestions(client)[0]
    client.post(f"/api/v1/inventory-review/suggestions/{original['id']}/dismiss")
    create_item(client, "Portable tent", room["id"])
    new_type = run_review(client, include_ai=True).json()
    assert new_type["ai_reused_count"] == new_type["ai_reviewed_count"] == 1
    assert any(
        row["type"] == "possible_duplicate"
        and item["id"] in (row["item_id"], row["secondary_item_id"])
        for row in suggestions(client)["items"]
    )
    client.patch(
        f"/api/v1/items/{item['id']}", json={"description": "Lightweight emergency shelter"}
    )
    changed = run_review(client, include_ai=True).json()
    assert changed["ai_reviewed_count"] == 1
    assert any(row["item_id"] == item["id"] for row in organisation_suggestions(client))
    assert suggestions(client, "dismissed")["items"][0]["id"] == original["id"]
    assert item_state(client, item["id"])["tags"] == []


def test_capability_changes_and_failures_do_not_reuse_incomplete_coverage(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai
    from housetory_api.services.inventory_review import coverage

    client = owner_client
    seed_review_items(client, 1)
    calls = []
    fail = True

    def complete(*args, **kwargs):
        calls.append(args)
        if fail:
            raise ai.AiError("Synthetic incomplete review")
        return decline_all(*args, **kwargs)

    monkeypatch.setattr(ai, "complete_json", complete)
    first = run_review(client, include_ai=True).json()
    assert first["ai_reviewed_count"] == first["ai_reused_count"] == 0
    assert first["remaining_item_count"] == 1
    fail = False
    resumed = advance_review(client, first)
    assert resumed["ai_reviewed_count"] == 1
    run_review(client, include_ai=True)
    assert len(calls) == 2
    monkeypatch.setattr(coverage, "CAPABILITY_VERSION", coverage.CAPABILITY_VERSION + 1)
    upgraded = run_review(client, include_ai=True).json()
    assert upgraded["ai_reviewed_count"] == 1
    assert upgraded["ai_reused_count"] == 0
    assert len(calls) == 3
    run_review(client, include_ai=False, review_again=True)
    assert len(calls) == 3


@pytest.mark.parametrize("indexes", [[39], [-1]])
def test_invalid_item_references_never_record_successful_coverage(
    owner_client,
    configured_ai,
    monkeypatch,
    indexes,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 1)
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "suggestions": [
                {
                    "index": index,
                    "tags": [{"name": "camping"}],
                    "confidence": "high",
                    "reason": "Synthetic invalid reference",
                }
                for index in indexes
            ]
        },
    )
    failed = run_review(owner_client, include_ai=True).json()
    assert failed["ai_reviewed_count"] == failed["ai_reused_count"] == 0
    assert failed["status"] == "partial"
    assert failed["ai_unanswered_count"] == 1
    assert "1 invalid AI entries were ignored" in failed["partial_reason"]
    assert organisation_suggestions(owner_client) == []
    monkeypatch.setattr(ai, "complete_json", decline_all)
    retry = run_review(owner_client, include_ai=True).json()
    assert retry["ai_reviewed_count"] == 1
    assert retry["ai_reused_count"] == 0


def test_capability_upgrade_preserves_completed_batches_but_requires_current_review(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai
    from housetory_api.services.inventory_review import coverage

    seed_review_items(owner_client, 41)
    monkeypatch.setattr(ai, "complete_json", decline_all)
    partial = run_review(owner_client, include_ai=True).json()
    assert partial["ai_reviewed_count"] == 40
    monkeypatch.setattr(coverage, "CAPABILITY_VERSION", coverage.CAPABILITY_VERSION + 1)
    refused = owner_client.post(
        f"/api/v1/inventory-review/runs/{partial['id']}/continue",
        json={"version": partial["batch_version"], "resume": True},
    )
    assert refused.status_code == 409
    restored = owner_client.get("/api/v1/inventory-review/summary").json()["last_run"]
    assert restored["ai_reviewed_count"] == 40
    assert restored["remaining_item_count"] == 1
    current = run_review(owner_client, include_ai=True).json()
    assert current["ai_reviewed_count"] == 40
    assert current["ai_reused_count"] == 0
    current = advance_review(owner_client, current)
    assert current["ai_reviewed_count"] == 41


def test_normal_review_prioritises_unfinished_inputs_over_unchanged_covered_items(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 41)
    calls = []

    def complete(*args, **kwargs):
        calls.append(args)
        return decline_all(*args, **kwargs)

    monkeypatch.setattr(ai, "complete_json", complete)
    first = run_review(owner_client, include_ai=True).json()
    assert first["ai_reviewed_count"] == 40
    cancelled = owner_client.post(
        f"/api/v1/inventory-review/runs/{first['id']}/cancel",
        json={"version": first["batch_version"]},
    )
    assert cancelled.status_code == 200
    normal = run_review(owner_client, include_ai=True).json()
    assert normal["ai_reviewed_count"] == 1
    assert normal["ai_reused_count"] == 39
    normal = advance_review(owner_client, normal)
    assert normal["ai_reused_count"] == 40
    assert normal["ai_reviewed_count"] == 1
    assert len(calls) == 2


def test_single_item_review_uses_authorised_context_and_filters_results_without_writes(
    owner_client,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    target = create_item(client, "Scoped drill", room["id"])
    sibling = create_item(client, "Scoped drill", room["id"], category_id=category["id"])
    create_item(client, "Other category pair", room["id"])
    create_item(client, "Other category pair", room["id"], category_id=category["id"])
    monkeypatch.setattr(
        ai, "complete_json", lambda *a, **k: pytest.fail("Local item review called AI")
    )
    first = run_review(client, scope_type="items", item_ids=[target["id"]]).json()
    assert first["item_count_scanned"] == first["total_item_count"] == 1
    pending = suggestions(client)["items"]
    assert any(row["type"] == "category" and row["item_id"] == target["id"] for row in pending)
    assert all(target["id"] in (row["item_id"], row["secondary_item_id"]) for row in pending)
    assert item_state(client, target["id"])["category"] is None
    category_proposal = next(row for row in pending if row["type"] == "category")
    client.post(f"/api/v1/inventory-review/suggestions/{category_proposal['id']}/dismiss")
    normal = run_review(client, scope_type="items", item_ids=[target["id"]]).json()
    assert normal["suppressed_suggestion_count"] == 1
    again = run_review(
        client, scope_type="items", item_ids=[target["id"]], review_again=True
    ).json()
    assert again["suppressed_suggestion_count"] == 1
    reconsidered = run_review(
        client,
        scope_type="items",
        item_ids=[target["id"]],
        review_again=True,
        reconsider_dismissed=True,
    )
    assert reconsidered.status_code == 200
    run_review(client)  # populate findings for other items, without changing selected-item results
    filtered = client.get(
        "/api/v1/inventory-review/suggestions",
        params={"status": "pending", "item_ids": target["id"]},
    ).json()["items"]
    assert all(target["id"] in (row["item_id"], row["secondary_item_id"]) for row in filtered)
    proposal = next(row for row in filtered if row["type"] == "category")
    approved = client.post(f"/api/v1/inventory-review/suggestions/{proposal['id']}/accept", json={})
    assert approved.json()["status"] == "applied"
    assert item_state(client, target["id"])["category"]["id"] == category["id"]
    assert item_state(client, sibling["id"])["category"]["id"] == category["id"]
    assert run_review(client, scope_type="items", item_ids=[str(uuid.uuid4())]).status_code == 404
    invalid = run_review(client, reconsider_dismissed=True)
    assert invalid.status_code == 422


def advance_review(client, run, *, resume=False):
    response = client.post(
        f"/api/v1/inventory-review/runs/{run['id']}/continue",
        json={"version": run["batch_version"], "resume": resume},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_hundreds_ai_batches_cancel_reload_failure_retry_and_duplicate_prevention(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    seed_review_items(client, 205)
    calls = []
    fail = False

    def complete(_system, prompt, **_kwargs):
        records = json.loads(prompt.split("Items: ", 1)[1].split("\nReturn ", 1)[0])
        calls.append([row["name"] for row in records])
        assert 1 <= len(records) <= 40
        if fail:
            raise ai.AiError("Synthetic provider outage")
        return {
            "suggestions": [
                {
                    "index": row["index"],
                    "tags": [{"name": "organised"}],
                    "confidence": "high",
                    "reason": "Synthetic review fixture",
                }
                for row in records
            ]
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    run = run_review(client, include_ai=True).json()
    assert (run["item_count_scanned"], run["ai_reviewed_count"], run["remaining_item_count"]) == (
        40,
        40,
        165,
    )
    cancelled = client.post(
        f"/api/v1/inventory-review/runs/{run['id']}/cancel", json={"version": run["batch_version"]}
    )
    assert cancelled.status_code == 200
    run = cancelled.json()
    assert run["batch_state"] == "cancelled"
    restored = client.get("/api/v1/inventory-review/summary").json()["last_run"]
    assert restored == run
    replayed = advance_review(client, run)
    assert replayed["batch_version"] == run["batch_version"]
    assert replayed["ai_reviewed_count"] == run["ai_reviewed_count"]
    assert len(calls) == 1
    fail = True
    run = advance_review(client, run, resume=True)
    assert run["status"] == "partial"
    assert run["ai_error"]
    assert (run["item_count_scanned"], run["ai_eligible_count"], run["ai_reviewed_count"]) == (
        80,
        80,
        40,
    )
    failed_version = run["batch_version"] - 1
    replay = {**run, "batch_version": failed_version}
    assert advance_review(client, replay) == run
    assert len(calls) == 2
    fail = False
    run = advance_review(client, run)
    assert calls[1] == calls[2]
    assert set(calls[0]).isdisjoint(calls[2])
    assert (run["item_count_scanned"], run["ai_reviewed_count"]) == (80, 80)
    while run["remaining_item_count"]:
        run = advance_review(client, run)
    assert run["status"] == "completed"
    assert (
        run["total_item_count"],
        run["item_count_scanned"],
        run["ai_eligible_count"],
        run["ai_reviewed_count"],
    ) == (205, 205, 205, 205)
    assert run["ai_item_count"] == 245  # failed provider batch was sent, not reviewed
    assert run["created_suggestion_count"] == 205
    assert len(calls) == 7
    replayed = advance_review(client, run)
    assert replayed["batch_version"] == run["batch_version"]
    assert replayed["ai_reviewed_count"] == run["ai_reviewed_count"]
    pages = [
        client.get(
            "/api/v1/inventory-review/suggestions", params={"limit": 100, "offset": offset}
        ).json()["items"]
        for offset in (0, 100, 200)
    ]
    proposals = [proposal for page in pages for proposal in page]
    assert len({proposal["fingerprint"] for proposal in proposals}) == 205
    assert all(proposal["run_id"] == run["id"] for proposal in proposals)
    inventory = client.get("/api/v1/items", params={"limit": 100}).json()["items"]
    assert all(not item["tags"] for item in inventory)  # analysis never writes inventory
    repeated = run_review(client, include_ai=True).json()
    while repeated["remaining_item_count"]:
        repeated = advance_review(client, repeated)
    assert repeated["ai_reused_count"] == 205
    assert repeated["ai_reviewed_count"] == 0
    assert len(calls) == 7


@pytest.mark.parametrize("count", [39, 40, 41, 501])
def test_offline_review_covers_every_item_and_exact_batch_boundaries(
    owner_client, monkeypatch, count
):
    from housetory_api.services import ai

    seed_review_items(owner_client, count)
    monkeypatch.setattr(
        ai, "complete_json", lambda *a, **k: pytest.fail("Offline review called AI")
    )
    run = run_review(owner_client).json()
    while run["remaining_item_count"]:
        run = advance_review(owner_client, run)
    assert run["status"] == "completed"
    assert run["item_count_scanned"] == run["total_item_count"] == count
    assert run["ai_eligible_count"] == count
    assert run["ai_reviewed_count"] == run["ai_item_count"] == 0
    assert run["completed_batch_count"] == (count + 39) // 40


def test_review_resume_rechecks_provider_consent_and_handles_interrupted_batch(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 41)
    monkeypatch.setattr(ai, "complete_json", decline_all)
    run = run_review(owner_client, include_ai=True).json()
    monkeypatch.setattr(
        ai, "config_for", lambda *a, **k: replace(configured_ai, model="changed-after-consent")
    )
    rejected = owner_client.post(
        f"/api/v1/inventory-review/runs/{run['id']}/continue",
        json={"version": run["batch_version"]},
    )
    assert rejected.status_code == 409
    monkeypatch.setattr(ai, "config_for", lambda *a, **k: configured_ai)

    def interrupt(*args, **kwargs):
        raise RuntimeError("Simulated interrupted request")

    monkeypatch.setattr(ai, "complete_json", interrupt)
    with pytest.raises(RuntimeError, match="interrupted"):
        advance_review(owner_client, run)
    restored = owner_client.get("/api/v1/inventory-review/summary").json()["last_run"]
    assert restored["batch_version"] == run["batch_version"]
    assert restored["ai_reviewed_count"] == 40
    monkeypatch.setattr(ai, "complete_json", decline_all)
    resumed = advance_review(owner_client, restored)
    assert resumed["ai_reviewed_count"] == 41


def test_provider_change_during_inference_does_not_publish_batch(
    owner_client, configured_ai, monkeypatch
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 2)

    def changed(*args, **kwargs):
        monkeypatch.setattr(
            ai,
            "config_for",
            lambda *a, **k: replace(configured_ai, model="changed-during-inference"),
        )
        return {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "must not publish"}],
                    "confidence": "high",
                    "reason": "Synthetic stale output",
                }
            ]
        }

    monkeypatch.setattr(ai, "complete_json", changed)
    response = run_review(owner_client, include_ai=True)
    assert response.status_code == 409
    assert suggestions(owner_client)["total"] == 0
    restored = owner_client.get("/api/v1/inventory-review/summary").json()["last_run"]
    assert restored["item_count_scanned"] == restored["ai_reviewed_count"] == 0
    assert restored["remaining_item_count"] == 2


def test_concurrent_review_runs_do_not_duplicate_suggestions(
    owner_client, configured_ai, monkeypatch
):
    from housetory_api.services import ai

    seed_review_items(owner_client, 1)
    monkeypatch.setattr(
        ai,
        "complete_json",
        lambda *a, **k: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "concurrent review"}],
                    "confidence": "high",
                    "reason": "Synthetic concurrent fixture",
                }
            ],
        },
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run_review(owner_client, include_ai=True), range(2)))
    assert all(result.status_code == 200 for result in results)
    assert suggestions(owner_client)["total"] == 1
    assert sorted(result.json()["created_suggestion_count"] for result in results) == [0, 1]


def test_ai_eligibility_excludes_organised_items_and_no_eligible_batch_is_sent(
    owner_client,
    configured_ai,
    monkeypatch,
):
    from housetory_api.services import ai

    client = owner_client
    room = seed_review_items(client, 40)
    category = create_category(client, "Already organised")
    tag = create_tag(client, "Already tagged")
    create_item(
        client, "Organised record", room["id"], category_id=category["id"], tag_ids=[tag["id"]]
    )
    sent = []

    def complete(_system, prompt, **_kwargs):
        sent.extend(json.loads(prompt.split("Items: ", 1)[1].split("\nReturn ", 1)[0]))
        return decline_all(_system, prompt)

    monkeypatch.setattr(ai, "complete_json", complete)
    run = run_review(client, include_ai=True).json()
    while run["remaining_item_count"]:
        run = advance_review(client, run)
    assert (run["item_count_scanned"], run["ai_eligible_count"], run["ai_reviewed_count"]) == (
        41,
        40,
        40,
    )
    assert len(sent) == 40
    assert "Organised record" not in {record["name"] for record in sent}


def create_room(client, name="Workshop"):
    response = client.post("/api/v1/rooms", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def test_capture_reviews_restore_authorized_pending_work_and_resolve_on_apply(
    owner_client,
    pdf_bytes,
):
    from housetory_api.services.import_pipeline import process_import_batch

    client = owner_client
    room = create_room(client)
    batch_ids = []
    for name in ("Alpha cable", "Beta adapter"):
        created = client.post(
            "/api/v1/imports",
            data={
                "text": f"Add a {name} to Workshop",
                "title": name,
                "room_id": room["id"],
                "assistant_capture": "true",
            },
        )
        assert created.status_code == 201, created.text
        batch_ids.append(created.json()["id"])
        process_import_batch(created.json()["id"])
    document = client.post(
        "/api/v1/documents",
        data={
            "title": "Uncaptioned invoice",
            "document_type": "invoice",
            "assistant_capture": "true",
        },
        files={"file": ("scan.pdf", pdf_bytes, "application/pdf")},
    )
    assert document.status_code == 201, document.text
    captures = client.get("/api/v1/inventory-review/captures").json()
    assert {entry["id"] for entry in captures} == {*batch_ids, document.json()["id"]}
    alpha = next(entry for entry in captures if entry["id"] == batch_ids[0])
    assert alpha["generation"]
    # Merely reading an older review cannot resolve it or select the newer one.
    first = client.get(f"/api/v1/imports/{batch_ids[0]}").json()
    assert client.get("/api/v1/inventory-review/captures").json() == captures
    applied = client.post(
        f"/api/v1/imports/{batch_ids[0]}/apply",
        json={"entries": [{"id": first["entries"][0]["id"], "action": "import"}]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["created"] == 1
    remaining = client.get("/api/v1/inventory-review/captures").json()
    assert {entry["id"] for entry in remaining} == {batch_ids[1], document.json()["id"]}
    assert client.get("/api/v1/items").json()["items"][0]["name"] == "Alpha cable"
    other = client.post(
        "/api/v1/households", json={"name": "Other household", "property_name": "Other"}
    )
    assert other.status_code == 201, other.text
    selected = client.post(f"/api/v1/households/{other.json()['household']['id']}/select")
    assert selected.status_code == 200
    assert client.get("/api/v1/inventory-review/captures").json() == []


def create_category(client, name):
    response = client.post("/api/v1/categories", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def create_item(client, name, room_id, **extra):
    response = client.post(
        "/api/v1/items",
        json={"name": name, "room_id": room_id, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def run_review(
    client,
    *,
    scope_type="household",
    scope_id=None,
    item_ids=None,
    include_ai=False,
    request_id=None,
    review_again=False,
    reconsider_dismissed=False,
):
    return client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": scope_type,
            "scope_id": scope_id,
            "item_ids": item_ids,
            "include_ai": include_ai,
            "review_again": review_again,
            "reconsider_dismissed": reconsider_dismissed,
            "request_id": request_id or str(uuid.uuid4()),
        },
    )


def suggestions(client, status="pending"):
    response = client.get(
        "/api/v1/inventory-review/suggestions",
        params={"status": status, "limit": 100},
    )
    assert response.status_code == 200, response.text
    return response.json()


def item_state(client, item_id):
    response = client.get(f"/api/v1/items/{item_id}")
    assert response.status_code == 200, response.text
    return response.json()["item"]


def add_member(client, role="member", email=None):
    state = client.get("/api/v1/auth/session").json()
    household_id = uuid.UUID(state["household"]["id"])
    with SessionLocal() as db:
        user = User(
            name=f"Review {role.title()}",
            email=email or f"review-{role}@example.com",
            password_hash=hash_password("review-member-password-2026"),
        )
        db.add(user)
        db.flush()
        db.add(
            HouseholdMember(
                household_id=household_id,
                user_id=user.id,
                role=role,
            )
        )
        token = create_session(
            db,
            user=user,
            settings=get_settings(),
            user_agent="inventory-review-test",
            ip_address="127.0.0.1",
            household_id=household_id,
        )
        db.commit()
    return {"Cookie": f"housetory_session={token}"}


def create_tag(client, name):
    response = client.post("/api/v1/tags", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def configure_review_assistant(client):
    provider = client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Organisation fixture AI",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-organisation-test",
            "api_key": "sk-organisation-fixture",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    task = client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider.json()["id"],
            "model": "gpt-organisation-test",
            "enabled": True,
        },
    )
    assert task.status_code == 200, task.text


def organisation_suggestions(client):
    return [entry for entry in suggestions(client)["items"] if entry["type"] == "organisation"]


def test_offline_review_persists_scoped_suggestions_without_mutating_items(owner_client):
    client = owner_client
    room = create_room(client)
    create_room(client, "Garage")
    create_room(client, "Attic")
    tools = create_category(client, "Tools")
    flashlight = create_category(client, "Lighting")

    drill = create_item(
        client,
        "Cordless drill",
        room["id"],
        category_id=tools["id"],
        brand="DeWalt",
        model="DCD791",
    )
    uncategorised_drill = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="DeWalt",
        model="DCD791",
    )
    create_item(
        client,
        "Camp lamp",
        room["id"],
        category_id=flashlight["id"],
    )
    casing = create_item(client, "camp lamp", room["id"])
    duplicate_a = create_item(
        client,
        "Camera charger",
        room["id"],
        brand="Sony",
        model="AC-UUD12",
    )
    duplicate_b = create_item(
        client,
        "camera charger",
        room["id"],
        brand="sony",
        model="ac-uud12",
    )
    create_item(
        client,
        "Old kettle",
        room["id"],
        description="Kept in the Attic according to the note.",
        purchase={"merchant": "Fixture store"},
    )
    before_updated = {
        entry["id"]: entry["updated_at"]
        for entry in [
            drill,
            uncategorised_drill,
            casing,
            duplicate_a,
            duplicate_b,
        ]
    }
    item_count = int((client.get("/api/v1/items?limit=1").json())["total"])

    response = run_review(client)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] in {"completed", "partial"}
    assert run["item_count_scanned"] >= 6
    assert run["created_suggestion_count"] > 0

    body = suggestions(client)
    types = {entry["type"] for entry in body["items"]}
    assert "category" in types
    assert "name" in types
    assert "possible_duplicate" in types
    assert "missing_detail" in types
    assert "location_conflict" in types
    assert body["pending_count"] == len(body["items"])
    category = next(
        entry
        for entry in body["items"]
        if entry["type"] == "category" and entry["item_id"] == uncategorised_drill["id"]
    )
    assert category["category_id"] == tools["id"]
    assert category["item"]["category"] is None
    name = next(
        entry
        for entry in body["items"]
        if entry["type"] == "name" and entry["item_id"] == casing["id"]
    )
    assert name["after"]["name"] == "Camp lamp"
    duplicate = next(
        entry
        for entry in body["items"]
        if entry["type"] == "possible_duplicate"
        and {entry["item_id"], entry["secondary_item_id"]} == {duplicate_a["id"], duplicate_b["id"]}
    )
    assert duplicate["action_kind"] == "advisory"
    location = next(entry for entry in body["items"] if entry["type"] == "location_conflict")
    assert "Attic" in location["evidence"]["mentioned_room"]
    missing = next(entry for entry in body["items"] if entry["type"] == "missing_detail")
    assert missing["action_kind"] == "advisory"

    # Analysis itself never changes inventory fields or timestamps.
    for item_id, updated_at in before_updated.items():
        assert item_state(client, item_id)["updated_at"] == updated_at
    assert int((client.get("/api/v1/items?limit=1").json())["total"]) == item_count

    # Re-running the same unchanged data does not flood the queue.
    second = run_review(client)
    assert second.status_code == 200, second.text
    second_body = suggestions(client)
    assert len(second_body["items"]) == len(body["items"])
    assert second.json()["created_suggestion_count"] == 0
    assert second.json()["existing_suggestion_count"] > 0

    # Dismissing one unchanged suggestion suppresses it on the next run.
    dismissed = client.post(f"/api/v1/inventory-review/suggestions/{duplicate['id']}/dismiss")
    assert dismissed.status_code == 200, dismissed.text
    third = run_review(client)
    assert third.status_code == 200, third.text
    pending_ids = {entry["id"] for entry in suggestions(client)["items"]}
    assert duplicate["id"] not in pending_ids
    assert third.json()["created_suggestion_count"] == 0

    # Undo brings the dismissed suggestion back as the same pending row. It stays
    # one row after another run, and dismissing it again is remembered again.
    restored = client.post(f"/api/v1/inventory-review/suggestions/{duplicate['id']}/undo")
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "applied"
    assert restored.json()["suggestion"]["status"] == "pending"
    fourth = run_review(client)
    assert fourth.json()["created_suggestion_count"] == 0
    assert [entry["id"] for entry in suggestions(client)["items"]].count(duplicate["id"]) == 1
    again = client.post(f"/api/v1/inventory-review/suggestions/{duplicate['id']}/dismiss")
    assert again.status_code == 200, again.text

    # A suggestion that was edited but not applied keeps that edit through Skip, a
    # reload and Restore; the memory of the dismissal is not changed by it.
    editable = next(
        entry
        for entry in suggestions(client)["items"]
        if entry["action_kind"] in {"apply_name", "apply_category"}
    )
    draft = {"name": "Edited before skipping"}
    skipped = client.post(
        f"/api/v1/inventory-review/suggestions/{editable['id']}/dismiss", json={"draft": draft}
    )
    assert skipped.status_code == 200, skipped.text
    kept = next(e for e in suggestions(client, "dismissed")["items"] if e["id"] == editable["id"])
    assert kept["evidence"]["review_draft"] == draft
    assert run_review(client).json()["created_suggestion_count"] == 0
    assert client.post(
        f"/api/v1/inventory-review/suggestions/{editable['id']}/undo"
    ).json()["suggestion"]["status"] == "pending"
    back = next(e for e in suggestions(client)["items"] if e["id"] == editable["id"])
    assert back["evidence"]["review_draft"] == draft
    assert back["fingerprint"] == editable["fingerprint"]
    assert run_review(client).json()["created_suggestion_count"] == 0
    assert duplicate["id"] not in {entry["id"] for entry in suggestions(client)["items"]}

    # A skip that says nothing about a draft leaves the kept edit alone. A skip with an
    # empty draft means the edit was taken back: it must not return with Restore.
    dismiss = f"/api/v1/inventory-review/suggestions/{editable['id']}/dismiss"
    undo = f"/api/v1/inventory-review/suggestions/{editable['id']}/undo"
    assert client.post(dismiss).status_code == 200
    assert client.post(undo).json()["suggestion"]["evidence"]["review_draft"] == draft
    assert client.post(dismiss, json={"draft": {}}).status_code == 200
    assert "review_draft" not in client.post(undo).json()["suggestion"]["evidence"]


def test_category_and_name_apply_undo_stale_and_bulk(owner_client):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    already = create_item(client, "Bench plane", room["id"], category_id=category["id"])
    target = create_item(client, "Bench plane", room["id"])
    variant = create_item(client, "Bench Plane", room["id"], category_id=category["id"])

    response = run_review(client)
    assert response.status_code == 200, response.text
    body = suggestions(client)
    category_suggestion = next(
        entry
        for entry in body["items"]
        if entry["type"] == "category" and entry["item_id"] == target["id"]
    )
    accepted = client.post(
        f"/api/v1/inventory-review/suggestions/{category_suggestion['id']}/accept",
        json={},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "applied"
    assert accepted.json()["suggestion"]["can_undo"] is True
    assert item_state(client, target["id"])["category"]["id"] == category["id"]

    undone = client.post(f"/api/v1/inventory-review/suggestions/{category_suggestion['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    assert item_state(client, target["id"])["category"] is None
    assert undone.json()["suggestion"]["status"] == "reverted"

    # A changed item makes the pending suggestion stale and protects its edits.
    run_review(client)
    name_suggestion = next(
        entry
        for entry in suggestions(client)["items"]
        if entry["type"] == "name" and entry["item_id"] == variant["id"]
    )
    edited = client.patch(
        f"/api/v1/items/{variant['id']}", json={"description": "Changed after analysis"}
    )
    assert edited.status_code == 200, edited.text
    stale = client.post(
        f"/api/v1/inventory-review/suggestions/{name_suggestion['id']}/accept",
        json={},
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["status"] == "stale"
    assert item_state(client, variant["id"])["name"] == "Bench Plane"

    # Bulk accept applies only compatible pending actionable suggestions.
    run_review(client)
    pending = [
        entry
        for entry in suggestions(client)["items"]
        if entry["action_kind"] in {"apply_category", "apply_name"}
    ][:2]
    if pending:
        bulk = client.post(
            "/api/v1/inventory-review/suggestions/bulk-accept",
            json={"suggestion_ids": [entry["id"] for entry in pending]},
        )
        assert bulk.status_code == 200, bulk.text
        assert bulk.json()["applied_count"] + bulk.json()["stale_count"] >= 1
    assert already


def test_duplicates_are_advisory_and_loan_quantities_are_untouched(owner_client):
    client = owner_client
    room = create_room(client)
    first = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="Makita",
        model="XFD12",
        serial_number="SN-REVIEW-1",
        quantity=3,
    )
    second = create_item(
        client,
        "Cordless drill",
        room["id"],
        brand="Makita",
        model="XFD12",
        serial_number="SN-REVIEW-2",
        quantity=2,
    )
    loan = client.post(
        "/api/v1/loans",
        json={
            "item_id": first["id"],
            "borrower_name": "Fixture borrower",
            "quantity": 1,
            "lent_on": "2026-10-01",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert loan.status_code == 201, loan.text
    run_review(client)
    duplicate = next(
        entry for entry in suggestions(client)["items"] if entry["type"] == "possible_duplicate"
    )
    assert duplicate["action_kind"] == "advisory"
    accepted = client.post(
        f"/api/v1/inventory-review/suggestions/{duplicate['id']}/accept",
        json={},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "unsupported"
    assert item_state(client, first["id"])["quantity"] == 3
    assert item_state(client, second["id"])["quantity"] == 2
    loans = client.get(f"/api/v1/loans?item_id={first['id']}").json()
    assert loans["items"][0]["outstanding_quantity"] == 1


def test_review_permissions_cross_household_and_idempotency(owner_client):
    client = owner_client
    room = create_room(client, "Scope room")
    item = create_item(client, "Scope item", room["id"])

    viewer = add_member(client, "viewer", email="review-viewer@example.com")
    member = add_member(client, "member", email="review-member@example.com")
    assert client.get("/api/v1/inventory-review/suggestions", headers=viewer).status_code == 200
    denied = client.post(
        "/api/v1/inventory-review/runs",
        headers=viewer,
        json={
            "scope_type": "household",
            "include_ai": False,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert denied.status_code == 403
    allowed = client.post(
        "/api/v1/inventory-review/runs",
        headers=member,
        json={
            "scope_type": "household",
            "include_ai": False,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert allowed.status_code == 200, allowed.text
    owner_only_ai = client.post(
        "/api/v1/inventory-review/runs",
        headers=member,
        json={
            "scope_type": "household",
            "include_ai": True,
            "request_id": str(uuid.uuid4()),
        },
    )
    assert owner_only_ai.status_code == 403
    assert owner_only_ai.json()["detail"]["code"] == "owner_required"

    first_household = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    request_id = str(uuid.uuid4())
    first = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "items",
            "item_ids": [item["id"]],
            "request_id": request_id,
        },
    )
    assert first.status_code == 200, first.text
    replay = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "items",
            "item_ids": [item["id"]],
            "request_id": request_id,
        },
    )
    assert replay.status_code == 200
    assert replay.json()["id"] == first.json()["id"]
    mismatch = client.post(
        "/api/v1/inventory-review/runs",
        json={
            "scope_type": "household",
            "request_id": request_id,
        },
    )
    assert mismatch.status_code == 409

    second = client.post(
        "/api/v1/households",
        json={"name": "Review other household", "property_name": "Other"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    second_room = client.post(
        "/api/v1/rooms",
        headers=second_headers,
        json={"name": "Other room"},
    ).json()
    selected = client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200
    headers = {"X-Household-Id": str(first_household)}

    cross_room = client.post(
        "/api/v1/inventory-review/runs",
        headers=headers,
        json={
            "scope_type": "room",
            "scope_id": second_room["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_room.status_code == 404
    cross_items = client.post(
        "/api/v1/inventory-review/runs",
        headers=headers,
        json={
            "scope_type": "items",
            "item_ids": [str(uuid.uuid4())],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert cross_items.status_code == 404


def test_ai_organisation_output_is_validated_and_offline_runs_never_call_ai(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Garden")
    create_item(client, "Pruning shears", room["id"], description="Garden hand tool")
    create_item(client, "Garden hose", room["id"])

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Offline review must not call AI.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)
    offline = run_review(client, include_ai=False)
    assert offline.status_code == 200, offline.text
    assert offline.json()["ai_used"] is False

    provider = client.post(
        "/api/v1/ai/providers",
        json={
            "provider": "openai",
            "display_name": "Review fixture AI",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-test",
            "api_key": "sk-review-fixture",
            "enabled": True,
            "cloud_consent": True,
        },
    )
    assert provider.status_code == 201, provider.text
    task = client.put(
        "/api/v1/ai/tasks/assistant",
        json={
            "provider_id": provider.json()["id"],
            "model": "gpt-test",
            "enabled": True,
        },
    )
    assert task.status_code == 200, task.text

    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(category["id"])},
                    "tags": [],
                    "confidence": "high",
                    "reason": "Explicit garden tool description.",
                }
            ]
        },
    )
    valid = run_review(client, include_ai=True)
    assert valid.status_code == 200, valid.text
    assert valid.json()["ai_used"] is True
    assert valid.json()["ai_error"] is None
    ai_suggestions = [entry for entry in suggestions(client)["items"] if entry["source"] == "ai"]
    assert ai_suggestions
    assert ai_suggestions[0]["type"] == "organisation"
    assert ai_suggestions[0]["category_id"] == category["id"]
    assert valid.json()["ai_item_count"] == 2

    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": "not-a-category"},
                    "tags": [],
                    "confidence": "high",
                    "reason": "bad",
                }
            ]
        },
    )
    invalid = run_review(client, include_ai=True, review_again=True)
    assert invalid.status_code == 200, invalid.text
    assert invalid.json()["status"] == "partial"
    assert "1 invalid AI entries were ignored" in invalid.json()["partial_reason"]


def test_scope_items_and_viewer_reads_are_household_scoped(owner_client):
    client = owner_client
    room = create_room(client)
    item = create_item(client, "Scoped item", room["id"])
    response = client.get(
        "/api/v1/inventory-review/scope-items",
        params=[("item_ids", item["id"])],
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["id"] == item["id"]

    viewer = add_member(client, "viewer", email="review-scope-viewer@example.com")
    assert (
        client.get(
            "/api/v1/inventory-review/scope-items",
            params=[("item_ids", item["id"])],
            headers=viewer,
        ).status_code
        == 200
    )
    assert (
        client.get(
            "/api/v1/inventory-review/scope-items",
            params=[("item_ids", str(uuid.uuid4()))],
        ).status_code
        == 404
    )


def test_room_container_property_and_item_scopes_stay_inside_scope(owner_client):
    client = owner_client
    room_a = create_room(client, "Scope A")
    room_b = create_room(client, "Scope B")
    category = create_category(client, "Scoped category")
    container = client.post(
        "/api/v1/storage-locations",
        json={"room_id": room_a["id"], "name": "Scope box", "kind": "box"},
    )
    assert container.status_code == 201, container.text
    container_id = container.json()["id"]

    container_category = create_item(
        client,
        "Container tool",
        room_a["id"],
        category_id=category["id"],
        storage_location_id=container_id,
    )
    container_uncategorised = create_item(
        client,
        "Container tool",
        room_a["id"],
        storage_location_id=container_id,
    )
    create_item(
        client,
        "Room tool",
        room_a["id"],
        category_id=category["id"],
    )
    room_uncategorised = create_item(client, "Room tool", room_a["id"])
    other_category = create_item(
        client,
        "Other room tool",
        room_b["id"],
        category_id=category["id"],
    )
    other_uncategorised = create_item(client, "Other room tool", room_b["id"])
    selected_category = create_item(
        client,
        "Selected tool",
        room_b["id"],
        category_id=category["id"],
    )
    selected_uncategorised = create_item(client, "Selected tool", room_b["id"])

    def run_and_ids(**kwargs):
        response = run_review(client, **kwargs)
        assert response.status_code == 200, response.text
        with SessionLocal() as db:
            rows = db.scalars(
                select(InventoryReviewSuggestion).where(
                    InventoryReviewSuggestion.run_id == uuid.UUID(response.json()["id"])
                )
            ).all()
            return {row.item_id for row in rows if row.item_id is not None}

    container_ids = run_and_ids(scope_type="container", scope_id=container_id)
    assert container_ids == {uuid.UUID(container_uncategorised["id"])}
    assert uuid.UUID(container_category["id"]) not in container_ids

    room_ids = run_and_ids(scope_type="room", scope_id=room_a["id"])
    assert room_ids == {uuid.UUID(room_uncategorised["id"])}
    assert uuid.UUID(other_uncategorised["id"]) not in room_ids

    selected_ids = run_and_ids(
        scope_type="items",
        item_ids=[selected_category["id"], selected_uncategorised["id"]],
    )
    assert selected_ids == {uuid.UUID(selected_uncategorised["id"])}

    property_ids = run_and_ids(scope_type="property", scope_id=room_a["property_id"])
    assert uuid.UUID(other_uncategorised["id"]) in property_ids
    assert uuid.UUID(other_category["id"]) not in property_ids


def test_ai_camping_organisation_creates_taxonomy_on_accept_and_undo_restores_exactly(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client, "Private gear locker")
    cooking = create_category(client, "Cooking")
    outdoors = create_tag(client, "outdoors")
    stove = create_item(
        client,
        "Camp stove",
        room["id"],
        category_id=cooking["id"],
        description="Compact stove for weekend camping and outdoor cooking.",
        serial_number="PRIVATE-SERIAL-NOT-FOR-AI",
    )
    organised = create_item(
        client,
        "Already organised lantern",
        room["id"],
        category_id=cooking["id"],
        tag_ids=[outdoors["id"]],
    )
    configure_review_assistant(client)
    prompts = []

    def fake_complete_json(_system, prompt, *, config):
        prompts.append(prompt)
        return {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"name": "Camping equipment"},
                    "tags": [
                        {"id": outdoors["id"]},
                        {"name": "camping"},
                        {"name": "cooking"},
                    ],
                    "confidence": "high",
                    "reason": "The description explicitly supports camping and outdoor cooking.",
                }
            ]
        }

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    before = item_state(client, stove["id"])
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert run["ai_used"] is True
    assert run["ai_item_count"] == 1
    assert len(prompts) == 1
    assert "Camp stove" in prompts[0]
    assert "Already organised lantern" not in prompts[0]
    assert "Private gear locker" not in prompts[0]
    assert "PRIVATE-SERIAL-NOT-FOR-AI" not in prompts[0]
    assert "current_tags" in prompts[0]
    assert item_state(client, stove["id"])["updated_at"] == before["updated_at"]
    assert item_state(client, organised["id"])["tags"][0]["name"] == "outdoors"

    entries = organisation_suggestions(client)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["action_kind"] == "apply_organisation"
    assert entry["before"]["category_id"] == cooking["id"]
    assert entry["before"]["tag_ids"] == []
    assert entry["after"]["category_name"] == "Camping equipment"
    assert entry["after"]["category_is_new"] is True
    assert {tag["name"] for tag in entry["after"]["tags"]} == {
        "outdoors",
        "camping",
        "cooking",
    }
    with SessionLocal() as db:
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is None
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is None

    accepted = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "applied"
    assert accepted.json()["suggestion"]["can_undo"] is True
    applied = item_state(client, stove["id"])
    assert applied["category"]["name"] == "Camping equipment"
    assert {tag["name"] for tag in applied["tags"]} == {"outdoors", "camping", "cooking"}
    with SessionLocal() as db:
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is not None
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is not None
        event = db.scalar(
            select(ActivityEvent).where(
                ActivityEvent.item_id == uuid.UUID(stove["id"]),
                ActivityEvent.action == "inventory_review.organisation_applied",
            )
        )
        assert event is not None

    undone = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    restored = item_state(client, stove["id"])
    assert restored["category"]["id"] == cooking["id"]
    assert restored["tags"] == []
    with SessionLocal() as db:
        # Undo restores item links, not approved taxonomy vocabulary records.
        assert db.scalar(select(Category).where(Category.name == "Camping equipment")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "camping")) is not None
        assert db.scalar(select(Tag).where(Tag.name == "cooking")) is not None


def test_organisation_bulk_accept_and_duplicate_ai_indexes(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    outdoors = create_tag(client, "outdoors")
    family = create_tag(client, "family")
    tent = create_item(client, "Family tent", room["id"], tag_ids=[family["id"]])
    kettle = create_item(client, "Camp kettle", room["id"])
    configure_review_assistant(client)

    def fake_complete_json(_system, prompt, *, config):
        prompt_items = json.loads(
            next(
                line.removeprefix("Items: ")
                for line in prompt.splitlines()
                if line.startswith("Items: ")
            )
        )
        entries = []
        for prompt_item in prompt_items:
            entries.append(
                {
                    "index": prompt_item["index"],
                    "tags": [{"id": outdoors["id"]}, {"name": "camping"}],
                    "confidence": "high",
                    "reason": "Camping activity is explicit in the item name.",
                }
            )
        # A repeated, agreeing answer does not create a second suggestion.
        entries.append(dict(entries[0]))
        return {"suggestions": entries}

    monkeypatch.setattr(inventory_review.ai, "complete_json", fake_complete_json)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    assert response.json()["ai_item_count"] == 2
    entries = organisation_suggestions(client)
    assert len(entries) == 2
    assert all(entry["after"]["category_name"] is None for entry in entries)
    bulk = client.post(
        "/api/v1/inventory-review/suggestions/bulk-accept",
        json={"suggestion_ids": [entry["id"] for entry in entries]},
    )
    assert bulk.status_code == 200, bulk.text
    assert bulk.json()["applied_count"] == 2
    assert {tag["name"] for tag in item_state(client, tent["id"])["tags"]} == {
        "family",
        "outdoors",
        "camping",
    }
    assert {tag["name"] for tag in item_state(client, kettle["id"])["tags"]} == {
        "outdoors",
        "camping",
    }
    tent_entry = next(entry for entry in entries if entry["item_id"] == tent["id"])
    undone = client.post(f"/api/v1/inventory-review/suggestions/{tent_entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "applied"
    assert {tag["name"] for tag in item_state(client, tent["id"])["tags"]} == {"family"}


def test_ai_organisation_skips_when_no_eligible_items(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Workshop hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Workshop hammer", room["id"])
    create_item(
        client,
        "Organised screwdriver",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    configure_review_assistant(client)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("AI must not run without eligible organisation items.")

    monkeypatch.setattr(inventory_review.ai, "complete_json", forbidden)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert run["ai_used"] is False
    assert run["ai_item_count"] == 0
    assert run["ai_error"] is None
    offline = [
        entry
        for entry in suggestions(client)["items"]
        if entry["type"] == "category" and entry["item_id"] == target["id"]
    ]
    assert len(offline) == 1
    assert organisation_suggestions(client) == []


def test_ai_organisation_validation_rejects_bad_taxonomy_and_keeps_offline(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Validation hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Validation hammer", room["id"])
    create_item(client, "Validation camp chair", room["id"], category_id=category["id"])
    configure_review_assistant(client)
    invalid_outputs = [
        {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": str(uuid.uuid4())},
                    "confidence": "high",
                    "reason": "Unknown category id.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"id": str(uuid.uuid4())}],
                    "confidence": "high",
                    "reason": "Unknown tag id.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": str(index)} for index in range(4)],
                    "confidence": "high",
                    "reason": "Too many tags.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"name": "x" * 81},
                    "confidence": "high",
                    "reason": "Category name is too long.",
                }
            ]
        },
        {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"name": "camping", "invented": "specification"}],
                    "confidence": "high",
                    "reason": "Extra fields are forbidden.",
                }
            ]
        },
    ]
    for output in invalid_outputs:
        monkeypatch.setattr(
            inventory_review.ai, "complete_json", lambda *_args, _output=output, **_kwargs: _output
        )
        response = run_review(client, include_ai=True)
        assert response.status_code == 200, response.text
        run = response.json()
        assert run["status"] == "partial"
        assert run["ai_used"] is True
        assert run["ai_item_count"] == 1
        assert run["ai_reviewed_count"] == 0
        assert "1 invalid AI entries were ignored" in run["partial_reason"]
        assert organisation_suggestions(client) == []
        offline = [
            entry
            for entry in suggestions(client)["items"]
            if entry["type"] == "category" and entry["item_id"] == target["id"]
        ]
        assert len(offline) == 1


def test_ai_provider_failure_is_honest_and_preserves_offline_suggestions(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Tools")
    tag = create_tag(client, "repair")
    create_item(
        client,
        "Provider hammer",
        room["id"],
        category_id=category["id"],
        tag_ids=[tag["id"]],
    )
    target = create_item(client, "Provider hammer", room["id"])
    create_item(client, "Provider camp chair", room["id"], category_id=category["id"])
    configure_review_assistant(client)

    def provider_failure(*_args, **_kwargs):
        raise inventory_review.ai.AiError("provider unavailable for fixture")

    monkeypatch.setattr(inventory_review.ai, "complete_json", provider_failure)
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "partial"
    assert run["ai_used"] is True
    assert run["ai_item_count"] == 1
    assert run["ai_provider_label"] == "Organisation fixture AI"
    assert run["ai_model"] == "gpt-organisation-test"
    assert "provider unavailable for fixture" in run["ai_error"]
    assert organisation_suggestions(client) == []
    assert any(
        entry["type"] == "category" and entry["item_id"] == target["id"]
        for entry in suggestions(client)["items"]
    )


def test_organisation_undo_detects_tag_changes_even_without_item_timestamp_change(
    owner_client, monkeypatch
):
    client = owner_client
    room = create_room(client)
    camping = create_tag(client, "camping")
    extra = create_tag(client, "weekend")
    item = create_item(client, "Camping wash kit", room["id"])
    configure_review_assistant(client)
    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "tags": [{"id": camping["id"]}],
                    "confidence": "high",
                    "reason": "The item name explicitly describes camping use.",
                }
            ]
        },
    )
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    entry = organisation_suggestions(client)[0]
    accepted = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    applied_updated_at = item_state(client, item["id"])["updated_at"]
    changed = client.post(
        "/api/v1/items/bulk/tags",
        json={
            "item_ids": [item["id"]],
            "tag_ids": [extra["id"]],
            "mode": "add",
            "request_id": str(uuid.uuid4()),
        },
    )
    assert changed.status_code == 200, changed.text
    # The association-only bulk operation need not touch items.updated_at; the exact
    # tag snapshot still prevents an unsafe undo.
    assert item_state(client, item["id"])["updated_at"] == applied_updated_at
    undone = client.post(f"/api/v1/inventory-review/suggestions/{entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "skipped"
    assert "tags changed" in undone.json()["message"]
    assert {tag["name"] for tag in item_state(client, item["id"])["tags"]} == {
        "camping",
        "weekend",
    }


def test_organisation_accept_enforces_permissions_and_household_taxonomy(owner_client, monkeypatch):
    client = owner_client
    room = create_room(client)
    category = create_category(client, "Household")
    proposed_category = create_category(client, "Cooking equipment")
    tag = create_tag(client, "cooking")
    item = create_item(client, "organisation safety stove", room["id"], category_id=category["id"])
    configure_review_assistant(client)
    monkeypatch.setattr(
        inventory_review.ai,
        "complete_json",
        lambda *_args, **_kwargs: {
            "suggestions": [
                {
                    "index": 0,
                    "category": {"id": proposed_category["id"]},
                    "tags": [{"id": tag["id"]}],
                    "confidence": "high",
                    "reason": "The item name supports cooking organisation.",
                }
            ]
        },
    )
    response = run_review(client, include_ai=True)
    assert response.status_code == 200, response.text
    entry = organisation_suggestions(client)[0]
    viewer = add_member(client, "viewer", email="organisation-viewer@example.com")
    denied = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=viewer,
        json={},
    )
    assert denied.status_code == 403

    first_household = uuid.UUID(client.get("/api/v1/auth/session").json()["household"]["id"])
    second = client.post(
        "/api/v1/households",
        json={"name": "Organisation other household", "property_name": "Other"},
    )
    assert second.status_code == 201, second.text
    second_household = uuid.UUID(second.json()["household"]["id"])
    second_headers = {"X-Household-Id": str(second_household)}
    other_category = client.post(
        "/api/v1/categories", headers=second_headers, json={"name": "Other category"}
    ).json()
    other_tag = client.post(
        "/api/v1/tags", headers=second_headers, json={"name": "other-tag"}
    ).json()
    selected = client.post(f"/api/v1/households/{first_household}/select")
    assert selected.status_code == 200

    with SessionLocal() as db:
        row = db.get(InventoryReviewSuggestion, uuid.UUID(entry["id"]))
        assert row is not None
        after = dict(row.after_json)
        after["category_id"] = other_category["id"]
        after["tags"] = [{**after["tags"][0], "id": other_tag["id"]}]
        row.after_json = after
        db.commit()
    first_headers = {"X-Household-Id": str(first_household)}
    cross_category = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=first_headers,
        json={},
    )
    assert cross_category.status_code == 200, cross_category.text
    assert cross_category.json()["status"] == "unsupported"
    assert "category" in cross_category.json()["message"]

    with SessionLocal() as db:
        row = db.get(InventoryReviewSuggestion, uuid.UUID(entry["id"]))
        assert row is not None
        after = dict(row.after_json)
        after["category_id"] = proposed_category["id"]
        row.after_json = after
        db.commit()
    cross_tag = client.post(
        f"/api/v1/inventory-review/suggestions/{entry['id']}/accept",
        headers=first_headers,
        json={},
    )
    assert cross_tag.status_code == 200, cross_tag.text
    assert cross_tag.json()["status"] == "unsupported"
    assert "tag" in cross_tag.json()["message"]
    item_response = client.get(f"/api/v1/items/{item['id']}", headers=first_headers)
    assert item_response.status_code == 200, item_response.text
    state = item_response.json()["item"]
    assert state["category"]["id"] == category["id"]
    assert state["tags"] == []
