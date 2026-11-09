"""Bounded, SSRF-safe product-page reading for assisted item imports."""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

from ..config import get_settings
from .manual_web import (
    MAX_LANDING_PAGE_BYTES,
    ManualFetchError,
    _request_following_redirects,
)

MAX_PRODUCT_TITLE_CHARS = 500
MAX_PRODUCT_DESCRIPTION_CHARS = 8_000
MAX_PRODUCT_SITE_CHARS = 200


class ProductPageError(RuntimeError):
    """A safe, user-presentable product-page retrieval or parsing failure."""


@dataclass(frozen=True)
class ProductPage:
    text: str
    title: str
    final_url: str


class _ProductMetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.og_title: str | None = None
        self.og_site_name: str | None = None
        self.description: str | None = None
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
            return
        if tag != "meta":
            return
        attributes = {key.lower(): (value or "") for key, value in attrs}
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

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and sum(len(part) for part in self.title_parts) < MAX_PRODUCT_TITLE_CHARS:
            self.title_parts.append(data)

    @property
    def title(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.title_parts)).strip()[:MAX_PRODUCT_TITLE_CHARS]


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
        )
    except ManualFetchError as exc:
        raise ProductPageError(
            "The product page could not be fetched safely. Check the URL and try again."
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
    title = parser.og_title or parser.title
    if not title and not parser.description:
        raise ProductPageError("The product page did not contain readable product details.")

    lines = ["Product page metadata (untrusted source data)."]
    if title:
        lines.append(f"Product: {title}")
    if parser.title and parser.og_title and parser.title != parser.og_title:
        lines.append(f"Page title: {parser.title}")
    if parser.og_site_name:
        lines.append(f"Site: {parser.og_site_name}")
    if parser.description:
        lines.append(f"Description: {parser.description}")
    lines.extend(
        [
            f"Source URL: {final_url}",
            "Current page prices and availability are not historical purchase facts. "
            "Do not infer a purchase price or purchase date from this page.",
        ]
    )
    return ProductPage(text="\n".join(lines), title=title or "Product page", final_url=final_url)
