"""Warranty date and status helpers.

Warranty durations are expressed in calendar months. The expiration date is the
same day of the month ``duration_months`` later, clamped to the last valid day
(for example, 31 January + 1 month becomes 28/29 February). Both the duration
and the resulting end date are stored so the record remains understandable if
the calculation rules are ever revisited.
"""

import calendar
from datetime import date, timedelta

from ..domain import WarrantyStatus


def add_months(start: date, months: int) -> date:
    if months < 0:
        raise ValueError("months must not be negative")
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def resolve_end_date(
    *, start_date: date | None, duration_months: int | None, end_date: date | None
) -> date | None:
    if duration_months is not None and start_date is not None:
        return add_months(start_date, duration_months)
    return end_date


def effective_reminder_days(
    warranty_reminder_days: int | None, household_reminder_days: int
) -> int:
    return warranty_reminder_days or household_reminder_days


def warranty_status(
    end_date: date | None,
    *,
    reminder_days: int,
    today: date | None = None,
) -> tuple[WarrantyStatus, int | None]:
    if end_date is None:
        return WarrantyStatus.UNKNOWN, None
    reference = today or date.today()
    days_remaining = (end_date - reference).days
    if days_remaining < 0:
        return WarrantyStatus.EXPIRED, days_remaining
    if days_remaining <= reminder_days:
        return WarrantyStatus.EXPIRING, days_remaining
    return WarrantyStatus.ACTIVE, days_remaining


def expiry_window(reminder_days: int, today: date | None = None) -> tuple[date, date]:
    reference = today or date.today()
    return reference, reference + timedelta(days=reminder_days)
