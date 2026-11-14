"""Deterministic inventory extraction from notes, tables and documents.

AI can improve extraction later, but this parser is the always-available baseline.
It never invents brands, models, serials, prices or locations: missing fields stay
missing and every proposal carries source context and per-field provenance.
"""

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from .import_types import ParsedDocument, ParsedTable, SourceBundle
from .ocr import _parse_date

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
MONEY_RE = re.compile(
    r"(?<![\w-])(?P<currency>US\$|CA\$|AU\$|C\$|A\$|[$€£¥₹])?\s*"
    r"(?P<amount>\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})?|\d+[.,]\d{2})(?![\w-])"
)
SERIAL_RE = re.compile(
    r"\b(?:serial(?:\s*(?:no\.?|number))?|s/n|sn|imei)\s*[:#-]?\s*"
    r"([A-Z0-9][A-Z0-9-]{3,})\b",
    re.IGNORECASE,
)
ORDER_RE = re.compile(
    r"\b(?:order|invoice|receipt)\s*(?:no\.?|number|#)?\s*[:#-]?\s*"
    r"([A-Z0-9][A-Z0-9./-]{2,})\b",
    re.IGNORECASE,
)
BRAND_RE = re.compile(r"\b(?:brand|make)\s*[:#-]\s*([^,;|]+)", re.IGNORECASE)
MODEL_RE = re.compile(r"\bmodel\s*[:#-]\s*([^,;|]+)", re.IGNORECASE)
WARRANTY_DURATION_RE = re.compile(
    r"(\d+)\s*(year|years|month|months)\s*(?:warranty|coverage|parts)?",
    re.IGNORECASE,
)
TAG_RE = re.compile(r"(?<![\w#])#([A-Za-z0-9_/-]{2,})")
NUMBER_WORDS = {
    "one": 1,
    "a": 1,
    "an": 1,
    "single": 1,
    "two": 2,
    "pair": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "dozen": 12,
    "twenty": 20,
}
PERSIAN_NUMBER_WORDS = {
    "یک": 1,
    "دو": 2,
    "سه": 3,
    "چهار": 4,
    "پنج": 5,
    "شش": 6,
    "هفت": 7,
    "هشت": 8,
    "نه": 9,
    "ده": 10,
}
HEADER_SYNONYMS = {
    "name": {
        "name",
        "item",
        "item name",
        "possession",
        "thing",
        "title",
        "object",
        "description name",
    },
    "description": {"description", "details", "detail", "about"},
    "quantity": {"quantity", "qty", "count", "number", "how many", "units"},
    "category": {"category", "type", "group", "collection", "class"},
    "brand": {"brand", "make", "manufacturer"},
    "model": {"model", "model number", "variant"},
    "serial_number": {"serial", "serial number", "serial no", "sn", "s/n", "imei"},
    "room": {"room", "area", "space"},
    "storage_location": {"location", "storage", "storage location", "place", "where"},
    "purchase_date": {"purchase date", "date bought", "bought", "date purchased", "date"},
    "price": {"price", "purchase price", "cost", "amount", "paid", "value"},
    "currency": {"currency", "currency code"},
    "merchant": {"merchant", "vendor", "store", "shop", "seller", "retailer"},
    "order_number": {"order number", "order", "order no", "invoice", "receipt", "reference"},
    "warranty_provider": {"warranty provider", "warranty", "warrantor", "coverage provider"},
    "warranty_start": {"warranty start", "warranty start date", "coverage start"},
    "warranty_end": {"warranty end", "warranty end date", "warranty expires", "coverage end"},
    "warranty_duration": {"warranty duration", "warranty months", "coverage months"},
    "warranty_notes": {"warranty notes", "coverage notes", "warranty details"},
    "tags": {"tags", "tag", "labels", "keywords"},
    "notes": {"notes", "note", "remarks", "comments"},
}
IGNORED_TYPES = {
    "room",
    "location",
    "place",
    "storage",
    "area",
    "daily",
    "journal",
    "template",
    "templates",
    "plugin",
    "plugins",
    "readme",
    "moc",
    "index",
    "project",
    "purchase",
    "receipt",
    "invoice",
    "warranty",
    "manual",
    "maintenance",
    "reference",
}
COLLECTION_WORDS = {
    "equipment",
    "collection",
    "inventory",
    "possessions",
    "items",
    "gear",
    "kit",
    "storage",
    "contents",
    "electronics",
    "tools",
    "clothes",
    "wardrobe",
}


@dataclass
class ProposalDraft:
    name: str
    description: str | None = None
    quantity: int = 1
    category_text: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    room_text: str | None = None
    storage_text: str | None = None
    location_phrases: list[str] = field(default_factory=list)
    location_preposition: str | None = None
    purchase_date: date | None = None
    price_cents: int | None = None
    currency: str | None = None
    merchant: str | None = None
    order_number: str | None = None
    warranty_provider: str | None = None
    warranty_start: date | None = None
    warranty_end: date | None = None
    warranty_duration_months: int | None = None
    warranty_notes: str | None = None
    tags: list[str] = field(default_factory=list)
    notes: str | None = None
    collection: str | None = None
    relationships: dict[str, Any] = field(default_factory=dict)
    field_sources: dict[str, str] = field(default_factory=dict)
    confidence: int | None = None
    source_path: str | None = None
    source_excerpt: str | None = None
    note_title: str | None = None
    source_file_path: str | None = None


@dataclass
class ParseResult:
    drafts: list[ProposalDraft]
    ignored_notes: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


def _clean_scalar(value: str) -> str:
    cleaned = value.strip().strip('"').strip("'")
    return cleaned


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration:
        return {}, text
    frontmatter: dict[str, Any] = {}
    current_key: str | None = None
    current_list: list[str] | None = None
    for raw_line in lines[1:end]:
        line = raw_line.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent and current_key is not None:
            if stripped.startswith("- "):
                if current_list is None:
                    current_list = []
                    frontmatter[current_key] = current_list
                current_list.append(_clean_scalar(stripped[2:]))
                continue
            if current_list is None:
                frontmatter[current_key] = _clean_scalar(stripped)
            continue
        current_list = None
        if ":" not in stripped:
            continue
        key, raw_value = stripped.split(":", 1)
        current_key = key.strip()
        value = raw_value.strip()
        if not value:
            frontmatter[current_key] = ""
            continue
        if value.startswith("[") and value.endswith("]"):
            frontmatter[current_key] = [
                _clean_scalar(item) for item in value[1:-1].split(",") if item.strip()
            ]
        else:
            frontmatter[current_key] = _clean_scalar(value)
    return frontmatter, "\n".join(lines[end + 1 :])


def _frontmatter_values(frontmatter: dict[str, Any], key: str) -> list[str]:
    value = frontmatter.get(key)
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    return [part.strip() for part in re.split(r"[,;]", text) if part.strip()]


def _frontmatter_first(frontmatter: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        values = _frontmatter_values(frontmatter, key)
        if values:
            return values[0]
    return None


def _strip_articles(text: str) -> str:
    cleaned = re.sub(r"^(?:my|our|the|a|an)\s+", "", text.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"^(?:old|vintage|spare|extra)\s+", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip(" .,;:-")


def parse_quantity(text: str) -> tuple[int, str]:
    pair = re.match(r"^\s*(?:a\s+)?pair\s+of\s+(?P<rest>.+)$", text, re.IGNORECASE)
    if pair:
        return 2, pair.group("rest").strip()
    quantity_words = {**NUMBER_WORDS, **PERSIAN_NUMBER_WORDS}
    number_pattern = "|".join(
        re.escape(word) for word in sorted(quantity_words, key=len, reverse=True)
    )
    match = re.match(
        r"^\s*(?:x\s*)?(?P<number>\d{1,4}|" + number_pattern + r")\s+"
        r"(?P<rest>.+)$",
        text,
        re.IGNORECASE,
    )
    if not match:
        return 1, text.strip()
    raw = match.group("number").casefold()
    quantity = int(raw) if raw.isdigit() else quantity_words.get(raw, 1)
    return max(0, quantity), match.group("rest").strip()


def parse_price(text: str) -> tuple[int | None, str | None, str]:
    result = None
    currency = None
    chosen_span: tuple[int, int] | None = None
    for match in MONEY_RE.finditer(text):
        raw = match.group("amount").replace(" ", "")
        symbol = match.group("currency")
        compact = raw.replace(",", "").replace(".", "")
        if (
            not symbol
            and "." not in raw
            and "," not in raw
            and not re.search(
                r"(?:price|paid|cost|amount|value|for)\s*[:$]?\s*$",
                text[max(0, match.start() - 24) : match.start()],
                re.IGNORECASE,
            )
        ):
            continue
        if "," in raw and "." in raw:
            if raw.rfind(",") > raw.rfind("."):
                raw = raw.replace(".", "").replace(",", ".")
            else:
                raw = raw.replace(",", "")
        elif "," in raw:
            whole, fraction = raw.rsplit(",", 1)
            if len(fraction) == 2:
                raw = f"{whole.replace(',', '')}.{fraction}"
            else:
                raw = raw.replace(",", "")
        try:
            cents = round(float(raw) * 100)
        except ValueError:
            continue
        if cents < 0 or not compact:
            continue
        result = cents
        currency = CURRENCY_SYMBOLS.get(symbol or "")
        chosen_span = (match.start(), match.end())
        if currency:
            break
    if chosen_span is None:
        return None, None, text
    cleaned = (text[: chosen_span[0]] + text[chosen_span[1] :]).strip(" ,;|")
    return result, currency, cleaned


def parse_serial(text: str) -> tuple[str | None, str]:
    match = SERIAL_RE.search(text)
    if not match:
        return None, text
    return match.group(1).upper(), SERIAL_RE.sub("", text).strip(" ,;|")


def parse_order(text: str) -> tuple[str | None, str]:
    match = ORDER_RE.search(text)
    if not match:
        return None, text
    return match.group(1).upper(), ORDER_RE.sub("", text).strip(" ,;|")


def parse_warranty(text: str) -> dict[str, Any]:
    lowered = text.lower()
    if "warranty" not in lowered and "coverage" not in lowered:
        return {}
    result: dict[str, Any] = {}
    duration = WARRANTY_DURATION_RE.search(text)
    if duration:
        amount = int(duration.group(1))
        result["duration_months"] = amount * 12 if "year" in duration.group(2).lower() else amount
    dates = []
    for token in re.findall(
        r"\b(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b", text
    ):
        parsed = _parse_date(token)
        if parsed:
            dates.append(date.fromisoformat(parsed))
    if dates:
        result["start_date"] = min(dates)
        if len(dates) > 1:
            result["end_date"] = max(dates)
    provider = re.search(r"\b(?:from|with|by)\s+([A-Za-z0-9&.' -]{2,80})", text)
    if provider:
        result["provider"] = provider.group(1).strip(" .,;")
    return result


def _line_tags(text: str) -> list[str]:
    return [match.group(1).strip("/") for match in TAG_RE.finditer(text)]


def _note_tags(frontmatter: dict[str, Any], text: str) -> list[str]:
    tags = _frontmatter_values(frontmatter, "tags") + _frontmatter_values(frontmatter, "tag")
    tags.extend(_line_tags(text))
    seen = set()
    result = []
    for tag in tags:
        cleaned = tag.strip().lstrip("#")
        if cleaned and cleaned.lower() not in seen:
            seen.add(cleaned.lower())
            result.append(cleaned)
    return result[:50]


def _normalize_header(header: str) -> str:
    return re.sub(r"[^a-z0-9/ ]+", " ", header.lower()).strip()


def _field_for_header(header: str) -> str | None:
    normalized = _normalize_header(header)
    for field_name, synonyms in HEADER_SYNONYMS.items():
        if normalized in synonyms:
            return field_name
    return None


def _table_headers(table: ParsedTable) -> tuple[dict[str, int], bool]:
    mapping: dict[str, int] = {}
    for index, header in enumerate(table.headers):
        field_name = _field_for_header(header)
        if field_name and field_name not in mapping:
            mapping[field_name] = index
    return mapping, "name" in mapping


def _row_value(row: list[str], mapping: dict[str, int], field_name: str) -> str | None:
    index = mapping.get(field_name)
    if index is None or index >= len(row):
        return None
    value = row[index].strip()
    return value or None


def _parse_date_value(value: str | None) -> date | None:
    if not value:
        return None
    parsed = _parse_date(value)
    return date.fromisoformat(parsed) if parsed else None


def _parse_int(value: str | None) -> int | None:
    if not value:
        return None
    digits = re.sub(r"[^\d]", "", value)
    return int(digits) if digits else None


def _parse_price_value(value: str | None) -> tuple[int | None, str | None]:
    if not value:
        return None, None
    cents, currency, _ = parse_price(value)
    if cents is not None:
        return cents, currency
    number = re.fullmatch(r"\s*([0-9][0-9 ,]*)(?:\.0+)?\s*", value)
    if number:
        digits = re.sub(r"[^\d]", "", number.group(1))
        if digits:
            return int(digits) * 100, None
    return None, None


def _parse_tags(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip().lstrip("#") for item in re.split(r"[,;|]", value) if item.strip()]


def _markdown_tables(text: str) -> list[ParsedTable]:
    lines = text.splitlines()
    tables: list[ParsedTable] = []
    index = 0
    while index + 1 < len(lines):
        header = lines[index].strip()
        separator = lines[index + 1].strip()
        if (
            "|" not in header
            or "|" not in separator
            or not re.fullmatch(r"\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*", separator)
        ):
            index += 1
            continue
        headers = [cell.strip() for cell in header.strip("|").split("|")]
        rows: list[list[str]] = []
        cursor = index + 2
        while cursor < len(lines) and "|" in lines[cursor]:
            row = [cell.strip() for cell in lines[cursor].strip().strip("|").split("|")]
            if any(row):
                rows.append(row)
            cursor += 1
        if headers and rows:
            tables.append(ParsedTable(headers=headers, rows=rows, name=f"Table {len(tables) + 1}"))
        index = max(cursor, index + 1)
    return tables


def _metadata_fields(text: str) -> tuple[dict[str, Any], dict[str, str]] | None:
    cleaned = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?", "", text).strip()
    if not cleaned:
        return None
    patterns = {
        "serial_number": r"^(?:serial(?:\s*(?:no\.?|number))?|s/n|sn|imei)\s*[:#-]\s*(.+)$",
        "brand": r"^(?:brand|make|manufacturer)\s*[:#-]\s*(.+)$",
        "model": r"^(?:model(?:\s*(?:no\.?|number))?)\s*[:#-]\s*(.+)$",
        "category_text": r"^(?:category|type|group)\s*[:#-]\s*(.+)$",
        "room_text": r"^(?:room|area)\s*[:#-]\s*(.+)$",
        "storage_text": r"^(?:location|storage(?: location)?|place)\s*[:#-]\s*(.+)$",
        "merchant": r"^(?:merchant|vendor|store|seller)\s*[:#-]\s*(.+)$",
        "order_number": r"^(?:order|invoice|receipt)\s*(?:no\.?|number|#)?\s*[:#-]\s*(.+)$",
        "notes": r"^(?:notes?|remarks?|comments?)\s*[:#-]\s*(.+)$",
    }
    for field_name, pattern in patterns.items():
        match = re.match(pattern, cleaned, re.IGNORECASE)
        if match:
            value = match.group(1).strip(" .,;|")
            if not value:
                return None
            if field_name == "order_number":
                value = value.upper()
            return {field_name: value[:4000] if field_name == "notes" else value[:200]}, {
                field_name: "explicit"
            }
    purchase = re.match(
        r"^(?:purchased?|bought|acquired|price|cost|paid|purchase date)\b(?P<rest>.+)$",
        cleaned,
        re.IGNORECASE,
    )
    if purchase:
        rest = purchase.group("rest")
        fields: dict[str, Any] = {}
        sources: dict[str, str] = {}
        parsed_date = _parse_date_value(rest)
        if parsed_date:
            fields["purchase_date"] = parsed_date
            sources["purchase_date"] = "explicit"
        price, currency, rest = parse_price(rest)
        if price is not None:
            fields["price_cents"] = price
            sources["price_cents"] = "explicit"
        if currency:
            fields["currency"] = currency
            sources["currency"] = "explicit"
        merchant = re.search(r"\bfrom\s+([A-Za-z0-9&.' -]{2,100})$", rest.strip(" .,;|"), re.I)
        if merchant:
            fields["merchant"] = merchant.group(1).strip(" .,;|")[:160]
            sources["merchant"] = "explicit"
        if fields:
            return fields, sources
    if re.match(r"^(?:tags?|labels?)\s*[:#-]", cleaned, re.IGNORECASE):
        raw = re.sub(r"^(?:tags?|labels?)\s*[:#-]\s*", "", cleaned, flags=re.I)
        tags = [item.strip().lstrip("#") for item in re.split(r"[,;|]", raw) if item.strip()]
        if tags:
            return {"tags": tags}, {"tags": "explicit"}
    if re.match(r"^warranty\b", cleaned, re.IGNORECASE):
        warranty = parse_warranty(cleaned)
        if warranty:
            mapping = {
                "provider": "warranty_provider",
                "start_date": "warranty_start",
                "end_date": "warranty_end",
                "duration_months": "warranty_duration_months",
            }
            fields = {mapping[key]: value for key, value in warranty.items() if key in mapping}
            if fields:
                sources = {field_name: "explicit" for field_name in fields}
                fields["warranty_notes"] = cleaned[:4000]
                sources["warranty_notes"] = "explicit"
                return fields, sources
    return None


def _attach_metadata(draft: ProposalDraft, fields: dict[str, Any], sources: dict[str, str]) -> None:
    for field_name, value in fields.items():
        if field_name == "tags":
            draft.tags = list(dict.fromkeys([*draft.tags, *[str(tag) for tag in value]]))
            continue
        if getattr(draft, field_name, None) in (None, ""):
            setattr(draft, field_name, value)
            draft.field_sources[field_name] = sources.get(field_name, "explicit")


def _list_drafts(
    body: str, document: ParsedDocument, *, collection: str | None
) -> list[ProposalDraft]:
    drafts: list[ProposalDraft] = []
    stack: list[tuple[int, ProposalDraft]] = []
    for raw_line in body.splitlines():
        if not re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", raw_line):
            continue
        indent = len(raw_line) - len(raw_line.lstrip())
        content = _remove_list_marker(raw_line)
        if not content:
            continue
        metadata = _metadata_fields(content)
        if metadata is not None:
            if stack:
                _attach_metadata(stack[-1][1], metadata[0], metadata[1])
            continue
        draft = _parse_detail_line(
            content,
            document,
            collection=collection,
            confidence=82 if collection else 74,
        )
        if draft is None:
            continue
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, draft))
        drafts.append(draft)
    return drafts


def _table_drafts(table: ParsedTable, document: ParsedDocument) -> list[ProposalDraft]:
    mapping, has_name = _table_headers(table)
    if not has_name:
        return []
    drafts = []
    for row in table.rows:
        name = _row_value(row, mapping, "name")
        if not name:
            continue
        lower_name = name.lower()
        if lower_name in {"total", "subtotal", "sum", "notes"}:
            continue
        raw_price = _row_value(row, mapping, "price")
        price, detected_currency = _parse_price_value(raw_price)
        currency_value = _row_value(row, mapping, "currency")
        currency = None
        if currency_value and re.fullmatch(r"[A-Za-z]{3}", currency_value):
            currency = currency_value.upper()
        if currency is None:
            currency = detected_currency
        warranty_start = _parse_date_value(_row_value(row, mapping, "warranty_start"))
        warranty_end = _parse_date_value(_row_value(row, mapping, "warranty_end"))
        warranty_duration = _parse_int(_row_value(row, mapping, "warranty_duration"))
        draft = ProposalDraft(
            name=name[:200],
            description=_row_value(row, mapping, "description"),
            quantity=max(1, _parse_int(_row_value(row, mapping, "quantity")) or 1),
            category_text=_row_value(row, mapping, "category"),
            brand=_row_value(row, mapping, "brand"),
            model=_row_value(row, mapping, "model"),
            serial_number=_row_value(row, mapping, "serial_number"),
            room_text=_row_value(row, mapping, "room"),
            storage_text=_row_value(row, mapping, "storage_location"),
            purchase_date=_parse_date_value(_row_value(row, mapping, "purchase_date")),
            price_cents=price,
            currency=currency,
            merchant=_row_value(row, mapping, "merchant"),
            order_number=_row_value(row, mapping, "order_number"),
            warranty_provider=_row_value(row, mapping, "warranty_provider"),
            warranty_start=warranty_start,
            warranty_end=warranty_end,
            warranty_duration_months=warranty_duration,
            warranty_notes=_row_value(row, mapping, "warranty_notes"),
            tags=_parse_tags(_row_value(row, mapping, "tags")),
            notes=_row_value(row, mapping, "notes"),
            source_path=document.relative_path,
            source_excerpt=" | ".join(cell for cell in row if cell.strip())[:2000],
            note_title=document.title,
            source_file_path=document.relative_path,
            confidence=92,
            field_sources={
                field_name: "explicit"
                for field_name in mapping
                if _row_value(row, mapping, field_name)
            },
        )
        if draft.warranty_duration_months and not draft.warranty_start:
            draft.warranty_start = draft.purchase_date
        drafts.append(draft)
    return drafts


def _frontmatter_draft(
    document: ParsedDocument, frontmatter: dict[str, Any]
) -> ProposalDraft | None:
    note_type = (
        str(
            frontmatter.get("type")
            or frontmatter.get("kind")
            or frontmatter.get("category_type")
            or ""
        )
        .strip()
        .lower()
    )
    if note_type in IGNORED_TYPES:
        return None
    name = _frontmatter_first(frontmatter, "name", "item", "title", "possession")
    item_fields = {
        "name",
        "item",
        "serial",
        "serial_number",
        "brand",
        "model",
        "room",
        "location",
        "quantity",
        "purchase_date",
        "price",
        "merchant",
    }
    present = {
        key.lower().replace(" ", "_")
        for key in frontmatter
        if key.lower().replace(" ", "_") in item_fields
    }
    if note_type not in {"item", "possession", "inventory"} and not present:
        return None
    resolved_name = name or document.title
    field_sources = {"name": "explicit"}
    for key in present:
        field_sources[key.lower().replace(" ", "_")] = "explicit"
    return ProposalDraft(
        name=resolved_name[:200],
        description=_frontmatter_first(frontmatter, "description", "details", "about"),
        quantity=1,
        category_text=_frontmatter_first(frontmatter, "category", "collection"),
        brand=_frontmatter_first(frontmatter, "brand", "make"),
        model=_frontmatter_first(frontmatter, "model"),
        serial_number=_frontmatter_first(
            frontmatter, "serial", "serial_number", "serial number", "sn"
        ),
        room_text=_frontmatter_first(frontmatter, "room", "area"),
        storage_text=_frontmatter_first(
            frontmatter, "location", "storage", "storage_location", "place"
        ),
        purchase_date=_parse_date_value(
            _frontmatter_first(frontmatter, "purchase_date", "purchase date", "date", "bought")
        ),
        price_cents=_parse_price_value(_frontmatter_first(frontmatter, "price", "cost", "paid"))[0],
        currency=(
            (_frontmatter_first(frontmatter, "currency") or "").upper()
            if re.fullmatch(
                r"[A-Za-z]{3}",
                _frontmatter_first(frontmatter, "currency") or "",
            )
            else None
        ),
        merchant=_frontmatter_first(frontmatter, "merchant", "vendor", "store"),
        order_number=_frontmatter_first(frontmatter, "order_number", "order", "invoice", "receipt"),
        warranty_provider=_frontmatter_first(frontmatter, "warranty_provider", "warranty"),
        warranty_start=_parse_date_value(
            _frontmatter_first(frontmatter, "warranty_start", "warranty start")
        ),
        warranty_end=_parse_date_value(
            _frontmatter_first(frontmatter, "warranty_end", "warranty end")
        ),
        warranty_duration_months=_parse_int(
            _frontmatter_first(frontmatter, "warranty_months", "warranty duration")
        ),
        warranty_notes=_frontmatter_first(frontmatter, "warranty_notes", "coverage"),
        tags=_note_tags(frontmatter, document.text),
        notes=_frontmatter_first(frontmatter, "notes", "note"),
        source_path=document.relative_path,
        source_excerpt=document.text[:2000],
        note_title=document.title,
        source_file_path=document.relative_path,
        confidence=95,
        field_sources=field_sources,
    )


def _remove_list_marker(line: str) -> str:
    return re.sub(
        r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?",
        "",
        line,
    ).strip()


def _parse_detail_line(
    text: str,
    document: ParsedDocument,
    *,
    collection: str | None,
    confidence: int,
) -> ProposalDraft | None:
    original = text.strip()
    if not original or len(original) > 2000:
        return None
    if not re.search(r"\w{2,}", original, re.UNICODE):
        return None
    if re.match(r"^(?:https?://|www\.)|\]\(|^#+$", original, re.I):
        return None
    if re.match(r"^(?:todo|to do|remember|buy|call|email|schedule)\b", original, re.I):
        return None
    body = original
    body = re.sub(
        r"^(?:I|we)\s+(?:have\s+)?(?:bought|purchased|acquired)\s+",
        "",
        body,
        flags=re.IGNORECASE,
    )
    quantity, body = parse_quantity(body)
    price, currency, body = parse_price(body)
    serial, body = parse_serial(body)
    order, body = parse_order(body)
    field_sources: dict[str, str] = {"name": "explicit"}
    if quantity != 1:
        field_sources["quantity"] = "explicit"
    if price is not None:
        field_sources["price_cents"] = "explicit"
    if currency:
        field_sources["currency"] = "explicit"
    if serial:
        field_sources["serial_number"] = "explicit"
    if order:
        field_sources["order_number"] = "explicit"
    brand_match = BRAND_RE.search(body)
    brand = brand_match.group(1).strip() if brand_match else None
    if brand:
        field_sources["brand"] = "explicit"
        body = BRAND_RE.sub("", body)
    model_match = MODEL_RE.search(body)
    model = model_match.group(1).strip() if model_match else None
    if model:
        field_sources["model"] = "explicit"
        body = MODEL_RE.sub("", body)
    purchase_date = _parse_date_value(body)
    if purchase_date:
        field_sources["purchase_date"] = "explicit"
        body = re.sub(
            r"\b(?:bought|purchased|on|date)?\s*20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b",
            "",
            body,
            flags=re.I,
        )
        body = re.sub(
            r"\b(?:bought|purchased|on|date)?\s*\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b",
            "",
            body,
            flags=re.I,
        )
    merchant_match = re.search(
        r"\b(?:merchant|vendor|seller|store|bought from|purchased from)\b\s*[:#-]?\s*"
        r"([A-Za-z0-9&.' -]{2,100}?)(?=[,;|.]|$)",
        body,
        re.IGNORECASE,
    )
    merchant = merchant_match.group(1).strip() if merchant_match else None
    if merchant:
        field_sources["merchant"] = "explicit"
        body = body[: merchant_match.start()] + " " + body[merchant_match.end() :]
    warranty = parse_warranty(original)
    for key in warranty:
        field_sources[f"warranty_{key}"] = "explicit"
    # Prepositional location phrases, preserving order. The last phrase is often
    # the room and the first the storage place.
    phrases = re.findall(
        r"\b(?:in|inside|under|on|at|within|behind|inside of|to|into)\s+"
        r"(.+?)(?=(?:\s+(?:in|inside|under|on|at|within|behind|to|into)\s+)|[.;|]|$)",
        body,
        re.IGNORECASE,
    )
    phrases = [
        _strip_articles(phrase.strip(" .,;|?!؟"))
        for phrase in phrases
        if phrase.strip()
    ]
    prep_match = re.search(
        r"\b(in|inside|under|on|at|within|behind|to|into)\b", body, re.IGNORECASE
    )
    if phrases:
        field_sources["location"] = "explicit"
        body = re.split(
            r"\b(?:in|inside|under|on|at|within|behind|to|into)\b",
            body,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
    name = _strip_articles(body.strip(" .,;|-–—"))
    name = re.sub(r"\s+", " ", name).strip()
    name = re.sub(
        r"\s+(?:is|are|was|were|stored|kept|sits?|lives?)$",
        "",
        name,
        flags=re.IGNORECASE,
    ).strip()
    if name and name[0].islower():
        name = name[0].upper() + name[1:]
    if not name or len(name) < 2:
        return None
    tags = _line_tags(original)
    if tags:
        field_sources["tags"] = "explicit"
    return ProposalDraft(
        name=name[:200],
        description=None,
        quantity=quantity,
        category_text=None,
        brand=brand,
        model=model,
        serial_number=serial,
        location_phrases=phrases,
        location_preposition=prep_match.group(1).lower() if prep_match else None,
        purchase_date=purchase_date,
        price_cents=price,
        currency=currency,
        merchant=merchant,
        order_number=order,
        warranty_provider=warranty.get("provider"),
        warranty_start=warranty.get("start_date"),
        warranty_end=warranty.get("end_date"),
        warranty_duration_months=warranty.get("duration_months"),
        warranty_notes=original if warranty else None,
        tags=tags,
        collection=collection,
        source_path=document.relative_path,
        source_excerpt=original[:2000],
        note_title=document.title,
        source_file_path=document.relative_path,
        confidence=confidence,
        field_sources=field_sources,
    )


def _sentence_draft(
    sentence: str,
    document: ParsedDocument,
    *,
    collection: str | None,
) -> ProposalDraft | None:
    cleaned = sentence.strip()
    if not cleaned:
        return None
    pronoun_destination = re.match(
        r"^(?P<item>.+?);\s*(?:put|place|store|keep)\s+"
        r"(?:them|it|this|that)\s+(?:in|into|at)\s+(?P<destination>.+)$",
        cleaned,
        re.IGNORECASE,
    )
    if pronoun_destination:
        cleaned = (
            f"{pronoun_destination.group('item')} in "
            f"{pronoun_destination.group('destination')}"
        )
    persian_creation = re.match(
        r"^(?:لطفاً\s+)?(?P<item>.+?)\s+را\s+(?:به|در)\s+"
        r"(?P<destination>.+?)\s+اضافه\s+کن(?:ید)?[.!?؟]*$",
        cleaned,
    )
    if persian_creation:
        cleaned = (
            f"{persian_creation.group('item')} in "
            f"{persian_creation.group('destination')}"
        )
    else:
        creation = re.match(
            r"^(?:(?:please|could you|can you|would you)\s+)*"
            r"(?:add|create)\s+(?P<details>.+)$",
            cleaned,
            re.IGNORECASE,
        )
        if creation:
            details = creation.group("details").strip()
            destination = re.match(
                r"^(?P<item>.+)\s+(?:to|into|in)\s+(?P<destination>.+)$",
                details,
                re.IGNORECASE,
            )
            if destination:
                cleaned = (
                    f"{destination.group('item')} in "
                    f"{destination.group('destination')}"
                )
            else:
                draft = _parse_detail_line(
                    details,
                    document,
                    collection=collection,
                    confidence=68,
                )
                if draft is not None:
                    draft.source_excerpt = sentence.strip()[:2000]
                return draft
    match = re.match(
        r"^(?P<subject>.+?)\s+(?:is|are|was|were|sits?|lives?|stored|kept|belongs?)\s+"
        r"(?P<rest>.+)$",
        cleaned,
        re.IGNORECASE,
    )
    if match:
        subject = match.group("subject").strip()
        rest = match.group("rest").strip()
    else:
        split = re.split(r"\b(?:stored|kept)\b", cleaned, maxsplit=1, flags=re.I)
        if len(split) == 2:
            subject, rest = split[0].strip(), split[1].strip()
        else:
            location_match = re.match(
                r"^(?P<subject>.+?)\s+(?P<rest>(?:in|inside|under|on|at|within|behind)\s+.+)$",
                cleaned,
                re.IGNORECASE,
            )
            if location_match is None:
                return None
            subject = location_match.group("subject").strip()
            rest = location_match.group("rest").strip()
    draft = _parse_detail_line(
        f"{subject} {rest}",
        document,
        collection=collection,
        confidence=68,
    )
    if draft is None:
        return None
    # Preserve the original sentence as provenance instead of the reconstructed one.
    draft.source_excerpt = cleaned[:2000]
    if not re.search(r"\b(?:in|inside|under|on|at|within|behind)\b", rest, re.I):
        return None
    return draft


def _note_type(document: ParsedDocument, frontmatter: dict[str, Any]) -> str:
    explicit = (
        str(
            frontmatter.get("type") or frontmatter.get("kind") or frontmatter.get("note_type") or ""
        )
        .strip()
        .lower()
    )
    if explicit:
        return explicit
    title = document.title.lower().strip()
    if title in {
        "attic",
        "basement",
        "garage",
        "kitchen",
        "office",
        "pantry",
        "storage",
        "closet",
        "wardrobe",
        "cupboard",
    } or re.search(
        r"\b(?:room|attic|garage|closet|cabinet|shelf|drawer|storage|pantry|basement)\s*$",
        title,
    ):
        return "location"
    return "note"


def _collection_name(document: ParsedDocument, frontmatter: dict[str, Any]) -> str | None:
    explicit = str(frontmatter.get("collection") or "").strip()
    if explicit:
        return explicit[:200]
    title = document.title
    if any(word in title.lower() for word in COLLECTION_WORDS):
        return title[:200]
    return None


def parse_documents(bundle: SourceBundle) -> ParseResult:
    drafts: list[ProposalDraft] = []
    ignored: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = list(bundle.warnings)
    backlinks: dict[str, list[str]] = {}
    note_titles: dict[str, str] = {}
    for document in bundle.documents:
        _, body = parse_frontmatter(document.text)
        for target in document.links:
            clean = target.replace("\\", "/")
            if clean.startswith("/"):
                clean = clean[1:]
            backlinks.setdefault(clean, []).append(document.relative_path)
            backlinks.setdefault(clean.removesuffix(".md"), []).append(document.relative_path)
            note_titles[clean] = document.title
    for document in bundle.documents:
        frontmatter, body = parse_frontmatter(document.text)
        if document.source_format == "markdown" and not document.tables:
            document.tables = _markdown_tables(body)
        note_type = _note_type(document, frontmatter)
        collection = _collection_name(document, frontmatter)
        note_tags = _note_tags(frontmatter, body)
        if note_type in IGNORED_TYPES:
            ignored.append(
                {
                    "path": document.relative_path,
                    "title": document.title,
                    "reason": f"{note_type} note",
                }
            )
            continue
        document_drafts: list[ProposalDraft] = []
        fm_draft = _frontmatter_draft(document, frontmatter)
        if fm_draft is None and re.search(
            r"\b(?:receipt|invoice|warranty|manual|maintenance|purchase|order)\b",
            document.title,
            re.IGNORECASE,
        ):
            ignored.append(
                {
                    "path": document.relative_path,
                    "title": document.title,
                    "reason": "reference note rather than a possession",
                }
            )
            continue
        if fm_draft is not None:
            fm_draft.tags = list(dict.fromkeys([*fm_draft.tags, *note_tags]))
            document_drafts.append(fm_draft)
        for table in document.tables:
            document_drafts.extend(_table_drafts(table, document))
        if not document_drafts:
            document_drafts.extend(_list_drafts(body, document, collection=collection))
            if not document_drafts:
                paragraphs = [
                    line.strip()
                    for line in re.split(r"\n\s*\n|(?<=[.!?])\s+", body)
                    if line.strip()
                ]
                for paragraph in paragraphs:
                    sentence = re.sub(r"^[#>*\-\s]+", "", paragraph).strip()
                    if _metadata_fields(sentence) is not None:
                        continue
                    draft = _sentence_draft(sentence, document, collection=collection)
                    if draft is not None:
                        draft.tags = list(dict.fromkeys([*draft.tags, *note_tags]))
                        document_drafts.append(draft)
        if not document_drafts:
            ignored.append(
                {
                    "path": document.relative_path,
                    "title": document.title,
                    "reason": "no inventory content detected",
                }
            )
            continue
        for draft in document_drafts:
            draft.relationships = {
                "source_note": document.relative_path,
                "note_title": document.title,
                "folder": str(document.relative_path.rsplit("/", 1)[0])
                if "/" in document.relative_path
                else "",
                "wikilinks": document.links,
                "embeds": document.embeds,
                "frontmatter": frontmatter,
                "collection": collection,
                "backlinks": backlinks.get(document.relative_path, [])
                + backlinks.get(document.relative_path.removesuffix(".md"), []),
            }
            draft.tags = list(dict.fromkeys([*draft.tags, *note_tags]))
            drafts.append(draft)
    # Deduplicate proposals created by overlapping frontmatter/table/list parsing.
    deduped: list[ProposalDraft] = []
    seen: dict[tuple[str, str], ProposalDraft] = {}
    for draft in drafts:
        key = (
            draft.name.strip().lower(),
            (draft.serial_number or "").lower(),
            draft.source_path or "",
        )
        if key in seen:
            existing = seen[key]
            for field_name in (
                "description",
                "brand",
                "model",
                "serial_number",
                "room_text",
                "storage_text",
                "price_cents",
                "currency",
                "merchant",
                "purchase_date",
                "warranty_provider",
                "warranty_start",
                "warranty_end",
            ):
                if getattr(existing, field_name) in (None, "") and getattr(
                    draft, field_name
                ) not in (
                    None,
                    "",
                ):
                    setattr(existing, field_name, getattr(draft, field_name))
            existing.tags = list(dict.fromkeys([*existing.tags, *draft.tags]))
            continue
        seen[key] = draft
        deduped.append(draft)
    if not deduped and not ignored:
        warnings.append(
            {
                "type": "no_entries",
                "message": "No inventory entries could be extracted from this source.",
            }
        )
    return ParseResult(
        drafts=deduped,
        ignored_notes=ignored,
        warnings=warnings,
        metadata={
            "document_count": len(bundle.documents),
            "ignored_count": len(ignored),
            "proposal_count": len(deduped),
        },
    )
