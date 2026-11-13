"""Canonical financial reconciliation for deterministic and AI invoice proposals."""

from __future__ import annotations

import re
from collections import defaultdict

from ..schemas.extraction import (
    ExtractionFields,
    ExtractionLine,
    FinancialCheck,
    FinancialComputedTotals,
    FinancialValidation,
)

_ZERO_DECIMAL_CURRENCIES = {"JPY"}


def _tolerance(currency: str | None) -> int:
    return 100 if currency in _ZERO_DECIMAL_CURRENCIES else 1


def _checks_from_source(source: str) -> list[FinancialCheck]:
    checks: list[FinancialCheck] = []
    for token in re.finditer(
        r"\b(?P<first>\d{1,2})[/. -](?P<second>\d{1,2})[/. -]20\d{2}\b", source
    ):
        first, second = int(token.group("first")), int(token.group("second"))
        if first != second and first <= 12 and second <= 12:
            checks.append(
                FinancialCheck(
                    code="ambiguous_date",
                    message=(
                        f"Date {token.group(0)} can be read in either day/month order; "
                        "confirm the purchase date."
                    ),
                )
            )
            break
    ambiguous_dollar = re.search(r"(?<![A-Z])\$(?![A-Z])", source, re.IGNORECASE) and not re.search(
        r"\b(?:USD|CAD|AUD)\b|(?:US|CA|A|AU)\$", source, re.IGNORECASE
    )
    ambiguous_yen = "¥" in source and not re.search(r"\bJPY\b", source, re.IGNORECASE)
    ambiguous_krona = re.search(r"\bkr\b", source, re.IGNORECASE) and not re.search(
        r"\b(?:SEK|NOK|DKK)\b", source, re.IGNORECASE
    )
    if ambiguous_dollar or ambiguous_yen or ambiguous_krona:
        checks.append(
            FinancialCheck(
                code="ambiguous_currency",
                message=(
                    "A currency symbol does not identify one currency; "
                    "confirm the invoice currency."
                ),
            )
        )
    return checks


def validate_invoice_financials(
    fields: ExtractionFields,
    lines: list[ExtractionLine],
    *,
    source: str = "",
) -> FinancialValidation:
    """Reconcile known amounts without filling missing values or changing source evidence."""
    checks = _checks_from_source(source)
    tolerance = _tolerance(fields.currency)
    products = [line for line in lines if line.kind == "product"]
    known_product_lines = [line for line in products if line.line_total_cents is not None]
    product_total = (
        sum(line.line_total_cents for line in known_product_lines) if known_product_lines else None
    )
    discount_lines = [line for line in lines if line.kind == "discount"]
    shipping_lines = [line for line in lines if line.kind == "shipping"]
    tax_lines = [line for line in lines if line.kind == "tax"]

    discount = fields.discount_cents
    if discount is None and any(line.line_total_cents is not None for line in discount_lines):
        discount = sum(
            abs(line.line_total_cents)
            for line in discount_lines
            if line.line_total_cents is not None
        )
    shipping = fields.shipping_cents
    if shipping is None and any(line.line_total_cents is not None for line in shipping_lines):
        shipping = sum(
            line.line_total_cents for line in shipping_lines if line.line_total_cents is not None
        )
    tax = fields.tax_cents
    if tax is None and any(line.line_total_cents is not None for line in tax_lines):
        tax = sum(line.line_total_cents for line in tax_lines if line.line_total_cents is not None)

    repeated: dict[str, list[ExtractionLine]] = defaultdict(list)
    for line in products:
        repeated[" ".join(line.description.casefold().split())].append(line)
    for same_description in repeated.values():
        if len(same_description) > 1:
            amounts = {
                (line.quantity, line.unit_price_cents, line.line_total_cents)
                for line in same_description
            }
            if len(amounts) > 1:
                checks.append(
                    FinancialCheck(
                        code="materially_distinct_repeated_lines",
                        message=(
                            f"Repeated item {same_description[0].description!r} has "
                            "different quantities or prices; review each source line separately."
                        ),
                        line_ids=[line.id for line in same_description],
                    )
                )

    for line in products:
        if line.line_total_cents is None:
            checks.append(
                FinancialCheck(
                    code="unreadable_line_amount",
                    message=(
                        f"No readable amount was found for {line.description!r}; "
                        "enter or verify it before applying this line."
                    ),
                    line_ids=[line.id],
                )
            )
        if (
            line.quantity is not None
            and line.unit_price_cents is not None
            and line.line_total_cents is not None
            and abs(line.quantity * line.unit_price_cents - line.line_total_cents) > tolerance
        ):
            checks.append(
                FinancialCheck(
                    code="line_extension_mismatch",
                    severity="error",
                    message=(
                        f"{line.description!r}: quantity × unit price does not equal "
                        "the evidenced line total."
                    ),
                    line_ids=[line.id],
                )
            )

    expected_total = None
    total_difference = None
    tax_treatment = "unknown"
    if product_total is not None:
        base_without_tax = product_total - (discount or 0) + (shipping or 0)
        candidates: dict[str, int] = {"inclusive": base_without_tax}
        if tax is not None:
            candidates["exclusive"] = base_without_tax + tax
        subtotal = fields.subtotal_cents
        if subtotal is not None:
            possible_subtotals = {product_total, product_total - (discount or 0)}
            if not any(abs(subtotal - candidate) <= tolerance for candidate in possible_subtotals):
                checks.append(
                    FinancialCheck(
                        code="subtotal_mismatch",
                        severity="error",
                        message=(
                            "Invoice subtotal does not match the product lines before or "
                            "after the evidenced discount."
                        ),
                        line_ids=[line.id for line in products],
                    )
                )

        if fields.total_cents is None:
            checks.append(
                FinancialCheck(
                    code="total_missing",
                    message="No supported invoice total was found; confirm the total manually.",
                )
            )
        else:
            matches = {
                treatment: value
                for treatment, value in candidates.items()
                if abs(fields.total_cents - value) <= tolerance
            }
            if len(matches) == 1:
                matched_treatment, expected_total = next(iter(matches.items()))
                tax_treatment = matched_treatment if tax is not None else "unknown"
                total_difference = fields.total_cents - expected_total
            elif len(matches) > 1:
                expected_total = fields.total_cents
                total_difference = 0
            else:
                expected_total = (
                    candidates.get("exclusive") if tax is not None else base_without_tax
                )
                total_difference = fields.total_cents - expected_total
                checks.append(
                    FinancialCheck(
                        code="total_mismatch",
                        severity="error",
                        message=(
                            f"Invoice total differs from the known product, discount, "
                            f"shipping and tax amounts by {total_difference} cents. "
                            "Check for omitted or unreadable lines."
                        ),
                        line_ids=[line.id for line in lines if line.line_total_cents is not None],
                    )
                )
    else:
        checks.append(
            FinancialCheck(
                code="product_total_unavailable",
                message="Product line totals are insufficient to reconcile the invoice.",
            )
        )

    # Keep one copy if the same source warning was already added by another caller.
    checks = list({(check.code, tuple(check.line_ids)): check for check in checks}.values())
    if checks:
        status = "needs_attention"
    elif product_total is None or fields.total_cents is None:
        status = "insufficient_evidence"
    else:
        status = "consistent"

    return FinancialValidation(
        status=status,
        tax_treatment=tax_treatment,
        computed=FinancialComputedTotals(
            product_total_cents=product_total,
            discount_cents=discount,
            shipping_cents=shipping,
            tax_cents=tax,
            expected_total_cents=expected_total,
            total_difference_cents=total_difference,
        ),
        checks=checks,
    )
