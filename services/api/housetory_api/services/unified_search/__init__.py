"""One submit-time search flow shared by the global box, search page and assistant.

The flow is deliberately ordered:

1. Authorised direct inventory lookup (cheap, deterministic, no provider call).
2. Reliable structured deterministic answer (loan/count/location/history).
3. Configured, consented AI interpretation grounded in fresh read-only tool
   results, with the answer in the user's language.

All-places and property scopes execute AI one household at a time using that
household's own provider and consent. No household's records are sent through
another household's provider.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from ...schemas.ai import (
    AssistantReference,
    NaturalSearchFilters,
    SearchContextItemRef,
    SearchConversationContext,
    SearchQueryResponse,
)
from .. import assistant as assistant_service
from .. import global_assistant, global_search
from ..ai_tools.references import dedupe_by_id, dedupe_references
from ..query_text import (
    clean_subject,
    contains_non_latin,
    looks_like_question,
    normalize_text,
)
from .context import (
    _answer_metadata,
    _build_dialogue_memory,
    _context_for_household,
    _context_from_outcomes,
    _has_contextual_reference,
    _history_from_memory,
    _history_models,
    _raw_history_allowed,
    _sanitise_context,
)
from .outcomes import (
    _ai_outcome,
    _combined_facts,
    _deterministic_outcome,
    _direct_items_for_term,
    _fallback_answer,
    _merge_result_facts,
    _outcome_answer,
    _quick_results,
    _structured_scope_outcomes,
)
from .scope import HouseholdOutcome, _aggregate_status, _scope_key


def execute_search(
    db: Session,
    *,
    user_id: uuid.UUID,
    query: str,
    explicit_ask: bool = False,
    history: list[Any] | None = None,
    context: SearchConversationContext | None = None,
    household_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    limit: int = 30,
) -> SearchQueryResponse:
    scope = global_search.resolve_search_scope(
        db,
        user_id,
        household_id=household_id,
        property_id=property_id,
    )
    current_key = _scope_key(scope)
    history_reset = bool(
        context is not None
        and context.scope_key
        and context.scope_key != current_key
    )
    safe_history = [] if history_reset else _history_models(history or [])
    safe_context = _sanitise_context(db, scope, context)
    multi_household = len(scope.households) > 1
    notices = list(scope.notices)

    raw_query = normalize_text(query).strip() or query.strip()
    question_like = looks_like_question(raw_query)
    non_latin = contains_non_latin(raw_query)
    has_context = bool(
        safe_context.resolved_items
        or safe_context.candidate_items
        or safe_context.loans
    )
    contextual_reference = _has_contextual_reference(raw_query)
    direct_term = clean_subject(raw_query) if question_like else raw_query
    if not direct_term:
        direct_term = raw_query

    quick_results = _quick_results(db, scope, direct_term, limit=limit)
    direct_items, direct_borrowed, direct_total, direct_borrowed_total = (
        _direct_items_for_term(db, scope, direct_term, limit=limit)
    )

    aggregate_status, configured_household_names = _aggregate_status(db, scope)
    any_ai_configured = bool(configured_household_names)

    # A simple named search with a confident direct match is answered without a
    # paid/model call. Populated context alone must not force AI: "Heavy drill"
    # remains a direct lookup even after an earlier question or a reload.
    plain_direct_match = bool(
        direct_items or direct_borrowed or quick_results
    ) and not contextual_reference
    self_contained_question = (
        question_like
        and bool(direct_items or direct_borrowed)
        and not contextual_reference
    )
    simple_direct = (
        not explicit_ask
        and not question_like
        and plain_direct_match
    )
    if simple_direct:
        interpretation = f"direct inventory match: {direct_term}"
        direct_facts = {
            "scope": "property" if scope.property is not None else (
                "all_places" if multi_household else "household"
            ),
            "total": direct_total,
            "borrowed_total": direct_borrowed_total,
            "direct_query": direct_term,
        }
        answer_meta = _answer_metadata(
            query,
            items=direct_items,
            quick_results=quick_results,
            borrowed=direct_borrowed,
            facts=direct_facts,
            documents=[],
            locations=[],
        )
        return SearchQueryResponse(
            query=query,
            **answer_meta,
            mode="direct",
            ai_used=False,
            ai_attempted=False,
            direct_match=True,
            ambiguous=direct_total > 1,
            needs_clarification=False,
            answer=None,
            answer_kind="direct_lookup",
            interpretation=interpretation,
            filters=NaturalSearchFilters(
                q=direct_term,
                property_id=scope.property.id if scope.property is not None else None,
            ),
            items=direct_items,
            quick_results=quick_results,
            borrowed=direct_borrowed,
            borrowed_total=direct_borrowed_total,
            total=direct_total,
            references=[
                AssistantReference(
                    type="item",
                    id=item.id,
                    title=item.name,
                    subtitle=item.room.name if item.room else None,
                    url=f"/items/{item.id}",
                    household_id=item.household.id if item.household else None,
                    household_name=item.household.name if item.household else None,
                )
                for item in direct_items[:12]
            ],
            notices=notices,
            facts=direct_facts,
            tool="direct_lookup",
            ai_status=aggregate_status,
            context=SearchConversationContext(
                scope_key=current_key,
                last_query=query[:2000],
                resolved_items=[
                    SearchContextItemRef(id=item.id, name=item.name)
                    for item in direct_items[:4]
                ],
                candidate_items=[
                    SearchContextItemRef(id=item.id, name=item.name)
                    for item in direct_items[:12]
                ],
                loans=[],
                dialogue_memory=_build_dialogue_memory(
                    db, scope, safe_context, query, None, direct_items
                ),
            ),
            scope_label=scope.label,
            households=global_search.scope_households(scope),
            property=global_search.scope_property(scope.property),
        )

    # Reliable structured questions are answered deterministically. If AI is
    # explicitly requested, or the input is multilingual, or a follow-up carries
    # structured context, AI interpretation is attempted first instead.
    deterministic_outcomes: list[HouseholdOutcome] = []
    structured_exists = False
    if (
        not explicit_ask
        and not non_latin
        and (not has_context or self_contained_question)
    ):
        deterministic_outcomes, structured_exists = _structured_scope_outcomes(
            db,
            scope,
            question=raw_query,
            history=safe_history,
        )

    if structured_exists and deterministic_outcomes:
        result_items = dedupe_by_id(
            [
                item
                for outcome in deterministic_outcomes
                if outcome.result
                for item in outcome.result.items
            ]
        )
        result_borrowed = dedupe_by_id(
            [
                record
                for outcome in deterministic_outcomes
                if outcome.result
                for record in outcome.result.borrowed
            ]
        )
        reliable = bool(
            result_items
            or result_borrowed
            or any(
                outcome.result is not None
                and outcome.result.tool
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
                for outcome in deterministic_outcomes
            )
        )
        if reliable:
            if (
                len(deterministic_outcomes) == 1
                and deterministic_outcomes[0].result is not None
            ):
                only_result = deterministic_outcomes[0].result
                answer = assistant_service._deterministic_answer(only_result)
                facts = dict(only_result.facts)
            else:
                _deterministic_tool, answer, facts = global_assistant._global_answer(
                    [
                        global_assistant.ScopeExecution(
                            household=outcome.household,
                            role=outcome.role,
                            result=outcome.result,
                        )
                        for outcome in deterministic_outcomes
                        if outcome.result is not None
                    ]
                )
            combined = _combined_facts(scope, deterministic_outcomes, mode="direct")
            facts = {**facts, **combined}
            result_documents = [
                document
                for outcome in deterministic_outcomes
                if outcome.result
                for document in outcome.result.documents
            ]
            result_locations = [
                location
                for outcome in deterministic_outcomes
                if outcome.result
                for location in outcome.result.locations
            ]
            answer_meta = _answer_metadata(
                query,
                items=result_items,
                quick_results=quick_results[:12],
                borrowed=result_borrowed,
                facts=facts,
                documents=result_documents,
                locations=result_locations,
            )
            context_out = _context_from_outcomes(
                db,
                scope,
                deterministic_outcomes,
                safe_context,
                query,
            )
            return SearchQueryResponse(
                query=query,
                **answer_meta,
                mode="direct",
                ai_used=False,
                ai_attempted=False,
                direct_match=bool(result_items or result_borrowed),
                ambiguous=bool(facts.get("ambiguous")),
                needs_clarification=bool(facts.get("ambiguous")),
                answer=answer,
                answer_kind=deterministic_outcomes[0].result.tool
                if deterministic_outcomes[0].result
                else None,
                interpretation="; ".join(
                    dict.fromkeys(
                        outcome.interpretation or ""
                        for outcome in deterministic_outcomes
                        if outcome.interpretation
                    )
                ),
                filters=NaturalSearchFilters(
                    property_id=scope.property.id if scope.property is not None else None
                ),
                items=result_items,
                quick_results=quick_results[:12],
                borrowed=result_borrowed,
                borrowed_total=len(result_borrowed),
                total=int(facts.get("total", len(result_items))),
                documents=result_documents,
                locations=result_locations,
                references=dedupe_references(
                    [
                        reference
                        for outcome in deterministic_outcomes
                        if outcome.result
                        for reference in outcome.result.references
                    ]
                ),
                notices=notices,
                facts=facts,
                tool=deterministic_outcomes[0].result.tool
                if deterministic_outcomes[0].result
                else None,
                ai_status=aggregate_status,
                context=context_out,
                scope_label=scope.label,
                households=global_search.scope_households(scope),
                property=global_search.scope_property(scope.property),
            )

    # If no configured provider exists, keep deterministic best-effort results
    # and label the limitation honestly. Never claim a conclusive no-result.
    if not any_ai_configured:
        fallback_outcomes: list[HouseholdOutcome] = []
        if deterministic_outcomes:
            fallback_outcomes = deterministic_outcomes
        else:
            for household, role in scope.households:
                fallback_outcomes.append(
                    _deterministic_outcome(
                        db,
                        household,
                        role,
                        question=raw_query,
                        property_id=(
                            scope.property.id if scope.property is not None else None
                        ),
                        context=safe_context,
                    )
                )
        fallback_items = dedupe_by_id(
            [
                item
                for outcome in fallback_outcomes
                if outcome.result
                for item in outcome.result.items
            ]
        ) or direct_items
        fallback_borrowed = dedupe_by_id(
            [
                record
                for outcome in fallback_outcomes
                if outcome.result
                for record in outcome.result.borrowed
            ]
        ) or direct_borrowed
        deterministic_answer = None
        fallback_tool = next(
            (
                outcome.result.tool
                for outcome in fallback_outcomes
                if outcome.result is not None
            ),
            None,
        )
        definitive_tools = {
            "list_outstanding_loans",
            "list_borrowed_items",
            "get_inventory_summary",
            "get_warranty_status",
            "get_purchase_history",
            "search_documents",
            "find_missing_information",
            "get_loan_history",
        }
        if fallback_outcomes and any(outcome.result for outcome in fallback_outcomes):
            if (
                len(fallback_outcomes) == 1
                and fallback_outcomes[0].result is not None
            ):
                deterministic_answer = assistant_service._deterministic_answer(
                    fallback_outcomes[0].result
                )
            else:
                _tool, deterministic_answer, _facts = global_assistant._global_answer(
                    [
                        global_assistant.ScopeExecution(
                            household=outcome.household,
                            role=outcome.role,
                            result=outcome.result,
                        )
                        for outcome in fallback_outcomes
                        if outcome.result is not None
                    ]
                )
            if (
                not fallback_items
                and not fallback_borrowed
                and fallback_tool not in definitive_tools
            ):
                # A keyword/tool miss without interpretation is not a conclusive
                # no-result answer. Keep the honest limitation instead.
                deterministic_answer = None
        fallback_notices = [
            *notices,
            *[
                notice
                for outcome in fallback_outcomes
                for notice in outcome.notices
                if notice not in notices
            ],
            (
                "No configured AI provider is available for this scope, so this "
                "question could not be interpreted beyond direct inventory matching. "
                "Direct results are shown; this is not a conclusive no-result answer."
            ),
        ]
        context_out = _context_from_outcomes(
            db,
            scope,
            fallback_outcomes,
            safe_context,
            query,
            direct_items=fallback_items,
        )
        fallback_documents = [
            document
            for outcome in fallback_outcomes
            if outcome.result
            for document in outcome.result.documents
        ]
        fallback_locations = [
            location
            for outcome in fallback_outcomes
            if outcome.result
            for location in outcome.result.locations
        ]
        fallback_facts = _merge_result_facts(
            _combined_facts(scope, fallback_outcomes, mode="fallback"),
            fallback_outcomes,
        )
        answer_meta = _answer_metadata(
            query,
            items=fallback_items,
            quick_results=quick_results,
            borrowed=fallback_borrowed,
            facts=fallback_facts,
            documents=fallback_documents,
            locations=fallback_locations,
        )
        return SearchQueryResponse(
            query=query,
            **answer_meta,
            mode="fallback",
            ai_used=False,
            ai_attempted=False,
            direct_match=bool(fallback_items or fallback_borrowed or quick_results),
            ambiguous=len(fallback_items) > 1,
            needs_clarification=len(fallback_items) > 1,
            answer=_fallback_answer(
                deterministic_answer,
                quick_results=quick_results,
                items=fallback_items,
                borrowed=fallback_borrowed,
                ai_attempted=False,
            ),
            answer_kind="fallback",
            interpretation="direct inventory matching only",
            filters=NaturalSearchFilters(
                q=direct_term,
                property_id=scope.property.id if scope.property is not None else None,
            ),
            items=fallback_items,
            quick_results=quick_results,
            borrowed=fallback_borrowed,
            borrowed_total=len(fallback_borrowed),
            total=len(fallback_items),
            references=dedupe_references(
                [
                    reference
                    for outcome in fallback_outcomes
                    if outcome.result
                    for reference in outcome.result.references
                ]
            ),
            notices=fallback_notices,
            facts=fallback_facts,
            tool=fallback_tool or "fallback",
            ai_status=aggregate_status,
            context=context_out,
            scope_label=scope.label,
            households=global_search.scope_households(scope),
            property=global_search.scope_property(scope.property),
        )

    # Configured AI path: one provider boundary per household. Structured
    # context is partitioned before any planning/answer call; raw prose history
    # is only reused in a single household without a property filter.
    ai_outcomes: list[HouseholdOutcome] = []
    allow_raw_history = _raw_history_allowed(scope)
    for household, role in scope.households:
        scoped_context = _context_for_household(db, household, scope, safe_context)
        ai_outcomes.append(
            _ai_outcome(
                db,
                household,
                role,
                scope=scope,
                question=raw_query,
                history=(
                    safe_history
                    if allow_raw_history
                    else _history_from_memory(scoped_context)
                ),
                context=scoped_context,
                explicit_ask=explicit_ask,
            )
        )

    ai_used = any(outcome.ai_used for outcome in ai_outcomes)
    ai_attempted = any(outcome.ai_attempted for outcome in ai_outcomes)
    result_items = dedupe_by_id(
        [
            item
            for outcome in ai_outcomes
            if outcome.result
            for item in outcome.result.items
        ]
    ) or direct_items
    result_borrowed = dedupe_by_id(
        [
            record
            for outcome in ai_outcomes
            if outcome.result
            for record in outcome.result.borrowed
        ]
    ) or direct_borrowed
    answers = [
        answer
        for outcome in ai_outcomes
        if (answer := _outcome_answer(outcome, multi_household=multi_household))
    ]
    answer = "\n\n".join(answers) if answers else None
    mode = "ai" if ai_used else "fallback"
    combined = _merge_result_facts(
        _combined_facts(scope, ai_outcomes, mode=mode), ai_outcomes
    )
    combined["total"] = len(result_items)
    combined["borrowed_total"] = len(result_borrowed)
    combined["ambiguous"] = bool(
        combined.get("ambiguous") or len(result_items) > 1
    )
    for outcome in ai_outcomes:
        for notice in outcome.notices:
            if notice not in notices:
                notices.append(notice)
    if not ai_used:
        notices.append(
            "The configured AI was available but did not produce a language answer. "
            "Grounded direct records are shown; no unsupported conclusion was added."
        )
    if not answer:
        answer = _fallback_answer(
            None,
            quick_results=quick_results,
            items=result_items,
            borrowed=result_borrowed,
            ai_attempted=ai_attempted,
        )
    interpretations = list(
        dict.fromkeys(
            outcome.interpretation
            for outcome in ai_outcomes
            if outcome.interpretation
        )
    )
    context_out = _context_from_outcomes(
        db, scope, ai_outcomes, safe_context, query, direct_items=result_items
    )
    ai_documents = [
        document
        for outcome in ai_outcomes
        if outcome.result
        for document in outcome.result.documents
    ]
    ai_locations = [
        location
        for outcome in ai_outcomes
        if outcome.result
        for location in outcome.result.locations
    ]
    answer_meta = _answer_metadata(
        query,
        items=result_items,
        quick_results=quick_results,
        borrowed=result_borrowed,
        facts=combined,
        documents=ai_documents,
        locations=ai_locations,
    )
    ai_status = next(
        (
            outcome.ai_status
            for outcome in ai_outcomes
            if outcome.ai_status is not None and outcome.ai_status.configured
        ),
        aggregate_status,
    )
    return SearchQueryResponse(
        query=query,
        **answer_meta,
        mode=mode,
        ai_used=ai_used,
        ai_attempted=ai_attempted,
        direct_match=bool(result_items or result_borrowed),
        ambiguous=bool(combined.get("ambiguous")),
        needs_clarification=bool(combined.get("ambiguous")),
        answer=answer,
        answer_kind=(
            ai_outcomes[0].result.tool
            if ai_outcomes and ai_outcomes[0].result is not None
            else None
        ),
        interpretation="; ".join(interpretations) or "AI interpretation",
        filters=NaturalSearchFilters(
            property_id=scope.property.id if scope.property is not None else None
        ),
        items=result_items,
        quick_results=quick_results,
        borrowed=result_borrowed,
        borrowed_total=len(result_borrowed),
        total=len(result_items),
        documents=ai_documents,
        locations=ai_locations,
        references=dedupe_references(
            [
                reference
                for outcome in ai_outcomes
                if outcome.result
                for reference in outcome.result.references
            ]
        ),
        notices=notices,
        facts=combined,
        tool=(
            ai_outcomes[0].result.tool
            if ai_outcomes and ai_outcomes[0].result is not None
            else None
        ),
        ai_status=ai_status,
        context=context_out,
        scope_label=scope.label,
        households=global_search.scope_households(scope),
        property=global_search.scope_property(scope.property),
    )
