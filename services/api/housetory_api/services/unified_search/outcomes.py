"""Per-household deterministic and AI search outcomes."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from ...models import Household
from ...schemas.ai import (
    AssistantPlan,
    NaturalSearchFilters,
    SearchConversationContext,
)
from ...schemas.borrowed import BorrowedOut
from ...schemas.items import ItemSummary
from ...schemas.search import QuickSearchResult
from .. import assistant as assistant_service
from .. import borrowed as borrowed_service
from .. import global_assistant, global_search
from ..ai_tools import _summaries_with_paths, search_inventory
from ..ai_tools.references import dedupe_by_id
from .context import _context_for_prompt
from .scope import PROPERTY_AWARE_TOOLS, HouseholdOutcome, _status_for_household


def _direct_items_for_term(
    db: Session,
    scope: global_search.SearchScope,
    term: str,
    *,
    limit: int,
) -> tuple[list[ItemSummary], list[BorrowedOut], int, int]:
    items: list[ItemSummary] = []
    borrowed: list[BorrowedOut] = []
    total = 0
    borrowed_total = 0
    property_id = scope.property.id if scope.property is not None else None
    for household, _role in scope.households:
        filters = NaturalSearchFilters(
            q=term or None,
            property_id=property_id,
            sort="relevance",
        )
        rows, household_total = search_inventory(
            db,
            household.id,
            filters,
            household_reminder_days=household.warranty_reminder_days,
            limit=limit,
        )
        total += household_total
        items.extend(
            _summaries_with_paths(
                db,
                household.id,
                rows,
                household_reminder_days=household.warranty_reminder_days,
            )
        )
        borrowed_rows, household_borrowed_total = borrowed_service.quick_search_records(
            db,
            household.id,
            q=term or "",
            limit=limit,
            property_id=property_id,
        )
        borrowed_total += household_borrowed_total
        for record in borrowed_rows:
            record.household_id = household.id
            record.household_name = household.name
            borrowed.append(record)
    return (
        dedupe_by_id(items)[:limit],
        dedupe_by_id(borrowed)[:limit],
        total,
        borrowed_total,
    )


def _quick_results(
    db: Session,
    scope: global_search.SearchScope,
    term: str,
    *,
    limit: int,
) -> list[QuickSearchResult]:
    results, _notices = global_search.quick_search(
        db,
        scope,
        effective_term=term,
        limit=min(limit, 8),
    )
    return results


def _structured_scope_outcomes(
    db: Session,
    scope: global_search.SearchScope,
    *,
    question: str,
    history: list[Any],
) -> tuple[list[HouseholdOutcome], bool]:
    executions, notices, structured_exists = global_assistant.execute_all_places(
        db,
        scope,
        question=question,
        history=history,
    )
    outcomes = [
        HouseholdOutcome(
            household=execution.household,
            role=execution.role,
            result=execution.result,
            structured=True,
        )
        for execution in executions
    ]
    if outcomes:
        outcomes[0].notices.extend(notices)
    return outcomes, structured_exists


def _deterministic_outcome(
    db: Session,
    household: Household,
    role: str,
    *,
    question: str,
    property_id: uuid.UUID | None,
    context: SearchConversationContext | None = None,
) -> HouseholdOutcome:
    plan = assistant_service.context_followup_plan(question, context)
    structured = plan is not None
    if plan is None:
        plan = assistant_service.structured_plan(db, household.id, question)
        structured = plan is not None
    if plan is None:
        plan = assistant_service.deterministic_plan(db, household.id, question)
    arguments = dict(plan.arguments)
    if property_id is not None and plan.tool in PROPERTY_AWARE_TOOLS:
        arguments["property_id"] = property_id
    try:
        result = assistant_service._execute_plan(
            db,
            household.id,
            AssistantPlan(tool=plan.tool, arguments=arguments),
            household_reminder_days=household.warranty_reminder_days,
        )
    except Exception:  # noqa: BLE001 - fall back to keyword retrieval
        fallback_plan = assistant_service.deterministic_plan(db, household.id, question)
        fallback_arguments = dict(fallback_plan.arguments)
        if property_id is not None and fallback_plan.tool in PROPERTY_AWARE_TOOLS:
            fallback_arguments["property_id"] = property_id
        result = assistant_service._execute_plan(
            db,
            household.id,
            AssistantPlan(tool=fallback_plan.tool, arguments=fallback_arguments),
            household_reminder_days=household.warranty_reminder_days,
        )
        plan = fallback_plan
        structured = False
    return HouseholdOutcome(
        household=household,
        role=role,
        result=result,
        plan=plan,
        interpretation=assistant_service._plan_interpretation(plan),
        structured=structured,
    )


def _validate_plan_arguments(
    plan: AssistantPlan,
    *,
    allowed_item_ids: set[uuid.UUID],
    property_id: uuid.UUID | None,
) -> AssistantPlan:
    arguments: dict[str, Any] = {}
    for key, value in plan.arguments.items():
        if isinstance(value, str):
            arguments[key] = value.strip()[:500]
        else:
            arguments[key] = value
    if arguments.get("item_ids"):
        valid_ids: list[str] = []
        for raw_id in arguments["item_ids"]:
            try:
                parsed = uuid.UUID(str(raw_id))
            except (ValueError, TypeError):
                continue
            if parsed in allowed_item_ids:
                valid_ids.append(str(parsed))
        if valid_ids:
            arguments["item_ids"] = valid_ids[:12]
        else:
            arguments.pop("item_ids", None)
    if arguments.get("item_id"):
        try:
            parsed = uuid.UUID(str(arguments["item_id"]))
        except (ValueError, TypeError):
            arguments.pop("item_id", None)
        else:
            if parsed not in allowed_item_ids:
                arguments.pop("item_id", None)
            else:
                arguments["item_id"] = str(parsed)
    if property_id is not None and plan.tool in PROPERTY_AWARE_TOOLS:
        arguments["property_id"] = str(property_id)
    return AssistantPlan(tool=plan.tool, arguments=arguments, rationale=plan.rationale)


def _ai_outcome(
    db: Session,
    household: Household,
    role: str,
    *,
    scope: global_search.SearchScope,
    question: str,
    history: list[Any],
    context: SearchConversationContext,
    explicit_ask: bool,
) -> HouseholdOutcome:
    status, task = _status_for_household(db, household.id)
    if not status.configured:
        outcome = _deterministic_outcome(
            db,
            household,
            role,
            question=question,
            property_id=scope.property.id if scope.property is not None else None,
            context=context,
        )
        outcome.ai_status = status
        outcome.notices.append(
            "No configured AI provider is available for this household, so the "
            "answer is limited to direct deterministic retrieval."
        )
        return outcome

    property_id = scope.property.id if scope.property is not None else None
    index = assistant_service._inventory_prompt_index(
        db,
        household.id,
        property_id=property_id,
    )
    plan, plan_used_ai = assistant_service._ai_plan(
        db,
        household.id,
        question,
        history,
        context=_context_for_prompt(context),
        task=task,
        inventory_index=index,
        scope_label=(
            f"{household.name} · {scope.property.name}"
            if scope.property is not None
            else household.name
        ),
        property_id=property_id,
    )
    ai_attempted = True
    if plan is None:
        outcome = _deterministic_outcome(
            db,
            household,
            role,
            question=question,
            property_id=property_id,
            context=context,
        )
        outcome.ai_status = status
        outcome.ai_attempted = True
        if outcome.result is not None and (
            outcome.result.items
            or outcome.result.borrowed
            or outcome.result.tool
            in {
                "list_outstanding_loans",
                "list_borrowed_items",
                "get_inventory_summary",
                "get_warranty_status",
                "get_purchase_history",
                "search_documents",
                "find_missing_information",
                "get_loan_history",
            }
        ):
            outcome.answer = assistant_service._deterministic_answer(outcome.result)
        outcome.notices.append(
            "The configured AI could not interpret this request. Direct inventory "
            "retrieval is shown; no factual conclusion is inferred from the failure."
        )
        return outcome

    allowed_ids = {
        uuid.UUID(str(entry["id"])) for entry in index["items"] if entry.get("id")
    }
    allowed_ids.update(ref.id for ref in context.resolved_items)
    allowed_ids.update(ref.id for ref in context.candidate_items)
    plan = _validate_plan_arguments(
        plan,
        allowed_item_ids=allowed_ids,
        property_id=property_id,
    )
    try:
        result = assistant_service._execute_plan(
            db,
            household.id,
            plan,
            household_reminder_days=household.warranty_reminder_days,
        )
    except Exception:  # noqa: BLE001 - model chose an impossible tool argument
        outcome = _deterministic_outcome(
            db,
            household,
            role,
            question=question,
            property_id=property_id,
            context=context,
        )
        outcome.ai_status = status
        outcome.ai_attempted = True
        if outcome.result is not None and (
            outcome.result.items or outcome.result.borrowed
        ):
            outcome.answer = assistant_service._deterministic_answer(outcome.result)
        outcome.notices.append(
            "The AI interpretation could not be executed safely. Direct inventory "
            "retrieval is shown instead."
        )
        return outcome

    answer = (
        assistant_service._ai_answer(
            db,
            household.id,
            question,
            result,
            context=_context_for_prompt(context),
            task=task,
        )
        if plan_used_ai
        else None
    )
    ai_used = bool(answer)
    deterministic_answer = assistant_service._deterministic_answer(result)
    return HouseholdOutcome(
        household=household,
        role=role,
        result=result,
        answer=answer or deterministic_answer,
        plan=plan,
        interpretation=assistant_service._plan_interpretation(plan),
        ai_used=ai_used,
        ai_attempted=ai_attempted,
        ai_status=status,
        structured=False,
        notices=(
            []
            if ai_used
            else [
                "The configured AI interpreted the request but could not produce a "
                "language answer. The grounded facts below come from read-only tools."
            ]
        ),
    )


def _outcome_answer(outcome: HouseholdOutcome, *, multi_household: bool) -> str | None:
    if outcome.answer is None:
        return None
    if not multi_household:
        return outcome.answer
    return f"{outcome.household.name}: {outcome.answer}"


def _combined_facts(
    scope: global_search.SearchScope,
    outcomes: list[HouseholdOutcome],
    *,
    mode: str,
) -> dict[str, Any]:
    items = dedupe_by_id(
        [item for outcome in outcomes if outcome.result for item in outcome.result.items]
    )
    borrowed = dedupe_by_id(
        [
            record
            for outcome in outcomes
            if outcome.result
            for record in outcome.result.borrowed
        ]
    )
    ambiguity = any(
        outcome.result is not None and outcome.result.facts.get("ambiguous")
        for outcome in outcomes
    )
    return {
        "scope": "property" if scope.property is not None else (
            "all_places" if len(scope.households) > 1 else "household"
        ),
        "scope_label": scope.label,
        "mode": mode,
        "total": len(items),
        "borrowed_total": len(borrowed),
        "ambiguous": bool(ambiguity or len(items) > 1),
        "partitions": [
            {
                "household_id": str(outcome.household.id),
                "household_name": outcome.household.name,
                "tool": outcome.result.tool if outcome.result else None,
                "total": (
                    outcome.result.facts.get("total", len(outcome.result.items))
                    if outcome.result
                    else 0
                ),
                "ai_used": outcome.ai_used,
            }
            for outcome in outcomes
        ],
        "households": [
            {"id": str(household.id), "name": household.name, "role": role}
            for household, role in scope.households
        ],
        "property": (
            {"id": str(scope.property.id), "name": scope.property.name}
            if scope.property is not None
            else None
        ),
    }


def _merge_result_facts(
    combined: dict[str, Any], outcomes: list[HouseholdOutcome]
) -> dict[str, Any]:
    merged = dict(combined)
    for outcome in outcomes:
        if outcome.result is None:
            continue
        for key, value in outcome.result.facts.items():
            if key in {"partitions", "households", "property", "scope", "scope_label", "mode"}:
                continue
            if key in {"total", "borrowed_total", "ambiguous"}:
                continue
            if key not in merged:
                merged[key] = value
    return merged


def _fallback_answer(
    deterministic: str | None,
    *,
    quick_results: list[QuickSearchResult],
    items: list[ItemSummary],
    borrowed: list[BorrowedOut],
    ai_attempted: bool,
) -> str:
    if deterministic:
        return deterministic
    if quick_results or items or borrowed:
        return (
            "Direct inventory lookup returned the matching records below. The "
            "question could not be interpreted further without a configured AI "
            "provider; this is not a conclusive no-result answer."
        )
    if ai_attempted:
        return (
            "No direct inventory record matched, and the configured AI could not "
            "complete the interpretation. This is not a conclusive no-result answer."
        )
    return (
        "No direct inventory record matched, and no configured AI provider was "
        "available to interpret the question. This is not a conclusive no-result "
        "answer."
    )
