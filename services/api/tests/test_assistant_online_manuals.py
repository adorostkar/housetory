"""The assistant finds a manual online, has the user approve it, then reads it."""

import re
import uuid
from datetime import UTC, datetime
from typing import get_args, get_type_hints

from sqlalchemy import func, select

from housetory_api.api.routes.assistant_actions import create_proposal
from housetory_api.db import SessionLocal
from housetory_api.models import (
    AssistantActionProposal,
    Document,
    ImportBatch,
    ManualSearchCandidate,
)
from housetory_api.services import assistant_tools, manual_web, manuals, ocr
from housetory_api.services.assistant_tools import manual_tools, registry
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.document_pages import MAP_SYSTEM
from tests.test_assistant_manuals import (
    CURRENT_STEP,
    PAGES,
    converse,
    map_from_headings,
    multimeter,
    page_with,
    results,
)
from tests.test_assistant_tools import call
from tests.test_cross_household import _other_household_headers
from tests.test_document_pages import pdf_bytes, run_document_jobs
from tests.test_manuals import (
    configure_search,
    confirmed_profile,
    disable_search,
    viewer_headers,
)

QUESTION = "How do I check the amp with the multimeter?"
MANUAL = {
    "title": "AstroAI M6K0R user manual",
    "source_url": "https://www.astroai.example/support/M6K0R",
    "file_url": "https://www.astroai.example/files/M6K0R-EN.pdf",
    "publisher": "AstroAI",
    "language": "en",
    "source_type": "manufacturer",
    "model_coverage": ["M6K0R"],
    "snippet": "User manual for the M6K0R digital multimeter.",
}
SIMILAR = {
    "title": "AstroAI M4K0R manual",
    "source_url": "https://manuals.example/astroai/M4K0R",
    "file_url": "https://manuals.example/astroai/M4K0R.pdf",
    "publisher": "Manuals Example",
    "language": "en",
    "source_type": "other",
    "model_coverage": ["M4K0R"],
    "snippet": "Manual for the smaller M4K0R meter.",
}
SOURCE_PAGE = {
    **MANUAL,
    "title": "AstroAI M6K0R support page",
    "source_url": "https://www.astroai.example/support/M6K0R/overview",
    "file_url": "https://www.astroai.example/support/M6K0R/overview",
}
ANSWER = {"kind": "answer", "message": "Done."}


def meter(client, **fields):
    room = client.post("/api/v1/rooms", json={"name": f"Workshop {uuid.uuid4().hex[:6]}"})
    payload = {"name": "Multimeter", "brand": "AstroAI", "model": "M6K0R"}
    created = client.post("/api/v1/items", json={**payload, **fields, "room_id": room.json()["id"]})
    assert created.status_code == 201, created.text
    return created.json()["item"]


def gateway(monkeypatch, found, calls=None):
    """Stand in for the configured search service. ``calls`` records what was sent."""
    configure_search(monkeypatch)

    def search(payload, **kwargs):
        if calls is not None:
            calls.append(payload)
        if isinstance(found, Exception):
            raise found
        return {"results": found}

    monkeypatch.setattr(manual_web, "_post_search", search)


def downloads(monkeypatch, content=None, error=None):
    fetched = []

    def fetch(url):
        fetched.append(url)
        if error:
            raise manual_web.ManualFetchError(error)
        return manual_web.FetchedManual(
            content=content or pdf_bytes(PAGES),
            content_type="application/pdf",
            filename="M6K0R-EN.pdf",
            final_url=url,
            retrieved_at=datetime.now(UTC),
        )

    monkeypatch.setattr(manual_web, "fetch_manual_pdf", fetch)
    return fetched


def apply(client, proposal, request_id=None, headers=None):
    return client.post(
        f"/api/v1/assistant/actions/proposals/{proposal['id']}/apply",
        json={"request_id": str(request_id or uuid.uuid4())},
        headers=headers,
    )


def last_facts(prompt):
    return prompt["observations"][-1]["result"]["facts"]


def save_first_candidate(item):
    def step(prompt):
        candidate = last_facts(prompt)["candidates"][0]
        return call(
            "prepare_action",
            action={
                "kind": "save_manual",
                "item_id": item["id"],
                "candidate_id": candidate["candidate_id"],
            },
        )

    return step


def manuals_of(client, item):
    return client.get(f"/api/v1/items/{item['id']}/manuals").json()


def count(model):
    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(model))


def test_no_manual_leads_to_approved_online_discovery_and_a_cited_answer(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item = meter(client)
    searched = []
    gateway(monkeypatch, [SIMILAR, MANUAL], searched)
    fetched = downloads(monkeypatch)

    first, _ = converse(
        client,
        monkeypatch,
        QUESTION,
        [
            call("read_manual", item_id=item["id"]),
            call("find_manuals_online", item_id=item["id"]),
            {"kind": "answer", "message": "No manual is attached. Is this the exact product?"},
        ],
    )
    nothing, blocked = (step["result"] for step in first["steps"])
    assert nothing["facts"]["condition"] == "no_manual"
    assert "find_manuals_online" in nothing["summary"]
    assert blocked["error"] == "manual_identity_required"
    assert blocked["facts"]["condition"] == "identity_not_confirmed"
    # The item records a real make and model, so the tool prepares the card itself: the
    # user checks it. The model does not have to remember to ask.
    assert "A proposal to confirm AstroAI M6K0R" in blocked["summary"]
    assert "Do not ask for the brand and model in words" in blocked["summary"]
    # Nothing left the server and nothing was stored before the user confirmed.
    assert searched == [] and manuals_of(client, item)["search"]["profile"] is None
    identity = blocked["proposal"]
    assert first["state"] == "awaiting_approval" and identity["kind"] == "confirm_manual_identity"
    assert identity["changes"] == {
        "item_id": item["id"],
        "manufacturer": "AstroAI",
        "model_identifier": "M6K0R",
        "variant": None,
    }
    assert identity["before"] == {"item_brand": "AstroAI", "item_model": "M6K0R"}
    # A proposal that is not applied starts nothing by itself.
    idle, _ = converse(
        client,
        monkeypatch,
        "Continue.",
        [call("find_manuals", item_id=item["id"]), ANSWER],
        applied_proposal_id=identity["id"],
    )
    assert [step["call"]["name"] for step in idle["steps"]] == ["find_manuals"]
    applied = apply(client, identity)
    assert applied.status_code == 200, applied.text
    assert (
        applied.json()["message"] == "Confirmed AstroAI M6K0R as the exact product of Multimeter."
    )
    assert manuals_of(client, item)["search"]["profile"]["model_identifier"] == "M6K0R"

    second, prompts = converse(
        client,
        monkeypatch,
        "Continue.",
        [ANSWER],
        parent_id=first["id"],
        applied_proposal_id=identity["id"],
    )
    # The search was the plain consequence of the Apply: the application started it.
    assert second["steps"][0]["call"] == {
        "name": "find_manuals_online",
        "arguments": {"item_id": item["id"]},
    }
    assert second["model_calls"] == 1
    # The follow-up sees the first question and that the identity proposal was applied.
    earlier = prompts[0]["context_newest_first"][0]
    assert earlier["request"] == QUESTION
    assert earlier["observations"][-1]["result"]["proposal"]["state"] == "applied"
    assert "A request that only says to continue" in prompts[0]["system"]
    (found,) = (step["result"] for step in second["steps"])
    assert searched == [
        {"mode": "manual", "manufacturer": "AstroAI", "model": "M6K0R", "variant": None}
    ]
    # The similar model is left out; the candidate shows what its source really names.
    (candidate,) = found["facts"]["candidates"]
    assert candidate["title"] == MANUAL["title"] and candidate["model_coverage"] == ["M6K0R"]
    assert candidate["source"] == "astroai.example" and candidate["direct_file"] is True
    assert found["web_sources"] == [
        {"title": MANUAL["title"], "url": MANUAL["source_url"], "publisher": "AstroAI"}
    ]
    assert any("hidden" in notice for notice in found["facts"]["notices"])
    # One candidate has a file, so the tool prepared the card for the user's review.
    saving = found["proposal"]
    assert "is prepared and shown to the user" in found["summary"]
    assert second["state"] == "awaiting_approval" and saving["kind"] == "save_manual"
    assert saving["changes"]["file_url"] == MANUAL["file_url"]
    assert saving["changes"]["source_url"] == MANUAL["source_url"]
    assert saving["before"]["model_identifier"] == "M6K0R"
    # A prepared proposal downloads and attaches nothing.
    assert fetched == [] and manuals_of(client, item)["manuals"] == []

    request_id = uuid.uuid4()
    saved = apply(client, saving, request_id)
    assert saved.status_code == 200, saved.text
    assert saved.json()["message"] == (
        f"Saved “{MANUAL['title']}” and attached it to Multimeter. Its pages are being read."
    )
    assert apply(client, saving, request_id).json() == saved.json()
    assert fetched == [MANUAL["file_url"]]
    (document,) = manuals_of(client, item)["manuals"]
    assert document["document_type"] == "manual" and document["title"] == MANUAL["title"]

    # The worker reads the saved file like any attached manual.
    run_document_ocr(uuid.UUID(document["id"]))
    run_document_jobs()

    def answer(prompt):
        page = page_with(prompt, "MEASURING CURRENT")
        return {
            "kind": "answer",
            "message": f"Connect the meter in series ({MANUAL['title']}, page 11).",
            "sources": [{"document_id": page["document_id"], "pages": [11], "quote": CURRENT_STEP}],
        }

    third, _ = converse(
        client,
        monkeypatch,
        "Continue.",
        [call("read_manual", item_id=item["id"]), answer],
        parent_id=second["id"],
        applied_proposal_id=saving["id"],
    )
    assert [step["call"]["name"] for step in third["steps"]] == ["process_manual", "read_manual"]
    assert third["state"] == "completed"
    assert [(entry["document_id"], entry["page"]) for entry in third["citations"]] == [
        (document["id"], 11)
    ]
    assert third["citations"][0]["url"] == f"/documents/{document['id']}/view?page=11"

    # Saving it again is refused, and reading opened no import or item review.
    again = results(
        client,
        monkeypatch,
        [
            call("read_manual", item_id=item["id"]),
            call("find_manuals_online", item_id=item["id"]),
            save_first_candidate(item),
        ],
    )
    assert again[1]["facts"]["candidates"][0]["already_saved_as_document_id"] == document["id"]
    assert again[2]["error"] == "manual_already_saved" and again[2]["proposal"] is None
    assert fetched == [MANUAL["file_url"]] and count(Document) == 1 and count(ImportBatch) == 0
    assert all(step["result"]["capture"] is None for step in third["steps"])


def test_attached_manuals_are_read_before_anything_is_searched_online(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item, document = multimeter(client, monkeypatch)
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    searched = []
    gateway(monkeypatch, [MANUAL], searched)

    (refused,) = results(client, monkeypatch, [call("find_manuals_online", item_id=item["id"])])
    assert refused["error"] == "read_attached_first" and searched == []
    assert "Read them with read_manual first" in refused["summary"]

    read, found = results(
        client,
        monkeypatch,
        [
            call("read_manual", item_id=item["id"]),
            call("find_manuals_online", item_id=item["id"]),
        ],
    )
    assert read["facts"]["condition"] == "pages_returned"
    assert found["error"] is None and found["facts"]["attached_manuals"] == 1
    assert len(searched) == 1


def test_identity_must_be_real_and_a_wrong_variant_finds_nothing(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    vague = meter(client, name="Old drill", brand=None, model=None)
    gateway(monkeypatch, [MANUAL])

    blocked, missing, generic = results(
        client,
        monkeypatch,
        [
            call("find_manuals_online", item_id=vague["id"]),
            call(
                "prepare_action",
                action={"kind": "confirm_manual_identity", "item_id": vague["id"]},
            ),
            call(
                "prepare_action",
                action={
                    "kind": "confirm_manual_identity",
                    "item_id": vague["id"],
                    "manufacturer": "Unknown",
                    "model_identifier": "cordless drill",
                },
            ),
        ],
    )
    assert "brand not set, model not set" in blocked["summary"] and blocked["proposal"] is None
    assert "Ask the user to read the manufacturer and the complete model" in blocked["summary"]
    assert generic["error"] == "incomplete_manual_identity" and generic["proposal"] is None
    # The model is told which arguments were missing, so it can correct the call.
    assert missing["error"] == "tool_validation"
    assert "manufacturer: Field required" in missing["summary"]
    assert count(AssistantActionProposal) == 0

    # The user named variant B. It goes into the proposal the tool prepares.
    item = meter(client)
    (prepared,) = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=item["id"], user_named_variant=" B ")],
    )
    assert prepared["proposal"]["changes"]["variant"] == "B"
    assert "with the variant B the user named" in prepared["summary"]
    assert apply(client, prepared["proposal"]).status_code == 200
    # The only source shows the plain model, so it is hidden.
    found, repeated = results(
        client,
        monkeypatch,
        [
            call("find_manuals_online", item_id=item["id"]),
            call(
                "prepare_action",
                action={
                    "kind": "confirm_manual_identity",
                    "item_id": item["id"],
                    "manufacturer": "AstroAI",
                    "model_identifier": "M6K0R",
                    "variant": "B",
                },
            ),
        ],
    )
    assert found["facts"]["condition"] == "no_exact_model_source"
    assert found["facts"]["candidates"] == [] and found["web_sources"] == []
    assert "ask them to check the product label" in found["summary"]
    assert repeated["error"] == "manual_identity_confirmed"

    # Later the user says it is variant C. Nothing is searched until they confirmed that.
    searched = []
    gateway(monkeypatch, [MANUAL], searched)
    (other,) = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=item["id"], user_named_variant="C")],
    )
    assert other["error"] == "manual_variant_not_confirmed" and searched == []
    assert other["proposal"]["changes"]["variant"] == "C"
    assert other["proposal"]["before"]["variant"] == "B"


def test_search_that_is_not_set_up_or_fails_is_reported_as_it_is(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item = meter(client)
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )

    disable_search(monkeypatch)
    (off,) = results(client, monkeypatch, [call("find_manuals_online", item_id=item["id"])])
    assert off["error"] == "manual_search_unconfigured"
    assert off["facts"]["condition"] == "search_not_configured"
    assert "Online manual search is not configured." in off["summary"]
    assert "Add manual" in off["summary"]

    gateway(monkeypatch, manual_web.ManualSearchUnavailable("The search service timed out."))
    (down,) = results(client, monkeypatch, [call("find_manuals_online", item_id=item["id"])])
    assert down["error"] == "manual_search_unavailable"
    assert "The search service timed out." in down["summary"]
    assert "internet connection may be down" in down["summary"]
    assert count(ManualSearchCandidate) == 0


def test_an_unsafe_or_missing_file_is_never_saved(owner_client, configured_ai, monkeypatch):
    client = owner_client
    item = meter(client)
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    gateway(monkeypatch, [MANUAL])
    fetched = downloads(monkeypatch, error="The manual URL resolved to a non-public address.")

    found, prepared = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=item["id"]), save_first_candidate(item)],
    )
    # Asking for the same candidate again shows the waiting card, not a second one.
    assert prepared["proposal"]["id"] == found["proposal"]["id"]
    assert count(AssistantActionProposal) == 1
    refused = apply(client, prepared["proposal"])
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "manual_download_failed"
    assert "non-public address" in refused.json()["detail"]["message"]
    assert fetched == [MANUAL["file_url"]] and count(Document) == 0
    assert manuals_of(client, item)["manuals"] == []
    # The proposal is still pending: the user can cancel it or try again.
    state = client.get(f"/api/v1/assistant/actions/proposals/{prepared['proposal']['id']}")
    assert state.json()["state"] == "ready"

    # A source page without a PDF link is never turned into a download.
    page_only = meter(client, name="Second meter")
    assert (
        confirmed_profile(
            client, page_only["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    gateway(monkeypatch, [SOURCE_PAGE])
    found, prepared = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=page_only["id"]), save_first_candidate(page_only)],
    )
    assert found["facts"]["candidates"][0]["direct_file"] is False and found["proposal"] is None
    assert prepared["error"] == "manual_source_page_only" and prepared["proposal"] is None

    # Two files and neither from the manufacturer: the choice is not made for the user.
    copies = [
        {**MANUAL, "source_type": "other", "publisher": name, "source_url": url, "file_url": file}
        for name, url, file in (
            ("Manual Shelf", "https://shelf.example/M6K0R", "https://shelf.example/M6K0R.pdf"),
            ("Manual Barn", "https://barn.example/M6K0R", "https://barn.example/M6K0R.pdf"),
        )
    ]
    gateway(monkeypatch, copies)
    (open_choice,) = results(
        client, monkeypatch, [call("find_manuals_online", item_id=page_only["id"])]
    )
    assert open_choice["proposal"] is None and "No proposal is prepared" in open_choice["summary"]
    # With the manufacturer's own file among them, that one is offered.
    gateway(monkeypatch, [*copies, {**MANUAL, "source_url": "https://www.astroai.example/m"}])
    (official,) = results(
        client, monkeypatch, [call("find_manuals_online", item_id=page_only["id"])]
    )
    assert official["proposal"]["changes"]["publisher"] == "AstroAI"


def test_a_proposal_goes_stale_when_the_identity_changes_and_can_be_refreshed(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item = meter(client)
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    gateway(monkeypatch, [MANUAL])
    fetched = downloads(monkeypatch)
    _, prepared = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=item["id"]), save_first_candidate(item)],
    )
    proposal = prepared["proposal"]
    edit = client.patch(
        f"/api/v1/assistant/actions/proposals/{proposal['id']}",
        json={"changes": {"name": "Other"}},
    )
    assert edit.status_code == 409 and edit.json()["detail"]["code"] == "proposal_not_editable"

    # The user confirms another model on the item page after the proposal was prepared.
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant="EU"
        ).status_code
        == 200
    )
    stale = apply(client, proposal)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "proposal_stale"
    assert fetched == []

    refreshed = client.post(f"/api/v1/assistant/actions/proposals/{proposal['id']}/refresh")
    assert refreshed.status_code == 201, refreshed.text
    assert refreshed.json()["before"]["variant"] == "EU"
    assert refreshed.json()["changes"]["candidate_id"] == proposal["changes"]["candidate_id"]
    assert apply(client, refreshed.json()).status_code == 200
    assert fetched == [MANUAL["file_url"]]


def test_the_same_file_is_attached_once_and_not_stored_twice(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item, document = multimeter(client, monkeypatch)
    other = meter(client, name="Spare meter")
    assert (
        confirmed_profile(
            client, other["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    gateway(monkeypatch, [MANUAL])
    # The search offers the very file that is already in the library.
    downloads(monkeypatch, content=pdf_bytes(PAGES))
    _, prepared = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=other["id"]), save_first_candidate(other)],
    )
    saved = apply(client, prepared["proposal"])
    assert saved.status_code == 200, saved.text
    assert "was already in the library" in saved.json()["message"]
    assert [entry["id"] for entry in manuals_of(client, other)["manuals"]] == [document["id"]]
    assert count(Document) == 1


def test_viewers_and_other_households_cannot_discover_or_save(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    item = meter(client)
    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    searched = []
    gateway(monkeypatch, [MANUAL], searched)
    fetched = downloads(monkeypatch)
    _, prepared = results(
        client,
        monkeypatch,
        [call("find_manuals_online", item_id=item["id"]), save_first_candidate(item)],
    )
    proposal = prepared["proposal"]
    candidate_id = proposal["changes"]["candidate_id"]
    searched.clear()

    viewer = viewer_headers(client)
    looked, tried = results(
        client,
        monkeypatch,
        [
            call("find_manuals_online", item_id=item["id"]),
            call(
                "prepare_action",
                action={"kind": "save_manual", "item_id": item["id"], "candidate_id": candidate_id},
            ),
        ],
        headers=viewer,
    )
    assert looked["error"] == tried["error"] == "read_only_role"
    assert apply(client, proposal, headers=viewer).status_code == 404
    assert searched == []

    stranger = _other_household_headers()["headers"]
    room = client.post("/api/v1/rooms", json={"name": "Shed"}, headers=stranger).json()
    theirs = client.post(
        "/api/v1/items",
        json={"name": "Their meter", "brand": "AstroAI", "model": "M6K0R", "room_id": room["id"]},
        headers=stranger,
    ).json()["item"]
    assert (
        client.put(
            f"/api/v1/items/{theirs['id']}/manual-profile",
            json={"manufacturer": "AstroAI", "model_identifier": "M6K0R", "confirmed": True},
            headers=stranger,
        ).status_code
        == 200
    )
    outside, borrowed = results(
        client,
        monkeypatch,
        [
            call("find_manuals_online", item_id=item["id"]),
            # Their own item with the first household's candidate.
            call(
                "prepare_action",
                action={
                    "kind": "save_manual",
                    "item_id": theirs["id"],
                    "candidate_id": candidate_id,
                },
            ),
        ],
        headers=stranger,
    )
    assert outside["error"] == "item_not_found"
    assert borrowed["error"] == "manual_candidate_not_found"
    assert apply(client, proposal, headers=stranger).status_code == 404
    assert searched == [] and fetched == [] and count(Document) == 0


def test_every_published_tool_and_action_kind_has_a_handler(
    owner_client, configured_ai, monkeypatch
):
    """The catalogue the model is given and the code that carries it out must agree."""
    published = owner_client.get("/api/v1/assistant/tools").json()["tools"]
    assert {tool["name"] for tool in published} == set(registry.TOOLS)
    # Real records, so that every call passes the scope checks and reaches its handler.
    item, document = multimeter(owner_client, monkeypatch)
    item_id, document_id = item["id"], document["id"]
    samples = {
        "ItemArguments": {"item_id": item_id},
        "OnlineManualArguments": {"item_id": item_id},
        "ManualArguments": {"document_id": document_id},
        "ManualReadArguments": {"document_id": document_id},
        "ManualPageArguments": {"document_id": document_id, "page": 1},
        "ManualSearchArguments": {"document_id": document_id, "query": "fuse"},
        "ActionArguments": {
            "action": {
                "kind": "confirm_manual_identity",
                "item_id": item_id,
                "manufacturer": "AstroAI",
                "model_identifier": "M6K0R",
            }
        },
        "CaptureArguments": {"kind": "document", "id": document_id},
        "ReviewStatusArguments": {"review_run_id": str(uuid.uuid4())},
        "list_room_contents": {"room_name": "Workshop"},
        "get_container_contents": {"container_name": "Nowhere"},
    }
    # The page picture and the vision model are stood in for.
    monkeypatch.setattr(
        ocr, "render_pdf_page", lambda path, page, target, **size: target.write_bytes(b"png")
    )
    others = {
        MAP_SYSTEM: map_from_headings,
        manual_tools.LOOK_SYSTEM: lambda *a, **k: {"text": "DIGITAL MULTIMETER"},
    }
    calls = []
    for name, tool in registry.TOOLS.items():
        # These two start real work in any household. Their own tests cover them.
        if name in {"prepare_item_capture", "start_inventory_review"}:
            continue
        sample = samples.get(name, samples.get(tool.arguments.__name__, {}))
        # The sample fits the schema, so the call reaches the tool's handler.
        tool.arguments.model_validate(sample)
        calls.append(call(name, **sample))
    size = assistant_tools.MAX_MODEL_CALLS - 1
    outputs = []
    for start in range(0, len(calls), size):
        outputs += results(owner_client, monkeypatch, calls[start : start + size], others=others)
    # A tool without a handler ends as unknown_tool.
    assert len(outputs) == len(calls)
    assert [output["error"] for output in outputs].count("unknown_tool") == 0

    # The assistant can prepare exactly the proposals the application accepts.
    def kinds(union):
        return {get_args(variant.model_fields["kind"].annotation)[0] for variant in union}

    accepted = kinds(get_args(get_type_hints(create_proposal)["payload"]))
    assert kinds(get_args(get_args(registry.Action)[0])) == accepted
    assert accepted > manuals.PROPOSAL_KINDS

    # Every tool the instructions and descriptions name is a registered tool.
    text = assistant_tools.SYSTEM + " ".join(tool.description for tool in registry.TOOLS.values())
    named = set(
        re.findall(
            r"\b(?:find|read|search|look|process|prepare|start|get|list|locate|count)_[a-z_]+\b",
            text,
        )
    )
    assert named and named <= set(registry.TOOLS), named - set(registry.TOOLS)


def test_without_ai_the_reviewed_steps_stay_usable_on_the_item_page(owner_client, monkeypatch):
    client = owner_client
    item = meter(client)
    refused = client.post(
        "/api/v1/assistant/runs", json={"request_id": str(uuid.uuid4()), "query": QUESTION}
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "assistant_tools_unavailable"
    # No second place answers questions: the old online question route is gone, and
    # the assistant has no tool that answers from search snippets.
    assert "search_web_for_item" not in registry.TOOLS
    gone = client.post(
        f"/api/v1/items/{item['id']}/manual-questions/online", json={"question": QUESTION}
    )
    assert gone.status_code == 404

    assert (
        confirmed_profile(
            client, item["id"], manufacturer="AstroAI", model_identifier="M6K0R", variant=None
        ).status_code
        == 200
    )
    gateway(monkeypatch, [MANUAL])
    downloads(monkeypatch)
    (candidate,) = client.post(f"/api/v1/items/{item['id']}/manual-search").json()["candidates"]
    saved = client.post(
        f"/api/v1/items/{item['id']}/manual-search/{candidate['id']}/download",
        json={"request_id": str(uuid.uuid4()), "confirm_model": True},
    )
    assert saved.status_code == 200, saved.text
    document = saved.json()["document"]
    assert client.get(f"/api/v1/documents/{document['id']}/file").status_code == 200
