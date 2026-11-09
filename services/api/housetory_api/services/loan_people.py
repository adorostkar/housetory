"""Household-scoped person-name suggestions from existing lending records.

Names are display values on loan and borrowed records. This module only
aggregates those stored names for autocomplete and filters; it never creates a
person, merges records, or rewrites a stored name.
"""

from __future__ import annotations

import unicodedata
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain import LoanStatus
from ..models import BorrowedRecord, Loan
from ..schemas.lending import LoanPersonListOut, LoanPersonOut
from .loan_status import OPEN_STATUSES

# Normalise common Arabic/Persian letter variants for comparison and duplicate
# detection only. The original display spelling is always preserved.
_ARABIC_PERSIAN_TRANSLATION = str.maketrans(
    {
        "\u064a": "\u06cc",  # Arabic yeh -> Persian yeh
        "\u0649": "\u06cc",  # alef maksura -> Persian yeh
        "\u0643": "\u06a9",  # Arabic kaf -> Persian kaf
        "\u0629": "\u0647",  # teh marbuta -> heh
        "\u06c0": "\u0647",
        "\u06d5": "\u0647",
        "\u0622": "\u0627",  # alef variants
        "\u0623": "\u0627",
        "\u0625": "\u0627",
        "\u0671": "\u0627",
    }
)
_DROPPED = {
    "\u200c",  # zero-width non-joiner
    "\u200d",  # zero-width joiner
    "\ufeff",
    "\u0640",  # tatweel
    *range(0x064B, 0x0660),  # Arabic diacritics
    0x0670,
    *range(0x06D6, 0x06EE),  # Quranic marks
}


def person_name_key(value: str | None) -> str:
    """A conservative comparison key; never used as the displayed name."""
    text = unicodedata.normalize("NFKC", value or "").strip().casefold()
    text = "".join(character for character in text if character not in _DROPPED)
    text = text.translate(_ARABIC_PERSIAN_TRANSLATION)
    return " ".join(text.split())


@dataclass
class _Person:
    names: Counter[str] = field(default_factory=Counter)
    latest_by_name: dict[str, date] = field(default_factory=dict)
    lent_open: int = 0
    borrowed_open: int = 0
    lent_total: int = 0
    borrowed_total: int = 0

    def add(
        self,
        name: str,
        on_date: date,
        *,
        direction: str,
        is_open: bool,
    ) -> None:
        self.names[name] += 1
        current = self.latest_by_name.get(name)
        if current is None or on_date > current:
            self.latest_by_name[name] = on_date
        if direction == "lent":
            self.lent_total += 1
            if is_open:
                self.lent_open += 1
        else:
            self.borrowed_total += 1
            if is_open:
                self.borrowed_open += 1

    @property
    def open_total(self) -> int:
        return self.lent_open + self.borrowed_open

    @property
    def total(self) -> int:
        return self.lent_total + self.borrowed_total

    @property
    def last_activity_on(self) -> date | None:
        return max(self.latest_by_name.values(), default=None)

    @property
    def display_name(self) -> str:
        if not self.latest_by_name:
            return next(iter(self.names), "")
        newest = max(self.latest_by_name.values())
        candidates = [
            name for name, latest in self.latest_by_name.items() if latest == newest
        ]
        candidates.sort(
            key=lambda name: (
                -self.names[name],
                person_name_key(name),
                name,
            )
        )
        return candidates[0]


def _household_people(db: Session, household_id: uuid.UUID) -> dict[str, _Person]:
    people: dict[str, _Person] = {}

    def add(name: str, on_date: date, *, direction: str, status: str) -> None:
        if status == LoanStatus.CANCELLED.value:
            return
        key = person_name_key(name)
        if not key:
            return
        person = people.setdefault(key, _Person())
        person.add(
            name,
            on_date,
            direction=direction,
            is_open=status in OPEN_STATUSES,
        )

    for name, status, lent_on in db.execute(
        select(Loan.borrower_name, Loan.status, Loan.lent_on).where(
            Loan.household_id == household_id
        )
    ).all():
        add(name, lent_on, direction="lent", status=status)
    for name, status, borrowed_on in db.execute(
        select(
            BorrowedRecord.owner_name,
            BorrowedRecord.status,
            BorrowedRecord.borrowed_on,
        ).where(BorrowedRecord.household_id == household_id)
    ).all():
        add(name, borrowed_on, direction="borrowed", status=status)
    return people


def suggest_people(
    db: Session,
    household_id: uuid.UUID,
    *,
    query: str | None = None,
    limit: int = 8,
) -> LoanPersonListOut:
    people = _household_people(db, household_id)
    query_key = person_name_key(query)
    if query_key:
        matches = [
            (key, person)
            for key, person in people.items()
            if key.startswith(query_key)
        ]
        if not matches:
            matches = [
                (key, person)
                for key, person in people.items()
                if query_key in key
            ]
    else:
        matches = list(people.items())

    def sort_key(entry: tuple[str, _Person]) -> tuple[object, ...]:
        key, person = entry
        activity = person.last_activity_on
        return (
            0 if key == query_key else 1,
            -person.open_total,
            -person.total,
            -(activity.toordinal() if activity else 0),
            key,
        )

    matches.sort(key=sort_key)
    total = len(matches)
    return LoanPersonListOut(
        items=[
            LoanPersonOut(
                name=person.display_name,
                lent_open=person.lent_open,
                borrowed_open=person.borrowed_open,
                lent_total=person.lent_total,
                borrowed_total=person.borrowed_total,
                last_activity_on=person.last_activity_on,
            )
            for _key, person in matches[:limit]
        ],
        total=total,
    )


def matching_person_names(
    db: Session,
    household_id: uuid.UUID,
    query: str | None,
    *,
    include_cancelled: bool = True,
) -> list[str]:
    """Resolve a typed person filter to exact stored display names."""
    query_key = person_name_key(query)
    if not query_key:
        return []
    names: set[str] = set()
    for table, column, status_column in (
        (Loan, Loan.borrower_name, Loan.status),
        (BorrowedRecord, BorrowedRecord.owner_name, BorrowedRecord.status),
    ):
        statement = select(column).where(table.household_id == household_id)
        if not include_cancelled:
            statement = statement.where(status_column != LoanStatus.CANCELLED.value)
        names.update(
            name
            for (name,) in db.execute(statement).all()
            if person_name_key(name)
        )
    exact = sorted(name for name in names if person_name_key(name) == query_key)
    if exact:
        return exact
    prefix = sorted(
        name for name in names if person_name_key(name).startswith(query_key)
    )
    if prefix:
        return prefix
    return sorted(
        name for name in names if query_key in person_name_key(name)
    )
