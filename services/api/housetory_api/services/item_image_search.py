"""Brave Image Search adapter with conservative, provenance-gated selection.

The matcher builds a temporary, query-only product profile from the item. It
never writes inferred brands, dimensions, technologies or model guesses back to
inventory records. Candidate selection requires compatible known attributes and
an explicit source-permission policy before any automatic local download.
"""

from __future__ import annotations

import contextlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlencode, urlparse

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..models import Item, ItemImage
from . import online_search, storage
from .item_images import (
    active_image,
    clear_active_images,
    image_search_fingerprint,
    item_type_key,
)
from .manual_web import (
    ManualFetchError,
    _read_bounded,
    _request_following_redirects,
)

BRAVE_IMAGE_SEARCH_PATH = "/res/v1/images/search"
MAX_SEARCH_RESPONSE_BYTES = 1_000_000
MAX_QUERY_CHARS = 400
MAX_QUERY_WORDS = 50

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

DEFAULT_PERMITTED_LICENSES = ("cc0", "cc-by", "cc-by-sa", "public-domain")

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
}

_TYPE_TERMS: dict[str, tuple[str, ...]] = {
    "tv": ("tv", "television"),
    "laptop": ("laptop", "notebook", "macbook"),
    "drill": ("drill", "impact driver"),
    "suitcase": ("suitcase", "luggage", "travel case"),
    "box": ("box", "storage bin", "crate"),
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
class ImageSearchProvider:
    kind: str
    label: str | None = None
    reason: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    source: Literal["household", "environment", "none"] = "environment"
    permitted_domains: frozenset[str] = frozenset()

    @property
    def configured(self) -> bool:
        return self.kind == "brave" and bool(self.api_key and self.base_url)


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
class SourcePermission:
    kind: Literal["configured_source_policy", "provider_license"]
    label: str
    evidence_url: str | None

    def note(self) -> str:
        if self.kind == "provider_license":
            return (
                f"Provider metadata records the license {self.label}"
                f"{f' ({self.evidence_url})' if self.evidence_url else ''}. "
                "This is recorded evidence, not an independent legal determination "
                "or a guarantee that the source's terms permit reuse."
            )
        return (
            f"Download allowed by the server's configured permitted-source policy "
            f"for {self.label}. Source page and retrieval time are recorded. This "
            "records an operator policy, not a legal determination or permission "
            "guarantee; review the source's terms before reuse."
        )


@dataclass(frozen=True)
class ProductProfile:
    """Temporary query-only interpretation of an item.

    Every field is derived on demand and discarded. None of it is persisted as
    an inventory fact.
    """

    brand: str | None
    brand_source: Literal["structured", "inferred"] | None
    brand_ambiguous: bool
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


def resolve_image_search_provider(
    db: Session | None = None,
    household_id: uuid.UUID | None = None,
) -> ImageSearchProvider:
    settings = get_settings()
    if db is not None and household_id is not None:
        row = online_search.get_row(db, household_id)
        if row is not None:
            if row.provider != "brave":
                return ImageSearchProvider(
                    kind="none",
                    reason="This household selected an unsupported online search provider.",
                    source="household",
                )
            if not row.reference_enabled:
                return ImageSearchProvider(
                    kind="none",
                    reason=online_search.REFERENCE_DISABLED_REASON,
                    source="household",
                )
            key, reason = online_search.decrypt_household_key(row)
            if not key:
                return ImageSearchProvider(
                    kind="none",
                    reason=reason or online_search.NO_KEY_REASON,
                    source="household",
                )
            base = settings.brave_search_base_url.strip().rstrip("/")
            parsed = urlparse(base)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                return ImageSearchProvider(
                    kind="none",
                    reason="BRAVE_SEARCH_BASE_URL must be an absolute http(s) URL.",
                    source="household",
                )
            if parsed.username or parsed.password:
                return ImageSearchProvider(
                    kind="none",
                    reason="BRAVE_SEARCH_BASE_URL must not contain embedded credentials.",
                    source="household",
                )
            return ImageSearchProvider(
                kind="brave",
                label="Brave Image Search API",
                api_key=key,
                base_url=base,
                source="household",
                permitted_domains=online_search.effective_domains(row),
            )
    configured_mode = settings.item_image_search_provider
    if configured_mode == "none":
        return ImageSearchProvider(
            kind="none",
            reason=(
                "Online reference-image search is disabled. The category icon fallback "
                "remains available offline."
            ),
            source="environment",
        )
    key = settings.brave_search_api_key.strip()
    if not key:
        return ImageSearchProvider(
            kind="none",
            reason=(
                "Reference-image search is not configured. Add a Brave Search API key "
                "in Settings → Online search, or set the installation fallback "
                "BRAVE_SEARCH_API_KEY. The category icon fallback remains available "
                "without it."
            ),
            source="none",
        )
    base = settings.brave_search_base_url.strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ImageSearchProvider(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must be an absolute http(s) URL.",
            source="environment",
        )
    if parsed.username or parsed.password:
        return ImageSearchProvider(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must not contain embedded credentials.",
            source="environment",
        )
    return ImageSearchProvider(
        kind="brave",
        label="Brave Image Search API",
        api_key=key,
        base_url=base,
        source="environment",
        permitted_domains=_environment_permitted_source_domains(),
    )


def brave_image_connection_test(provider: ImageSearchProvider) -> None:
    """User-triggered bounded probe using a fixed neutral query."""
    if not provider.configured:
        raise ApiError(
            503,
            "image_search_unconfigured",
            provider.reason or "Image search is not configured.",
        )
    _brave_image_results(provider, "Housetory connectivity test")


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
    if brand is None:
        brand, brand_ambiguous = _infer_brand(name, description, item_type)
        if brand is not None:
            brand_source = "inferred"
    return ProductProfile(
        brand=brand,
        brand_source=brand_source,
        brand_ambiguous=brand_ambiguous,
        item_type=item_type,
        sizes=sizes,
        tech_families=technologies,
        variants=variants,
        model=(item.model or "").strip() or None,
    )


def reference_search_ready(item: Item) -> bool:
    profile = build_product_profile(item)
    return bool(profile.brand and profile.item_type and not profile.brand_ambiguous)


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
    return len(target) >= 2 and target in _model_windows(tokens)


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
    if profile.brand_ambiguous or not profile.brand or not profile.item_type:
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
        brand_in_title = _phrase_present(_word_tokens(candidate.title), _word_tokens(profile.brand))
        manufacturer_verified = _manufacturer_verified(profile.brand, page_host)
        if not brand_in_title and not manufacturer_verified:
            continue
        if _type_conflict(profile.item_type, text):
            continue

        tokens = _word_tokens(text)
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
        model_present = bool(profile.model and _model_present(profile.model, tokens))
        model_conflict = _model_conflict(profile.model, tokens)
        if model_conflict:
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


def _environment_permitted_source_domains() -> frozenset[str]:
    domains = set()
    for entry in _split_config(get_settings().item_image_permitted_source_domains):
        host = urlparse(entry if "//" in entry else f"//{entry}").hostname or entry
        domain = _registrable_domain(host.removeprefix("*."))
        if domain and "." in domain:
            domains.add(domain)
    return frozenset(domains)


def _permitted_source_domains(
    provider: ImageSearchProvider | None = None,
) -> frozenset[str]:
    if provider is not None:
        return provider.permitted_domains
    return _environment_permitted_source_domains()


def _permitted_license_names() -> frozenset[str]:
    configured = get_settings().item_image_permitted_licenses
    entries = _split_config(configured) if configured.strip() else list(DEFAULT_PERMITTED_LICENSES)
    return frozenset(_compact(entry) for entry in entries if _compact(entry))


def permitted_source_policy_configured(
    provider: ImageSearchProvider | None = None,
) -> bool:
    """The Brave adapter has no license metadata; it needs an explicit domain policy."""
    return bool(_permitted_source_domains(provider))


def _asset_host_permitted(
    candidate: ImageCandidate,
    provider: ImageSearchProvider | None = None,
) -> bool:
    domains = _permitted_source_domains(provider)
    if not domains:
        return False
    _page_host, image_host, thumbnail_host = _candidate_hosts(candidate)
    asset_host = image_host or thumbnail_host
    return bool(asset_host and _registrable_domain(asset_host) in domains)


def source_permission(
    candidate: ImageCandidate,
    provider: ImageSearchProvider | None = None,
) -> SourcePermission | None:
    if not _source_domain_consistent(candidate):
        return None
    license_name = _compact(candidate.license_name)
    if license_name and candidate.license_url and license_name in _permitted_license_names():
        return SourcePermission(
            kind="provider_license",
            label=candidate.license_name or license_name,
            evidence_url=candidate.license_url,
        )
    page_host, _image_host, _thumbnail_host = _candidate_hosts(candidate)
    domain = _registrable_domain(page_host)
    if (
        domain
        and domain in _permitted_source_domains(provider)
        and _asset_host_permitted(candidate, provider)
    ):
        return SourcePermission(
            kind="configured_source_policy",
            label=domain,
            evidence_url=candidate.page_url,
        )
    return None


def _url_permitted(
    url: str | None,
    permission: SourcePermission,
    provider: ImageSearchProvider | None = None,
) -> bool:
    if not url:
        return False
    if permission.kind == "provider_license":
        return True
    host = (urlparse(url).hostname or "").lower()
    return bool(host and _registrable_domain(host) in _permitted_source_domains(provider))


def _brave_image_results(provider: ImageSearchProvider, query: str) -> list[ImageCandidate]:
    import http.client

    if not provider.configured or not provider.api_key or not provider.base_url:
        raise ApiError(
            503, "image_search_unconfigured", provider.reason or "Image search is not configured."
        )
    settings = get_settings()
    parsed = urlparse(provider.base_url)
    params: dict[str, str | int] = {
        "q": query,
        "count": settings.item_image_search_count,
        "safesearch": "strict",
        "text_decorations": "false",
    }
    country = settings.brave_search_country.strip()
    language = settings.brave_search_lang.strip()
    if country:
        params["country"] = country
    if language:
        params["search_lang"] = language
    path = f"{parsed.path.rstrip('/')}{BRAVE_IMAGE_SEARCH_PATH}?{urlencode(params)}"
    connection_class = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = None
    try:
        connection = connection_class(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            timeout=settings.manual_search_timeout_seconds,
        )
        connection.request(
            "GET",
            path,
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "identity",
                "X-Subscription-Token": provider.api_key,
                "User-Agent": "HousetoryImageSearch/1.0",
            },
        )
        response = connection.getresponse()
        if response.status in {401, 403}:
            raise ApiError(
                502,
                "image_search_auth_failed",
                "Brave Image Search rejected the configured subscription token.",
            )
        if response.status == 429:
            raise ApiError(
                429,
                "image_search_rate_limited",
                "Brave Image Search rate limit reached; try again later.",
            )
        if 300 <= response.status < 400:
            raise ApiError(
                502,
                "image_search_redirect",
                "Brave Image Search returned a redirect; redirects are not followed.",
            )
        if response.status < 200 or response.status >= 300:
            raise ApiError(
                502,
                "image_search_failed",
                f"Brave Image Search returned HTTP {response.status}.",
            )
        data = _read_bounded(
            response,
            max_bytes=MAX_SEARCH_RESPONSE_BYTES,
            timeout=settings.manual_search_timeout_seconds,
            error_type=ManualFetchError,
        )
    except (OSError, TimeoutError, ValueError, http.client.HTTPException) as exc:
        raise ApiError(
            502,
            "image_search_unavailable",
            "Brave Image Search could not be reached safely.",
        ) from exc
    finally:
        with contextlib.suppress(Exception):
            if connection is not None:
                connection.close()
    try:
        payload = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(
            502,
            "image_search_invalid",
            "Brave Image Search returned invalid JSON.",
        ) from exc
    if not isinstance(payload, dict):
        raise ApiError(
            502,
            "image_search_invalid",
            "Brave Image Search returned an unexpected response.",
        )
    return parse_brave_image_results(payload)


def _download_candidate(
    candidate: ImageCandidate,
    *,
    permission: SourcePermission | None = None,
    provider: ImageSearchProvider | None = None,
) -> tuple[bytes, str, str]:
    settings = get_settings()
    max_bytes = settings.item_image_max_download_bytes
    last_error: Exception | None = None
    for url, label in (
        (candidate.image_url, "original"),
        (candidate.thumbnail_url, "thumbnail"),
    ):
        if not url:
            continue
        if permission is not None and not _url_permitted(url, permission, provider):
            last_error = ManualFetchError("The asset host is outside the permitted source policy.")
            continue
        try:
            status, headers, body, final_url = _request_following_redirects(
                url,
                timeout=settings.manual_search_timeout_seconds,
                max_bytes=max_bytes,
                accept="image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
            )
        except ManualFetchError as exc:
            last_error = exc
            continue
        if status != 200 or not body:
            last_error = ManualFetchError(f"Image source returned HTTP {status}.")
            continue
        content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if content_type and not content_type.startswith("image/"):
            last_error = ManualFetchError("The candidate was not an image response.")
            continue
        return body, final_url, label
    raise ApiError(
        422,
        "image_download_failed",
        "The selected image could not be downloaded safely; the category icon "
        "fallback remains available.",
    ) from last_error


def _reuse_household_reference(
    db: Session,
    item: Item,
    fingerprint: str,
    actor_user_id: uuid.UUID | None,
) -> ItemImage | None:
    existing = db.scalar(
        select(ItemImage)
        .where(
            ItemImage.household_id == item.household_id,
            ItemImage.item_id != item.id,
            ItemImage.source_type == "reference",
            ItemImage.status == "active",
            ItemImage.search_fingerprint == fingerprint,
            ItemImage.storage_key.is_not(None),
        )
        .order_by(ItemImage.created_at.desc())
        .limit(1)
    )
    if existing is None or existing.storage_key is None:
        return None
    try:
        content = storage.resolve_key(existing.storage_key).read_bytes()
    except (OSError, ApiError):
        return None
    stored = storage.store_item_image_bytes(
        item.household_id,
        item.id,
        content,
        source_type="reference",
        filename=existing.original_filename,
    )
    clear_active_images(db, item.id)
    image = ItemImage(
        household_id=item.household_id,
        item_id=item.id,
        created_by_user_id=actor_user_id,
        source_type="reference",
        status="active",
        storage_key=stored.storage_key,
        thumbnail_key=stored.thumbnail_key,
        original_filename=stored.original_filename,
        content_type=stored.content_type,
        byte_size=stored.byte_size,
        width=stored.width,
        height=stored.height,
        source_url=existing.source_url,
        source_name=existing.source_name,
        source_page_url=existing.source_page_url,
        license_note=existing.license_note,
        license_name=existing.license_name,
        license_url=existing.license_url,
        permission_basis=existing.permission_basis,
        retrieved_at=existing.retrieved_at,
        exact_model_confirmed=existing.exact_model_confirmed,
        model_label=existing.model_label,
        search_fingerprint=fingerprint,
    )
    db.add(image)
    db.flush()
    return image


def find_and_select_reference(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    *,
    actor_user_id: uuid.UUID | None,
    force: bool = False,
) -> ItemImage:
    # Serialize image decisions for one item.
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"housetory-item-image-{item.id}"},
    )
    db.expire(item, ["photos", "images", "category", "household"])
    if item.household_id != household_id:
        raise ApiError(404, "item_not_found", "Item not found.")
    if item.photos:
        raise ApiError(
            409,
            "actual_photo_exists",
            "Actual photos already take priority over reference images.",
        )
    fingerprint = image_search_fingerprint(item)
    if not force:
        current = active_image(item)
        if (
            current is not None
            and current.source_type == "reference"
            and current.search_fingerprint == fingerprint
        ):
            return current
        reused = _reuse_household_reference(db, item, fingerprint, actor_user_id)
        if reused is not None:
            return reused
    provider = resolve_image_search_provider(db, household_id)
    if not provider.configured:
        raise ApiError(
            503, "image_search_unconfigured", provider.reason or "Image search is not configured."
        )
    # The current documented Brave Image Search response carries no license
    # metadata, so this adapter requires an explicit domain policy. An adapter
    # that later supplies license evidence can pass source_permission instead.
    if provider.kind == "brave" and not permitted_source_policy_configured(provider):
        raise ApiError(
            503,
            "image_search_policy_unconfigured",
            "Reference-image downloads require at least one permitted source domain. "
            "Add domains in Settings → Online search. The category icon fallback "
            "remains available.",
        )
    profile = build_product_profile(item)
    if profile.brand_ambiguous or not profile.brand or not profile.item_type:
        raise ApiError(
            422,
            "image_description_required",
            "Add a recognizable product brand and type before finding a reference image. "
            "The category icon fallback remains available.",
        )
    query = _query(item, profile)
    if not query.strip():
        raise ApiError(
            422,
            "image_description_required",
            "Add a product name or description before finding a reference image.",
        )
    candidates = _brave_image_results(provider, query)
    ranked = rank_candidates(item, candidates)
    permitted: list[tuple[RankedImage, SourcePermission]] = []
    for entry in ranked:
        permission = source_permission(entry.candidate, provider)
        if permission is not None:
            permitted.append((entry, permission))
    if not permitted and ranked:
        raise ApiError(
            422,
            "no_permitted_image_candidate",
            "A compatible image was found, but its reuse permission is not established "
            "by the configured permitted-source policy or provider license evidence. "
            "The category icon fallback remains available.",
        )
    if not permitted:
        raise ApiError(
            422,
            "no_image_candidate",
            "No suitable compatible image source was found. The category icon "
            "fallback remains available.",
        )
    chosen, permission = permitted[0]
    content, final_url, _kind = _download_candidate(
        chosen.candidate,
        permission=permission,
        provider=provider,
    )
    # Recheck after the network call so a real photo/change cannot be overwritten.
    db.refresh(item, attribute_names=["photos", "updated_at"])
    if item.photos:
        raise ApiError(
            409,
            "actual_photo_exists",
            "A real photo was added while the reference image was downloading; it takes priority.",
        )
    stored = storage.store_item_image_bytes(
        household_id,
        item.id,
        content,
        source_type="reference",
        filename=(
            f"{_compact(profile.brand) or 'reference'}."
            f"{chosen.candidate.image_url.rsplit('.', 1)[-1][:5]}"
        ),
    )
    clear_active_images(db, item.id)
    image = ItemImage(
        household_id=household_id,
        item_id=item.id,
        created_by_user_id=actor_user_id,
        source_type="reference",
        status="active",
        storage_key=stored.storage_key,
        thumbnail_key=stored.thumbnail_key,
        original_filename=stored.original_filename,
        content_type=stored.content_type,
        byte_size=stored.byte_size,
        width=stored.width,
        height=stored.height,
        source_url=final_url or chosen.candidate.image_url,
        source_name=chosen.candidate.source_domain or chosen.candidate.title,
        source_page_url=chosen.candidate.page_url,
        license_note=permission.note(),
        license_name=chosen.candidate.license_name,
        license_url=chosen.candidate.license_url,
        permission_basis=permission.kind,
        retrieved_at=datetime.now(UTC),
        exact_model_confirmed=chosen.exact_model_confirmed,
        model_label=profile.model if chosen.exact_model_confirmed else None,
        search_fingerprint=fingerprint,
    )
    db.add(image)
    db.flush()
    return image
