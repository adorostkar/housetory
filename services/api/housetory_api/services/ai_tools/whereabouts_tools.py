"""Item location, lending and borrowing tools."""

import contextlib
import uuid
from datetime import date
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ...models import (
    Item,
    Loan,
    LoanReturn,
    Room,
    StorageLocation,
)
from ...schemas.ai import AssistantReference
from ...services.query_text import (
    clean_subject,
    item_words,
    normalize_for_match,
    normalize_label,
)
from ...services.serializers import (
    item_load_options,
    item_summary,
)
from .. import borrowed as borrowed_service
from ..items import get_item
from ..lending import item_loan_summary, list_loans
from .inventory_query import property_item_conditions
from .references import (
    ToolResult,
    _borrowed_label,
    _borrowed_reference,
    _home_path,
    _item_reference,
    _summaries_with_paths,
    _whereabouts_summary,
)


def tool_list_borrowed_items(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    del household_reminder_days
    today = date.today()
    result = borrowed_service.list_records(
        db,
        household_id,
        status="open",
        property_id=args.get("property_id"),
        on_date=today,
        limit=50,
        offset=0,
    )
    records = result.items
    if not records:
        summary = "No items are currently recorded as borrowed from others."
    else:
        summary = (
            f"{result.open_count} borrowed record(s), {result.outstanding_quantity} "
            f"unit(s) held here and {result.returned_quantity} unit(s) returned so far"
            f"{f', {result.overdue_count} past due' if result.overdue_count else ''}. "
            "These are owned by other people and are not part of household stock."
        )
    references = [_borrowed_reference(record) for record in records]
    return ToolResult(
        tool="list_borrowed_items",
        summary=summary,
        borrowed=records,
        references=references,
        facts={
            "total": result.total,
            "open_count": result.open_count,
            "overdue_count": result.overdue_count,
            "borrowed_quantity": result.total_borrowed_quantity,
            "borrowed_outstanding_quantity": result.outstanding_quantity,
            "borrowed_returned_quantity": result.returned_quantity,
            "borrowed_physically_held_quantity": result.physically_held_quantity,
            "borrowed": [record.model_dump(mode="json") for record in records],
        },
    )


def tool_find_borrowed_owner(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    del household_reminder_days
    raw = str(args.get("q") or args.get("item_name") or "").strip()
    subject = clean_subject(raw) or raw
    borrowed_matches = (
        borrowed_service.matching_records(
            db,
            household_id,
            q=subject,
            limit=20,
            property_id=args.get("property_id"),
        )
        if subject
        else []
    )
    owned_matches = (
        borrowed_service.find_owned_items_matching(db, household_id, subject, limit=5)
        if subject
        else []
    )
    filters = {"q": subject} if subject else {}
    if borrowed_matches:
        lines = [_borrowed_label(record) for record in borrowed_matches[:8]]
        summary = (
            f"I found {len(borrowed_matches)} borrowed record(s) matching "
            f"“{subject}”: " + "; ".join(lines) + "."
        )
        if owned_matches:
            summary += (
                " The household also owns item record(s) with a similar name; "
                "those are separate from the borrowed goods."
            )
    elif owned_matches:
        names = ", ".join(item.name for item in owned_matches)
        summary = (
            f"{names} is recorded as household-owned inventory. No borrowed record "
            "lists another owner for that item."
        )
    else:
        summary = (
            f"I couldn't find an owned item or borrowed record matching "
            f"“{subject or 'that item'}” in this household."
        )
    references = [_borrowed_reference(record) for record in borrowed_matches]
    owned_summaries = [item_summary(item, household_reminder_days=0) for item in owned_matches]
    references.extend(_item_reference(item) for item in owned_summaries)
    return ToolResult(
        tool="find_borrowed_owner",
        summary=summary,
        filters=filters,
        items=owned_summaries,
        borrowed=borrowed_matches,
        references=references,
        facts={
            "total": len(borrowed_matches) + len(owned_matches),
            "borrowed_total": len(borrowed_matches),
            "owned_item_total": len(owned_matches),
            "borrowed": [record.model_dump(mode="json") for record in borrowed_matches],
            "owned_items": [item.model_dump(mode="json") for item in owned_summaries],
        },
    )


def tool_list_outstanding_loans(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    today = date.today()
    result = list_loans(
        db,
        household_id,
        status="open",
        on_date=today,
        limit=50,
        offset=0,
    )
    property_id = args.get("property_id")
    property_item_ids: set[uuid.UUID] | None = None
    if property_id is not None:
        property_item_ids = set(
            db.scalars(
                select(Item.id).where(
                    Item.household_id == household_id,
                    or_(
                        Item.room.has(Room.property_id == property_id),
                        Item.storage_location.has(
                            StorageLocation.room.has(Room.property_id == property_id)
                        ),
                    ),
                )
            ).all()
        )
        result.items = [loan for loan in result.items if loan.item_id in property_item_ids]
        result.outstanding_count = sum(1 for loan in result.items if loan.outstanding_quantity > 0)
        result.on_loan_quantity = sum(loan.outstanding_quantity for loan in result.items)
        result.overdue_count = sum(1 for loan in result.items if loan.overdue)
    item_ids = [loan.item_id for loan in result.items if loan.item_id]
    items = (
        list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    Item.household_id == household_id,
                    Item.id.in_(item_ids),
                )
            ).all()
        )
        if item_ids
        else []
    )
    summaries = _summaries_with_paths(
        db, household_id, items, household_reminder_days=household_reminder_days
    )
    item_name_by_id = {item.id: item.name for item in summaries}
    facts_loans = [
        {
            "loan_id": str(loan.id),
            "item_id": str(loan.item_id) if loan.item_id else None,
            "item_name": item_name_by_id.get(loan.item_id) if loan.item_id else loan.item_name,
            "borrower_name": loan.borrower_name,
            "quantity": loan.outstanding_quantity,
            "lent_on": loan.lent_on.isoformat(),
            "due_on": loan.due_on.isoformat() if loan.due_on else None,
            "overdue": loan.overdue,
            "status": loan.status,
        }
        for loan in result.items
    ]
    if not result.items:
        summary = "No items are currently recorded as on loan."
    else:
        summary = (
            f"{result.outstanding_count} open loan(s), "
            f"{result.on_loan_quantity} unit(s) on loan"
            f"{', ' + str(result.overdue_count) + ' past due' if result.overdue_count else ''}."
        )
    references = [_item_reference(item) for item in summaries]
    return ToolResult(
        tool="list_outstanding_loans",
        summary=summary,
        items=summaries,
        references=references,
        facts={
            "outstanding_count": result.outstanding_count,
            "overdue_count": result.overdue_count,
            "on_loan_quantity": result.on_loan_quantity,
            "loans": facts_loans,
        },
    )


def _locate_candidates(
    db: Session,
    household_id: uuid.UUID,
    subject: str,
    *,
    property_id: uuid.UUID | None = None,
) -> list[Item]:
    cleaned = clean_subject(subject) or subject.strip()
    if not cleaned:
        return []
    property_conditions = []
    if property_id is not None:
        property_conditions.append(
            or_(
                Item.room.has(Room.property_id == property_id),
                Item.storage_location.has(
                    StorageLocation.room.has(Room.property_id == property_id)
                ),
            )
        )
    exact = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                *property_conditions,
                func.lower(Item.name) == cleaned.lower(),
            )
            .limit(12)
        ).all()
    )
    if exact:
        return exact
    # Normalised exact match catches ZWNJ, Persian/Arabic letter variants and
    # Arabic-Indic digits without changing the stored name.
    target = normalize_label(cleaned)
    exact_candidates = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(
            Item.household_id == household_id,
            Item.is_archived.is_(False),
            *property_conditions,
        )
        .order_by(func.lower(Item.name))
        .limit(400)
    ).all()
    normalized_exact = [
        item for item in exact_candidates if normalize_label(item.name) == target
    ]
    if normalized_exact:
        return normalized_exact[:12]

    tokens = item_words(cleaned)
    if not tokens:
        return []
    token_conditions = [
        or_(
            Item.name.ilike(f"%{token}%"),
            Item.brand.ilike(f"%{token}%"),
            Item.model.ilike(f"%{token}%"),
        )
        for token in tokens
    ]
    matches = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(
                Item.household_id == household_id,
                Item.is_archived.is_(False),
                *property_conditions,
                and_(*token_conditions),
            )
            .order_by(func.lower(Item.name))
            .limit(12)
        ).all()
    )
    if matches:
        return matches
    # Python fallback for any script/spelling the SQL collation did not fold.
    normalized_tokens = tokens
    fuzzy = []
    for item in exact_candidates:
        labels = [item.name, item.brand or "", item.model or "", item.description or ""]
        normalized_labels = normalize_for_match(" ".join(labels))
        if all(token in normalized_labels for token in normalized_tokens):
            fuzzy.append(item)
    return fuzzy[:12]


def tool_locate_item(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    query = str(args.get("q") or args.get("item_name") or "").strip()
    item_id = args.get("item_id")
    property_id = args.get("property_id")
    if item_id:
        item = get_item(db, household_id, uuid.UUID(str(item_id)))
        if property_id is not None:
            property_rooms = {
                row[0]
                for row in db.execute(
                    select(Room.id).where(
                        Room.household_id == household_id,
                        Room.property_id == property_id,
                    )
                ).all()
            }
            candidates = [] if item.room_id not in property_rooms else [item]
        else:
            candidates = [item]
    elif args.get("item_ids"):
        requested_ids: list[uuid.UUID] = []
        for raw_id in args.get("item_ids") or []:
            try:
                requested_ids.append(uuid.UUID(str(raw_id)))
            except (ValueError, TypeError):
                continue
        candidates = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    Item.household_id == household_id,
                    Item.is_archived.is_(False),
                    Item.id.in_(requested_ids[:12]),
                    *property_item_conditions(property_id),
                )
                .order_by(func.lower(Item.name))
            ).all()
        )
        if not candidates:
            candidates = _locate_candidates(
                db, household_id, query, property_id=property_id
            )
    else:
        candidates = _locate_candidates(
            db, household_id, query, property_id=args.get("property_id")
        )
    borrowed_matches = (
        borrowed_service.matching_records(
            db,
            household_id,
            q=query,
            limit=8,
            property_id=args.get("property_id"),
        )
        if query
        else []
    )
    if not candidates:
        if borrowed_matches:
            summary = (
                f"I didn't find an owned item matching “{query}”, but this is recorded "
                "as borrowed: "
                + "; ".join(_borrowed_label(record) for record in borrowed_matches[:8])
                + ". Borrowed goods are kept here but owned by someone else."
            )
            return ToolResult(
                tool="locate_item",
                summary=summary,
                filters={"q": query},
                borrowed=borrowed_matches,
                references=[_borrowed_reference(record) for record in borrowed_matches],
                facts={
                    "total": 0,
                    "ambiguous": False,
                    "whereabouts": None,
                    "borrowed_total": len(borrowed_matches),
                    "borrowed": [record.model_dump(mode="json") for record in borrowed_matches],
                },
            )
        return ToolResult(
            tool="locate_item",
            summary=(
                f"I couldn't find an item matching “{query or 'that description'}” "
                "in this household, including borrowed records."
                if query
                else "Tell me the item name to look up its recorded whereabouts."
            ),
            filters={"q": query} if query else {},
            facts={"total": 0, "ambiguous": False, "whereabouts": None},
        )
    candidates = sorted(candidates, key=lambda item: item.name.lower())
    summaries = _summaries_with_paths(
        db, household_id, candidates, household_reminder_days=household_reminder_days
    )
    if len(candidates) > 1:
        names = ", ".join(
            f"{item.name} ({item.property.name + ' / ' if item.property else ''}"
            f"{item.room.name if item.room else 'No room'})"
            for item in summaries[:6]
        )
        summary = (
            f"I found {len(candidates)} owned items that could match “{query}”: {names}. "
            "Which one did you mean?"
        )
        if borrowed_matches:
            summary += (
                " Borrowed records also match and are listed separately: "
                + "; ".join(_borrowed_label(record) for record in borrowed_matches[:4])
                + "."
            )
        return ToolResult(
            tool="locate_item",
            summary=summary,
            filters={"q": query},
            items=summaries,
            borrowed=borrowed_matches,
            references=[_item_reference(item) for item in summaries]
            + [_borrowed_reference(record) for record in borrowed_matches],
            facts={
                "total": len(candidates),
                "ambiguous": True,
                "whereabouts": None,
                "borrowed_total": len(borrowed_matches),
            },
        )

    item = candidates[0]
    loan_summary = item_loan_summary(db, household_id, item.id)
    home = _home_path(db, household_id, item)
    owned = loan_summary.owned_quantity
    on_loan = loan_summary.on_loan_quantity
    at_home = loan_summary.available_quantity
    open_loans = [loan for loan in loan_summary.loans if loan.outstanding_quantity > 0]
    loan_facts = [
        {
            "loan_id": str(loan.id),
            "borrower_name": loan.borrower_name,
            "outstanding_quantity": loan.outstanding_quantity,
            "due_on": loan.due_on.isoformat() if loan.due_on else None,
            "overdue": loan.overdue,
        }
        for loan in open_loans
    ]
    summary = _whereabouts_summary(
        item=item,
        owned=owned,
        on_loan=on_loan,
        at_home=at_home,
        home=home,
        open_loans=open_loans,
    )
    if borrowed_matches:
        summary += (
            " Separately, these borrowed records also match: "
            + "; ".join(_borrowed_label(record) for record in borrowed_matches[:4])
            + ". Borrowed goods are not owned stock."
        )
    references = [_item_reference(item)]
    references.extend(
        AssistantReference(
            type="loan",
            id=loan.id,
            title=f"{item.name} loan to {loan.borrower_name}",
            subtitle=(
                f"{loan.outstanding_quantity} on loan"
                + (f" · due {loan.due_on.isoformat()}" if loan.due_on else "")
            ),
            url=f"/loans/{loan.id}",
        )
        for loan in open_loans
    )
    references.extend(_borrowed_reference(record) for record in borrowed_matches)
    return ToolResult(
        tool="locate_item",
        summary=summary,
        filters={"q": query} if query else {},
        items=summaries,
        borrowed=borrowed_matches,
        references=references,
        facts={
            "total": 1,
            "ambiguous": False,
            "borrowed_total": len(borrowed_matches),
            "whereabouts": {
                "item_id": str(item.id),
                "item_name": item.name,
                "owned_quantity": owned,
                "on_loan_quantity": on_loan,
                "at_home_quantity": at_home,
                "home_path": home,
                "loans": loan_facts,
            },
        },
    )


def tool_get_loan_history(
    db: Session,
    household_id: uuid.UUID,
    args: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    """Historical loan rows, including returned loans and completed durations.

    Mutable facts are always read fresh. A returned loan is never reported as
    still with the borrower, and no damage/loss causality is inferred.
    """
    subject = clean_subject(str(args.get("q") or args.get("item_name") or ""))
    property_id = args.get("property_id")
    requested_ids: list[uuid.UUID] = []
    for raw_id in args.get("item_ids") or []:
        try:
            requested_ids.append(uuid.UUID(str(raw_id)))
        except (ValueError, TypeError):
            continue
    if args.get("item_id"):
        with contextlib.suppress(ValueError, TypeError):
            requested_ids.append(uuid.UUID(str(args["item_id"])))

    items: list[Item] = []
    if requested_ids:
        items = list(
            db.scalars(
                select(Item)
                .options(*item_load_options())
                .where(
                    Item.household_id == household_id,
                    Item.is_archived.is_(False),
                    Item.id.in_(requested_ids[:12]),
                    *property_item_conditions(property_id),
                )
                .order_by(func.lower(Item.name))
            ).all()
        )
    if not items and subject:
        items = _locate_candidates(db, household_id, subject, property_id=property_id)
    if not items:
        return ToolResult(
            tool="get_loan_history",
            summary=(
                f"I couldn't find an owned item matching “{subject or 'that description'}” "
                "to check its loan history."
                if subject
                else "Tell me which item to check for past or current loans."
            ),
            filters={"q": subject} if subject else {},
            facts={"total": 0, "ambiguous": False, "loan_history": []},
        )

    item_ids = [item.id for item in items]
    loans = list(
        db.scalars(
            select(Loan)
            .where(
                Loan.household_id == household_id,
                Loan.item_id.in_(item_ids),
                Loan.status != "cancelled",
            )
            .order_by(Loan.lent_on.desc(), Loan.created_at.desc())
            .limit(100)
        ).all()
    )
    borrower_filter = normalize_for_match(str(args.get("borrower_name") or ""))
    if borrower_filter:
        loans = [
            loan
            for loan in loans
            if borrower_filter in normalize_for_match(loan.borrower_name)
        ]

    item_by_id = {item.id: item for item in items}
    returns_by_loan: dict[uuid.UUID, list[Any]] = {}
    if loans:
        returns = db.scalars(
            select(LoanReturn)
            .where(
                LoanReturn.household_id == household_id,
                LoanReturn.loan_id.in_([loan.id for loan in loans]),
                LoanReturn.reversed_at.is_(None),
            )
            .order_by(LoanReturn.returned_on.asc(), LoanReturn.created_at.asc())
        ).all()
        for record in returns:
            returns_by_loan.setdefault(record.loan_id, []).append(record)

    today = date.today()
    history: list[dict[str, Any]] = []
    for loan in loans:
        returned_records = returns_by_loan.get(loan.id, [])
        latest_return = returned_records[-1].returned_on if returned_records else None
        is_open = loan.status in {"outstanding", "partially_returned"}
        end_date = None if is_open else latest_return
        duration_days = (
            max(0, (end_date - loan.lent_on).days)
            if end_date is not None
            else (max(0, (today - loan.lent_on).days) if is_open else None)
        )
        item = item_by_id.get(loan.item_id) if loan.item_id else None
        history.append(
            {
                "loan_id": str(loan.id),
                "item_id": str(loan.item_id) if loan.item_id else None,
                "item_name": item.name if item is not None else loan.item_name_snapshot,
                "borrower_name": loan.borrower_name,
                "quantity": loan.quantity,
                "outstanding_quantity": (
                    max(0, loan.quantity - loan.returned_quantity) if is_open else 0
                ),
                "status": loan.status,
                "lent_on": loan.lent_on.isoformat(),
                "returned_on": (
                None
                if is_open
                else (latest_return.isoformat() if latest_return else None)
            ),
                "due_on": loan.due_on.isoformat() if loan.due_on else None,
                "open": is_open,
                "duration_days": duration_days,
            }
        )

    distinct_items = {entry["item_id"] for entry in history if entry["item_id"]}
    ambiguous = (
        len(items) > 1
        or len(distinct_items) > 1
        or (len(history) > 1 and not borrower_filter)
        or (bool(borrower_filter) and len(history) > 1)
    )
    if not history:
        borrower_text = (
            f" with borrower “{args.get('borrower_name')}”" if borrower_filter else ""
        )
        summary = (
            f"No loan history{borrower_text} was found for "
            f"{', '.join(item.name for item in items[:6])}."
        )
    elif ambiguous:
        pieces = []
        for entry in history[:10]:
            state = (
                f"currently with {entry['borrower_name']} for {entry['duration_days']} days"
                if entry["open"]
                else (
                    f"{entry['borrower_name']} had it for {entry['duration_days']} days"
                    + (
                        f" and returned it on {entry['returned_on']}"
                        if entry["returned_on"]
                        else ""
                    )
                )
            )
            pieces.append(f"{entry['item_name']}: {state} (loan {entry['loan_id'][:8]})")
        summary = (
            "Several matching loans need clarification: "
            + "; ".join(pieces)
            + ". Which item or loan did you mean?"
        )
    else:
        entry = history[0]
        if entry["open"]:
            summary = (
                f"{entry['borrower_name']} has had {entry['item_name']} since "
                f"{entry['lent_on']} ({entry['duration_days']} days so far)"
                + (f", due {entry['due_on']}." if entry["due_on"] else ".")
            )
        else:
            duration_text = (
                f"for {entry['duration_days']} days"
                if entry["duration_days"] is not None
                else "for an unrecorded duration"
            )
            summary = (
                f"{entry['borrower_name']} had {entry['item_name']} since "
                f"{entry['lent_on']} {duration_text}"
                + (
                    f" and returned it on {entry['returned_on']}."
                    if entry["returned_on"]
                    else "; the return date was not recorded."
                )
                + " It is not currently with them."
            )

    summaries = _summaries_with_paths(
        db, household_id, items[:12], household_reminder_days=household_reminder_days
    )
    references = [_item_reference(summary) for summary in summaries]
    references.extend(
        AssistantReference(
            type="loan",
            id=uuid.UUID(entry["loan_id"]),
            title=f"{entry['item_name']} loan to {entry['borrower_name']}",
            subtitle=(
                f"{entry['status']} · "
                + (
                    f"{entry['duration_days']} days"
                    if entry["duration_days"] is not None
                    else "duration not recorded"
                )
                + (f" · due {entry['due_on']}" if entry["due_on"] else "")
            ),
            url=f"/loans/{entry['loan_id']}",
        )
        for entry in history[:12]
    )
    return ToolResult(
        tool="get_loan_history",
        summary=summary,
        filters={
            "q": subject or None,
            "borrower_name": args.get("borrower_name"),
            "item_ids": [str(item.id) for item in items],
        },
        items=summaries,
        references=references,
        facts={
            "total": len(history),
            "ambiguous": ambiguous,
            "loan_history": history,
            "candidates": [
                {"id": str(item.id), "name": item.name} for item in items[:12]
            ],
        },
    )
