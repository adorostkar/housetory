"""Grounded assistant planning, deterministic fallback and smart search."""

import uuid

from pydantic import ValidationError
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...domain import AiTask
from ...schemas.ai import (
    AssistantRequest,
    AssistantResponse,
    NaturalSearchResponse,
)
from .. import ai
from .. import borrowed as borrowed_service
from ..ai_tools import (
    _summaries_with_paths,
    search_inventory,
)
from ..import_matching import build_index
from ..query_text import (
    clean_subject,
)
from .answers import _ai_answer, _deterministic_answer
from .planning import _ai_plan, _execute_plan, _followup_plan, deterministic_plan, structured_plan
from .planning import _inventory_prompt_index as _inventory_prompt_index
from .planning import context_followup_plan as context_followup_plan
from .search_interpretation import (
    _ai_search_plan,
    _plan_filters,
    _plan_interpretation,
    _search_answer,
    interpret_search,
)


def answer_question(
    db: Session,
    household_id: uuid.UUID,
    request: AssistantRequest,
    *,
    household_reminder_days: int,
) -> AssistantResponse:
    status = ai.status_for(db, household_id, AiTask.ASSISTANT.value, probe=False)

    # Exact lookups (item codes, loans) are answered from records. When a model
    # is configured everything else goes to it; without one the broader
    # deterministic routing keeps the assistant useful offline.
    structured = _followup_plan(request.question, request.history) or structured_plan(
        db, household_id, request.question, ai_available=status.configured
    )
    if structured is not None:
        try:
            result = _execute_plan(
                db,
                household_id,
                structured,
                household_reminder_days=household_reminder_days,
            )
        except (ValueError, TypeError, ValidationError, ApiError):
            result = _execute_plan(
                db,
                household_id,
                deterministic_plan(db, household_id, request.question),
                household_reminder_days=household_reminder_days,
            )
        return AssistantResponse(
            answer=_deterministic_answer(result),
            mode="deterministic",
            tool=result.tool,
            filters=result.filters,
            items=result.items,
            borrowed=result.borrowed,
            documents=result.documents,
            locations=result.locations,
            references=result.references,
            notices=result.notices,
            facts=result.facts,
            ai_status=status,
        )

    plan, plan_used_ai = _ai_plan(db, household_id, request.question, request.history)
    if plan is None:
        plan = deterministic_plan(db, household_id, request.question)
        plan_used_ai = False
    try:
        result = _execute_plan(
            db,
            household_id,
            plan,
            household_reminder_days=household_reminder_days,
        )
    except (ValueError, TypeError, ValidationError, ApiError):
        plan = deterministic_plan(db, household_id, request.question)
        result = _execute_plan(
            db,
            household_id,
            plan,
            household_reminder_days=household_reminder_days,
        )
        plan_used_ai = False
    answer = _ai_answer(db, household_id, request.question, result) if plan_used_ai else None
    answer_used_ai = answer is not None
    if not answer:
        answer = _deterministic_answer(result)
    if plan_used_ai or answer_used_ai:
        status = status.model_copy(update={"available": True})
    return AssistantResponse(
        answer=answer,
        mode="ai" if plan_used_ai or answer_used_ai else "deterministic",
        tool=result.tool,
        filters=result.filters,
        items=result.items,
        borrowed=result.borrowed,
        documents=result.documents,
        locations=result.locations,
        references=result.references,
        notices=result.notices,
        facts=result.facts,
        ai_status=status,
    )


def natural_search(
    db: Session,
    household_id: uuid.UUID,
    question: str,
    *,
    household_reminder_days: int,
    limit: int = 30,
) -> NaturalSearchResponse:
    status = ai.status_for(db, household_id, AiTask.SEARCH.value, probe=False)
    plan = structured_plan(db, household_id, question, ai_available=status.configured)
    if plan is not None:
        result = _execute_plan(
            db,
            household_id,
            plan,
            household_reminder_days=household_reminder_days,
        )
        return NaturalSearchResponse(
            question=question,
            interpretation=_plan_interpretation(plan),
            filters=_plan_filters(db, household_id, plan),
            items=result.items,
            borrowed=result.borrowed,
            borrowed_total=int(result.facts.get("borrowed_total", len(result.borrowed))),
            total=int(result.facts.get("total", len(result.items))),
            mode="deterministic",
            ai_available=status.configured,
            answer=_deterministic_answer(result),
            answer_kind=result.tool,
            tool=result.tool,
            facts=result.facts,
            notices=result.notices,
            references=result.references,
            needs_assistant=False,
            suggested_question=question,
        )

    index = build_index(db, household_id)
    filters, interpretation = interpret_search(db, household_id, question)
    filters, interpretation, ai_used, ai_available = _ai_search_plan(
        db, household_id, question, index, filters, interpretation
    )
    items, total = search_inventory(
        db,
        household_id,
        filters,
        household_reminder_days=household_reminder_days,
        limit=limit,
    )
    summaries = _summaries_with_paths(
        db,
        household_id,
        items,
        household_reminder_days=household_reminder_days,
    )
    borrowed_matches, borrowed_total = borrowed_service.quick_search_records(
        db,
        household_id,
        q=clean_subject(question),
        limit=20,
        property_id=filters.property_id,
    )
    return NaturalSearchResponse(
        question=question,
        interpretation=interpretation,
        filters=filters,
        items=summaries,
        borrowed=borrowed_matches,
        borrowed_total=borrowed_total,
        total=total,
        mode="ai" if ai_used else "deterministic",
        ai_available=ai_available,
        answer=_search_answer(total, interpretation, filters, summaries, borrowed_total),
        answer_kind="list",
        tool="search_items",
        facts={"total": total, "borrowed_total": borrowed_total},
        needs_assistant=total == 0 and borrowed_total == 0,
        suggested_question=question,
    )
