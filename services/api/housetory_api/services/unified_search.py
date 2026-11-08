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

import re
import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..domain import AiTask
from ..models import Document, Household, Item, Loan, Room, StorageLocation
from ..schemas.ai import (
    AiStatus,
    AssistantPlan,
    AssistantReference,
    NaturalSearchFilters,
    SearchContextItemRef,
    SearchContextLoanRef,
    SearchContextMemoryEntry,
    SearchConversationContext,
    SearchQueryResponse,
)
from ..schemas.borrowed import BorrowedOut
from ..schemas.items import ItemSummary
from ..schemas.search import QuickSearchResult, SearchHousehold, SearchProperty
from . import ai, global_assistant, global_search
from . import assistant as assistant_service
from . import borrowed as borrowed_service
from .ai_tools import ToolResult, _summaries_with_paths, search_inventory
from .query_text import (
    clean_subject,
    contains_non_latin,
    looks_like_question,
    normalize_for_match,
    normalize_text,
)

PROPERTY_AWARE_TOOLS = global_assistant.PROPERTY_AWARE_TOOLS | {"get_loan_history"}
MAX_HISTORY_TURNS = 8
MAX_HISTORY_CHARS = 1200


@dataclass
class HouseholdOutcome:
    household: Household
    role: str
    result: ToolResult | None = None
    answer: str | None = None
    plan: AssistantPlan | None = None
    interpretation: str = ""
    ai_used: bool = False
    ai_attempted: bool = False
    ai_status: AiStatus | None = None
    structured: bool = False
    notices: list[str] = field(default_factory=list)


def _scope_key(scope: global_search.SearchScope) -> str:
    household_ids = ",".join(sorted(str(household.id) for household, _role in scope.households))
    property_id = str(scope.property.id) if scope.property is not None else ""
    return f"{household_ids}|{property_id}"


def _scope_households(scope: global_search.SearchScope) -> list[SearchHousehold]:
    return global_search.scope_households(scope)


def _scope_property(scope: global_search.SearchScope) -> SearchProperty | None:
    return global_search.scope_property(scope.property)


def _status_for_household(
    db: Session, household_id: uuid.UUID
) -> tuple[AiStatus, str]:
    """Reuse a configured search task, else the configured assistant task.

    This does not create or override settings; it only avoids demanding a
    separate search-provider assignment when the household already consented to
    an assistant model.
    """
    search_status = ai.status_for(db, household_id, AiTask.SEARCH.value, probe=False)
    if search_status.configured:
        return search_status, AiTask.SEARCH.value
    assistant_status = ai.status_for(
        db, household_id, AiTask.ASSISTANT.value, probe=False
    )
    if assistant_status.configured:
        return assistant_status, AiTask.ASSISTANT.value
    return search_status, AiTask.SEARCH.value


def _disabled_status(note: str | None = None) -> AiStatus:
    return AiStatus(
        provider="none",
        mode="disabled",
        model=None,
        configured=False,
        available=False,
        error=None,
        privacy_note=note
        or (
            "No configured AI provider is available for this scope. Direct "
            "inventory lookup and read-only deterministic retrieval still work."
        ),
    )


def _aggregate_status(
    db: Session, scope: global_search.SearchScope
) -> tuple[AiStatus, list[str]]:
    statuses: list[AiStatus] = []
    configured_labels: list[str] = []
    for household, _role in scope.households:
        status, _task = _status_for_household(db, household.id)
        statuses.append(status)
        if status.configured:
            configured_labels.append(household.name)
    if not statuses:
        return _disabled_status(), []
    configured = [status for status in statuses if status.configured]
    if not configured:
        return statuses[0], []
    first = configured[0]
    return first.model_copy(
        update={
            "available": False,
            "privacy_note": (
                "AI interpretation is executed per household using that household's "
                "own provider and consent. Configured for: "
                + ", ".join(configured_labels)
                + ". No records are sent through another household's provider."
            ),
        }
    ), configured_labels


def _bounded_history(history: list[Any]) -> list[Any]:
    return [
        message
        for message in history[-MAX_HISTORY_TURNS:]
        if getattr(message, "role", None) in {"user", "assistant"}
        and str(getattr(message, "content", "")).strip()
    ]


def _history_models(history: list[Any]) -> list[Any]:
    return _bounded_history(history)


def _scope_allowed_item_ids(
    db: Session, scope: global_search.SearchScope
) -> set[uuid.UUID]:
    allowed: set[uuid.UUID] = set()
    for household, _role in scope.households:
        conditions = [
            Item.household_id == household.id,
            Item.is_archived.is_(False),
        ]
        if scope.property is not None:
            conditions.append(
                or_(
                    Item.room.has(Room.property_id == scope.property.id),
                    Item.storage_location.has(
                        StorageLocation.room.has(Room.property_id == scope.property.id)
                    ),
                )
            )
        allowed.update(db.scalars(select(Item.id).where(*conditions)).all())
    return allowed


def _sanitise_context(
    db: Session,
    scope: global_search.SearchScope,
    context: SearchConversationContext | None,
) -> SearchConversationContext:
    if context is None:
        return SearchConversationContext(scope_key=_scope_key(scope))
    current_key = _scope_key(scope)
    if context.scope_key and context.scope_key != current_key:
        # A scope change must not carry candidate/loan context across a
        # household or property boundary. History is reset by the caller.
        return SearchConversationContext(scope_key=current_key)
    allowed = _scope_allowed_item_ids(db, scope)
    resolved = [ref for ref in context.resolved_items if ref.id in allowed][:6]
    candidates = [ref for ref in context.candidate_items if ref.id in allowed][:12]
    loans: list[SearchContextLoanRef] = []
    loan_ids = [ref.id for ref in context.loans][:12]
    if loan_ids:
        household_ids = [household.id for household, _role in scope.households]
        rows = db.scalars(
            select(Loan).where(
                Loan.household_id.in_(household_ids),
                Loan.id.in_(loan_ids),
            )
        ).all()
        item_ids = {
            loan.item_id for loan in rows if loan.item_id is not None and loan.item_id in allowed
        }
        for loan in rows:
            if loan.item_id is not None and loan.item_id not in item_ids:
                continue
            loans.append(
                SearchContextLoanRef(
                    id=loan.id,
                    item_id=loan.item_id,
                    item_name=loan.item_name_snapshot,
                    borrower_name=loan.borrower_name,
                )
            )
    memory: list[SearchContextMemoryEntry] = []
    if context.dialogue_memory:
        own_terms, foreign_terms = _partition_terms(db, scope)
        household_ids = {household.id for household, _role in scope.households}
        property_id = scope.property.id if scope.property is not None else None
        for entry in context.dialogue_memory[-24:]:
            if entry.household_id not in household_ids:
                continue
            if property_id is not None and entry.property_id != property_id:
                continue
            key = (entry.household_id, property_id)
            own = own_terms.get(key, set())
            foreign = foreign_terms.get(key, set())
            memory.append(
                SearchContextMemoryEntry(
                    household_id=entry.household_id,
                    property_id=entry.property_id,
                    user_intent=_redact_memory_text(
                        entry.user_intent,
                        foreign_terms=foreign,
                        own_terms=own,
                        limit=800,
                    )
                    or "Earlier request",
                    answer_meaning=(
                        _redact_memory_text(
                            entry.answer_meaning,
                            foreign_terms=foreign,
                            own_terms=own,
                            limit=1200,
                        )
                        if entry.answer_meaning
                        else None
                    ),
                )
            )
    return SearchConversationContext(
        scope_key=current_key,
        last_query=(context.last_query or "")[:2000] or None,
        resolved_items=resolved,
        candidate_items=candidates,
        loans=loans,
        dialogue_memory=memory,
    )


def _property_item_conditions(property_id: uuid.UUID | None) -> list[Any]:
    if property_id is None:
        return []
    return [
        or_(
            Item.room.has(Room.property_id == property_id),
            Item.storage_location.has(
                StorageLocation.room.has(Room.property_id == property_id)
            ),
        )
    ]


_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)


def _household_terms(
    db: Session,
    household_id: uuid.UUID,
    *,
    property_id: uuid.UUID | None = None,
) -> set[str]:
    item_conditions: list[Any] = [
        Item.household_id == household_id,
        Item.is_archived.is_(False),
    ]
    if property_id is not None:
        item_conditions.extend(_property_item_conditions(property_id))
    items = db.scalars(select(Item).where(*item_conditions)).all()
    terms: set[str] = set()
    for item in items:
        for value in (item.name, item.brand, item.model, item.serial_number):
            if value and len(value.strip()) >= 3:
                terms.add(value.strip())
    location_conditions: list[Any] = [
        StorageLocation.household_id == household_id,
        StorageLocation.active(),
    ]
    if property_id is not None:
        location_conditions.append(StorageLocation.room.has(Room.property_id == property_id))
    for location in db.scalars(select(StorageLocation).where(*location_conditions)).all():
        for value in [
            location.name,
            location.identifier,
            location.legacy_identifier,
            *(location.aliases or []),
        ]:
            cleaned = str(value).strip() if value else ""
            if len(cleaned) >= 3:
                terms.add(cleaned)
    document_conditions: list[Any] = [Document.household_id == household_id]
    if property_id is not None:
        item_ids = [item.id for item in items]
        if not item_ids:
            return terms
        document_conditions.append(Document.items.any(Item.id.in_(item_ids)))
    documents = db.scalars(select(Document).where(*document_conditions)).all()
    for document in documents:
        if document.title and len(document.title.strip()) >= 3:
            terms.add(document.title.strip())
    loan_conditions: list[Any] = [Loan.household_id == household_id]
    if property_id is not None:
        item_ids = [item.id for item in items]
        if not item_ids:
            return terms
        loan_conditions.append(Loan.item_id.in_(item_ids))
    for borrower in db.scalars(select(Loan.borrower_name).where(*loan_conditions)).all():
        if borrower and len(borrower.strip()) >= 3:
            terms.add(borrower.strip())
    return terms


def _partition_terms(
    db: Session,
    scope: global_search.SearchScope,
) -> tuple[
    dict[tuple[uuid.UUID, uuid.UUID | None], set[str]],
    dict[tuple[uuid.UUID, uuid.UUID | None], set[str]],
]:
    property_id = scope.property.id if scope.property is not None else None
    all_by_household = {
        household.id: _household_terms(db, household.id)
        for household, _role in scope.households
    }
    own_terms: dict[tuple[uuid.UUID, uuid.UUID | None], set[str]] = {}
    foreign_terms: dict[tuple[uuid.UUID, uuid.UUID | None], set[str]] = {}
    for household, _role in scope.households:
        key = (household.id, property_id)
        own = _household_terms(db, household.id, property_id=property_id)
        own_terms[key] = own
        foreign: set[str] = set()
        for other_id, other_terms in all_by_household.items():
            if other_id != household.id:
                foreign.update(other_terms)
        if property_id is not None:
            foreign.update(all_by_household[household.id] - own)
        foreign_terms[key] = foreign - own
    return own_terms, foreign_terms


def _redact_memory_text(
    text: str,
    *,
    foreign_terms: set[str],
    own_terms: set[str],
    limit: int,
) -> str:
    cleaned = _UUID_RE.sub("[id]", text.strip())
    own_lower = [term.casefold() for term in own_terms]
    for term in sorted(foreign_terms, key=len, reverse=True):
        lowered = term.casefold()
        if len(term) < 3:
            continue
        # Do not destroy a shared generic word that is already part of an
        # authorised label in this partition (e.g. a foreign "Drill" versus
        # this partition's "Heavy drill").
        if any(lowered in own for own in own_lower):
            continue
        cleaned = re.sub(re.escape(term), "[redacted]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:limit]


def _partition_answer_meaning(
    outcome: HouseholdOutcome | None,
    direct_items: list[ItemSummary],
    household_id: uuid.UUID,
) -> str | None:
    if outcome is not None:
        if outcome.answer:
            return " ".join(outcome.answer.split())[:1200]
        if outcome.result is not None:
            names = [item.name for item in outcome.result.items[:8]]
            if names:
                return "Matching records: " + ", ".join(names)
            return outcome.result.summary[:1200]
    names = [
        item.name
        for item in direct_items
        if item.household is not None and item.household.id == household_id
    ]
    if names:
        return "Direct matches: " + ", ".join(names[:8])
    return None


def _build_dialogue_memory(
    db: Session,
    scope: global_search.SearchScope,
    prior: SearchConversationContext,
    query: str,
    outcomes: list[HouseholdOutcome] | None,
    direct_items: list[ItemSummary],
) -> list[SearchContextMemoryEntry]:
    property_id = scope.property.id if scope.property is not None else None
    own_terms, foreign_terms = _partition_terms(db, scope)
    outcome_by_household = {
        outcome.household.id: outcome for outcome in (outcomes or [])
    }
    memory: list[SearchContextMemoryEntry] = []
    for household, _role in scope.households:
        key = (household.id, property_id)
        own = own_terms.get(key, set())
        foreign = foreign_terms.get(key, set())
        entries = [
            entry
            for entry in prior.dialogue_memory
            if entry.household_id == household.id
            and (property_id is None or entry.property_id == property_id)
        ]
        user_intent = _redact_memory_text(
            query,
            foreign_terms=foreign,
            own_terms=own,
            limit=800,
        ) or "Earlier request"
        meaning = _partition_answer_meaning(
            outcome_by_household.get(household.id), direct_items, household.id
        )
        answer_meaning = (
            _redact_memory_text(
                meaning,
                foreign_terms=foreign,
                own_terms=own,
                limit=1200,
            )
            if meaning
            else None
        )
        entry = SearchContextMemoryEntry(
            household_id=household.id,
            property_id=property_id,
            user_intent=user_intent,
            answer_meaning=answer_meaning,
        )
        if entries and entries[-1].user_intent == user_intent:
            entries[-1] = entry
        else:
            entries.append(entry)
        memory.extend(entries[-3:])
    return memory[-24:]


def _history_from_memory(
    context: SearchConversationContext,
) -> list[Any]:
    messages: list[Any] = []
    for entry in context.dialogue_memory:
        messages.append(SimpleNamespace(role="user", content=entry.user_intent))
        if entry.answer_meaning:
            messages.append(
                SimpleNamespace(role="assistant", content=entry.answer_meaning)
            )
    return messages[-8:]


def _answer_direction(query: str) -> str:
    rtl = 0
    ltr = 0
    for character in query:
        codepoint = ord(character)
        if (
            0x0590 <= codepoint <= 0x08FF
            or 0xFB1D <= codepoint <= 0xFDFF
            or 0xFE70 <= codepoint <= 0xFEFF
        ) and character.isalpha():
            rtl += 1
        elif character.isalpha() and codepoint < 128:
            ltr += 1
    if rtl > ltr:
        return "rtl"
    if ltr > 0:
        return "ltr"
    return "auto"


def _preserve_terms(
    items: list[ItemSummary],
    quick_results: list[QuickSearchResult],
    borrowed: list[BorrowedOut],
    facts: dict[str, Any],
    documents: list[dict[str, Any]],
    locations: list[dict[str, Any]],
) -> list[str]:
    terms: set[str] = set()
    for item in items:
        terms.add(item.name)
        if item.model:
            terms.add(item.model)
        if item.brand:
            terms.add(f"{item.brand} {item.model}".strip() if item.model else item.brand)
        path = [segment.name for segment in item.location_path]
        if item.room is not None:
            path.insert(0, item.room.name)
        if len(path) > 1:
            terms.add(" / ".join(path))
    whereabouts = facts.get("whereabouts")
    if isinstance(whereabouts, dict) and whereabouts.get("home_path"):
        terms.add(str(whereabouts["home_path"]))
    for result in quick_results:
        if result.kind != "item":
            terms.add(result.title)
        if result.context:
            terms.add(result.context)
    for record in borrowed:
        terms.add(record.item_name)
    for document in documents:
        title = str(document.get("title") or "").strip()
        if title:
            terms.add(title)
    for location in locations:
        name = str(location.get("name") or "").strip()
        if name:
            terms.add(name)
    cleaned = [
        term.strip()
        for term in terms
        if term and 2 <= len(term.strip()) <= 200 and "\n" not in term
    ]
    return sorted(dict.fromkeys(cleaned), key=len, reverse=True)[:40]


def _answer_metadata(
    query: str,
    *,
    items: list[ItemSummary],
    quick_results: list[QuickSearchResult],
    borrowed: list[BorrowedOut],
    facts: dict[str, Any],
    documents: list[dict[str, Any]],
    locations: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "answer_direction": _answer_direction(query),
        "preserve_terms": _preserve_terms(
            items, quick_results, borrowed, facts, documents, locations
        ),
    }


def _context_for_household(
    db: Session,
    household: Household,
    scope: global_search.SearchScope,
    context: SearchConversationContext,
) -> SearchConversationContext:
    """Build a provider input containing only this household/property context.

    Names and borrowers are re-read from authorised rows; client-supplied labels
    are never trusted. This runs before every provider planning and answer call.
    """
    property_id = scope.property.id if scope.property is not None else None
    ref_ids = {
        ref.id for ref in [*context.resolved_items, *context.candidate_items]
    }
    loan_ids = [ref.id for ref in context.loans]
    loan_rows: list[Loan] = []
    if loan_ids:
        loan_rows = list(
            db.scalars(
                select(Loan).where(
                    Loan.household_id == household.id,
                    Loan.id.in_(loan_ids[:12]),
                )
            ).all()
        )
        ref_ids.update(
            loan.item_id for loan in loan_rows if loan.item_id is not None
        )
    items = (
        list(
            db.scalars(
                select(Item).where(
                    Item.household_id == household.id,
                    Item.is_archived.is_(False),
                    Item.id.in_(ref_ids),
                    *_property_item_conditions(property_id),
                )
            ).all()
        )
        if ref_ids
        else []
    )
    item_by_id = {item.id: item for item in items}
    resolved_ids = {ref.id for ref in context.resolved_items}
    candidate_ids = {ref.id for ref in context.candidate_items}
    resolved = [
        SearchContextItemRef(id=item.id, name=item.name)
        for item in items
        if item.id in resolved_ids
    ][:6]
    candidates = [
        SearchContextItemRef(id=item.id, name=item.name)
        for item in items
        if item.id in candidate_ids
    ][:12]
    loans: list[SearchContextLoanRef] = []
    for loan in loan_rows:
        if loan.item_id is None or loan.item_id not in item_by_id:
            continue
        item = item_by_id[loan.item_id]
        loans.append(
            SearchContextLoanRef(
                id=loan.id,
                item_id=loan.item_id,
                item_name=item.name,
                borrower_name=loan.borrower_name,
            )
        )
    memory = [
        entry
        for entry in context.dialogue_memory
        if entry.household_id == household.id
        and (property_id is None or entry.property_id == property_id)
    ][-3:]
    return SearchConversationContext(
        scope_key=_scope_key(scope),
        last_query=None,
        resolved_items=resolved,
        candidate_items=candidates,
        loans=loans[:12],
        dialogue_memory=memory,
    )


def _raw_history_allowed(scope: global_search.SearchScope) -> bool:
    """Only a single household without a property filter is provably safe.

    In wider scopes, prior assistant prose can mix household/property facts with
    no sound provenance. Raw history is withheld and the validated per-household
    structured context is used instead; the current user question is still sent
    because the user authored it intentionally.
    """
    return len(scope.households) == 1 and scope.property is None


_CONTEXT_REFERENCE_WORDS = {
    # English
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "them",
    "they",
    "one",
    "another",
    "same",
    "previous",
    "earlier",
    "before",
    "former",
    "latter",
    "due",
    "returned",
    "return",
    "still",
    "current",
    "history",
    "loan",
    "loaned",
    "lent",
    "borrow",
    "borrowed",
    "borrower",
    "had",
    "has",
    "have",
    "more",
    "other",
    # Persian
    "این",
    "آن",
    "اون",
    "اونی",
    "همان",
    "همون",
    "همین",
    "دیگه",
    "دیگر",
    "قبلی",
    "قبلا",
    "قبل",
    "قرض",
    "امانت",
    "برگرد",
    "پس",
    "تحویل",
    "دست",
    "مهلت",
    "سررسید",
    "چند",
    "چقدر",
    "مدت",
    "سابقه",
    "داشت",
    "داشته",
    "دارد",
    "کی",
    # Arabic
    "هذا",
    "هذه",
    "ذلك",
    "تلك",
    "هو",
    "هي",
    "نفسه",
    "نفسها",
    "اخر",
    "آخر",
    "سابق",
    "اقرض",
    "أمانة",
    "امانة",
    "ارجع",
    "أرجع",
    "متى",
    "كم",
    "مدة",
    "تاريخ",
    "لديه",
    "لديها",
}

_CONTEXT_REFERENCE_PHRASES = (
    "which one",
    "the one",
    "same one",
    "how long",
    "how many",
    "which item",
    "that one",
    "this one",
    "یکی دیگه",
    "یکی دیگر",
    "همان یکی",
    "همون یکی",
    "چند تا",
    "چه مدت",
)


def _has_contextual_reference(query: str) -> bool:
    normalized = normalize_for_match(query)
    tokens = set(re.findall(r"[\w]+", normalized, flags=re.UNICODE))
    if tokens & _CONTEXT_REFERENCE_WORDS:
        return True
    return any(phrase in normalized for phrase in _CONTEXT_REFERENCE_PHRASES)


def _context_for_prompt(context: SearchConversationContext) -> dict[str, Any]:
    return context.model_dump(mode="json")


def _dedupe_items(items: list[ItemSummary]) -> list[ItemSummary]:
    seen: set[uuid.UUID] = set()
    output: list[ItemSummary] = []
    for item in items:
        if item.id in seen:
            continue
        seen.add(item.id)
        output.append(item)
    return output


def _dedupe_borrowed(records: list[BorrowedOut]) -> list[BorrowedOut]:
    seen: set[uuid.UUID] = set()
    output: list[BorrowedOut] = []
    for record in records:
        if record.id in seen:
            continue
        seen.add(record.id)
        output.append(record)
    return output


def _dedupe_references(
    references: list[AssistantReference],
) -> list[AssistantReference]:
    seen: set[tuple[str, uuid.UUID]] = set()
    output: list[AssistantReference] = []
    for reference in references:
        key = (reference.type, reference.id)
        if key in seen:
            continue
        seen.add(key)
        output.append(reference)
    return output


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
        _dedupe_items(items)[:limit],
        _dedupe_borrowed(borrowed)[:limit],
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
    items = _dedupe_items(
        [item for outcome in outcomes if outcome.result for item in outcome.result.items]
    )
    borrowed = _dedupe_borrowed(
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


def _context_from_outcomes(
    db: Session,
    scope: global_search.SearchScope,
    outcomes: list[HouseholdOutcome],
    prior_context: SearchConversationContext,
    query: str,
    *,
    direct_items: list[ItemSummary] | None = None,
) -> SearchConversationContext:
    items = _dedupe_items(
        [item for outcome in outcomes if outcome.result for item in outcome.result.items]
    )
    resolved = [
        SearchContextItemRef(id=item.id, name=item.name) for item in items[:4]
    ]
    candidates = [
        SearchContextItemRef(id=item.id, name=item.name) for item in items[:12]
    ]
    loans: list[SearchContextLoanRef] = []
    seen_loans: set[uuid.UUID] = set()
    for outcome in outcomes:
        if outcome.result is None:
            continue
        facts = outcome.result.facts
        whereabouts = facts.get("whereabouts")
        if isinstance(whereabouts, dict):
            item_id = whereabouts.get("item_id")
            for loan in whereabouts.get("loans") or []:
                try:
                    loan_id = uuid.UUID(str(loan.get("loan_id") or loan.get("id")))
                except (ValueError, TypeError):
                    continue
                if loan_id in seen_loans:
                    continue
                seen_loans.add(loan_id)
                loans.append(
                    SearchContextLoanRef(
                        id=loan_id,
                        item_id=(
                            uuid.UUID(str(item_id)) if item_id else None
                        ),
                        item_name=whereabouts.get("item_name"),
                        borrower_name=loan.get("borrower_name"),
                    )
                )
        for loan in facts.get("loans") or []:
            try:
                loan_id = uuid.UUID(str(loan.get("loan_id") or loan.get("id")))
            except (ValueError, TypeError):
                continue
            if loan_id in seen_loans:
                continue
            seen_loans.add(loan_id)
            item_id = loan.get("item_id")
            loans.append(
                SearchContextLoanRef(
                    id=loan_id,
                    item_id=uuid.UUID(str(item_id)) if item_id else None,
                    item_name=loan.get("item_name"),
                    borrower_name=loan.get("borrower_name"),
                )
            )
        for entry in facts.get("loan_history") or []:
            try:
                loan_id = uuid.UUID(str(entry.get("loan_id")))
            except (ValueError, TypeError):
                continue
            if loan_id in seen_loans:
                continue
            seen_loans.add(loan_id)
            item_id = entry.get("item_id")
            loans.append(
                SearchContextLoanRef(
                    id=loan_id,
                    item_id=uuid.UUID(str(item_id)) if item_id else None,
                    item_name=entry.get("item_name"),
                    borrower_name=entry.get("borrower_name"),
                )
            )
    return SearchConversationContext(
        scope_key=_scope_key(scope),
        last_query=query[:2000],
        resolved_items=resolved,
        candidate_items=candidates,
        loans=loans[:12],
        dialogue_memory=_build_dialogue_memory(
            db,
            scope,
            prior_context,
            query,
            outcomes,
            direct_items or [],
        ),
    )


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
            households=_scope_households(scope),
            property=_scope_property(scope),
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
        result_items = _dedupe_items(
            [
                item
                for outcome in deterministic_outcomes
                if outcome.result
                for item in outcome.result.items
            ]
        )
        result_borrowed = _dedupe_borrowed(
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
                references=_dedupe_references(
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
                households=_scope_households(scope),
                property=_scope_property(scope),
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
        fallback_items = _dedupe_items(
            [
                item
                for outcome in fallback_outcomes
                if outcome.result
                for item in outcome.result.items
            ]
        ) or direct_items
        fallback_borrowed = _dedupe_borrowed(
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
            references=_dedupe_references(
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
            households=_scope_households(scope),
            property=_scope_property(scope),
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
    result_items = _dedupe_items(
        [
            item
            for outcome in ai_outcomes
            if outcome.result
            for item in outcome.result.items
        ]
    ) or direct_items
    result_borrowed = _dedupe_borrowed(
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
        references=_dedupe_references(
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
        households=_scope_households(scope),
        property=_scope_property(scope),
    )
