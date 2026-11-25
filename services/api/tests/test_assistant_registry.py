"""The assistant's tools are registered once. The catalogue for the model, the API and
the build export are made from those registrations, and a call runs the registered
handler. These tests keep that true."""

import inspect
import json
import re
from dataclasses import replace

import pytest
from pydantic import BaseModel

from housetory_api.api.deps import AuthContext
from housetory_api.models import AssistantActionProposal
from housetory_api.schemas.assistant_actions import ProposalRequest
from housetory_api.schemas.assistant_tools import ToolOutput
from housetory_api.services import ai_tools, assistant_tools
from housetory_api.services.assistant_tools import export, online_manuals, registry
from tests.test_assistant_manuals import converse, results
from tests.test_assistant_online_manuals import MANUAL, apply, count, gateway, meter
from tests.test_assistant_tools import call, seed
from tests.test_manuals import configure_search, disable_search, viewer_headers

ANSWER = {"kind": "answer", "message": "Done."}
TOOL_NAME = r"\b(?:find|read|search|look|process|prepare|start|get|list|locate|count)_[a-z_]+\b"


def test_each_tool_is_registered_once_with_a_valid_schema_and_a_handler():
    assert len(registry.TOOLS) > 20
    schemas = {}
    for name, tool in registry.TOOLS.items():
        assert tool.name == name and re.fullmatch(r"[a-z][a-z_]+", name)
        assert tool.description.strip() and tool.permission in {"reader", "writer"}
        # Typed arguments that refuse anything the schema does not name.
        assert issubclass(tool.arguments, BaseModel)
        schema = tool.arguments.model_json_schema()
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert set(schema.get("required", [])) <= set(schema["properties"])
        json.dumps(schema)
        assert schemas.setdefault(tool.arguments.__name__, tool.arguments) is tool.arguments
        # The handler is bound in the registration and takes the checked call.
        assert callable(tool.handler)
        assert len(inspect.signature(tool.handler).parameters) == 1
        for requirement in tool.requires:
            assert requirement.name and callable(requirement.missing)

    # A registration that would break this is refused when the application starts.
    first = next(iter(registry.TOOLS.values()))
    with pytest.raises(RuntimeError, match="registered twice"):
        registry._register(first, first)
    with pytest.raises(RuntimeError, match="no handler"):
        registry._register(replace(first, handler=None))
    twin = type(first.arguments.__name__, (registry.Arguments,), {})
    with pytest.raises(RuntimeError, match="Two argument schemas"):
        registry._register(first, replace(first, name="other_tool", arguments=twin))

    # The search planner's own table of lookups names the same functions as the registry.
    for name, function in ai_tools.READ_TOOLS.items():
        assert registry.TOOLS[name].handler.reads is function
    # prepare_action offers exactly the proposals the proposal route accepts.
    assert registry.ActionArguments.model_fields["action"].annotation == ProposalRequest


def test_the_export_the_api_and_the_prompt_are_made_from_the_same_registrations(
    owner_client, configured_ai, monkeypatch, tmp_path
):
    configure_search(monkeypatch)
    static = registry.catalogue()
    assert [tool["name"] for tool in static["tools"]] == list(registry.TOOLS)
    for entry, tool in zip(static["tools"], registry.TOOLS.values(), strict=True):
        assert entry == tool.entry() and entry["arguments"] in static["argument_schemas"]
    assert static["result_schema"] == ToolOutput.model_json_schema()

    # The build export: the same data, as a file, the same every time, without a database.
    target = tmp_path / "assistant-tools.json"
    assert export.main([str(target)]) == 0
    assert target.read_text(encoding="utf-8") == export.export()
    assert json.loads(target.read_text(encoding="utf-8")) == static

    # The API: the same data, with this user's limits.
    published = owner_client.get("/api/v1/assistant/tools").json()
    assert published.pop("limits") == {
        "model_calls": assistant_tools.MAX_MODEL_CALLS,
        "deadline_seconds": assistant_tools.MAX_SECONDS,
    }
    assert published == static

    # The model: the same tools, descriptions and argument schemas, in every request.
    _, prompts = converse(owner_client, monkeypatch, "What do I have?", [ANSWER, ANSWER])
    keys = assistant_tools.PROMPT_TOOL_KEYS
    assert prompts[0]["tools"] == [{key: tool[key] for key in keys} for tool in static["tools"]]
    assert prompts[0]["argument_schemas"] == static["argument_schemas"]


def test_the_instructions_are_general_and_every_tool_named_anywhere_is_registered():
    # What a tool is for is said in its registration, so a new tool needs no new rule here.
    assert not set(re.findall(TOOL_NAME, assistant_tools.SYSTEM)) & set(registry.TOOLS)
    assert len(assistant_tools.SYSTEM) < 4_000
    general = " ".join(assistant_tools.SYSTEM.split())
    for rule in (
        "Prefer what the household has stored",
        "When a result does not answer the request, go on",
        "Use an online service only through a tool",
        "Say when something comes from an online source",
        "A tool marked unavailable cannot be used now",
    ):
        assert rule in general

    # Tools that descriptions, correction notes and follow-up steps point to exist.
    notes = [
        assistant_tools.NO_EVIDENCE_NOTE,
        assistant_tools.INVALID_CALL_NOTE,
        assistant_tools.REPEATED_CALL_NOTE,
        assistant_tools.UNREAD_PAGES_NOTE,
        assistant_tools.LOOKED_NOTE,
    ]
    text = " ".join([*notes, *(tool.description for tool in registry.TOOLS.values())])
    named = (
        set(re.findall(TOOL_NAME, text))
        | assistant_tools.MANUAL_TOOLS
        | set(assistant_tools.STEP_AFTER_APPLIED.values())
        | online_manuals.ATTACHED_READS
    )
    assert named and named <= set(registry.TOOLS), named - set(registry.TOOLS)


def test_an_unavailable_tool_is_explained_in_the_catalogue_and_refused_when_called(
    owner_client, anon_client, configured_ai, monkeypatch
):
    client = owner_client
    item = meter(client)
    searched = []

    def offered(prompt):
        return {tool["name"]: tool.get("unavailable") for tool in prompt["tools"]}

    # Online search is not set up. The entry says so and what still works, and a call is
    # refused with the same words. Nothing is searched and nothing is prepared.
    gateway(monkeypatch, [MANUAL], searched)
    disable_search(monkeypatch)
    run, prompts = converse(
        client,
        monkeypatch,
        "Find its manual",
        [call("find_manuals_online", item_id=item["id"]), ANSWER],
    )
    missing = offered(prompts[0])["find_manuals_online"]
    assert missing["code"] == "manual_search_unconfigured"
    assert "Online manual search is not configured." in missing["reason"]
    assert "Add manual" in missing["alternative"]
    assert [name for name, reason in offered(prompts[0]).items() if reason] == [
        "find_manuals_online"
    ]
    (refused,) = (step["result"] for step in run["steps"])
    assert refused["error"] == missing["code"]
    assert refused["summary"] == f"{missing['reason']} {missing['alternative']}"
    assert searched == [] and count(AssistantActionProposal) == 0
    api = {
        tool["name"]: tool.get("unavailable")
        for tool in client.get("/api/v1/assistant/tools").json()["tools"]
    }
    assert api["find_manuals_online"] == missing and api["search_items"] is None

    # Set up: the entry says nothing and the call runs.
    configure_search(monkeypatch)
    run, prompts = converse(
        client,
        monkeypatch,
        "Find its manual",
        [call("find_manuals_online", item_id=item["id"]), ANSWER],
    )
    assert not any(offered(prompts[0]).values())
    assert run["steps"][0]["result"]["proposal"]["kind"] == "confirm_manual_identity"
    prepared = count(AssistantActionProposal)

    # A viewer: every tool that writes is marked, and none of them runs.
    viewer = viewer_headers(client)
    rename = call(
        "prepare_action",
        action={"kind": "edit_item", "item_id": item["id"], "changes": {"name": "Renamed"}},
    )
    run, prompts = converse(
        anon_client,
        monkeypatch,
        "Rename it",
        [call("search_items", q="Multimeter"), rename, ANSWER],
        viewer,
    )
    marked = {name for name, reason in offered(prompts[0]).items() if reason}
    assert marked == {name for name, tool in registry.TOOLS.items() if tool.permission == "writer"}
    assert offered(prompts[0])["prepare_action"]["code"] == "read_only_role"
    looked_up, refused = (step["result"] for step in run["steps"])
    assert looked_up["error"] is None and refused["error"] == "read_only_role"

    # The catalogue is not the authority. A model that was told the tool is available is
    # refused all the same: the check runs again on every call.
    monkeypatch.setattr(
        assistant_tools,
        "_tool_catalog",
        lambda db, auth: {
            "tools": registry.catalogue()["tools"],
            "argument_schemas": registry.catalogue()["argument_schemas"],
        },
    )
    (refused,) = results(anon_client, monkeypatch, [rename], viewer)
    assert refused["error"] == "read_only_role"
    assert count(AssistantActionProposal) == prepared
    assert client.get(f"/api/v1/items/{item['id']}").json()["item"]["name"] == "Multimeter"


def test_registered_handlers_carry_out_lookup_edit_loan_and_manual_discovery(
    owner_client, configured_ai, monkeypatch
):
    """From the registration to the effect: each call runs the handler its tool is
    registered with, and the proposals go through the normal review and Apply."""
    client = owner_client
    _, drill = seed(client)
    item = meter(client)
    searched = []
    gateway(monkeypatch, [MANUAL], searched)
    ran = []

    def recorded(tool):
        def handler(checked):
            assert isinstance(checked, registry.Call) and isinstance(checked.auth, AuthContext)
            assert isinstance(checked.args, tool.arguments)
            ran.append(tool.name)
            return tool.handler(checked)

        return replace(tool, handler=handler)

    for name, tool in list(registry.TOOLS.items()):
        monkeypatch.setitem(registry.TOOLS, name, recorded(tool))

    def approve(proposal):
        assert apply(client, proposal, request_id=proposal["id"]).status_code == 200

    # Lookup, then an item edit that the user applies.
    found, renamed = results(
        client,
        monkeypatch,
        [
            call("search_items", q="Validation drill"),
            call(
                "prepare_action",
                action={
                    "kind": "edit_item",
                    "item_id": drill["id"],
                    "changes": {"name": "Cordless drill"},
                },
            ),
        ],
    )
    assert [reference["id"] for reference in found["references"]] == [drill["id"]]
    assert client.get(f"/api/v1/items/{drill['id']}").json()["item"]["name"] == drill["name"]
    approve(renamed["proposal"])
    assert client.get(f"/api/v1/items/{drill['id']}").json()["item"]["name"] == "Cordless drill"

    # A loan that the user applies.
    (lent,) = results(
        client,
        monkeypatch,
        [
            call(
                "prepare_action",
                action={
                    "kind": "lend",
                    "item_id": drill["id"],
                    "borrower_name": "Mohsen",
                    "quantity": 1,
                    "lent_on": "2026-01-03",
                },
            )
        ],
    )
    assert client.get("/api/v1/loans").json()["total"] == 0
    approve(lent["proposal"])
    (loan,) = client.get("/api/v1/loans").json()["items"]
    assert loan["borrower_name"] == "Mohsen"
    (history,) = results(client, monkeypatch, [call("get_loan_history", item_id=drill["id"])])
    assert "Mohsen" in json.dumps(history["facts"])

    # Manual discovery: identity first, and the search only after the user confirmed it.
    (unconfirmed,) = results(client, monkeypatch, [call("find_manuals_online", item_id=item["id"])])
    assert unconfirmed["proposal"]["kind"] == "confirm_manual_identity" and searched == []
    approve(unconfirmed["proposal"])
    (candidates,) = results(client, monkeypatch, [call("find_manuals_online", item_id=item["id"])])
    assert len(searched) == 1 and candidates["facts"]["condition"] == "candidates"
    assert candidates["proposal"]["kind"] == "save_manual"
    assert [source["url"] for source in candidates["web_sources"]] == [MANUAL["source_url"]]

    assert ran == [
        "search_items",
        "prepare_action",
        "prepare_action",
        "get_loan_history",
        "find_manuals_online",
        "find_manuals_online",
    ]
