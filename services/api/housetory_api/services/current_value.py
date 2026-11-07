"""Current-value basis helpers.

Stored values are integer minor currency units, following the existing money
convention. New values are per owned unit. Historical values that predate the
basis column are treated as a legacy record total: their amount is reported once
and is never multiplied by quantity.
"""

from __future__ import annotations

from ..api.errors import ApiError
from ..models import Item

PER_UNIT = "per_unit"
LEGACY_RECORD_TOTAL = "legacy_record_total"
VALID_BASES = frozenset({PER_UNIT, LEGACY_RECORD_TOTAL})
MAX_VALUE_CENTS = 10**12
# JSON/JavaScript consumers must be able to represent an extended total exactly.
MAX_TOTAL_CENTS = 9_007_199_254_740_991


def effective_basis(item: Item) -> str | None:
    if item.current_value_cents is None:
        return None
    # A value without a basis can only have come from pre-basis data or a direct
    # database write. Treat it as a legacy total rather than multiplying it.
    return item.current_value_basis or LEGACY_RECORD_TOTAL


def unit_value_cents(item: Item) -> int | None:
    return item.current_value_cents if effective_basis(item) == PER_UNIT else None


def legacy_total_cents(item: Item) -> int | None:
    return item.current_value_cents if effective_basis(item) == LEGACY_RECORD_TOTAL else None


def owned_quantity(item: Item) -> int:
    # Item.quantity is the owned quantity. Loaned owned units remain included;
    # borrowed-from-others records live in a separate table and never enter here.
    return max(item.quantity, 0)


def total_value_cents(item: Item) -> int | None:
    value = item.current_value_cents
    basis = effective_basis(item)
    if value is None or basis is None:
        return None
    if basis == PER_UNIT:
        return value * owned_quantity(item)
    return value


def validate_current_value(value_cents: int | None, quantity: int, basis: str | None) -> None:
    if value_cents is None:
        return
    if value_cents < 0 or value_cents > MAX_VALUE_CENTS:
        raise ApiError(
            422,
            "invalid_current_value",
            "Current value must be between 0 and 1,000,000,000,000 minor units.",
        )
    if basis is not None and basis not in VALID_BASES:
        raise ApiError(422, "invalid_current_value_basis", "Unsupported current-value basis.")
    if basis == PER_UNIT and value_cents * max(quantity, 0) > MAX_TOTAL_CENTS:
        raise ApiError(
            422,
            "current_value_total_too_large",
            "Current value per unit multiplied by owned quantity is too large to "
            "represent safely. Reduce the value or quantity.",
        )
