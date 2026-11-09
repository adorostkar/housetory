"""Tool result type and shared item, location and loan reference formatting."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from ...models import (
    Item,
)
from ...schemas.ai import AssistantReference
from ...schemas.borrowed import BorrowedOut
from ...schemas.items import ItemSummary
from ...services.serializers import (
    item_summary,
)
from .. import borrowed as borrowed_service
from ..container_serializers import location_path_map
from ..containers import (
    location_ancestors,
    room_ancestors,
)
from ..lending import loan_quantities_for_items


@dataclass
class ToolResult:
    tool: str
    summary: str
    filters: dict[str, Any] = field(default_factory=dict)
    items: list[ItemSummary] = field(default_factory=list)
    borrowed: list[BorrowedOut] = field(default_factory=list)
    documents: list[dict[str, Any]] = field(default_factory=list)
    locations: list[dict[str, Any]] = field(default_factory=list)
    references: list[AssistantReference] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)


def _summaries_with_paths(
    db: Session,
    household_id: uuid.UUID,
    items: list[Item],
    *,
    household_reminder_days: int,
) -> list[ItemSummary]:
    paths = location_path_map(db, household_id)
    loan_quantities = loan_quantities_for_items(db, household_id, [item.id for item in items])
    summaries = []
    for item in items:
        summary = item_summary(
            item,
            household_reminder_days=household_reminder_days,
            on_loan_quantity=loan_quantities.get(item.id, 0),
        )
        if item.storage_location_id:
            summary = summary.model_copy(
                update={"location_path": paths.get(item.storage_location_id, [])}
            )
        summaries.append(summary)
    return summaries


def _location_display(location: Any) -> str:
    identifier = getattr(location, "identifier", None)
    name = getattr(location, "name", "")
    if identifier and identifier != name:
        return f"{identifier} · {name}"
    return identifier or name


def _item_reference(item: ItemSummary | Item) -> AssistantReference:
    if isinstance(item, Item):
        property_name = (
            item.room.property.name
            if item.room is not None and item.room.property is not None
            else None
        )
        room_name = getattr(item.room, "name", None)
        household = item.household
    else:
        property_name = item.property.name if item.property else None
        room_name = item.room.name if item.room else None
        household = item.household
    subtitle = " / ".join(part for part in (property_name, room_name) if part) or None
    return AssistantReference(
        type="item",
        id=item.id,
        title=item.name,
        subtitle=subtitle,
        url=f"/items/{item.id}",
        household_id=household.id if household is not None else None,
        household_name=household.name if household is not None else None,
    )


def _borrowed_reference(record: BorrowedOut) -> AssistantReference:
    place = _borrowed_place(record)
    subtitle = (
        f"{record.physically_held_quantity} held"
        if borrowed_service.has_held_stock(record)
        else "returned"
        if record.status == "returned"
        else "cancelled"
    )
    if place:
        subtitle += f" · {borrowed_service.location_prefix(record)} {place}"
    if record.due_on:
        subtitle += f" · due {_human_date(record.due_on)}"
    return AssistantReference(
        type="borrowed",
        id=record.id,
        title=f"{record.item_name} borrowed from {record.owner_name}",
        subtitle=subtitle,
        url=f"/borrowed/{record.id}",
    )


def borrowed_storage_label(record: BorrowedOut) -> str | None:
    return (
        f"{record.storage_location_identifier} · {record.storage_location_name}"
        if record.storage_location_identifier
        and record.storage_location_name
        and record.storage_location_identifier != record.storage_location_name
        else record.storage_location_identifier or record.storage_location_name
    )


def _borrowed_place(record: BorrowedOut) -> str | None:
    parts = [record.property_name, record.room_name, borrowed_storage_label(record)]
    filtered = [part for part in parts if part]
    return " / ".join(filtered) if filtered else None


def _borrowed_label(record: BorrowedOut) -> str:
    place = _borrowed_place(record)
    due = f", due {_human_date(record.due_on)}" if record.due_on else ""
    return (
        f"{record.item_name} — belongs to {record.owner_name}, "
        f"{borrowed_service.location_prefix(record)} "
        f"{place or 'no place recorded'}{due} · "
        f"{record.outstanding_quantity} outstanding"
    )


def _home_path(db: Session, household_id: uuid.UUID, item: Item) -> str | None:
    room_records = room_ancestors(db, household_id, item.room_id) if item.room_id else []
    property_name = (
        room_records[0].property.name
        if room_records and room_records[0].property is not None
        else None
    )
    room_parts = [room.name for room in room_records]
    location_parts = (
        [
            _location_display(location)
            for location in location_ancestors(db, household_id, item.storage_location_id)
        ]
        if item.storage_location_id
        else []
    )
    parts = [property_name] if property_name else []
    if room_parts:
        parts.append(" → ".join(room_parts))
    if location_parts:
        parts.append(" → ".join(location_parts))
    return " → ".join(parts) if parts else None


def _human_date(value: Any) -> str:
    if hasattr(value, "day") and hasattr(value, "strftime"):
        return f"{value.day} {value.strftime('%b %Y')}"
    return str(value)


def _item_display_name(item: Item) -> str:
    if item.brand and item.brand.lower() not in item.name.lower():
        return f"{item.brand} {item.name}"
    return item.name


def _join_natural(parts: list[str]) -> str:
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return f"{', '.join(parts[:-1])}, and {parts[-1]}"


def _borrower_breakdown(loans: list[Any]) -> str:
    grouped: dict[str, list[Any]] = {}
    for loan in loans:
        grouped.setdefault(loan.borrower_name, []).append(loan)
    pieces: list[str] = []
    for borrower, borrower_loans in grouped.items():
        quantity = sum(loan.outstanding_quantity for loan in borrower_loans)
        due = ""
        if len(borrower_loans) == 1 and borrower_loans[0].due_on is not None:
            due = f" (due {_human_date(borrower_loans[0].due_on)})"
        pieces.append(f"{borrower} has {quantity}{due}")
    return _join_natural(pieces)


def _whereabouts_summary(
    *,
    item: Item,
    owned: int,
    on_loan: int,
    at_home: int,
    home: str | None,
    open_loans: list[Any],
) -> str:
    display = _item_display_name(item)
    if on_loan <= 0:
        if home:
            return f"Your {display} is recorded at home in {home}. No open loan is recorded."
        return f"Your {display} has no open loan. No home location is recorded."

    if len(open_loans) == 1 and at_home == 0:
        loan = open_loans[0]
        date_sentence = (
            f"Due {_human_date(loan.due_on)}."
            if loan.due_on is not None
            else "No return date is set."
        )
        home_sentence = (
            f"You normally keep it in {home}." if home else "No home location is recorded."
        )
        return f"{loan.borrower_name} has your {display}. {date_sentence} {home_sentence}"

    if len(open_loans) == 1:
        loan = open_loans[0]
        first = f"{loan.borrower_name} has {on_loan} of your {owned} units of {display}."
        if loan.due_on is not None:
            first += f" Due {_human_date(loan.due_on)}."
        else:
            first += " No return date is set."
        if home:
            return (
                f"{first} The other {at_home} {'is' if at_home == 1 else 'are'} at home in {home}."
            )
        return f"{first} No home location is recorded for the other {at_home}."

    breakdown = _borrower_breakdown(open_loans)
    if at_home == 0:
        return f"All {owned} of your units of {display} are on loan: {breakdown}."
    if home:
        return (
            f"{on_loan} of your {owned} units of {display} are on loan: {breakdown}. "
            f"The other {at_home} {'is' if at_home == 1 else 'are'} at home in {home}."
        )
    return (
        f"{on_loan} of your {owned} units of {display} are on loan: {breakdown}. "
        f"No home location is recorded for the other {at_home}."
    )


def dedupe_by_id(records: Iterable[Any]) -> list[Any]:
    seen: set[uuid.UUID] = set()
    output: list[Any] = []
    for record in records:
        if record.id in seen:
            continue
        seen.add(record.id)
        output.append(record)
    return output


def dedupe_references(references: Iterable[AssistantReference]) -> list[AssistantReference]:
    seen: set[tuple[str, uuid.UUID]] = set()
    output: list[AssistantReference] = []
    for reference in references:
        key = (reference.type, reference.id)
        if key in seen:
            continue
        seen.add(key)
        output.append(reference)
    return output
