"""Query-only product profiles and conservative reference-image ranking."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

from ...config import get_settings
from ...models import Item
from ..item_images import (
    item_type_key,
)

MAX_QUERY_CHARS = 400
MAX_QUERY_WORDS = 50


REFERENCE_MIN_SHORT_SIDE = 256
REFERENCE_MIN_AREA = 65_536
REFERENCE_THIN_MIN_SHORT_SIDE = 120
REFERENCE_THIN_MIN_LONG_SIDE = 600
REFERENCE_THIN_MIN_AREA = 120_000
REFERENCE_THIN_MIN_RATIO = 2.5


INFOGRAPHIC_TERMS = (
    "dimension",
    "dimensions",
    "measurement",
    "measurements",
    "size chart",
    "what's in the box",
    "whats in the box",
    "what is in the box",
    "in the box",
    "spec sheet",
    "specification",
    "specifications",
    "specs",
    "installation",
    "manual",
    "diagram",
    "drawing",
    "schematic",
    "blueprint",
    "collage",
    "comparison",
    "chart",
    "guide",
    "package contents",
    "packaging",
    "ports",
    "remote control",
    "cables included",
    "wall mount",
)
PACKAGING_TERMS = (
    "box",
    "packaging",
    "package",
    "unboxing",
    "open box",
    "retail box",
    "empty box",
    "contents",
    "what's in the box",
    "whats in the box",
    "what is in the box",
    "in the box",
    "package contents",
)
CLEAN_PRODUCT_TERMS = (
    "product photo",
    "product image",
    "official image",
    "front view",
    "rear view",
    "white background",
    "transparent background",
    "isolated",
    "studio",
    "clean product",
)
DIAGRAM_ITEM_TERMS = (
    "diagram",
    "document",
    "manual",
    "spec sheet",
    "drawing",
    "schematic",
    "blueprint",
    "infographic",
)

STOCK_OR_WATERMARK_HOSTS = {
    "shutterstock.com",
    "istockphoto.com",
    "gettyimages.com",
    "dreamstime.com",
    "alamy.com",
    "123rf.com",
    "adobe.com",
    "stock.adobe.com",
    "depositphotos.com",
    "vecteezy.com",
    "freepik.com",
}

# A bounded, configurable lexicon for conservative brand inference. It is not a
# statement that a brand owns or permits any image; manufacturer domains are
# verified separately below.
DEFAULT_KNOWN_BRANDS: tuple[str, ...] = (
    "lg",
    "samsung",
    "sony",
    "panasonic",
    "philips",
    "tcl",
    "hisense",
    "toshiba",
    "sharp",
    "jvc",
    "bose",
    "jbl",
    "denon",
    "yamaha",
    "dyson",
    "bosch",
    "siemens",
    "miele",
    "beko",
    "electrolux",
    "whirlpool",
    "haier",
    "hoover",
    "rowenta",
    "tefal",
    "delonghi",
    "nespresso",
    "keurig",
    "dewalt",
    "stanley",
    "makita",
    "milwaukee",
    "ryobi",
    "einhell",
    "worx",
    "black decker",
    "apple",
    "dell",
    "hp",
    "lenovo",
    "asus",
    "acer",
    "microsoft",
    "canon",
    "nikon",
    "fujifilm",
    "olympus",
    "gopro",
    "dji",
    "anker",
    "belkin",
    "netgear",
    "tp-link",
    "d-link",
    "ubiquiti",
    "cisco",
    "seagate",
    "sandisk",
    "kingston",
    "logitech",
    "razer",
    "corsair",
    "ikea",
    "samsonite",
    "rimowa",
)

# Words that are also ordinary nouns. They only infer a brand beside a fitting
# product type.
CONTEXT_BRANDS = {"apple", "sharp"}
CONTEXT_BRAND_TYPES = {"tv", "laptop", "camera"}

# A deliberately small, deterministic alias map for common product-family names.
# It never asserts an exact model; the item type must still match.
PRODUCT_BRAND_ALIASES: dict[str, tuple[str, ...]] = {
    "sony": ("ps5", "playstation 5", "playstation5"),
}
# Narrow, explicit spelling normalization for structured brand values. These
# are query-time only and never rewrite the stored inventory record.
BRAND_SPELLING_ALIASES: dict[str, str] = {
    "stanely": "stanley",
}

DEFAULT_MANUFACTURER_DOMAINS: dict[str, tuple[str, ...]] = {
    "lg": ("lg.com",),
    "samsung": ("samsung.com",),
    "sony": ("sony.com",),
    "panasonic": ("panasonic.com",),
    "philips": ("philips.com",),
    "tcl": ("tcl.com",),
    "hisense": ("hisense.com",),
    "toshiba": ("toshiba.com",),
    "sharp": ("sharp.com",),
    "jvc": ("jvc.com",),
    "bose": ("bose.com",),
    "jbl": ("jbl.com",),
    "denon": ("denon.com",),
    "yamaha": ("yamaha.com",),
    "dyson": ("dyson.com",),
    "bosch": ("bosch.com",),
    "siemens": ("siemens.com",),
    "miele": ("miele.com",),
    "beko": ("beko.com",),
    "electrolux": ("electrolux.com",),
    "whirlpool": ("whirlpool.com",),
    "haier": ("haier.com",),
    "hoover": ("hoover.com",),
    "rowenta": ("rowenta.com",),
    "tefal": ("tefal.com",),
    "delonghi": ("delonghi.com",),
    "nespresso": ("nespresso.com",),
    "keurig": ("keurig.com",),
    "dewalt": ("dewalt.com",),
    "stanley": ("stanleytools.com", "stanleyblackanddecker.com"),
    "makita": ("makita.com",),
    "milwaukee": ("milwaukeetool.com",),
    "ryobi": ("ryobitools.com",),
    "einhell": ("einhell.com",),
    "worx": ("worx.com",),
    "black decker": ("blackanddecker.com",),
    "apple": ("apple.com",),
    "dell": ("dell.com",),
    "hp": ("hp.com",),
    "lenovo": ("lenovo.com",),
    "asus": ("asus.com",),
    "acer": ("acer.com",),
    "microsoft": ("microsoft.com",),
    "canon": ("canon.com",),
    "nikon": ("nikon.com",),
    "fujifilm": ("fujifilm.com",),
    "olympus": ("olympus.com",),
    "gopro": ("gopro.com",),
    "dji": ("dji.com",),
    "anker": ("anker.com",),
    "belkin": ("belkin.com",),
    "netgear": ("netgear.com",),
    "tp-link": ("tp-link.com",),
    "d-link": ("d-link.com",),
    "ubiquiti": ("ui.com",),
    "cisco": ("cisco.com",),
    "seagate": ("seagate.com",),
    "sandisk": ("sandisk.com",),
    "kingston": ("kingston.com",),
    "logitech": ("logitech.com",),
    "razer": ("razer.com",),
    "corsair": ("corsair.com",),
    "ikea": ("ikea.com",),
    "samsonite": ("samsonite.com",),
    "rimowa": ("rimowa.com",),
}


_MULTI_PART_SUFFIXES = {
    "co.uk",
    "co.jp",
    "co.nz",
    "co.za",
    "co.in",
    "com.au",
    "com.br",
    "com.cn",
    "com.mx",
    "com.tr",
    "com.sg",
    "com.hk",
    # Shared hosting suffixes need one extra label so a tenant policy does not
    # silently widen to every unrelated tenant on the same platform.
    "azurewebsites.net",
    "blogspot.com",
    "cloudfront.net",
    "firebaseapp.com",
    "github.io",
    "herokuapp.com",
    "netlify.app",
    "pages.dev",
    "vercel.app",
    "web.app",
    "wordpress.com",
}

_TYPE_CONFLICTS = {
    "tv": ("laptop", "monitor stand", "phone", "refrigerator", "washing machine"),
    "laptop": ("television", "desktop monitor", "tablet"),
    "drill": ("mill", "drill bit set only", "lathe"),
    "suitcase": ("backpack", "handbag", "briefcase"),
    "chair": ("sofa", "bed", "table"),
    "sofa": ("chair", "bed", "mattress"),
    "camera": ("webcam cover", "doorbell", "security camera mount"),
    "kettle": ("coffee machine", "toaster", "saucepan"),
    "bicycle": ("motorcycle", "tricycle", "car"),
    "toolbox": ("bag", "backpack", "handbag"),
}

_TYPE_TERMS: dict[str, tuple[str, ...]] = {
    "tv": ("tv", "television"),
    "laptop": ("laptop", "notebook", "macbook"),
    "drill": ("drill", "impact driver"),
    "suitcase": ("suitcase", "luggage", "travel case"),
    "box": ("box", "storage bin", "crate"),
    "toolbox": ("toolbox", "tool box", "tool chest", "tool case"),
    "chair": ("chair", "stool", "armchair"),
    "sofa": ("sofa", "couch", "settee"),
    "camera": ("camera", "dslr", "mirrorless", "eos"),
    "kettle": ("kettle", "teapot", "electric kettle"),
    "bicycle": ("bicycle", "bike", "cycle"),
    "book": ("book", "novel", "paperback", "hardcover"),
    "ethernet-cable": ("ethernet", "network cable", "rj45", "cat6", "cat 6"),
}

_TYPE_QUERY_WORDS = {
    "tv": "TV",
    "laptop": "laptop",
    "drill": "drill",
    "suitcase": "suitcase",
    "box": "storage box",
    "toolbox": "toolbox",
    "chair": "chair",
    "sofa": "sofa",
    "camera": "camera",
    "kettle": "kettle",
    "bicycle": "bicycle",
    "book": "book",
    "ethernet-cable": "ethernet cable",
}

_TECH_PHRASES = {
    "mini led": "lcd_led",
    "micro led": "lcd_led",
}
_TECH_TOKENS = {
    "oled": "oled",
    "qled": "lcd_led",
    "lcd": "lcd_led",
    "led": "lcd_led",
    "plasma": "plasma",
}
_VARIANT_TOKENS = {"pro", "plus", "max", "ultra", "mini", "lite", "se", "air", "neo", "evo"}

_INCH_QUOTE_RE = re.compile(r"(?<!\d)(\d{2,3})\s*(?:\"|”|''|inches\b|inch\b|in\b)", re.IGNORECASE)


@dataclass(frozen=True)
class ImageCandidate:
    title: str
    page_url: str
    source_domain: str
    image_url: str
    thumbnail_url: str | None
    width: int | None
    height: int | None
    # Only populated when a provider supplies explicit license metadata. The
    # current documented Brave Image Search response does not include it.
    license_name: str | None = None
    license_url: str | None = None


@dataclass(frozen=True)
class RankedImage:
    candidate: ImageCandidate
    score: int
    exact_model_confirmed: bool
    manufacturer_verified: bool = False


@dataclass(frozen=True)
class ProductProfile:
    """Temporary query-only interpretation of an item.

    Every field is derived on demand and discarded. None of it is persisted as
    an inventory fact.
    """

    brand: str | None
    brand_source: Literal["structured", "inferred"] | None
    brand_ambiguous: bool
    brand_terms: frozenset[str]
    item_type: str | None
    sizes: frozenset[int]
    tech_families: frozenset[str]
    variants: frozenset[str]
    model: str | None

    @property
    def size_constraint(self) -> int | None:
        return next(iter(self.sizes)) if len(self.sizes) == 1 else None

    @property
    def tech_constraint(self) -> str | None:
        return next(iter(self.tech_families)) if len(self.tech_families) == 1 else None


def _normalized(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _compact(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def _word_tokens(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", (value or "").lower())


def _attribute_tokens(value: str | None) -> list[str]:
    lowered = (value or "").lower()
    lowered = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", lowered)
    return re.findall(r"[a-z0-9]+", lowered)


def _phrase_present(tokens: list[str], phrase: list[str]) -> bool:
    if not phrase or len(phrase) > len(tokens):
        return False
    width = len(phrase)
    return any(tokens[index : index + width] == phrase for index in range(len(tokens) - width + 1))


def _split_config(value: str | None) -> list[str]:
    return [entry.strip() for entry in re.split(r"[,;\n]+", value or "") if entry.strip()]


def _registrable_domain(host: str | None) -> str:
    labels = [label for label in (host or "").strip().strip(".").lower().split(".") if label]
    if len(labels) <= 2:
        return ".".join(labels)
    if ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _host_in_domain(host: str, domain: str) -> bool:
    clean = host.strip(".").lower()
    return clean == domain or clean.endswith(f".{domain}")


def _known_brands() -> tuple[str, ...]:
    entries = list(DEFAULT_KNOWN_BRANDS)
    entries.extend(_split_config(get_settings().item_image_known_brands))
    return tuple(dict.fromkeys(entry.lower() for entry in entries))


def _configured_manufacturer_domains() -> dict[str, tuple[str, ...]]:
    overrides: dict[str, tuple[str, ...]] = {}
    for entry in _split_config(get_settings().item_image_manufacturer_domains):
        brand, separator, domains = entry.partition("=")
        if not separator:
            continue
        key = _compact(brand)
        values = tuple(
            domain
            for domain in (_registrable_domain(value) for value in re.split(r"[| ]+", domains))
            if domain and "." in domain
        )
        if key and values:
            overrides[key] = values
    return overrides


def _manufacturer_domains(brand: str | None) -> tuple[str, ...]:
    key = _compact(brand)
    if not key:
        return ()
    configured = _configured_manufacturer_domains()
    if key in configured:
        return configured[key]
    return DEFAULT_MANUFACTURER_DOMAINS.get(key, ())


def _manufacturer_verified(brand: str | None, host: str | None) -> bool:
    if not host:
        return False
    return any(_host_in_domain(host, domain) for domain in _manufacturer_domains(brand))


def _deceptive_brand_host(brand: str | None, host: str | None) -> bool:
    """Detect brand-bearing hosts that are not the verified manufacturer domain."""
    if not brand or not host:
        return False
    if _manufacturer_verified(brand, host):
        return False
    compact_brand = _compact(brand)
    if len(compact_brand) < 2:
        return False
    for label in host.split("."):
        compact_label = _compact(label)
        if len(compact_label) < len(compact_brand):
            continue
        if (
            compact_label == compact_brand
            or compact_label.startswith(compact_brand)
            or compact_label.endswith(compact_brand)
        ):
            return True
    return False


def _infer_brand(
    name: str,
    description: str,
    item_type: str | None,
) -> tuple[str | None, bool]:
    name_tokens = _word_tokens(name)
    description_tokens = _word_tokens(description)
    type_words = [
        word for term in _TYPE_TERMS.get(item_type or "", ()) for word in _word_tokens(term)
    ]
    matches: list[str] = []
    for brand in _known_brands():
        phrase = _word_tokens(brand)
        if not phrase:
            continue
        if _phrase_present(name_tokens, phrase):
            matches.append(brand)
            continue
        if not _phrase_present(description_tokens, phrase):
            continue
        index = next(
            (
                position
                for position in range(len(description_tokens) - len(phrase) + 1)
                if description_tokens[position : position + len(phrase)] == phrase
            ),
            None,
        )
        if index is None:
            continue
        nearby = description_tokens[max(0, index - 2) : index + len(phrase) + 3]
        if any(_phrase_present(nearby, [word]) for word in type_words):
            matches.append(brand)
    distinct = list(dict.fromkeys(matches))
    if len(distinct) > 1:
        return None, True
    if len(distinct) == 1:
        brand = distinct[0]
        if _compact(brand) in CONTEXT_BRANDS and item_type not in CONTEXT_BRAND_TYPES:
            return None, False
        return brand, False
    return None, False


def _sizes(value: str | None) -> frozenset[int]:
    found: set[int] = set()
    for match in _INCH_QUOTE_RE.finditer(value or ""):
        size = int(match.group(1))
        if 10 <= size <= 200:
            found.add(size)
    tokens = _attribute_tokens(value)
    for index, token in enumerate(tokens[:-1]):
        if token.isdigit() and tokens[index + 1] in {"inch", "inches", "in"}:
            size = int(token)
            if 10 <= size <= 200:
                found.add(size)
    return frozenset(found)


def _tech_families(value: str | None) -> frozenset[str]:
    tokens = _attribute_tokens(value)
    text = " ".join(tokens)
    families = {family for phrase, family in _TECH_PHRASES.items() if phrase in text}
    families.update(_TECH_TOKENS[token] for token in tokens if token in _TECH_TOKENS)
    return frozenset(families)


def _variants(value: str | None) -> frozenset[str]:
    return frozenset(token for token in _attribute_tokens(value) if token in _VARIANT_TOKENS)


def build_product_profile(item: Item) -> ProductProfile:
    name = item.name or ""
    description = item.description or ""
    combined = f"{name} {description}"
    tokens = _attribute_tokens(combined)
    sizes = _sizes(combined)
    technologies = _tech_families(" ".join(tokens))
    variants = _variants(combined)
    item_type = item_type_key(item)
    if item_type is None and sizes and technologies:
        item_type = "tv"
    brand = (item.brand or "").strip() or None
    brand_source: Literal["structured", "inferred"] | None = "structured" if brand else None
    brand_ambiguous = False
    if brand is not None:
        compact_brand = _compact(brand)
        if compact_brand in PRODUCT_BRAND_ALIASES:
            brand = compact_brand
        else:
            for canonical, aliases in PRODUCT_BRAND_ALIASES.items():
                if compact_brand in {_compact(alias) for alias in aliases}:
                    brand = canonical
                    break
    if brand is None:
        for canonical, aliases in PRODUCT_BRAND_ALIASES.items():
            if any(
                _phrase_present(_word_tokens(combined), _word_tokens(alias)) for alias in aliases
            ):
                brand = canonical
                brand_source = "inferred"
                break
        if brand is None:
            brand, brand_ambiguous = _infer_brand(name, description, item_type)
            if brand is not None:
                brand_source = "inferred"
    if brand is not None:
        brand = BRAND_SPELLING_ALIASES.get(_compact(brand), brand)
    brand_terms = {_normalized(brand)} if brand else set()
    if brand:
        for canonical, aliases in PRODUCT_BRAND_ALIASES.items():
            if _compact(brand) == _compact(canonical):
                for alias in aliases:
                    if _phrase_present(_word_tokens(combined), _word_tokens(alias)):
                        brand_terms.add(_normalized(alias))
    return ProductProfile(
        brand=brand,
        brand_source=brand_source,
        brand_ambiguous=brand_ambiguous,
        brand_terms=frozenset(term for term in brand_terms if term),
        item_type=item_type,
        sizes=sizes,
        tech_families=technologies,
        variants=variants,
        model=(item.model or "").strip() or None,
    )


def _searchable_model(model: str | None) -> bool:
    return len(_compact(model)) >= 2


def _profile_search_ready(profile: ProductProfile) -> bool:
    return bool(
        profile.brand
        and (profile.item_type or _searchable_model(profile.model))
        and not profile.brand_ambiguous
    )


def reference_search_ready(item: Item) -> bool:
    return _profile_search_ready(build_product_profile(item))


def _query(item: Item, profile: ProductProfile) -> str:
    parts: list[str] = []
    name_tokens = _word_tokens(item.name)
    if profile.brand and not _phrase_present(name_tokens, _word_tokens(profile.brand)):
        parts.append(profile.brand)
    parts.extend(part for part in (item.name, item.model, item.description) if part)
    if profile.item_type:
        type_words = " ".join(_TYPE_TERMS.get(profile.item_type, ()))
        if type_words and not _phrase_present(
            _attribute_tokens(" ".join(parts)), _attribute_tokens(type_words)
        ):
            parts.append(_TYPE_QUERY_WORDS.get(profile.item_type, ""))
    text = " ".join(part for part in parts if part and part.strip())
    words = text.split()[:MAX_QUERY_WORDS]
    return " ".join(words)[:MAX_QUERY_CHARS]


def _valid_url(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text or len(text) > 2000:
        return None
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    return text


def _candidate_hosts(candidate: ImageCandidate) -> tuple[str, str, str]:
    page_host = (urlparse(candidate.page_url).hostname or "").lower()
    image_host = (urlparse(candidate.image_url).hostname or "").lower()
    thumbnail_host = (urlparse(candidate.thumbnail_url or "").hostname or "").lower()
    return page_host, image_host, thumbnail_host


def _source_domain_consistent(candidate: ImageCandidate) -> bool:
    page_host, _image_host, _thumbnail_host = _candidate_hosts(candidate)
    raw = (candidate.source_domain or "").strip().lower()
    if not raw:
        return True
    source_host = urlparse(raw if "//" in raw else f"//{raw}").hostname or raw
    if "." not in source_host:
        return True
    return _registrable_domain(source_host) == _registrable_domain(page_host)


def _type_evidence(item_type: str | None, value: str) -> bool:
    if not item_type:
        return False
    text_tokens = _attribute_tokens(value)
    for term in _TYPE_TERMS.get(item_type, ()):
        if _phrase_present(text_tokens, _attribute_tokens(term)):
            return True
    return bool(item_type == "tv" and (_sizes(value) or _tech_families(value)))


def _type_conflict(item_type: str | None, value: str) -> bool:
    if not item_type:
        return False
    lowered = f" {_normalized(value)} "
    conflicts = _TYPE_CONFLICTS.get(item_type, ())
    current_terms = _TYPE_TERMS.get(item_type, (item_type.replace("-", " "),))
    if any(f" {term} " in lowered for term in conflicts):
        return not any(f" {term} " in lowered for term in current_terms)
    return False


def _model_windows(tokens: list[str]) -> set[str]:
    windows: set[str] = set()
    for index in range(len(tokens)):
        for end in range(index + 1, min(index + 5, len(tokens) + 1)):
            windows.add("".join(tokens[index:end]))
    return windows


def _model_present(model: str, tokens: list[str]) -> bool:
    target = _compact(model)
    return _searchable_model(model) and target in _model_windows(tokens)


def _model_conflict(model: str | None, tokens: list[str]) -> bool:
    """Reject attached longer model identifiers such as A10 for model A1."""
    if not model:
        return False
    target = _compact(model)
    if len(target) < 2:
        return False
    for token in tokens:
        compact_token = _compact(token)
        if compact_token == target:
            continue
        if compact_token.startswith(target) and compact_token[len(target) :].isdigit():
            return True
    return False


def parse_brave_image_results(payload: dict[str, Any]) -> list[ImageCandidate]:
    results = payload.get("results")
    if not isinstance(results, list):
        return []
    candidates: list[ImageCandidate] = []
    for entry in results[:30]:
        if not isinstance(entry, dict):
            continue
        title = _normalized(entry.get("title"))[:300]
        page_url = _valid_url(entry.get("url"))
        properties = entry.get("properties") if isinstance(entry.get("properties"), dict) else {}
        thumbnail = entry.get("thumbnail") if isinstance(entry.get("thumbnail"), dict) else {}
        image_url = _valid_url(properties.get("url"))
        thumbnail_url = _valid_url(thumbnail.get("src"))
        if not page_url or (not image_url and not thumbnail_url):
            continue
        source_domain = (
            _normalized(entry.get("source")) or (urlparse(page_url).hostname or "").lower()
        )
        width = properties.get("width") if isinstance(properties.get("width"), int) else None
        height = properties.get("height") if isinstance(properties.get("height"), int) else None
        candidates.append(
            ImageCandidate(
                title=title,
                page_url=page_url,
                source_domain=source_domain[:200],
                image_url=image_url or "",
                thumbnail_url=thumbnail_url,
                width=width,
                height=height,
            )
        )
    return candidates


def rank_candidates(item: Item, candidates: list[ImageCandidate]) -> list[RankedImage]:
    profile = build_product_profile(item)
    if not _profile_search_ready(profile):
        return []
    ranked: list[RankedImage] = []
    for candidate in candidates:
        page_host, image_host, thumbnail_host = _candidate_hosts(candidate)
        if any(
            host == stock_host or host.endswith(f".{stock_host}")
            for host in (page_host, image_host, thumbnail_host)
            for stock_host in STOCK_OR_WATERMARK_HOSTS
        ):
            continue
        if _deceptive_brand_host(profile.brand, page_host) or _deceptive_brand_host(
            profile.brand, image_host
        ):
            continue
        if not _source_domain_consistent(candidate):
            continue
        # Attribute/model conflicts use title and provenance hosts only. A URL
        # path can mention other models/technologies and must not make a
        # contradictory candidate look compatible.
        text = " ".join(
            [
                candidate.title,
                candidate.source_domain,
                page_host,
                image_host,
            ]
        )
        tokens = _word_tokens(text)
        title_tokens = _word_tokens(candidate.title)
        # Model evidence is title-only: provenance hosts cannot confirm an exact
        # model or substitute for unknown product-type evidence.
        model_present = bool(profile.model and _model_present(profile.model, title_tokens))
        model_conflict = _model_conflict(profile.model, tokens)
        if model_conflict:
            continue
        brand_in_title = any(
            _phrase_present(title_tokens, _word_tokens(term)) for term in profile.brand_terms
        )
        manufacturer_verified = _manufacturer_verified(profile.brand, page_host)
        if not brand_in_title and not manufacturer_verified:
            continue
        if _type_conflict(profile.item_type, text):
            continue

        candidate_sizes = _sizes(text)
        candidate_technologies = _tech_families(text)
        candidate_variants = _variants(text)
        size_conflict = bool(
            profile.size_constraint
            and candidate_sizes
            and profile.size_constraint not in candidate_sizes
        )
        tech_conflict = bool(
            profile.tech_constraint
            and candidate_technologies
            and profile.tech_constraint not in candidate_technologies
        )
        variant_conflict = bool(
            profile.variants and candidate_variants and not (profile.variants & candidate_variants)
        )
        if size_conflict or tech_conflict or variant_conflict:
            continue
        size_match = bool(profile.size_constraint and profile.size_constraint in candidate_sizes)
        tech_match = bool(
            profile.tech_constraint and profile.tech_constraint in candidate_technologies
        )
        variant_match = bool(profile.variants and profile.variants <= candidate_variants)
        type_evidence = _type_evidence(profile.item_type, text) or (
            model_present and not model_conflict
        )
        if not type_evidence:
            continue
        exact = bool(
            profile.model
            and model_present
            and not model_conflict
            and candidate_variants == profile.variants
        )
        score = 0
        if brand_in_title:
            score += 8
        if manufacturer_verified:
            score += 8
        if type_evidence:
            score += 6
        if size_match:
            score += 6
        if tech_match:
            score += 4
        if variant_match:
            score += 3
        if exact:
            score += 10
        if candidate.width and candidate.height:
            if 400 <= candidate.width <= 5000 and 400 <= candidate.height <= 5000:
                score += 2
            ratio = candidate.width / max(candidate.height, 1)
            if 0.5 <= ratio <= 2.0:
                score += 2
            candidate_short = min(candidate.width, candidate.height)
            candidate_long = max(candidate.width, candidate.height)
            candidate_area = candidate.width * candidate.height
            if candidate_short >= REFERENCE_MIN_SHORT_SIDE and candidate_area >= REFERENCE_MIN_AREA:
                score += 5
            elif (
                candidate_short >= REFERENCE_THIN_MIN_SHORT_SIDE
                and candidate_long >= REFERENCE_THIN_MIN_LONG_SIDE
                and candidate_area >= REFERENCE_THIN_MIN_AREA
                and candidate_long / max(candidate_short, 1) >= REFERENCE_THIN_MIN_RATIO
            ):
                score += 2
            else:
                # Metadata may be deceptive; this only affects ordering.
                # Decoded dimensions are validated before any store.
                score -= 6

        # Prefer usable product photography over specification sheets,
        # measurement diagrams, text-heavy marketing collages and packaging
        # shots when the item is the product itself. This is metadata-only and
        # does not depend on an AI provider.
        item_text = " ".join(
            part
            for part in [
                item.name,
                item.description,
                item.category.name if item.category else "",
            ]
            if part
        )
        item_tokens = _word_tokens(item_text)
        diagram_item = any(
            _phrase_present(item_tokens, _word_tokens(term)) for term in DIAGRAM_ITEM_TERMS
        )
        if not diagram_item:
            image_text = " ".join(
                [
                    candidate.title,
                    urlparse(candidate.page_url).path,
                    urlparse(candidate.image_url).path,
                    candidate.source_domain,
                ]
            )
            image_tokens = _word_tokens(image_text)
            info_terms = INFOGRAPHIC_TERMS
            if profile.item_type == "box":
                info_terms = tuple(
                    term for term in INFOGRAPHIC_TERMS if term not in PACKAGING_TERMS
                )
            info_hits = sum(
                1 for term in info_terms if _phrase_present(image_tokens, _word_tokens(term))
            )
            clean_hits = sum(
                1
                for term in CLEAN_PRODUCT_TERMS
                if _phrase_present(image_tokens, _word_tokens(term))
            )
            score += clean_hits * 4
            score -= info_hits * 8
            if profile.item_type != "box":
                packaging_hits = sum(
                    1
                    for term in PACKAGING_TERMS
                    if _phrase_present(image_tokens, _word_tokens(term))
                )
                score -= packaging_hits * 10
        if score < 12:
            continue
        ranked.append(
            RankedImage(
                candidate=candidate,
                score=score,
                exact_model_confirmed=exact,
                manufacturer_verified=manufacturer_verified,
            )
        )
    ranked.sort(key=lambda entry: (-entry.score, entry.candidate.page_url))
    return ranked


def _reference_dimensions_ok(width: int, height: int) -> bool:
    short = min(width, height)
    long = max(width, height)
    area = width * height
    if short >= REFERENCE_MIN_SHORT_SIDE and area >= REFERENCE_MIN_AREA:
        return True
    return bool(
        short >= REFERENCE_THIN_MIN_SHORT_SIDE
        and long >= REFERENCE_THIN_MIN_LONG_SIDE
        and area >= REFERENCE_THIN_MIN_AREA
        and long / max(short, 1) >= REFERENCE_THIN_MIN_RATIO
    )
