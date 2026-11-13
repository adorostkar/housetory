"""Deterministic receipt/document extraction and review proposals.

The parser is intentionally conservative. It records source lines, keeps ambiguous
money/date/currency evidence visible and never invents missing values. Matching is
handled separately so deterministic extraction remains usable when no AI provider
is configured.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain import AiTask
from ..models import Document, DocumentExtractionApply
from ..schemas.extraction import (
    DuplicateDocumentBrief,
    ExtractionApplySummary,
    ExtractionFields,
    ExtractionLine,
    ExtractionReviewOut,
    LineMatchInput,
    SourceEvidence,
)
from . import ai
from .invoice_validation import validate_invoice_financials
from .ocr import (
    CURRENCY_SYMBOLS,
    DATE_PATTERNS,
    ISO_CURRENCIES,
    MONEY_RE,
    MONTHS,
    _parse_brand_model,
    _parse_date,
    _parse_invoice_number,
    _parse_merchant,
    _parse_serials,
    _parse_warranty_fields,
)

EXTRACTION_VERSION = "2026-11-13.1"
MAX_LINES = 50

NON_PRODUCT_WORDS = {
    "subtotal",
    "sub total",
    "total",
    "amount due",
    "balance due",
    "tax",
    "sales tax",
    "gst",
    "vat",
    "hst",
    "discount",
    "promo",
    "coupon",
    "savings",
    "shipping",
    "delivery",
    "freight",
    "handling",
    "change",
    "cash back",
    "payment",
    "paid",
    "visa",
    "mastercard",
    "amex",
    "card",
    "cash",
    "debit",
    "credit",
    "tip",
    "gratuity",
    "invoice",
    "receipt",
    "order",
    "thank you",
    "welcome",
    "cashier",
    "server",
    "phone",
    "tel",
    "address",
    "www.",
    "http",
    "kvitto",
    "datum",
    "butik",
    "moms",
    "brutto",
    "netto",
    "antal artiklar",
    "du sparar",
    "you saved",
    "kund registrerad",
    "köp",
    "kop ",
    "godkänt",
    "godkant",
    "contactless",
    "swedbank",
    "terminal",
    "period",
    "ref:",
    "resp:",
}

PAYMENT_WORDS = {
    "payment",
    "paid",
    "visa",
    "mastercard",
    "amex",
    "card",
    "cash",
    "debit",
    "credit",
}
TAX_WORDS = {"tax", "sales tax", "gst", "vat", "hst", "moms"}
DISCOUNT_WORDS = {"discount", "promo", "coupon", "savings", "markdown", "rabatt"}
SHIPPING_WORDS = {"shipping", "delivery", "freight", "handling"}
QTY_RE = re.compile(r"\b(?P<qty>\d{1,4})\s*(?:x|×|@)\s*", re.IGNORECASE)
QTY_PREFIX_RE = re.compile(r"^\s*(?:qty|quantity)\s*[:#-]?\s*(?P<qty>\d{1,4})\b", re.IGNORECASE)
GROUPED_MONEY_RE = re.compile(
    r"(?P<currency>US\$|CA\$|AU\$|C\$|A\$|[$€£¥₹]|"
    r"(?<![A-Za-z])(?:SEK|NOK|DKK|EUR|USD|GBP|CHF)(?![A-Za-z]))?\s*"
    r"(?P<amount>\d{1,3}(?:[.,]\d{3})+[.,]\d{2})"
)
SPACE_DECIMAL_MONEY_RE = re.compile(
    r"(?P<currency>US\$|CA\$|AU\$|C\$|A\$|[$€£¥₹]|"
    r"(?<![A-Za-z])(?:SEK|NOK|DKK|EUR|USD|GBP|CHF)(?![A-Za-z]))?\s*"
    r"(?P<amount>\d{1,3}(?: \d{3})* \d{2})$"
)


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value.lower()).strip()


def _money_matches(line: str) -> list[tuple[int, str | None, int, bool]]:
    matches: list[tuple[int, str | None, int, bool]] = []
    grouped_matches = list(GROUPED_MONEY_RE.finditer(line))
    space_decimal_matches = list(SPACE_DECIMAL_MONEY_RE.finditer(line))
    special_matches = grouped_matches + space_decimal_matches
    for match in [*special_matches, *MONEY_RE.finditer(line)]:
        if match not in special_matches and any(
            match.start() < special.end() and match.end() > special.start()
            for special in special_matches
        ):
            continue
        amount = _financial_amount(match.group("amount"))
        if amount is None:
            continue
        prefix = line[max(0, match.start() - 3) : match.start()]
        suffix = line[match.end() : match.end() + 2]
        negative = (
            "-" in prefix
            or suffix.lstrip().startswith("-")
            or (line[max(0, match.start() - 1) : match.start()] == "(" and ")" in suffix)
        )
        matches.append(
            (
                amount,
                CURRENCY_SYMBOLS.get(match.group("currency") or ""),
                match.start(),
                negative,
            )
        )
    return matches


def _financial_amount(raw: str) -> int | None:
    value = raw.strip()
    if " " in value and "," not in value and "." not in value:
        whole, fraction = value.rsplit(" ", 1)
        if len(fraction) == 2 and whole.replace(" ", "").isdigit():
            value = f"{whole.replace(' ', '')}.{fraction}"
    value = value.replace(" ", "")
    if "," in value and "." in value:
        decimal_separator = "," if value.rfind(",") > value.rfind(".") else "."
        grouping_separator = "." if decimal_separator == "," else ","
        value = value.replace(grouping_separator, "")
        value = value.replace(decimal_separator, ".")
    elif "," in value or "." in value:
        separator = "," if "," in value else "."
        whole, fraction = value.rsplit(separator, 1)
        if len(fraction) == 2:
            value = f"{whole.replace(',', '').replace('.', '')}.{fraction}"
        elif len(fraction) == 3 and len(whole.replace(",", "").replace(".", "")) <= 3:
            value = whole.replace(",", "").replace(".", "") + fraction
        else:
            return None
    try:
        cents = int((Decimal(value) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return None
    return cents if cents >= 0 else None


def _line_kind(line: str) -> str:
    lowered = _normalized(line)
    if "subtotal" in lowered or "sub total" in lowered:
        return "other"
    if "change" in lowered or "cash back" in lowered:
        return "change"
    if re.fullmatch(r"(sek|nok|dkk|eur|usd|gbp|kr)\s*[\d.,\s]+", lowered.strip()):
        return "payment"
    if any(word in lowered for word in DISCOUNT_WORDS):
        return "discount"
    if any(word in lowered for word in TAX_WORDS):
        return "tax"
    if any(word in lowered for word in SHIPPING_WORDS):
        return "shipping"
    if any(word in lowered for word in PAYMENT_WORDS):
        return "payment"
    if any(word in lowered for word in NON_PRODUCT_WORDS):
        return "other"
    return "product"


def _line_description(line: str, matches: list[tuple[int, str | None, int, bool]]) -> str:
    description = line
    for _amount, _currency, start, _negative in reversed(matches):
        end = start
        while end < len(description) and (
            description[end].isdigit() or description[end] in "., $€£¥₹"
        ):
            end += 1
        description = description[:start] + description[end:]
    description = QTY_RE.sub(" ", description)
    description = QTY_PREFIX_RE.sub(" ", description)
    description = re.sub(
        r"\b(?:serial(?:\s*(?:no\.?|number))?|s/n|sn|imei)\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{3,}\b",
        " ",
        description,
        flags=re.I,
    )
    description = re.sub(r"\b(?:qty|quantity)\s*[:#-]?\s*\d+\b", " ", description, flags=re.I)
    # Retail receipts lead each line with a VAT flag and article number: `b 10-1-272 Name`.
    description = re.sub(r"^\s*[A-Za-z]?\s+\d[\d-]{3,}\s+", "", description)
    description = re.sub(r"\s+", " ", description).strip(" -:•·|*")
    return description[:300]


def _page_spans(text: str, metadata: dict[str, Any]) -> list[tuple[int, int, int]]:
    spans: list[tuple[int, int, int]] = []
    cursor = 0
    pages = metadata.get("ocr_pages")
    if not isinstance(pages, list):
        return spans
    for entry in pages[:40]:
        if not isinstance(entry, dict):
            continue
        page = entry.get("page")
        page_text = entry.get("text")
        if not isinstance(page, int) or page < 1 or not isinstance(page_text, str) or not page_text:
            continue
        page_text = page_text.strip()
        if not page_text:
            continue
        start = text.find(page_text, cursor)
        if start < 0:
            continue
        end = start + len(page_text)
        spans.append((start, end, page))
        cursor = end
    return spans


def _source_lines(text: str, metadata: dict[str, Any]) -> list[tuple[int, str, int | None]]:
    page_spans = _page_spans(text, metadata)
    lines: list[tuple[int, str, int | None]] = []
    offset = 0
    for line_number, raw_line in enumerate(text.splitlines(keepends=True), start=1):
        line = raw_line.strip()
        if line:
            line_start = offset + len(raw_line) - len(raw_line.lstrip())
            page = next(
                (page for start, end, page in page_spans if start <= line_start < end),
                None,
            )
            lines.append((line_number, line, page))
        offset += len(raw_line)
    return lines


def page_number_for_evidence(text: str, metadata: dict[str, Any], evidence: str) -> int | None:
    start = text.find(evidence)
    if start < 0:
        return None
    return next(
        (
            page
            for page_start, end, page in _page_spans(text, metadata)
            if page_start <= start < end
        ),
        None,
    )


def _parse_line(
    line: str,
    line_number: int,
    product_index: int,
    document_id,
    version: str,
    page_number: int | None = None,
):
    lowered = _normalized(line)
    kind = _line_kind(line)
    amounts = _money_matches(line)
    if kind == "product":
        if not amounts:
            quantity_match = QTY_RE.search(line) or QTY_PREFIX_RE.search(line)
            if quantity_match is None:
                return None
        quantity_match = QTY_RE.search(line) or QTY_PREFIX_RE.search(line)
        quantity = int(quantity_match.group("qty")) if quantity_match else 1
        description = _line_description(line, amounts)
        if len(description) < 2 or not re.search(r"[A-Za-z]{2,}", description):
            return None
        if any(word in lowered for word in NON_PRODUCT_WORDS):
            return None
    else:
        if not amounts:
            return None
        quantity = None
        description = _line_description(line, amounts) or line.strip()
        if not description:
            description = kind.title()

    warnings: list[str] = []
    unit_price: int | None = None
    line_total: int | None = None
    if amounts:
        line_total = -abs(amounts[-1][0]) if amounts[-1][3] else abs(amounts[-1][0])
        if len(amounts) >= 2:
            unit_price = -abs(amounts[-2][0]) if amounts[-2][3] else abs(amounts[-2][0])
        elif quantity and quantity > 1 and QTY_RE.search(line):
            unit_price = line_total
            line_total *= quantity
            warnings.append(
                "The line amount follows an explicit quantity × marker and was "
                "treated as unit price."
            )
        elif quantity == 1:
            unit_price = line_total
        if kind == "product" and quantity and quantity > 1 and unit_price is None:
            warnings.append(
                "Quantity is present but the unit price is not explicit; "
                "the recorded line total was kept."
            )
        if (
            kind == "product"
            and quantity
            and unit_price is not None
            and abs(unit_price * quantity - (line_total or 0)) > 1
        ):
            warnings.append(
                "Quantity × unit price does not match the line total; review the amount."
            )
    else:
        warnings.append("No monetary amount was found on this line.")

    line_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"housetory-extraction:{document_id}:{version}:{line_number}:{line}",
        )
    )
    return ExtractionLine(
        id=line_id,
        line_number=line_number,
        kind=kind,
        description=description,
        quantity=quantity,
        unit_price_cents=unit_price,
        line_total_cents=line_total,
        evidence=SourceEvidence(
            page=page_number,
            line_number=line_number,
            text=line[:1000],
        ),
        warnings=warnings,
        purchase_eligible=kind == "product",
    )


def _named_amount(
    lines: list[tuple[int, str, int | None]], names: tuple[str, ...]
) -> tuple[int | None, str]:
    candidates: list[tuple[int, str]] = []
    for _line_number, line, _page in reversed(lines):
        lowered = _normalized(line)
        if not any(name in lowered for name in names):
            continue
        if "total" in names and "subtotal" in lowered.replace("sub total", "subtotal"):
            continue
        amounts = _money_matches(line)
        if not amounts:
            continue
        # A VAT table row (gross, VAT, net) is a last resort and uses its gross amount.
        if len(amounts) >= 3:
            candidates.append((1, f"{amounts[0][0]}\0{line}"))
        else:
            candidates.append((0, f"{amounts[-1][0]}\0{line}"))
    if not candidates:
        return None, ""
    _rank, packed = min(candidates, key=lambda candidate: candidate[0])
    value, line = packed.split("\0", 1)
    amount = int(value)
    matched = _money_matches(line)
    if matched and matched[-1][3]:
        amount = -amount
    return amount, line


def _all_dates(text: str) -> list[date]:
    found: list[date] = []
    tokens = set()
    for pattern in DATE_PATTERNS:
        for match in pattern.finditer(text):
            tokens.add(match.group(0))
    for match in re.finditer(
        r"\b(" + "|".join(MONTHS) + r")\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b",
        text,
        re.IGNORECASE,
    ):
        tokens.add(match.group(0))
    for token in tokens:
        parsed = _parse_date(token)
        if parsed:
            value = date.fromisoformat(parsed)
            if value not in found:
                found.append(value)
    return found


def _all_currencies(text: str) -> list[str]:
    found: list[str] = []
    for code in ISO_CURRENCIES:
        if re.search(rf"\b{code}\b", text):
            found.append(code)
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in text and code not in found:
            found.append(code)
    return found


def build_extraction(
    document: Document,
    text: str,
    metadata: dict[str, Any],
    *,
    source_artifact: str,
) -> dict[str, Any]:
    version = hashlib.sha256(
        f"{EXTRACTION_VERSION}\0{document.document_type}\0{text}".encode()
    ).hexdigest()[:24]
    raw_lines = _source_lines(text, metadata)
    fields = ExtractionFields()
    warnings: list[str] = []
    uncertain: list[str] = []
    sources: dict[str, str] = {}

    merchant = metadata.get("merchant") or _parse_merchant([line for _n, line, _p in raw_lines])
    if merchant:
        fields.merchant = str(merchant)[:160]
        sources["merchant"] = "Extracted from the document header."
    else:
        uncertain.append("merchant")

    purchase_date = metadata.get("purchase_date") or _parse_date(text)
    if purchase_date:
        fields.purchase_date = date.fromisoformat(str(purchase_date))
        sources["purchase_date"] = "Extracted from a date line."
    else:
        uncertain.append("purchase_date")
    dates = _all_dates(text)
    if len(dates) > 1:
        warnings.append(
            "Multiple dates were found ("
            + ", ".join(value.isoformat() for value in dates[:4])
            + "). Verify which date belongs to this purchase/document."
        )
        uncertain.extend(["purchase_date", "document_date"])

    total_line = ""
    total_cents, total_line = _named_amount(
        raw_lines,
        ("grand total", "amount due", "total due", "att betala", "totalt", "summa", "total"),
    )
    if total_cents is None and metadata.get("total_cents") is not None:
        total_cents = int(metadata["total_cents"])
    if total_cents is not None:
        fields.total_cents = total_cents
        if total_line:
            sources["total_cents"] = total_line[:500]
    else:
        uncertain.append("total_cents")

    subtotal_cents, subtotal_line = _named_amount(raw_lines, ("subtotal", "sub total"))
    if subtotal_cents is not None:
        fields.subtotal_cents = subtotal_cents
        sources["subtotal_cents"] = subtotal_line[:500]

    line_items: list[ExtractionLine] = []
    for line_number, line, page_number in raw_lines:
        item = _parse_line(
            line,
            line_number,
            len(line_items),
            document.id,
            version,
            page_number,
        )
        if item is not None:
            line_items.append(item)
            if len(line_items) >= MAX_LINES:
                warnings.append(f"Only the first {MAX_LINES} source lines were extracted.")
                break

    if document.document_type not in {"receipt", "invoice"} and not any(
        line.kind == "product" for line in line_items
    ):
        description = " ".join(value for value in [fields.brand, fields.model] if value).strip()
        if not description and fields.serial_numbers:
            description = fields.serial_numbers[0]
        if not description:
            description = document.title
        line_items.append(
            ExtractionLine(
                id=str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"housetory-extraction:{document.id}:{version}:document-evidence",
                    )
                ),
                line_number=1,
                kind="product",
                description=description[:300],
                quantity=1,
                unit_price_cents=None,
                line_total_cents=None,
                evidence=SourceEvidence(
                    page=None,
                    line_number=None,
                    text="Document-level brand/model/serial evidence; no priced product line.",
                ),
                warnings=[
                    "No priced product line was extracted. Use this as item evidence only; "
                    "purchase recording is disabled for this document type."
                ],
                purchase_eligible=False,
            )
        )

    tax_cents: int | None = None
    discount_cents: int | None = None
    shipping_cents: int | None = None
    for line in line_items:
        if line.kind == "tax" and line.line_total_cents is not None:
            tax_cents = (tax_cents or 0) + line.line_total_cents
        elif line.kind == "discount" and line.line_total_cents is not None:
            discount_cents = (discount_cents or 0) + abs(line.line_total_cents)
        elif line.kind == "shipping" and line.line_total_cents is not None:
            shipping_cents = (shipping_cents or 0) + line.line_total_cents
    if tax_cents is not None:
        fields.tax_cents = tax_cents
    if discount_cents is not None:
        fields.discount_cents = discount_cents
    if shipping_cents is not None:
        fields.shipping_cents = shipping_cents

    currency = metadata.get("currency") or (
        _all_currencies(text)[0] if _all_currencies(text) else None
    )
    if currency:
        fields.currency = str(currency)[:3].upper()
        sources["currency"] = "Extracted from a currency symbol or code."
    else:
        uncertain.append("currency")
    currencies = _all_currencies(text)
    if len(currencies) > 1:
        warnings.append(
            "Multiple currencies or symbols were found ("
            + ", ".join(currencies)
            + "). Confirm the purchase currency."
        )
        uncertain.append("currency")

    order_number = metadata.get("invoice_number") or _parse_invoice_number(text)
    if order_number:
        fields.order_number = str(order_number)[:120]
        sources["order_number"] = "Extracted from an invoice/order reference."

    brand, model = _parse_brand_model(text)
    fields.brand = metadata.get("brand") or brand
    fields.model = metadata.get("model") or model
    if fields.brand:
        sources["brand"] = "Extracted from brand/make text."
    if fields.model:
        sources["model"] = "Extracted from model text."
    serials = metadata.get("serial_numbers") or _parse_serials(text)
    if serials:
        fields.serial_numbers = [str(value)[:200] for value in serials][:50]
        sources["serial_numbers"] = "Extracted from serial/IMEI text."

    warranty = _parse_warranty_fields(text)
    for key in ("warranty_provider", "warranty_start", "warranty_end", "warranty_months"):
        value = metadata.get(key, warranty.get(key))
        if value is not None:
            setattr(fields, key, value)
            sources[key] = "Extracted from warranty/coverage text."
    if fields.warranty_provider:
        sources["warranty_provider"] = "Extracted from warranty/coverage text."

    document_date = document.document_date or (
        fields.purchase_date if document.document_type in {"receipt", "invoice"} else None
    )
    if document_date:
        fields.document_date = document_date
        sources["document_date"] = "Document date; verify against the source."
    else:
        uncertain.append("document_date")

    if fields.total_cents is None:
        warnings.append("No receipt total was found. Enter or confirm the total manually.")
    if line_items and (tax_cents or discount_cents or shipping_cents):
        warnings.append(
            "Tax, discount and shipping lines are kept separate; they are not "
            "allocated to product lines."
        )
    if line_items and all(line.kind != "product" for line in line_items):
        warnings.append("No product lines were found; confirm which lines are inventory-worthy.")

    if document.document_type not in {"receipt", "invoice"}:
        warnings.append(
            "This document type is not treated as proof of purchase. Purchase "
            "creation is disabled; you can still review product/model/serial and "
            "warranty evidence."
        )

    fields.field_sources = sources
    fields.uncertain_fields = sorted(set(uncertain))
    financial_validation = validate_invoice_financials(
        fields,
        line_items,
        source=text,
    )
    for check in financial_validation.checks:
        if check.code == "ambiguous_date":
            fields.uncertain_fields = sorted(set(fields.uncertain_fields + ["purchase_date"]))
        elif check.code == "ambiguous_currency":
            fields.uncertain_fields = sorted(set(fields.uncertain_fields + ["currency"]))
        if check.message not in warnings:
            warnings.append(check.message)
    fields_data = fields.model_dump(mode="json")
    lines_data = [line.model_dump(mode="json") for line in line_items]
    return {
        "version": version,
        "source_artifact": source_artifact,
        "document_type": document.document_type,
        "generated_at": datetime.now(UTC).isoformat(),
        "purchase_eligible": document.document_type in {"receipt", "invoice"},
        "fields": fields_data,
        "lines": lines_data,
        "warnings": warnings,
        "financial_validation": financial_validation.model_dump(mode="json"),
        "extractor_version": EXTRACTION_VERSION,
    }


def _stored_extraction(document: Document) -> dict[str, Any] | None:
    extraction = (document.extracted_metadata or {}).get("extraction")
    return extraction if isinstance(extraction, dict) and extraction.get("version") else None


def ensure_extraction(db: Session, document: Document) -> dict[str, Any]:
    extraction = _stored_extraction(document)
    if extraction is not None and extraction.get("extractor_version") == EXTRACTION_VERSION:
        return extraction
    if not (document.extracted_text or "").strip():
        raise ValueError("Document has no OCR text to extract.")
    metadata = document.extracted_metadata or {}
    extraction = build_extraction(
        document,
        document.extracted_text or "",
        metadata,
        source_artifact=str(metadata.get("ocr_artifact") or "original"),
    )
    metadata = dict(metadata)
    metadata["extraction"] = extraction
    document.extracted_metadata = metadata
    db.commit()
    return extraction


def _duplicate_documents(db: Session, document: Document) -> list[DuplicateDocumentBrief]:
    if not document.content_sha256:
        return []
    duplicates = db.scalars(
        select(Document)
        .where(
            Document.household_id == document.household_id,
            Document.id != document.id,
            Document.content_sha256 == document.content_sha256,
        )
        .order_by(Document.created_at.desc())
        .limit(5)
    ).all()
    return [
        DuplicateDocumentBrief(
            id=other.id,
            title=other.title,
            document_type=other.document_type,
            content_type=other.content_type,
            url=f"/api/v1/documents/{other.id}/file",
            created_at=other.created_at,
        )
        for other in duplicates
    ]


def _applied_summaries(db: Session, document: Document) -> list[ExtractionApplySummary]:
    rows = db.scalars(
        select(DocumentExtractionApply)
        .where(
            DocumentExtractionApply.household_id == document.household_id,
            DocumentExtractionApply.document_id == document.id,
        )
        .order_by(DocumentExtractionApply.created_at.desc())
        .limit(5)
    ).all()
    summaries: list[ExtractionApplySummary] = []
    for row in rows:
        result = row.result or {}
        try:
            summaries.append(
                ExtractionApplySummary(
                    request_id=row.request_id,
                    applied_at=row.created_at,
                    created_item_ids=result.get("created_item_ids", []),
                    updated_item_ids=result.get("updated_item_ids", []),
                    linked_item_ids=result.get("linked_item_ids", []),
                    skipped_line_ids=result.get("skipped_line_ids", []),
                    purchase_id=result.get("purchase_id"),
                )
            )
        except ValueError:
            continue
    return summaries


def extraction_review(db: Session, document: Document) -> ExtractionReviewOut:
    extraction = ensure_extraction(db, document)
    lines = [ExtractionLine.model_validate(line) for line in extraction.get("lines", [])]
    fields = ExtractionFields.model_validate(extraction.get("fields", {}))
    from .document_matching import deterministic_matches

    product_lines = [line for line in lines if line.kind == "product"]
    match_inputs = []
    for line in product_lines:
        evidence_serials = _parse_serials(line.evidence.text)
        evidence_brand, evidence_model = _parse_brand_model(line.evidence.text)
        match_inputs.append(
            LineMatchInput(
                line_id=line.id,
                description=line.description,
                quantity=line.quantity,
                brand=evidence_brand or (fields.brand if len(product_lines) == 1 else None),
                model=evidence_model or (fields.model if len(product_lines) == 1 else None),
                serial_numbers=evidence_serials
                or (fields.serial_numbers if len(product_lines) == 1 else []),
            )
        )
    matches = deterministic_matches(db, document.household_id, match_inputs)
    status = ai.status_for(
        db,
        document.household_id,
        AiTask.DOCUMENTS.value,
        probe=False,
    )
    from .enrichment import enhancement_state

    enhancement = enhancement_state(db, document, document_matches=matches) or {}
    financial_validation = validate_invoice_financials(
        fields,
        lines,
        source=document.extracted_text or "",
    )
    warnings = list(extraction.get("warnings") or [])
    for check in financial_validation.checks:
        if check.message not in warnings:
            warnings.append(check.message)
    suggested_refinement = (
        enhancement.get("proposal") if enhancement.get("status") == "ready" else None
    )
    if isinstance(suggested_refinement, dict):
        suggested_refinement = dict(suggested_refinement)
        refined_fields = ExtractionFields.model_validate(suggested_refinement.get("fields") or {})
        refined_lines = [
            ExtractionLine.model_validate(line) for line in suggested_refinement.get("lines", [])
        ]
        refined_validation = validate_invoice_financials(
            refined_fields,
            refined_lines,
            source=document.extracted_text or "",
        )
        if any(check.code == "ambiguous_currency" for check in refined_validation.checks):
            refined_fields.uncertain_fields = sorted(
                set(refined_fields.uncertain_fields + ["currency"])
            )
        if any(check.code == "ambiguous_date" for check in refined_validation.checks):
            refined_fields.uncertain_fields = sorted(
                set(refined_fields.uncertain_fields + ["purchase_date", "document_date"])
            )
        suggested_refinement["fields"] = refined_fields.model_dump(mode="json")
        suggested_refinement["financial_validation"] = refined_validation.model_dump(mode="json")
        suggested_refinement["warnings"] = list(
            dict.fromkeys(
                list(suggested_refinement.get("warnings") or [])
                + [check.message for check in refined_validation.checks]
            )
        )
    return ExtractionReviewOut(
        document_id=document.id,
        version=str(extraction["version"]),
        source_artifact=str(extraction.get("source_artifact") or "original"),
        document_type=document.document_type,
        generated_at=datetime.fromisoformat(str(extraction["generated_at"])),
        purchase_eligible=bool(extraction.get("purchase_eligible")),
        fields=fields,
        lines=lines,
        warnings=warnings,
        financial_validation=validate_invoice_financials(
            fields,
            lines,
            source=document.extracted_text or "",
        ),
        matches=matches,
        duplicate_documents=_duplicate_documents(db, document),
        applied=_applied_summaries(db, document),
        ai_status=status,
        enhancement=enhancement or None,
        suggested_refinement=suggested_refinement,
    )
