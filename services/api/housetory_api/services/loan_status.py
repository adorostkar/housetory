"""Loan status rules shared by lent and borrowed records."""

from __future__ import annotations

from ..domain import LoanStatus

OPEN_STATUSES = {
    LoanStatus.OUTSTANDING.value,
    LoanStatus.PARTIALLY_RETURNED.value,
}


def status_for(quantity: int, returned: int, *, cancelled: bool = False) -> str:
    if cancelled:
        return LoanStatus.CANCELLED.value
    if returned <= 0:
        return LoanStatus.OUTSTANDING.value
    if returned >= quantity:
        return LoanStatus.RETURNED.value
    return LoanStatus.PARTIALLY_RETURNED.value
