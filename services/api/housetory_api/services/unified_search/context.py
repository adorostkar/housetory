"""Conversation context sanitising and dialogue memory for unified search."""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...models import Document, Household, Item, Loan, Room, StorageLocation
from ...schemas.ai import (
    SearchContextItemRef,
    SearchContextLoanRef,
    SearchContextMemoryEntry,
    SearchContextPageReference,
    SearchConversationContext,
    SearchPageReference,
)
from ...schemas.borrowed import BorrowedOut
from ...schemas.items import ItemSummary
from ...schemas.search import QuickSearchResult
from .. import global_search
from ..ai_tools.inventory_query import property_item_conditions
from ..ai_tools.references import dedupe_by_id
from ..query_text import (
    normalize_for_match,
    text_contains_term,
)
from .scope import HouseholdOutcome, _scope_key

MAX_HISTORY_TURNS = 8


def _resolve_page_references(
    db: Session,
    scope: global_search.SearchScope,
    references: list[SearchPageReference],
) -> list[SearchContextPageReference]:
    household_ids = [household.id for household, _role in scope.households]
    property_id = scope.property.id if scope.property is not None else None
    resolved: list[SearchContextPageReference] = []
    seen: set[tuple[str, uuid.UUID]] = set()
    for ref in references:
        key = (ref.kind, ref.id)
        if key in seen:
            continue
        seen.add(key)
        if ref.kind == "item":
            conditions = [
                Item.id == ref.id,
                Item.household_id.in_(household_ids),
                Item.is_archived.is_(False),
                *property_item_conditions(property_id),
            ]
            row = db.scalar(select(Item).where(*conditions))
            label = row.name if row else None
        elif ref.kind == "room":
            conditions = [Room.id == ref.id, Room.household_id.in_(household_ids)]
            if property_id is not None:
                conditions.append(Room.property_id == property_id)
            row = db.scalar(select(Room).where(*conditions))
            label = row.name if row else None
        elif ref.kind == "location":
            conditions = [
                StorageLocation.id == ref.id,
                StorageLocation.household_id.in_(household_ids),
                StorageLocation.active(),
            ]
            if property_id is not None:
                conditions.append(StorageLocation.room.has(Room.property_id == property_id))
            row = db.scalar(select(StorageLocation).where(*conditions))
            label = row.name if row else None
        else:
            conditions = [Document.id == ref.id, Document.household_id.in_(household_ids)]
            if property_id is not None:
                conditions.append(
                    Document.items.any(
                        or_(
                            Item.room.has(Room.property_id == property_id),
                            Item.storage_location.has(
                                StorageLocation.room.has(Room.property_id == property_id)
                            ),
                        )
                    )
                )
            row = db.scalar(select(Document).where(*conditions))
            label = row.title if row else None
        if row is None or label is None:
            raise ApiError(
                404,
                "page_context_unavailable",
                "The current page or selection is unavailable in this search scope.",
            )
        resolved.append(
            SearchContextPageReference(
                kind=ref.kind,
                id=ref.id,
                name=label,
                household_id=row.household_id,
            )
        )
    return resolved


def _page_reference_requested(query: str) -> bool:
    tokens = set(re.findall(r"[\w]+", normalize_for_match(query), flags=re.UNICODE))
    return bool(
        tokens
        & {
            "it",
            "its",
            "this",
            "that",
            "these",
            "those",
            "them",
            "they",
            "این",
            "آن",
            "اون",
            "اونی",
            "همین",
            "همون",
            "همان",
            "اینها",
            "آنها",
        }
    )


def _plural_page_reference_requested(query: str) -> bool:
    tokens = set(re.findall(r"[\w]+", normalize_for_match(query), flags=re.UNICODE))
    return bool(tokens & {"these", "those", "them", "they", "اینها", "آنها"})


def _explicit_other_target(
    db: Session,
    scope: global_search.SearchScope,
    query: str,
    current_ids: set[uuid.UUID],
) -> bool:
    household_ids = [household.id for household, _role in scope.households]
    property_id = scope.property.id if scope.property is not None else None
    item_rows = db.execute(
        select(Item.id, Item.name).where(
            Item.household_id.in_(household_ids),
            Item.is_archived.is_(False),
            *property_item_conditions(property_id),
        )
    ).all()
    room_conditions = [Room.household_id.in_(household_ids)]
    location_conditions = [
        StorageLocation.household_id.in_(household_ids),
        StorageLocation.active(),
    ]
    document_conditions = [Document.household_id.in_(household_ids)]
    if property_id is not None:
        room_conditions.append(Room.property_id == property_id)
        location_conditions.append(StorageLocation.room.has(Room.property_id == property_id))
        document_conditions.append(
            Document.items.any(
                or_(
                    Item.room.has(Room.property_id == property_id),
                    Item.storage_location.has(
                        StorageLocation.room.has(Room.property_id == property_id)
                    ),
                )
            )
        )
    rows = [
        *item_rows,
        *db.execute(select(Room.id, Room.name).where(*room_conditions)).all(),
        *db.execute(
            select(StorageLocation.id, StorageLocation.name).where(*location_conditions)
        ).all(),
        *db.execute(select(Document.id, Document.title).where(*document_conditions)).all(),
    ]
    return any(
        id not in current_ids and len(name.strip()) >= 3 and text_contains_term(query, name)
        for id, name in rows
    )


def _bounded_history(history: list[Any]) -> list[Any]:
    return [
        message
        for message in history[-MAX_HISTORY_TURNS:]
        if getattr(message, "role", None) in {"user", "assistant"}
        and str(getattr(message, "content", "")).strip()
    ]


def _history_models(history: list[Any]) -> list[Any]:
    return _bounded_history(history)


def _scope_allowed_item_ids(db: Session, scope: global_search.SearchScope) -> set[uuid.UUID]:
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
        item_conditions.extend(property_item_conditions(property_id))
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
        household.id: _household_terms(db, household.id) for household, _role in scope.households
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
    outcome_by_household = {outcome.household.id: outcome for outcome in (outcomes or [])}
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
        user_intent = (
            _redact_memory_text(
                query,
                foreign_terms=foreign,
                own_terms=own,
                limit=800,
            )
            or "Earlier request"
        )
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
            messages.append(SimpleNamespace(role="assistant", content=entry.answer_meaning))
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
    ref_ids = {ref.id for ref in [*context.resolved_items, *context.candidate_items]}
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
        ref_ids.update(loan.item_id for loan in loan_rows if loan.item_id is not None)
    items = (
        list(
            db.scalars(
                select(Item).where(
                    Item.household_id == household.id,
                    Item.is_archived.is_(False),
                    Item.id.in_(ref_ids),
                    *property_item_conditions(property_id),
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
        page_references=[
            ref for ref in context.page_references if ref.household_id == household.id
        ],
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


def _context_from_outcomes(
    db: Session,
    scope: global_search.SearchScope,
    outcomes: list[HouseholdOutcome],
    prior_context: SearchConversationContext,
    query: str,
    *,
    direct_items: list[ItemSummary] | None = None,
) -> SearchConversationContext:
    items = dedupe_by_id(
        [item for outcome in outcomes if outcome.result for item in outcome.result.items]
    )
    resolved = [SearchContextItemRef(id=item.id, name=item.name) for item in items[:4]]
    candidates = [SearchContextItemRef(id=item.id, name=item.name) for item in items[:12]]
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
                        item_id=(uuid.UUID(str(item_id)) if item_id else None),
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
