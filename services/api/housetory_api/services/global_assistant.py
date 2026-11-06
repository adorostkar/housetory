"""Read-only assistant aggregation across a person's current households.

AI is deliberately not invoked in this module. All-my-places and property-wide
answers use deterministic retrieval with each household's own records. When the
person narrows to one household and no property filter, the regular assistant
may use that household's provider and consent.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from ..domain import AiTask
from ..models import Household
from ..schemas.ai import (
    AiStatus,
    AssistantReference,
    AssistantRequest,
    AssistantResponse,
    NaturalSearchFilters,
    NaturalSearchResponse,
)
from . import ai
from .ai_tools import ToolResult, _human_date
from .assistant import (
    _followup_plan,
    _plan_interpretation,
    deterministic_plan,
    structured_plan,
)
from .global_search import SearchScope, scope_households, scope_property

PROPERTY_AWARE_TOOLS = {
    "search_items",
    "count_items",
    "find_missing_information",
    "locate_item",
    "search_locations",
    "list_room_contents",
    "get_container_contents",
    "search_documents",
    "get_purchase_history",
    "get_warranty_status",
    "get_inventory_summary",
    "list_outstanding_loans",
    "list_borrowed_items",
    "find_borrowed_owner",
}


@dataclass
class ScopeExecution:
    household: Household
    role: str
    result: ToolResult


def deterministic_status() -> AiStatus:
    return AiStatus(
        provider="none",
        mode="disabled",
        model=None,
        configured=False,
        available=False,
        error=None,
        privacy_note=(
            "All-my-places answers use deterministic, read-only retrieval across "
            "current memberships. AI interpretation is only used when the scope is "
            "one household without a property filter."
        ),
    )


def _item_place(item: Any) -> str:
    parts: list[str] = []
    household = getattr(item, "household", None)
    if household is not None:
        parts.append(household.name)
    property_record = getattr(item, "property", None)
    if property_record is not None:
        parts.append(property_record.name)
    room = getattr(item, "room", None)
    if room is not None:
        parts.append(room.name)
    entries = list(getattr(item, "location_path", None) or [])
    if not entries and getattr(item, "location", None) is not None:
        entries = [item.location]
    for entry in entries:
        label = (
            f"{entry.identifier} · {entry.name}"
            if entry.identifier and entry.identifier != entry.name
            else entry.identifier or entry.name
        )
        if label:
            parts.append(label)
    return " / ".join(parts) if parts else "No place recorded"


def _annotate_result(execution: ScopeExecution) -> ToolResult:
    result = execution.result
    for reference in result.references:
        if reference.household_id is None:
            reference.household_id = execution.household.id
            reference.household_name = execution.household.name
    for document in result.documents:
        document.setdefault("household_id", str(execution.household.id))
        document.setdefault("household_name", execution.household.name)
    for location in result.locations:
        location.setdefault("household_id", str(execution.household.id))
        location.setdefault("household_name", execution.household.name)
    for purchase in result.facts.get("purchases") or []:
        purchase.setdefault("household_id", str(execution.household.id))
        purchase.setdefault("household_name", execution.household.name)
    for warranty in (
        result.facts.get("warranties") if isinstance(result.facts.get("warranties"), list) else []
    ):
        warranty.setdefault("household_id", str(execution.household.id))
        warranty.setdefault("household_name", execution.household.name)
    loans = result.facts.get("loans")
    if isinstance(loans, list):
        for loan in loans:
            loan.setdefault("household_id", str(execution.household.id))
            loan.setdefault("household_name", execution.household.name)
    for record in result.borrowed:
        record.household_id = execution.household.id
        record.household_name = execution.household.name
    whereabouts = result.facts.get("whereabouts")
    if isinstance(whereabouts, dict):
        whereabouts.setdefault("household_id", str(execution.household.id))
        whereabouts.setdefault("household_name", execution.household.name)
    return result


def _decode_plan(db: Session, household_id: uuid.UUID, question: str, history: list[Any]):  # noqa: ANN202
    followup = _followup_plan(question, history)
    if followup is not None:
        return followup, True
    structured = structured_plan(db, household_id, question)
    if structured is not None:
        return structured, True
    return deterministic_plan(db, household_id, question), False


def _execute_scope(
    db: Session,
    scope: SearchScope,
    *,
    question: str,
    history: list[Any],
    use_only_structured: bool,
) -> tuple[list[ScopeExecution], list[str]]:
    executions: list[ScopeExecution] = []
    notices: list[str] = []
    for household, role in scope.households:
        plan, structured = _decode_plan(db, household.id, question, history)
        if use_only_structured and not structured:
            continue
        arguments = dict(plan.arguments)
        if scope.property is not None and plan.tool in PROPERTY_AWARE_TOOLS:
            arguments["property_id"] = scope.property.id
        try:
            result = _execute_plan_arguments(
                db,
                household,
                plan.tool,
                arguments,
            )
        except Exception:  # noqa: BLE001 - a single partition must not break the answer
            try:
                fallback = deterministic_plan(db, household.id, question)
                fallback_arguments = dict(fallback.arguments)
                if scope.property is not None and fallback.tool in PROPERTY_AWARE_TOOLS:
                    fallback_arguments["property_id"] = scope.property.id
                result = _execute_plan_arguments(
                    db,
                    household,
                    fallback.tool,
                    fallback_arguments,
                )
            except Exception:  # noqa: BLE001
                notices.append(f"{household.name}: this part of the search could not be completed.")
                continue
        execution = ScopeExecution(household=household, role=role, result=result)
        executions.append(
            ScopeExecution(household=household, role=role, result=_annotate_result(execution))
        )
    return executions, notices


def _execute_plan_arguments(
    db: Session,
    household: Household,
    tool: str,
    arguments: dict[str, Any],
) -> ToolResult:
    from ..schemas.ai import AssistantPlan
    from .assistant import _execute_plan

    return _execute_plan(
        db,
        household.id,
        AssistantPlan(tool=tool, arguments=arguments),
        household_reminder_days=household.warranty_reminder_days,
    )


def _dedupe_items(executions: list[ScopeExecution]) -> list[Any]:
    seen: set[uuid.UUID] = set()
    items = []
    for execution in executions:
        for item in execution.result.items:
            if item.id in seen:
                continue
            seen.add(item.id)
            items.append(item)
    return items


def _dedupe_borrowed(executions: list[ScopeExecution]) -> list[Any]:
    seen: set[uuid.UUID] = set()
    records = []
    for execution in executions:
        for record in execution.result.borrowed:
            if record.id in seen:
                continue
            seen.add(record.id)
            records.append(record)
    return records


def _dedupe_references(executions: list[ScopeExecution]) -> list[AssistantReference]:
    seen: set[tuple[str, uuid.UUID]] = set()
    references: list[AssistantReference] = []
    for execution in executions:
        for reference in execution.result.references:
            key = (reference.type, reference.id)
            if key in seen:
                continue
            seen.add(key)
            references.append(reference)
    return references


def _scope_facts(scope: SearchScope, executions: list[ScopeExecution]) -> dict[str, Any]:
    return {
        "scope": "property" if scope.property is not None else "all_places",
        "scope_label": scope.label,
        "household_count": len(scope.households),
        "households": [
            {"id": str(household.id), "name": household.name, "role": role}
            for household, role in scope.households
        ],
        "property": (
            {"id": str(scope.property.id), "name": scope.property.name}
            if scope.property is not None
            else None
        ),
        "partitions": [
            {
                "household_id": str(execution.household.id),
                "household_name": execution.household.name,
                "tool": execution.result.tool,
                "total": execution.result.facts.get("total", len(execution.result.items)),
            }
            for execution in executions
        ],
    }


def _scope_notices(scope: SearchScope, executions: list[ScopeExecution]) -> list[str]:
    notices = list(scope.notices)
    notices.extend(
        notice
        for execution in executions
        for notice in execution.result.notices
        if notice not in notices
    )
    notices.append(
        "All-my-places and property-wide answers use read-only deterministic "
        "retrieval across current memberships. AI interpretation is only used when "
        "the scope is one household without a property filter, so no household's "
        "data is sent through another household's provider or consent."
    )
    return notices


def _locate_answer(executions: list[ScopeExecution]) -> tuple[str, dict[str, Any]]:
    items = _dedupe_items(executions)
    if not items:
        return "I couldn't find a matching item across your places.", {
            "total": 0,
            "ambiguous": False,
            "whereabouts": None,
        }
    if len(items) == 1:
        item = items[0]
        for execution in executions:
            whereabouts = execution.result.facts.get("whereabouts")
            if isinstance(whereabouts, dict) and whereabouts.get("item_id") == str(item.id):
                home_path = whereabouts.get("home_path")
                summary = execution.result.summary
                if home_path:
                    summary = summary.replace(
                        str(home_path),
                        f"{execution.household.name} / {home_path}",
                    )
                facts = dict(whereabouts)
                facts["household_id"] = str(execution.household.id)
                facts["household_name"] = execution.household.name
                facts["scope"] = "all_places"
                return summary, {
                    "total": 1,
                    "ambiguous": False,
                    "whereabouts": facts,
                }
        return (
            f"{item.name} is recorded in {_item_place(item)}.",
            {
                "total": 1,
                "ambiguous": False,
                "whereabouts": {
                    "item_id": str(item.id),
                    "item_name": item.name,
                    "home_path": _item_place(item),
                },
            },
        )
    names = "; ".join(f"{item.name} — {_item_place(item)}" for item in items[:8])
    return (
        f"I found {len(items)} items across your places that could match: {names}. "
        "Which one did you mean?",
        {"total": len(items), "ambiguous": True, "whereabouts": None},
    )


def _count_answer(executions: list[ScopeExecution]) -> tuple[str, dict[str, Any]]:
    total = sum(
        int(execution.result.facts.get("total", len(execution.result.items)))
        for execution in executions
    )
    quantity = sum(int(execution.result.facts.get("quantity_total", 0)) for execution in executions)
    on_loan = sum(
        int(execution.result.facts.get("on_loan_quantity", 0)) for execution in executions
    )
    subject = next(
        (
            str(execution.result.facts.get("subject"))
            for execution in executions
            if execution.result.facts.get("subject")
        ),
        "the requested items",
    )
    households = len({execution.household.id for execution in executions if execution.result.items})
    if total == 0:
        answer = f"No items matching “{subject}” were found across your places."
    else:
        answer = (
            f"You have {quantity} units across {total} matching item records for "
            f"“{subject}” in {households or len(executions)} "
            f"{'household' if (households or len(executions)) == 1 else 'households'}."
        )
        if on_loan:
            answer += f" {on_loan} units are currently on loan."
    return answer, {
        "total": total,
        "quantity_total": quantity,
        "on_loan_quantity": on_loan,
        "subject": subject,
    }


def _loans_answer(executions: list[ScopeExecution]) -> tuple[str, dict[str, Any]]:
    facts_loans: list[dict[str, Any]] = []
    for execution in executions:
        facts_loans.extend(execution.result.facts.get("loans") or [])
    outstanding = sum(
        int(execution.result.facts.get("outstanding_count", 0)) for execution in executions
    )
    overdue = sum(int(execution.result.facts.get("overdue_count", 0)) for execution in executions)
    quantity = sum(
        int(execution.result.facts.get("on_loan_quantity", 0)) for execution in executions
    )
    if not facts_loans:
        return (
            "No items are currently recorded as on loan across your places.",
            {
                "outstanding_count": 0,
                "overdue_count": 0,
                "on_loan_quantity": 0,
                "loans": [],
            },
        )
    lines = [
        f"{outstanding} open loan(s), {quantity} unit(s) on loan across your places"
        + (f", {overdue} past due." if overdue else ".")
    ]
    for loan in facts_loans[:10]:
        due = (
            f" · due {_human_date(loan['due_on'])}"
            if loan.get("due_on")
            else " · no return date set"
        )
        lines.append(
            f"• {loan.get('household_name') or 'Household'}: "
            f"{loan.get('item_name') or 'Item'} — {loan.get('quantity')} with "
            f"{loan.get('borrower_name') or 'an unnamed borrower'}{due}"
        )
    return "\n".join(lines), {
        "outstanding_count": outstanding,
        "overdue_count": overdue,
        "on_loan_quantity": quantity,
        "loans": facts_loans,
    }


def _borrowed_answer(executions: list[ScopeExecution]) -> tuple[str, dict[str, Any]]:
    records = _dedupe_borrowed(executions)
    held = sum(int(record.outstanding_quantity) for record in records)
    returned = sum(int(record.returned_quantity) for record in records)
    overdue = sum(1 for record in records if record.overdue)
    if not records:
        return (
            "No items are currently recorded as borrowed from others across your places.",
            {
                "total": 0,
                "open_count": 0,
                "overdue_count": 0,
                "borrowed_outstanding_quantity": 0,
                "borrowed_returned_quantity": 0,
                "borrowed": [],
            },
        )
    lines = [
        f"{len(records)} borrowed record(s), {held} unit(s) held here and "
        f"{returned} unit(s) returned from owners" + (f", {overdue} past due." if overdue else ".")
    ]
    for record in records[:10]:
        due = f", due {_human_date(record.due_on)}" if record.due_on else ""
        lines.append(
            f"• {record.household_name or 'Household'}: {record.item_name} belongs to "
            f"{record.owner_name}{due} — {record.outstanding_quantity} outstanding"
        )
    return "\n".join(lines), {
        "total": len(records),
        "open_count": sum(
            1 for record in records if record.status in {"outstanding", "partially_returned"}
        ),
        "overdue_count": overdue,
        "borrowed_outstanding_quantity": held,
        "borrowed_returned_quantity": returned,
        "borrowed": [record.model_dump(mode="json") for record in records],
    }


def _summary_answer(executions: list[ScopeExecution]) -> tuple[str, dict[str, Any]]:
    item_count = sum(int(execution.result.facts.get("item_count", 0)) for execution in executions)
    quantity = sum(int(execution.result.facts.get("total_quantity", 0)) for execution in executions)
    on_loan = sum(
        int(execution.result.facts.get("on_loan_quantity", 0)) for execution in executions
    )
    missing = sum(
        int(execution.result.facts.get("items_missing_purchase_count", 0))
        for execution in executions
    )
    active = sum(
        int((execution.result.facts.get("warranties") or {}).get("active", 0))
        for execution in executions
    )
    expiring = sum(
        int((execution.result.facts.get("warranties") or {}).get("expiring", 0))
        for execution in executions
    )
    expired = sum(
        int((execution.result.facts.get("warranties") or {}).get("expired", 0))
        for execution in executions
    )
    answer = (
        f"Across {len(executions)} households there are {item_count} active item records "
        f"with {quantity} units. {on_loan} units are currently on loan. "
        f"{missing} items have missing or unresolved purchase information. "
        f"Warranties: {active} active, {expiring} expiring soon, {expired} expired."
    )
    return answer, {
        "item_count": item_count,
        "total_quantity": quantity,
        "on_loan_quantity": on_loan,
        "items_missing_purchase_count": missing,
        "warranties": {"active": active, "expiring": expiring, "expired": expired},
    }


def _global_answer(executions: list[ScopeExecution]) -> tuple[str, str, dict[str, Any]]:
    tools = {execution.result.tool for execution in executions}
    if tools == {"locate_item"}:
        answer, facts = _locate_answer(executions)
        return "locate_item", answer, facts
    if tools == {"count_items"}:
        answer, facts = _count_answer(executions)
        return "count_items", answer, facts
    if tools == {"list_outstanding_loans"}:
        answer, facts = _loans_answer(executions)
        return "list_outstanding_loans", answer, facts
    if tools == {"list_borrowed_items"}:
        answer, facts = _borrowed_answer(executions)
        return "list_borrowed_items", answer, facts
    if tools == {"find_borrowed_owner"}:
        borrowed = _dedupe_borrowed(executions)
        lines = [
            f"{record.household_name or 'Household'}: {record.item_name} belongs to "
            f"{record.owner_name} — {record.outstanding_quantity} outstanding"
            for record in borrowed[:10]
        ]
        answer = (
            "\n".join(lines)
            if lines
            else "I couldn't find a borrowed record matching that item across your places."
        )
        return (
            "find_borrowed_owner",
            answer,
            {
                "borrowed_total": len(borrowed),
                "borrowed": [record.model_dump(mode="json") for record in borrowed],
            },
        )
    if tools == {"get_inventory_summary"}:
        answer, facts = _summary_answer(executions)
        return "get_inventory_summary", answer, facts
    if tools == {"find_missing_information"}:
        total = sum(
            int(execution.result.facts.get("total", len(execution.result.items)))
            for execution in executions
        )
        return (
            "find_missing_information",
            f"Found {total} items matching that missing-information criterion across your places.",
            {"total": total},
        )
    if tools == {"search_items"}:
        total = sum(
            int(execution.result.facts.get("total", len(execution.result.items)))
            for execution in executions
        )
        quantity = sum(
            int(execution.result.facts.get("quantity_total", 0)) for execution in executions
        )
        borrowed = _dedupe_borrowed(executions)
        borrowed_sentence = (
            f" Separately, {len(borrowed)} borrowed record(s) match; they belong to "
            "other owners and are not owned stock."
            if borrowed
            else ""
        )
        return (
            "search_items",
            f"Found {total} owned items across your places"
            + (f" with {quantity} units recorded." if quantity else ".")
            + " The matching records are listed below."
            + borrowed_sentence,
            {
                "total": total,
                "quantity_total": quantity,
                "borrowed_total": len(borrowed),
                "borrowed": [record.model_dump(mode="json") for record in borrowed],
            },
        )
    if tools == {"get_warranty_status"}:
        rows = [
            warranty
            for execution in executions
            if isinstance(execution.result.facts.get("warranties"), list)
            for warranty in execution.result.facts["warranties"]
        ]
        return (
            "get_warranty_status",
            f"Found {len(rows)} warranties matching that request across your places.",
            {"warranties": rows},
        )
    if tools == {"get_purchase_history"}:
        purchases = [
            purchase
            for execution in executions
            for purchase in execution.result.facts.get("purchases") or []
        ]
        return (
            "get_purchase_history",
            f"Found {len(purchases)} purchase records across your places.",
            {"purchases": purchases},
        )
    if tools == {"search_documents"}:
        documents = [
            document for execution in executions for document in execution.result.documents
        ]
        return (
            "search_documents",
            f"Found {len(documents)} matching documents across your places.",
            {"total": len(documents)},
        )
    # Mixed structured tools: keep each partition labelled instead of claiming a
    # combined count that would be wrong.
    lines = [f"Results across {len(executions)} households:"]
    for execution in executions:
        if (
            not execution.result.items
            and not execution.result.documents
            and not execution.result.borrowed
        ):
            continue
        lines.append(f"{execution.household.name}: {execution.result.summary}")
        for item in execution.result.items[:4]:
            lines.append(f"• {item.name} — {_item_place(item)}")
        for record in execution.result.borrowed[:4]:
            lines.append(
                f"• {record.item_name} — borrowed from {record.owner_name}, "
                f"{record.outstanding_quantity} held"
            )
    return (
        "search_items",
        "\n".join(lines),
        {
            "total": sum(len(execution.result.items) for execution in executions),
            "borrowed_total": sum(len(execution.result.borrowed) for execution in executions),
            "borrowed": [
                record.model_dump(mode="json")
                for execution in executions
                for record in execution.result.borrowed
            ],
        },
    )


def execute_all_places(
    db: Session,
    scope: SearchScope,
    *,
    question: str,
    history: list[Any],
) -> tuple[list[ScopeExecution], list[str], bool]:
    # First see whether any current household recognises a structured question.
    # If so, only those partitions answer it; keyword fallback would otherwise
    # add unrelated records from households that simply do not have that room.
    structured_exists = False
    for household, _role in scope.households:
        if (
            _followup_plan(question, history) is not None
            or structured_plan(db, household.id, question) is not None
        ):
            structured_exists = True
            break
    executions, notices = _execute_scope(
        db,
        scope,
        question=question,
        history=history,
        use_only_structured=structured_exists,
    )
    return executions, notices, structured_exists


def _response_scope(scope: SearchScope) -> dict[str, Any]:
    return {
        "scope_label": scope.label,
        "households": scope_households(scope),
        "property": scope_property(scope.property),
    }


def answer_all_places(
    db: Session,
    scope: SearchScope,
    request: AssistantRequest,
) -> AssistantResponse:
    executions, notices, _structured = execute_all_places(
        db,
        scope,
        question=request.question,
        history=request.history,
    )
    items = _dedupe_items(executions)[:50]
    borrowed = _dedupe_borrowed(executions)[:50]
    references = _dedupe_references(executions)[:50]
    if not executions:
        answer = "No current household could answer that request."
        tool = "search_items"
        facts: dict[str, Any] = {"total": 0}
    else:
        tool, answer, facts = _global_answer(executions)
    facts = {**facts, **_scope_facts(scope, executions)}
    return AssistantResponse(
        answer=answer,
        mode="deterministic",
        tool=tool,
        filters={"scope": facts["scope"]},
        items=items,
        borrowed=borrowed,
        documents=[document for execution in executions for document in execution.result.documents],
        locations=[location for execution in executions for location in execution.result.locations],
        references=references,
        notices=[*_scope_notices(scope, executions), *notices],
        facts=facts,
        ai_status=deterministic_status(),
        **_response_scope(scope),
    )


def natural_search_all_places(
    db: Session,
    scope: SearchScope,
    question: str,
    *,
    limit: int = 30,
) -> NaturalSearchResponse:
    executions, notices, structured = execute_all_places(
        db,
        scope,
        question=question,
        history=[],
    )
    items = _dedupe_items(executions)[:limit]
    borrowed = _dedupe_borrowed(executions)[:limit]
    references = _dedupe_references(executions)
    if not executions:
        tool = "search_items"
        answer = "No current household could answer that request."
        facts: dict[str, Any] = {"total": 0}
    else:
        tool, answer, facts = _global_answer(executions)
    total = int(facts.get("total", len(items)))
    facts = {**facts, **_scope_facts(scope, executions)}
    interpretations = []
    for household, _role in scope.households:
        if structured:
            plan = structured_plan(db, household.id, question)
            if plan is None:
                continue
        else:
            plan = deterministic_plan(db, household.id, question)
        label = _plan_interpretation(plan)
        if label not in interpretations:
            interpretations.append(label)
    return NaturalSearchResponse(
        question=question,
        interpretation="; ".join(interpretations) or "all my places keyword search",
        filters=NaturalSearchFilters(
            property_id=scope.property.id if scope.property is not None else None
        ),
        items=items,
        borrowed=borrowed,
        borrowed_total=int(facts.get("borrowed_total", len(borrowed))),
        total=total,
        mode="deterministic",
        ai_available=any(
            ai.status_for(db, household.id, AiTask.SEARCH.value, probe=False).configured
            for household, _role in scope.households
        ),
        answer=answer,
        answer_kind=tool,
        tool=tool,
        facts=facts,
        notices=[*_scope_notices(scope, executions), *notices],
        references=references,
        needs_assistant=total == 0 and not borrowed,
        suggested_question=question,
        **_response_scope(scope),
    )
