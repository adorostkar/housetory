"""Bounded, SSRF-safe product-page reading for assisted item imports."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..config import get_settings
from .manual_web import (
    MAX_LANDING_PAGE_BYTES,
    ManualFetchError,
    _request_following_redirects,
)

MAX_PRODUCT_TITLE_CHARS = 500
MAX_PRODUCT_DESCRIPTION_CHARS = 8_000
MAX_PRODUCT_SITE_CHARS = 200
MAX_JSON_LD_CHARS = 200_000
TLD_CURRENCIES = {
    "se": "SEK",
    "no": "NOK",
    "dk": "DKK",
    "de": "EUR",
    "fr": "EUR",
    "it": "EUR",
    "es": "EUR",
    "nl": "EUR",
    "ie": "EUR",
    "fi": "EUR",
    "co.uk": "GBP",
    "com": "USD",
}


class ProductPageError(RuntimeError):
    """A safe, user-presentable product-page retrieval or parsing failure."""


@dataclass(frozen=True)
class ProductPage:
    text: str
    title: str
    final_url: str
    fields: dict[str, str] = field(default_factory=dict)


class _ProductMetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.og_title: str | None = None
        self.og_site_name: str | None = None
        self.description: str | None = None
        self.brand: str | None = None
        self.model: str | None = None
        self.price: str | None = None
        self.currency: str | None = None
        self._in_title = False
        self._in_json_ld = False
        self._json_ld: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = {key.lower(): (value or "") for key, value in attrs}
        if tag == "title":
            self._in_title = True
            return
        if tag == "script":
            self._in_json_ld = "ld+json" in attributes.get("type", "").lower()
            return
        if tag == "a" and attributes.get("id") == "bylineInfo" and self.brand is None:
            brands = parse_qs(urlparse(attributes.get("href", "")).query).get("field-brandtextbin")
            if brands and brands[0].strip():
                self.brand = brands[0].strip()[:120]
            return
        if tag != "meta":
            return
        itemprop = attributes.get("itemprop", "").strip().lower()
        if itemprop in {"price", "pricecurrency", "brand"} and attributes.get("content"):
            self._set_structured(itemprop, attributes["content"])
        key = (attributes.get("property") or attributes.get("name") or "").strip().lower()
        content = re.sub(r"\s+", " ", attributes.get("content", "")).strip()
        if not content:
            return
        if key == "og:title" and self.og_title is None:
            self.og_title = content[:MAX_PRODUCT_TITLE_CHARS]
        elif key == "og:site_name" and self.og_site_name is None:
            self.og_site_name = content[:MAX_PRODUCT_SITE_CHARS]
        elif key == "description" and self.description is None:
            self.description = content[:MAX_PRODUCT_DESCRIPTION_CHARS]
        elif key in {"product:price:amount", "og:price:amount"}:
            self._set_structured("price", content)
        elif key in {"product:price:currency", "og:price:currency"}:
            self._set_structured("pricecurrency", content)
        elif key in {"product:brand", "og:brand"}:
            self._set_structured("brand", content)

    def _set_structured(self, key: str, value: str) -> None:
        value = re.sub(r"\s+", " ", value).strip()[:120]
        if not value:
            return
        if key == "price" and self.price is None:
            self.price = value
        elif key == "pricecurrency" and self.currency is None:
            self.currency = value.upper()
        elif key == "brand" and self.brand is None:
            self.brand = value

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False
        elif tag.lower() == "script":
            if self._in_json_ld:
                self._json_ld.append("\x00")
            self._in_json_ld = False

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            if sum(len(part) for part in self._json_ld) < MAX_JSON_LD_CHARS:
                self._json_ld.append(data)
            return
        if self._in_title and sum(len(part) for part in self.title_parts) < MAX_PRODUCT_TITLE_CHARS:
            self.title_parts.append(data)

    def apply_json_ld(self) -> None:
        for raw in "".join(self._json_ld).split("\x00"):
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            for product in _json_ld_products(data):
                self._apply_product(product)

    def _apply_product(self, product: dict[str, Any]) -> None:
        brand = product.get("brand")
        if isinstance(brand, dict):
            brand = brand.get("name")
        if isinstance(brand, str):
            self._set_structured("brand", brand)
        for key in ("mpn", "model"):
            value = product.get(key)
            if isinstance(value, (str, int)) and self.model is None and str(value).strip():
                self.model = str(value).strip()[:120]
        offers = product.get("offers")
        for offer in offers if isinstance(offers, list) else [offers]:
            if not isinstance(offer, dict):
                continue
            price = offer.get("price", offer.get("lowPrice"))
            if isinstance(price, (str, int, float)):
                self._set_structured("price", str(price))
            currency = offer.get("priceCurrency")
            if isinstance(currency, str):
                self._set_structured("pricecurrency", currency)

    @property
    def title(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.title_parts)).strip()[:MAX_PRODUCT_TITLE_CHARS]


def _json_ld_products(data: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(data, list):
        for entry in data:
            found.extend(_json_ld_products(entry))
    elif isinstance(data, dict):
        kind = data.get("@type")
        kinds = kind if isinstance(kind, list) else [kind]
        if "Product" in kinds:
            found.append(data)
        found.extend(_json_ld_products(data.get("@graph")))
    return found


def clean_product_title(title: str) -> tuple[str, str | None]:
    """Strip a trailing site/category suffix such as ' : Amazon.se: Tools'.

    Returns the product name and, when present, the site label that followed it.
    """
    parts = re.split(r"\s+(?::|\|)\s+", title, maxsplit=1)
    name = parts[0].strip() or title
    site = None
    if len(parts) == 2:
        site = parts[1].split(":", 1)[0].split("|", 1)[0].strip() or None
    return name[:MAX_PRODUCT_TITLE_CHARS], site


def _model_from_title(title: str) -> str | None:
    """Marketplace titles often end with the model code, e.g. '..., 48 W, VTSS4N'."""
    last = title.rsplit(",", 1)[-1].strip() if "," in title else ""
    if re.fullmatch(r"(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{4,20}", last):
        return last
    return None


def _host_currency(host: str) -> str | None:
    labels = host.lower().split(".")
    for size in (2, 1):
        if len(labels) > size and ".".join(labels[-size:]) in TLD_CURRENCIES:
            return TLD_CURRENCIES[".".join(labels[-size:])]
    return None


def _normalize_price(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"[^\d.,]", "", value)
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        whole, _, fraction = cleaned.rpartition(",")
        cleaned = (
            f"{whole.replace(',', '')}.{fraction}"
            if len(fraction) == 2
            else cleaned.replace(",", "")
        )
    try:
        amount = float(cleaned)
    except ValueError:
        return None
    if not 0 < amount < 10_000_000:
        return None
    return f"{amount:.2f}"


def _single_line(value: str | None, limit: int = 200) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"\s+", " ", value).strip().lstrip("[-#").strip()
    return cleaned[:limit] or None


def render_product_note(page: ProductPage, purchase_date: str | None = None) -> str:
    """Render extracted fields as note front matter the import parser reads."""
    if not page.fields:
        text = page.text
        if purchase_date:
            text += f"\nPurchase date (explicit user fact): {purchase_date}\n"
        return text
    keys = ("name", "brand", "model", "merchant", "price", "currency")
    lines = ["---"]
    for key in keys:
        value = _single_line(page.fields.get(key))
        if value:
            lines.append(f"{key}: {value}")
    if purchase_date:
        lines.append(f"purchase_date: {purchase_date}")
    lines.extend(["---", page.text])
    return "\n".join(lines) + "\n"


def fetch_product_page(url: str) -> ProductPage:
    """Fetch only public HTML and retain a small set of product metadata.

    The request implementation is shared with manual retrieval, including pinned
    public DNS, redirect, byte and wall-clock limits. No page body, scripts,
    structured price data or linked resources are read.
    """

    settings = get_settings()
    try:
        status, headers, body, final_url = _request_following_redirects(
            url,
            timeout=settings.manual_search_timeout_seconds,
            max_bytes=MAX_LANDING_PAGE_BYTES,
            accept="text/html,application/xhtml+xml",
            truncate=True,
        )
    except ManualFetchError as exc:
        raise ProductPageError(
            f"The product page could not be fetched safely: {exc} Check the URL and try again."
        ) from exc
    if status != 200:
        raise ProductPageError(f"The product page returned HTTP {status}.")
    if (headers.get("content-encoding") or "identity").strip().lower() not in {"", "identity"}:
        raise ProductPageError("The product page used an unsupported content encoding.")
    content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type not in {"text/html", "application/xhtml+xml"} and not body.lstrip().startswith(
        b"<"
    ):
        raise ProductPageError("The product URL did not return a readable HTML page.")

    parser = _ProductMetadataParser()
    try:
        parser.feed(body.decode("utf-8", "replace"))
        parser.close()
    except Exception as exc:  # noqa: BLE001 - malformed HTML is a safe source failure
        raise ProductPageError(
            "The product page did not contain readable product details."
        ) from exc
    parser.apply_json_ld()
    raw_title = parser.og_title or parser.title
    if not raw_title and not parser.description:
        raise ProductPageError("The product page did not contain readable product details.")
    title, title_site = clean_product_title(raw_title) if raw_title else ("", None)
    host = (urlparse(final_url).hostname or "").lower().removeprefix("www.")
    host_label = host.split(".")[0] if host else ""
    merchant = parser.og_site_name
    if not merchant and title_site and host_label and host_label in title_site.lower():
        merchant = title_site
    if not merchant and host:
        merchant = host
    model = parser.model or _model_from_title(title)
    price = _normalize_price(parser.price)
    if price is None:
        match = re.search(
            r'"priceAmount"\s*:\s*([0-9]+(?:\.[0-9]+)?)', body.decode("utf-8", "replace")
        )
        price = _normalize_price(match.group(1)) if match else None
    currency = parser.currency or (_host_currency(host) if price else None)
    fields = {
        key: value
        for key, value in {
            "name": title,
            "brand": parser.brand,
            "model": model,
            "merchant": merchant,
            "price": price,
            "currency": currency,
        }.items()
        if value
    }

    lines = ["Product page metadata (untrusted source data)."]
    if raw_title:
        lines.append(f"Product: {raw_title}")
    if parser.title and parser.og_title and parser.title != parser.og_title:
        lines.append(f"Page title: {parser.title}")
    if parser.og_site_name:
        lines.append(f"Site: {parser.og_site_name}")
    if parser.description:
        lines.append(f"Description: {parser.description}")
    lines.extend(
        [
            f"Source URL: {final_url}",
            "The price, if any, is the current listing price on the page, not a verified "
            "purchase price. Do not infer a purchase date from this page.",
        ]
    )
    return ProductPage(
        text="\n".join(lines),
        title=title or "Product page",
        final_url=final_url,
        fields=fields,
    )
