"""CPU-only local OCR and receipt field extraction.

The pipeline deliberately depends on system binaries rather than GPU models:
Tesseract for images and Poppler for rendering scanned PDF pages. Embedded PDF
text is read first with pypdf, so digital receipts need no OCR at all.

All parsing is heuristic. Extracted values are proposals for the review screen;
nothing is applied to inventory until the user confirms it.
"""

import csv
import io
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..config import get_settings


class OcrError(RuntimeError):
    pass


class OcrUnavailableError(OcrError):
    pass


@dataclass(frozen=True)
class ExtractedText:
    text: str
    confidence: int | None
    source: str


CURRENCY_SYMBOLS = {
    "$": "USD",
    "US$": "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
    "₹": "INR",
    "C$": "CAD",
    "CA$": "CAD",
    "A$": "AUD",
    "AU$": "AUD",
}

ISO_CURRENCIES = (
    "USD",
    "EUR",
    "GBP",
    "CAD",
    "AUD",
    "JPY",
    "CHF",
    "SEK",
    "NZD",
    "SGD",
    "INR",
    "NOK",
    "DKK",
    "PLN",
)

MONEY_RE = re.compile(
    r"(?P<currency>US\$|CA\$|AU\$|C\$|A\$|[$€£¥₹])?\s*"
    r"(?P<amount>\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})"
)

DATE_PATTERNS = (
    re.compile(r"\b(?P<year>20\d{2})[-/.](?P<month>\d{1,2})[-/.](?P<day>\d{1,2})\b"),
    re.compile(r"\b(?P<day>\d{1,2})[-/.](?P<month>\d{1,2})[-/.](?P<year>\d{2,4})\b"),
)

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

NON_MERCHANT_WORDS = {
    "receipt",
    "invoice",
    "tax invoice",
    "thank you",
    "welcome",
    "customer copy",
    "sales receipt",
    "order",
    "subtotal",
    "total",
    "amount due",
    "balance",
    "cash",
    "change",
    "card",
    "visa",
    "mastercard",
    "amex",
}

ITEM_LINE_EXCLUDES = NON_MERCHANT_WORDS | {
    "phone",
    "tel",
    "address",
    "www.",
    "http",
    "gst",
    "vat",
    "hst",
    "shipping",
    "delivery",
    "discount",
    "refund",
    "date",
    "time",
    "serial",
    "s/n",
    "imei",
    "invoice",
    "receipt",
    "total",
    "subtotal",
}


def _require_binary(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise OcrUnavailableError(
            f"Local OCR is unavailable because {name!r} is not installed in the worker image."
        )
    return path


def _tesseract_tsv(path: Path) -> ExtractedText:
    binary = _require_binary("tesseract")
    settings = get_settings()
    try:
        completed = subprocess.run(
            [
                binary,
                str(path),
                "stdout",
                "-l",
                settings.ocr_language,
                "--psm",
                "6",
                "tsv",
            ],
            capture_output=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise OcrError("OCR timed out while reading this document.") from exc
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", "replace").strip()
        raise OcrError(f"Tesseract failed: {message[:300] or 'unknown error'}")

    lines: dict[tuple[str, str, str, str], list[str]] = {}
    confidence_values: list[float] = []
    reader = csv.DictReader(
        io.StringIO(completed.stdout.decode("utf-8", "replace")),
        delimiter="\t",
    )
    for row in reader:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        key = (
            row.get("page_num") or "1",
            row.get("block_num") or "0",
            row.get("par_num") or "0",
            row.get("line_num") or "0",
        )
        lines.setdefault(key, []).append(text)
        try:
            confidence = float(row.get("conf") or "-1")
        except ValueError:
            confidence = -1
        if confidence >= 0:
            confidence_values.append(confidence)

    ordered = [
        " ".join(words)
        for _, words in sorted(
            lines.items(),
            key=lambda entry: tuple(int(part or 0) for part in entry[0]),
        )
    ]
    confidence = (
        round(sum(confidence_values) / len(confidence_values)) if confidence_values else None
    )
    return ExtractedText(text="\n".join(ordered), confidence=confidence, source="ocr")


def _pdf_embedded_text(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path), strict=False)
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(pages).strip()


def _ocr_pdf(path: Path) -> ExtractedText:
    _require_binary("pdftoppm")
    settings = get_settings()
    with tempfile.TemporaryDirectory(prefix="housetory-ocr-") as temp_dir:
        prefix = Path(temp_dir) / "page"
        completed = subprocess.run(
            [
                "pdftoppm",
                "-r",
                "200",
                "-png",
                "-f",
                "1",
                "-l",
                str(settings.ocr_max_pdf_pages),
                str(path),
                str(prefix),
            ],
            capture_output=True,
            check=False,
            timeout=120,
        )
        if completed.returncode != 0:
            message = completed.stderr.decode("utf-8", "replace").strip()
            raise OcrError(f"Poppler failed: {message[:300] or 'unknown error'}")
        pages = sorted(Path(temp_dir).glob("page-*.png"))
        if not pages:
            raise OcrError("The PDF did not render any pages for OCR.")
        extracted = [_tesseract_tsv(page) for page in pages]
    text = "\n\n".join(page.text for page in extracted if page.text).strip()
    confidences = [page.confidence for page in extracted if page.confidence is not None]
    return ExtractedText(
        text=text,
        confidence=round(sum(confidences) / len(confidences)) if confidences else None,
        source="ocr",
    )


def extract_text(path: Path, content_type: str) -> ExtractedText:
    lowered = content_type.lower()
    if lowered == "application/pdf":
        embedded = _pdf_embedded_text(path)
        if len(re.sub(r"\s+", "", embedded)) >= 30:
            return ExtractedText(text=embedded, confidence=None, source="pdf_text")
        return _ocr_pdf(path)
    if lowered.startswith("image/"):
        return _tesseract_tsv(path)
    if lowered.startswith("text/"):
        return ExtractedText(
            text=path.read_text(encoding="utf-8", errors="replace"),
            confidence=None,
            source="text",
        )
    raise OcrError(f"OCR does not support {content_type!r}.")


def _parse_date(text: str) -> str | None:
    normalized = text.replace("\n", " ")
    candidates: list[date] = []

    for match in DATE_PATTERNS[0].finditer(normalized):
        try:
            candidates.append(
                date(
                    int(match.group("year")),
                    int(match.group("month")),
                    int(match.group("day")),
                )
            )
        except ValueError:
            continue

    for match in DATE_PATTERNS[1].finditer(normalized):
        first, second = int(match.group("day")), int(match.group("month"))
        year = int(match.group("year"))
        if year < 100:
            year += 2000 if year < 70 else 1900
        # Prefer the unambiguous interpretation; otherwise use month-first for
        # receipt-like documents, which is the common US/international layout.
        if first > 12 and second <= 12:
            day, month = first, second
        elif second > 12 and first <= 12:
            month, day = first, second
        else:
            month, day = first, second
        try:
            candidates.append(date(year, month, day))
        except ValueError:
            continue

    month_pattern = re.compile(
        r"\b(" + "|".join(MONTHS) + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b",
        re.IGNORECASE,
    )
    for match in month_pattern.finditer(normalized):
        try:
            candidates.append(
                date(
                    int(match.group(3)),
                    MONTHS[match.group(1).lower()],
                    int(match.group(2)),
                )
            )
        except ValueError:
            continue

    if not candidates:
        return None
    return candidates[0].isoformat()


def _parse_amount(raw: str) -> int | None:
    value = raw.strip().replace(" ", "")
    if "," in value and "." in value:
        if value.rfind(",") > value.rfind("."):
            value = value.replace(".", "").replace(",", ".")
        else:
            value = value.replace(",", "")
    elif "," in value:
        whole, fraction = value.rsplit(",", 1)
        value = f"{whole.replace(',', '')}.{fraction}" if len(fraction) == 2 else whole
    try:
        cents = round(float(value) * 100)
    except ValueError:
        return None
    return cents if cents >= 0 else None


def _parse_total(lines: list[str]) -> tuple[int | None, str | None]:
    priorities = ("grand total", "amount due", "total due", "balance due", "total")
    for keyword in priorities:
        for line in reversed(lines):
            lowered = line.lower()
            if keyword not in lowered:
                continue
            if keyword == "total" and "subtotal" in lowered:
                continue
            matches = list(MONEY_RE.finditer(line))
            if matches:
                match = matches[-1]
                amount = _parse_amount(match.group("amount"))
                currency = CURRENCY_SYMBOLS.get(match.group("currency") or "")
                if amount is not None:
                    return amount, currency
    # Fallback: a currency-marked amount, preferring the largest value. This
    # catches receipts whose total line was split across OCR lines.
    marked: list[tuple[int, str]] = []
    for line in lines:
        for match in MONEY_RE.finditer(line):
            if not match.group("currency"):
                continue
            amount = _parse_amount(match.group("amount"))
            currency = CURRENCY_SYMBOLS.get(match.group("currency") or "")
            if amount is not None and currency:
                marked.append((amount, currency))
    if marked:
        amount, currency = max(marked)
        return amount, currency
    return None, None


def _parse_currency(text: str, fallback: str | None) -> str | None:
    if fallback:
        return fallback
    for code in ISO_CURRENCIES:
        if re.search(rf"\b{code}\b", text):
            return code
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in text:
            return code
    return None


def _clean_merchant(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip(" -:•·|")
    cleaned = re.sub(r"\s+(?:#|no\.?|store)\s*\d+.*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned[:160]


def _parse_merchant(lines: list[str]) -> str | None:
    phone = re.compile(r"(?:\+?\d[\d ()-]{7,}\d)")
    address = re.compile(r"\b(?:street|st\.|road|rd\.|avenue|ave\.|suite|floor|unit)\b", re.I)
    for line in lines[:14]:
        candidate = line.strip()
        if not (2 <= len(candidate) <= 80):
            continue
        if not re.search(r"[A-Za-z]", candidate):
            continue
        lowered = candidate.lower()
        if any(word == lowered.strip() or word in lowered for word in NON_MERCHANT_WORDS):
            continue
        if phone.search(candidate) or address.search(candidate):
            continue
        if re.search(r"https?://|www\.|@", candidate, re.I):
            continue
        if MONEY_RE.search(candidate) or DATE_PATTERNS[0].search(candidate):
            continue
        return _clean_merchant(candidate)
    return None


def _parse_invoice_number(text: str) -> str | None:
    pattern = re.compile(
        r"\b(?:invoice|receipt|order|transaction|reference|ref)"
        r"\s*(?:no\.?|number|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./-]{2,})\b",
        re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        token = match.group(1).strip(".-/")
        if token.lower() not in {"number", "receipt", "invoice", "order"}:
            return token[:120]
    return None


def _parse_serials(text: str) -> list[str]:
    pattern = re.compile(
        r"\b(?:serial(?:\s*(?:no\.?|number))?|s/n|sn|imei)"
        r"\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b",
        re.IGNORECASE,
    )
    values: list[str] = []
    for match in pattern.finditer(text):
        token = match.group(1).strip("-")
        if token.upper() not in values:
            values.append(token.upper())
        if len(values) >= 10:
            break
    return values


def _parse_product_names(lines: list[str], merchant: str | None) -> list[str]:
    names: list[str] = []
    for line in lines:
        candidate = line.strip()
        if not (3 <= len(candidate) <= 100):
            continue
        lowered = candidate.lower()
        if merchant and lowered == merchant.lower():
            continue
        if any(word in lowered for word in ITEM_LINE_EXCLUDES):
            continue
        if not re.search(r"[A-Za-z]{2,}", candidate):
            continue
        if re.search(r"https?://|www\.|@", candidate, re.I):
            continue
        if re.search(
            r"\b(?:street|st\.|road|rd\.|avenue|ave\.|suite|floor|unit)\b",
            candidate,
            re.I,
        ):
            continue
        if re.search(r"(?:\+?\d[\d ()-]{7,}\d)", candidate):
            continue
        # Item lines commonly end with a price; strip it for the review card.
        candidate = re.sub(r"\s+[$€£¥₹]?\s*\d+[.,]\d{2}\s*[A-Z]?$", "", candidate).strip()
        if candidate and candidate not in names:
            names.append(candidate[:120])
        if len(names) >= 5:
            break
    return names


def _parse_brand_model(text: str) -> tuple[str | None, str | None]:
    brand = re.search(r"\b(?:brand|make|manufacturer)\s*[:#-]\s*([^\n,;|]{2,120})", text, re.I)
    model = re.search(r"\bmodel\s*(?:number|no\.?)?\s*[:#-]\s*([^\n,;|]{1,120})", text, re.I)
    return (
        brand.group(1).strip() if brand else None,
        model.group(1).strip() if model else None,
    )


def _parse_warranty_fields(text: str) -> dict:
    lowered = text.lower()
    if "warranty" not in lowered and "coverage" not in lowered:
        return {}
    result: dict = {}
    duration = re.search(
        r"(\d+)\s*(year|years|month|months)\s*(?:warranty|coverage|parts|labour|parts and labour)?",
        text,
        re.IGNORECASE,
    )
    if duration:
        amount = int(duration.group(1))
        result["warranty_months"] = amount * 12 if "year" in duration.group(2).lower() else amount
    provider = re.search(
        r"\b(?:warranty|coverage)\s+(?:by|from|with)\s+([A-Za-z0-9&.' -]{2,80})",
        text,
        re.IGNORECASE,
    )
    if provider:
        result["warranty_provider"] = provider.group(1).strip(" .,;")
    dates = []
    for token in re.findall(
        r"\b(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b",
        text,
    ):
        parsed = _parse_date(token)
        if parsed:
            dates.append(parsed)
    if dates:
        result["warranty_start"] = min(dates)
        if len(dates) > 1:
            result["warranty_end"] = max(dates)
    return result


def parse_receipt(text: str) -> dict:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    merchant = _parse_merchant(lines)
    total_cents, total_currency = _parse_total(lines)
    brand, model = _parse_brand_model(text)
    return {
        "merchant": merchant,
        "purchase_date": _parse_date(text),
        "total_cents": total_cents,
        "currency": _parse_currency(text, total_currency),
        "product_names": _parse_product_names(lines, merchant),
        "invoice_number": _parse_invoice_number(text),
        "serial_numbers": _parse_serials(text),
        "brand": brand,
        "model": model,
        **_parse_warranty_fields(text),
    }
