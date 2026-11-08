"""Optional manual search adapters and SSRF-safe document retrieval.

Two supported backends are available:

- ``brave`` uses the official Brave Search API over HTTPS. The operator supplies
  a subscription token in ``BRAVE_SEARCH_API_KEY`` and Housetory searches only
  when a user explicitly asks for an exact confirmed manufacturer/model.
- ``gateway`` is the original advanced JSON gateway. It is useful for a custom
  internal search service, but it is no longer the only usable integration.

Candidate PDFs are downloaded only after explicit user review and only from
public HTTP(S) destinations with pinned DNS resolution, bounded redirects,
bounded bytes/time and PDF signature validation. Landing pages may be read with
the same safe fetch path to discover an actual linked PDF; Housetory never
guesses a ``.pdf`` URL and never fetches embedded document references.
"""

from __future__ import annotations

import contextlib
import html
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any, Literal
from urllib.parse import unquote, urlencode, urljoin, urlparse

from sqlalchemy.orm import Session

from ..config import get_settings
from . import online_search

MAX_SEARCH_RESPONSE_BYTES = 1_000_000
MAX_LANDING_PAGE_BYTES = 512_000
MAX_LANDING_PAGES = 2
MAX_PAGE_LINKS = 500
MAX_REDIRECTS = 3
BRAVE_SEARCH_PATH = "/res/v1/web/search"
BRAVE_RESULT_LIMIT = 10
BRAVE_QUESTION_LIMIT = 5
MANUAL_LINK_TERMS = (
    "manual",
    "instruction",
    "operator",
    "user guide",
    "owner's manual",
    "owners manual",
)
COMMON_SECOND_LEVEL_LABELS = {"ac", "co", "com", "edu", "gov", "net", "org"}


class ManualWebError(RuntimeError):
    pass


class ManualSearchUnavailable(ManualWebError):
    pass


class ManualFetchError(ManualWebError):
    pass


@dataclass(frozen=True)
class SearchProviderConfig:
    kind: Literal["brave", "gateway", "none"] = "none"
    label: str | None = None
    reason: str | None = None
    gateway_url: str | None = None
    brave_api_key: str | None = None
    brave_base_url: str | None = None
    source: Literal["household", "environment", "none"] = "environment"

    @property
    def configured(self) -> bool:
        return self.kind != "none"


@dataclass(frozen=True)
class SearchCandidateData:
    title: str
    source_url: str
    file_url: str
    publisher: str | None
    language: str | None
    source_type: str
    model_coverage: list[str]
    snippet: str | None
    retrieved_at: datetime


@dataclass(frozen=True)
class SearchOutcome:
    candidates: list[SearchCandidateData] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FetchedManual:
    content: bytes
    content_type: str
    filename: str
    final_url: str
    retrieved_at: datetime


def _read_bounded(
    response: Any,
    *,
    max_bytes: int,
    timeout: int,
    error_type: type[ManualWebError],
) -> bytes:
    """Read a response with both a byte cap and a total wall-clock deadline.

    A plain socket timeout only bounds an individual read, so a server could
    otherwise trickle bytes forever while staying below the per-read timeout.
    """
    deadline = time.monotonic() + timeout
    chunks: list[bytes] = []
    total = 0
    while total <= max_bytes:
        if time.monotonic() > deadline:
            raise error_type("The response timed out.")
        chunk = response.read(min(65_536, max_bytes + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    body = b"".join(chunks)
    if len(body) > max_bytes:
        raise error_type("The response was too large.")
    return body


def _unconfigured_reason() -> str:
    return (
        "Online manual search is not configured. Add a Brave Search API key in "
        "Settings → Online search, or use the installation fallback "
        "BRAVE_SEARCH_API_KEY / MANUAL_SEARCH_URL. Manual upload and attached-manual "
        "questions do not require it."
    )


def _gateway_config(url: str, label: str) -> SearchProviderConfig:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return SearchProviderConfig(
            kind="none",
            reason="MANUAL_SEARCH_URL is not a valid absolute http(s) URL.",
            source="environment",
        )
    if parsed.username or parsed.password:
        return SearchProviderConfig(
            kind="none",
            reason="MANUAL_SEARCH_URL must not contain embedded credentials.",
            source="environment",
        )
    return SearchProviderConfig(
        kind="gateway",
        label=label.strip() or "Configured manual search",
        gateway_url=url,
        source="environment",
    )


def brave_connection_test(provider: SearchProviderConfig) -> None:
    """User-triggered bounded probe using a fixed neutral query.

    No item, manual, household or borrower content is included.
    """
    if provider.kind != "brave":
        raise ManualSearchUnavailable(provider.reason or "Brave manual search is not configured.")
    _brave_search_results(provider, "Housetory connectivity test", 1)


def _brave_config(
    *,
    api_key: str,
    base_url: str,
    source: Literal["household", "environment"] = "environment",
) -> SearchProviderConfig:
    if not api_key:
        return SearchProviderConfig(
            kind="none",
            reason=(
                "MANUAL_SEARCH_PROVIDER=brave requires BRAVE_SEARCH_API_KEY. Add a "
                "Brave Search API key in Settings → Online search or set the "
                "installation fallback; no provider request is made until an item "
                "search is confirmed."
            ),
            source=source,
        )
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return SearchProviderConfig(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must be an absolute http(s) URL.",
            source=source,
        )
    if parsed.username or parsed.password:
        return SearchProviderConfig(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must not contain embedded credentials.",
            source=source,
        )
    return SearchProviderConfig(
        kind="brave",
        label="Brave Search API",
        brave_api_key=api_key,
        brave_base_url=base_url.rstrip("/"),
        source=source,
    )


def resolve_search_provider(
    db: Session | None = None,
    household_id: uuid.UUID | None = None,
) -> SearchProviderConfig:
    settings = get_settings()
    if db is not None and household_id is not None:
        row = online_search.get_row(db, household_id)
        if row is not None:
            if row.provider != "brave":
                return SearchProviderConfig(
                    kind="none",
                    reason="This household selected an unsupported online search provider.",
                    source="household",
                )
            if not row.manual_enabled:
                return SearchProviderConfig(
                    kind="none",
                    reason=online_search.MANUAL_DISABLED_REASON,
                    source="household",
                )
            key, reason = online_search.decrypt_household_key(row)
            if not key:
                return SearchProviderConfig(
                    kind="none",
                    reason=reason or online_search.NO_KEY_REASON,
                    source="household",
                )
            return _brave_config(
                api_key=key,
                base_url=settings.brave_search_base_url.strip(),
                source="household",
            )
    provider = settings.manual_search_provider
    gateway_url = settings.manual_search_url.strip()
    brave_key = settings.brave_search_api_key.strip()
    if provider == "none":
        return SearchProviderConfig(
            kind="none",
            reason=(
                "Online manual search is disabled by MANUAL_SEARCH_PROVIDER=none. "
                "Manual upload and attached-manual questions remain available."
            ),
            source="environment",
        )
    if provider == "gateway":
        if not gateway_url:
            return SearchProviderConfig(
                kind="none",
                reason="MANUAL_SEARCH_PROVIDER=gateway requires MANUAL_SEARCH_URL.",
                source="environment",
            )
        return _gateway_config(gateway_url, settings.manual_search_provider_label)
    if provider == "brave":
        return _brave_config(
            api_key=brave_key,
            base_url=settings.brave_search_base_url.strip(),
        )
    # Auto retains the original gateway configuration as the advanced option,
    # then falls back to the supported Brave adapter.
    if gateway_url:
        return _gateway_config(gateway_url, settings.manual_search_provider_label)
    if brave_key:
        return _brave_config(
            api_key=brave_key,
            base_url=settings.brave_search_base_url.strip(),
        )
    return SearchProviderConfig(kind="none", reason=_unconfigured_reason(), source="none")


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def _compact(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _contains_identifier(text: str, identifier: str) -> bool:
    target = _normalized(identifier)
    if not target:
        return False
    return (
        re.search(
            rf"(?<![a-z0-9]){re.escape(target)}(?![a-z0-9])",
            _normalized(text),
        )
        is not None
    )


def _matches_identity(text: str, model: str, variant: str | None) -> bool:
    normalized = _normalized(text)
    if _contains_identifier(normalized, model) and (
        not variant or _contains_identifier(normalized, variant)
    ):
        return True
    if variant:
        # Manufacturers commonly concatenate the model and regional suffix,
        # for example DCD791B. Accept that only for the confirmed variant.
        combined = re.escape(_normalized(f"{model}{variant}"))
        if re.search(rf"(?<![a-z0-9]){combined}(?![a-z0-9])", normalized):
            return True
        separated = re.escape(_normalized(model)) + r"[\s\-]*" + re.escape(_normalized(variant))
        if re.search(rf"(?<![a-z0-9]){separated}(?![a-z0-9])", normalized):
            return True
    return False


def is_pdf_url(url: str) -> bool:
    return unquote(urlparse(url).path).lower().endswith(".pdf")


def _candidate_text(item: dict[str, Any], coverage: list[str]) -> str:
    url_path = unquote(urlparse(str(item.get("url") or "")).path)
    parts = [
        str(item.get("title") or ""),
        str(item.get("snippet") or ""),
        str(item.get("publisher") or ""),
        url_path,
        " ".join(coverage),
    ]
    return " ".join(parts)


def _validated_url(value: str, *, field: str) -> str:
    clean = value.strip()
    if not clean or len(clean) > 2000:
        raise ManualWebError(f"Candidate {field} is missing or too long.")
    parsed = urlparse(clean)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ManualWebError(f"Candidate {field} must be an absolute http(s) URL.")
    if parsed.username or parsed.password:
        raise ManualWebError(f"Candidate {field} must not contain credentials.")
    return clean


def _parse_candidate(item: dict[str, Any], *, file_required: bool) -> SearchCandidateData:
    title = str(item.get("title") or "").strip()[:300]
    source_url = _validated_url(
        str(item.get("source_url") or item.get("url") or ""), field="source"
    )
    file_url = _validated_url(str(item.get("file_url") or item.get("url") or ""), field="file")
    if not title:
        raise ManualWebError("Candidate title is missing.")
    if file_required and not file_url:
        raise ManualWebError("Candidate file URL is missing.")
    raw_coverage = item.get("model_coverage") or item.get("models") or []
    coverage = [
        str(value).strip()[:120]
        for value in raw_coverage
        if isinstance(value, (str, int, float)) and str(value).strip()
    ][:20]
    publisher = str(item.get("publisher") or "").strip()[:200] or None
    language = str(item.get("language") or "").strip()[:40] or None
    source_type = str(item.get("source_type") or "other").strip().lower()
    if source_type not in {"manufacturer", "official", "other"}:
        source_type = "other"
    snippet = str(item.get("snippet") or "").strip()[:2000] or None
    return SearchCandidateData(
        title=title,
        source_url=source_url,
        file_url=file_url,
        publisher=publisher,
        language=language,
        source_type=source_type,
        model_coverage=coverage,
        snippet=snippet,
        retrieved_at=datetime.now(UTC),
    )


def _post_search(
    payload: dict[str, Any],
    *,
    db: Session | None = None,
    household_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    provider = resolve_search_provider(db, household_id)
    if provider.kind != "gateway" or not provider.gateway_url:
        raise ManualSearchUnavailable(provider.reason or "Manual search is not configured.")
    settings = get_settings()
    url = provider.gateway_url
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "HousetoryManualSearch/1.0",
    }
    if settings.manual_search_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.manual_search_api_key.strip()}"
    body = json.dumps(payload).encode()
    request = (
        http.client.HTTPSConnection
        if urlparse(url).scheme == "https"
        else http.client.HTTPConnection
    )
    parsed = urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path += f"?{parsed.query}"
    connection = None
    try:
        # This is an operator-configured service, not a URL supplied by household
        # content. Redirects are still refused to avoid credential/content leakage.
        connection = request(
            parsed.hostname or "",
            parsed.port or (443 if parsed.scheme == "https" else 80),
            timeout=settings.manual_search_timeout_seconds,
        )
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise ManualSearchUnavailable(
                "The manual search service returned a redirect; configure its final URL."
            )
        if response.status < 200 or response.status >= 300:
            raise ManualSearchUnavailable(
                f"The manual search service returned HTTP {response.status}."
            )
        try:
            data = _read_bounded(
                response,
                max_bytes=MAX_SEARCH_RESPONSE_BYTES,
                timeout=settings.manual_search_timeout_seconds,
                error_type=ManualSearchUnavailable,
            )
        except ManualSearchUnavailable as exc:
            raise ManualSearchUnavailable(
                "The manual search response was too large or timed out."
            ) from exc
    except (OSError, TimeoutError, ValueError, http.client.HTTPException) as exc:
        raise ManualSearchUnavailable("The manual search service is unavailable.") from exc
    finally:
        with contextlib.suppress(Exception):
            if connection is not None:
                connection.close()
    try:
        parsed_body = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManualSearchUnavailable("The manual search service returned invalid JSON.") from exc
    if not isinstance(parsed_body, dict):
        raise ManualSearchUnavailable("The manual search service returned an unexpected response.")
    return parsed_body


def _limit_query(value: str) -> str:
    # Brave documents a 600-character / 75-word query cap.
    return " ".join(value.split())[:600]


def _brave_query(manufacturer: str, model: str, variant: str | None) -> str:
    parts = [f'"{manufacturer}"', f'"{model}"']
    if variant:
        parts.append(f'"{variant}"')
    parts.extend(["manual", "instruction", "operator guide", "pdf"])
    return _limit_query(" ".join(parts))


def _brave_question_query(manufacturer: str, model: str, variant: str | None, question: str) -> str:
    parts = [manufacturer, model]
    if variant:
        parts.append(variant)
    parts.append(question.strip()[:300])
    return _limit_query(" ".join(parts))


def _brave_search_results(
    provider: SearchProviderConfig, query: str, count: int
) -> list[dict[str, Any]]:
    if provider.kind != "brave" or not provider.brave_api_key or not provider.brave_base_url:
        raise ManualSearchUnavailable(provider.reason or "Brave Search API is not configured.")
    settings = get_settings()
    parsed = urlparse(provider.brave_base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ManualSearchUnavailable("BRAVE_SEARCH_BASE_URL is invalid.")
    params: dict[str, str | int] = {
        "q": _limit_query(query),
        "count": max(1, min(count, 20)),
        "extra_snippets": "true",
        "text_decorations": "false",
        "safesearch": "moderate",
    }
    country = settings.brave_search_country.strip()
    language = settings.brave_search_lang.strip()
    if country:
        params["country"] = country
    if language:
        params["search_lang"] = language
    path = f"{parsed.path.rstrip('/')}{BRAVE_SEARCH_PATH}?{urlencode(params)}"
    connection_class = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "X-Subscription-Token": provider.brave_api_key,
        "User-Agent": "HousetoryManualSearch/1.0",
    }
    connection = None
    try:
        connection = connection_class(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            timeout=settings.manual_search_timeout_seconds,
        )
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        if response.status in {401, 403}:
            raise ManualSearchUnavailable(
                "Brave Search API rejected the configured subscription token."
            )
        if response.status == 429:
            raise ManualSearchUnavailable("Brave Search API rate limit reached; try again later.")
        if 300 <= response.status < 400:
            raise ManualSearchUnavailable(
                "Brave Search API returned a redirect; redirects are not followed."
            )
        if response.status < 200 or response.status >= 300:
            raise ManualSearchUnavailable(f"Brave Search API returned HTTP {response.status}.")
        try:
            data = _read_bounded(
                response,
                max_bytes=MAX_SEARCH_RESPONSE_BYTES,
                timeout=settings.manual_search_timeout_seconds,
                error_type=ManualSearchUnavailable,
            )
        except ManualSearchUnavailable as exc:
            raise ManualSearchUnavailable(
                "The Brave Search response was too large or timed out."
            ) from exc
    except (OSError, TimeoutError, ValueError, http.client.HTTPException) as exc:
        raise ManualSearchUnavailable("Brave Search API could not be reached safely.") from exc
    finally:
        with contextlib.suppress(Exception):
            if connection is not None:
                connection.close()
    try:
        parsed_body = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManualSearchUnavailable("Brave Search API returned invalid JSON.") from exc
    if not isinstance(parsed_body, dict):
        raise ManualSearchUnavailable("Brave Search API returned an unexpected response.")
    web = parsed_body.get("web")
    if web is None:
        return []
    if not isinstance(web, dict) or not isinstance(web.get("results"), list):
        raise ManualSearchUnavailable("Brave Search API returned no usable results list.")
    return [entry for entry in web["results"][:20] if isinstance(entry, dict)]


def _plain_text(value: Any, limit: int) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


@dataclass(frozen=True)
class GenericWebResult:
    """One Brave search snippet used for optional price comparisons.

    Result pages are never fetched here. The URL is only a citation the user may
    open; prices parsed from snippets are labelled by the caller as asking/listed
    prices, never confirmed sold prices.
    """

    title: str
    url: str
    snippet: str | None
    retrieved_at: datetime


def search_generic_web(
    db: Session,
    household_id: uuid.UUID,
    query: str,
    *,
    count: int = 5,
) -> list[GenericWebResult]:
    provider = resolve_search_provider(db, household_id)
    if provider.kind != "brave":
        raise ManualSearchUnavailable(
            provider.reason or "Online price comparisons require Brave Search."
        )
    raw_results = _brave_search_results(provider, _limit_query(query), min(max(count, 1), 5))
    results: list[GenericWebResult] = []
    for entry in raw_results:
        title = _plain_text(entry.get("title"), 300)
        if not title:
            continue
        try:
            source_url = _validated_url(str(entry.get("url") or ""), field="comparison")
        except ManualWebError:
            continue
        description = _plain_text(entry.get("description"), 1200)
        extras = entry.get("extra_snippets")
        if isinstance(extras, list):
            extra_text = " · ".join(
                _plain_text(value, 400) for value in extras[:2] if str(value).strip()
            )
            if extra_text:
                description = f"{description} · {extra_text}".strip(" ·")
        results.append(
            GenericWebResult(
                title=title,
                url=source_url,
                snippet=description or None,
                retrieved_at=datetime.now(UTC),
            )
        )
    return results


def _registrable_labels(host: str) -> list[str]:
    labels = [_compact(part) for part in host.lower().split(".") if part]
    if len(labels) >= 3 and labels[-2] in COMMON_SECOND_LEVEL_LABELS:
        return labels[-3:]
    return labels[-2:] if len(labels) >= 2 else labels


def _brave_source_type(manufacturer: str, source_url: str, publisher: str | None) -> str:
    maker = _compact(manufacturer)
    if not maker:
        return "other"
    host_labels = _registrable_labels(urlparse(source_url).hostname or "")
    publisher_compact = _compact(publisher or "")
    host_match = maker in host_labels
    publisher_match = bool(
        publisher_compact
        and (
            publisher_compact == maker
            or publisher_compact.startswith(maker)
            or maker in publisher_compact
        )
    )
    if host_match and publisher_match:
        return "manufacturer"
    if host_match or publisher_match:
        return "official"
    return "other"


def _brave_coverage(text: str, model: str, variant: str | None) -> list[str]:
    if not _matches_identity(text, model, variant):
        return []
    coverage = [model]
    if variant:
        coverage.append(variant)
    return coverage


def _brave_candidate(
    entry: dict[str, Any],
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
    default_language: str | None,
) -> tuple[SearchCandidateData, bool] | None:
    title = _plain_text(entry.get("title"), 300)
    if not title:
        return None
    try:
        source_url = _validated_url(str(entry.get("url") or ""), field="source")
    except ManualWebError:
        return None
    profile = entry.get("profile") if isinstance(entry.get("profile"), dict) else {}
    publisher = (
        _plain_text(
            profile.get("long_name") or profile.get("name") or urlparse(source_url).hostname,
            200,
        )
        or None
    )
    description = _plain_text(entry.get("description"), 1600)
    extras = entry.get("extra_snippets")
    if isinstance(extras, list):
        extra_text = " · ".join(
            _plain_text(value, 500) for value in extras[:2] if str(value).strip()
        )
        if extra_text:
            description = f"{description} · {extra_text}".strip(" ·")
    snippet = _plain_text(description, 2000) or None
    text = f"{title} {snippet or ''} {publisher or ''} {unquote(urlparse(source_url).path)}"
    coverage = _brave_coverage(text, model, variant)
    language = _plain_text(entry.get("language") or default_language or "", 40) or None
    direct_pdf = is_pdf_url(source_url)
    return (
        SearchCandidateData(
            title=title,
            source_url=source_url,
            file_url=source_url,
            publisher=publisher,
            language=language,
            source_type=_brave_source_type(manufacturer, source_url, publisher),
            model_coverage=coverage,
            snippet=snippet,
            retrieved_at=datetime.now(UTC),
        ),
        direct_pdf,
    )


class _AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        self._flush()
        self._href = dict(attrs).get("href")
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None and len(self.links) < MAX_PAGE_LINKS:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a":
            self._flush()

    def _flush(self) -> None:
        if self._href is not None:
            text = " ".join(self._text).strip()
            self.links.append((self._href, text))
        self._href = None
        self._text = []


def _extract_pdf_links(
    page: str,
    *,
    base_url: str,
    manufacturer: str,
    model: str,
    variant: str | None,
) -> str | None:
    parser = _AnchorParser()
    try:
        parser.feed(page[:MAX_LANDING_PAGE_BYTES])
        parser.close()
    except Exception:  # noqa: BLE001 - malformed HTML must not fail a search
        return None
    maker = _compact(manufacturer)
    base_host = (urlparse(base_url).hostname or "").lower()
    scored: list[tuple[int, str]] = []
    for href, text in parser.links:
        if not href:
            continue
        absolute = urljoin(base_url, href.strip())
        if not is_pdf_url(absolute):
            continue
        try:
            _validated_url(absolute, field="file")
        except ManualWebError:
            continue
        label = f"{text} {unquote(urlparse(absolute).path)}".lower()
        identity_match = _matches_identity(f"{text} {absolute}", model, variant)
        manual_term = any(term in label for term in MANUAL_LINK_TERMS)
        if not identity_match and not manual_term:
            continue
        score = 8 if identity_match else 0
        if manual_term:
            score += 4
        if maker and maker in _compact(label):
            score += 2
        if (urlparse(absolute).hostname or "").lower() == base_host:
            score += 1
        scored.append((score, absolute))
    if not scored:
        return None
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return scored[0][1]


def _fetch_public_page(url: str, *, timeout: int) -> tuple[str, bytes, str, dict[str, str]] | None:
    try:
        status, headers, body, final_url = _request_following_redirects(
            url,
            timeout=timeout,
            max_bytes=MAX_LANDING_PAGE_BYTES,
            accept="text/html,application/xhtml+xml",
        )
    except ManualFetchError:
        return None
    if status != 200:
        return None
    encoding = (headers.get("content-encoding") or "").strip().lower()
    if encoding not in {"", "identity"}:
        return None
    content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    return content_type, body, final_url, headers


def _find_landing_pdf(
    url: str,
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
    timeout: int,
) -> str | None:
    page = _fetch_public_page(url, timeout=timeout)
    if page is None:
        return None
    content_type, body, final_url, _headers = page
    if body.startswith(b"%PDF-"):
        return final_url
    if content_type not in {"text/html", "application/xhtml+xml"} and not body.lstrip().startswith(
        b"<"
    ):
        return None
    text = body.decode("utf-8", "replace")
    return _extract_pdf_links(
        text,
        base_url=final_url,
        manufacturer=manufacturer,
        model=model,
        variant=variant,
    )


def _exact_model_candidates(
    candidates: list[SearchCandidateData],
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
) -> tuple[list[SearchCandidateData], list[str]]:
    accepted: list[SearchCandidateData] = []
    rejected = 0
    for candidate in candidates:
        text = _candidate_text(
            {
                "title": candidate.title,
                "snippet": candidate.snippet,
                "publisher": candidate.publisher,
                "url": candidate.source_url,
            },
            candidate.model_coverage,
        )
        if not _matches_identity(text, model, variant):
            rejected += 1
            continue
        accepted.append(candidate)
    notices: list[str] = []
    if rejected:
        notices.append(
            f"{rejected} search result(s) were hidden because the title/snippet did not "
            "show the exact confirmed model identifier."
        )
    accepted.sort(
        key=lambda entry: (
            0
            if entry.source_type == "manufacturer"
            else 1
            if entry.source_type == "official"
            else 2,
            entry.title.lower(),
        )
    )
    return accepted[:10], notices


def _brave_manual_outcome(
    provider: SearchProviderConfig,
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
) -> SearchOutcome:
    settings = get_settings()
    raw_results = _brave_search_results(
        provider,
        _brave_query(manufacturer, model, variant),
        BRAVE_RESULT_LIMIT,
    )
    candidates: list[SearchCandidateData] = []
    direct_urls: set[str] = set()
    for entry in raw_results:
        parsed = _brave_candidate(
            entry,
            manufacturer=manufacturer,
            model=model,
            variant=variant,
            default_language=settings.brave_search_lang.strip() or None,
        )
        if parsed is None:
            continue
        candidate, direct_pdf = parsed
        candidates.append(candidate)
        if direct_pdf:
            direct_urls.add(candidate.source_url)
    accepted, notices = _exact_model_candidates(
        candidates, manufacturer=manufacturer, model=model, variant=variant
    )
    enriched: list[SearchCandidateData] = []
    pages_fetched = 0
    pdfs_found = 0
    for candidate in accepted:
        if candidate.source_url in direct_urls:
            enriched.append(candidate)
            continue
        if (
            candidate.source_type in {"manufacturer", "official"}
            and pages_fetched < MAX_LANDING_PAGES
        ):
            pages_fetched += 1
            pdf_url = _find_landing_pdf(
                candidate.source_url,
                manufacturer=manufacturer,
                model=model,
                variant=variant,
                timeout=settings.manual_search_timeout_seconds,
            )
            if pdf_url:
                enriched.append(replace(candidate, file_url=pdf_url))
                pdfs_found += 1
                continue
        enriched.append(candidate)
    if pdfs_found:
        notices.append(
            f"Found an actual linked PDF on {pdfs_found} official source page(s); "
            "review the source before saving."
        )
    source_only = sum(
        1
        for candidate in enriched
        if not is_pdf_url(candidate.file_url) and candidate.file_url == candidate.source_url
    )
    if source_only:
        notices.append(
            f"{source_only} result(s) are source pages without a discovered PDF link. "
            "Open the source or upload the manual yourself."
        )
    if not enriched:
        notices.append(
            "No source with exact model evidence was found. Try a different variant or "
            "upload the manual."
        )
    return SearchOutcome(candidates=enriched[:10], notices=notices)


def search_manual_candidates(
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
    db: Session | None = None,
    household_id: uuid.UUID | None = None,
) -> SearchOutcome:
    provider = resolve_search_provider(db, household_id)
    if provider.kind == "brave":
        return _brave_manual_outcome(
            provider, manufacturer=manufacturer, model=model, variant=variant
        )
    if provider.kind != "gateway":
        raise ManualSearchUnavailable(provider.reason or "Manual search is not configured.")
    raw = _post_search(
        {
            "mode": "manual",
            "manufacturer": manufacturer,
            "model": model,
            "variant": variant,
        },
        db=db,
        household_id=household_id,
    )
    results = raw.get("results")
    if not isinstance(results, list):
        raise ManualSearchUnavailable("The manual search service returned no results list.")
    candidates: list[SearchCandidateData] = []
    for entry in results[:30]:
        if not isinstance(entry, dict):
            continue
        try:
            candidates.append(_parse_candidate(entry, file_required=True))
        except ManualWebError:
            continue
    accepted, notices = _exact_model_candidates(
        candidates, manufacturer=manufacturer, model=model, variant=variant
    )
    if not accepted:
        notices.append(
            "No source with exact model evidence was found. Try a different variant or "
            "upload the manual."
        )
    return SearchOutcome(candidates=accepted, notices=notices)


def search_online_sources(
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
    question: str,
    db: Session | None = None,
    household_id: uuid.UUID | None = None,
) -> SearchOutcome:
    provider = resolve_search_provider(db, household_id)
    if provider.kind == "brave":
        settings = get_settings()
        raw_results = _brave_search_results(
            provider,
            _brave_question_query(manufacturer, model, variant, question),
            BRAVE_QUESTION_LIMIT,
        )
        candidates: list[SearchCandidateData] = []
        for entry in raw_results:
            parsed = _brave_candidate(
                entry,
                manufacturer=manufacturer,
                model=model,
                variant=variant,
                default_language=settings.brave_search_lang.strip() or None,
            )
            if parsed is not None:
                candidates.append(parsed[0])
        accepted, notices = _exact_model_candidates(
            candidates, manufacturer=manufacturer, model=model, variant=variant
        )
        if not accepted:
            notices.append(
                "No online source showed the exact confirmed model identifier; no answer "
                "was synthesized from generic or similar-product results."
            )
        return SearchOutcome(candidates=accepted, notices=notices)
    if provider.kind != "gateway":
        raise ManualSearchUnavailable(provider.reason or "Manual search is not configured.")
    raw = _post_search(
        {
            "mode": "question",
            "manufacturer": manufacturer,
            "model": model,
            "variant": variant,
            "question": question,
        },
        db=db,
        household_id=household_id,
    )
    results = raw.get("results")
    if not isinstance(results, list):
        raise ManualSearchUnavailable("The manual search service returned no results list.")
    sources: list[SearchCandidateData] = []
    for entry in results[:30]:
        if not isinstance(entry, dict):
            continue
        try:
            sources.append(_parse_candidate(entry, file_required=False))
        except ManualWebError:
            continue
    accepted, notices = _exact_model_candidates(
        sources, manufacturer=manufacturer, model=model, variant=variant
    )
    if not accepted:
        notices.append(
            "No online source showed the exact confirmed model identifier; no answer "
            "was synthesized from generic or similar-product results."
        )
    return SearchOutcome(candidates=accepted, notices=notices)


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _resolve_public(hostname: str, port: int) -> list[str]:
    try:
        records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise ManualFetchError("The manual source host could not be resolved.") from exc
    addresses = sorted({record[4][0] for record in records})
    if not addresses or any(not _public_ip(address) for address in addresses):
        raise ManualFetchError(
            "The manual source resolves to a private, loopback or internal address."
        )
    return addresses


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, connect_host: str, *, timeout: int) -> None:
        super().__init__(host, port, timeout=timeout)
        self._connect_host = connect_host

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._connect_host, self.port), self.timeout, self.source_address
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        port: int,
        connect_host: str,
        *,
        timeout: int,
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self._connect_host = connect_host

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self._connect_host, self.port), self.timeout, self.source_address
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


def _request_once(
    url: str,
    *,
    timeout: int,
    max_bytes: int,
    accept: str = "application/pdf",
) -> tuple[int, dict[str, str], bytes]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ManualFetchError("Manual URLs must be absolute http(s) URLs.")
    if parsed.username or parsed.password:
        raise ManualFetchError("Manual URLs must not contain credentials.")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ManualFetchError("The manual URL contains an invalid port.") from exc
    addresses = _resolve_public(parsed.hostname, port)
    host = parsed.hostname
    connect_host = addresses[0]
    if parsed.scheme == "https":
        context = ssl.create_default_context()
        connection: http.client.HTTPConnection = _PinnedHTTPSConnection(
            host,
            port,
            connect_host,
            timeout=timeout,
            context=context,
        )
    else:
        connection = _PinnedHTTPConnection(host, port, connect_host, timeout=timeout)
    path = parsed.path or "/"
    if parsed.query:
        path += f"?{parsed.query}"
    headers = {
        "Host": host,
        "Accept": accept,
        "Accept-Encoding": "identity",
        "User-Agent": "HousetoryManualFetch/1.0",
        "Connection": "close",
    }
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        length = response_headers.get("content-length")
        if length and length.isdigit() and int(length) > max_bytes:
            raise ManualFetchError("The manual file is larger than the configured upload limit.")
        body = _read_bounded(
            response,
            max_bytes=max_bytes,
            timeout=timeout,
            error_type=ManualFetchError,
        )
        return response.status, response_headers, body
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        raise ManualFetchError("The manual source could not be downloaded safely.") from exc
    finally:
        connection.close()


def _request_following_redirects(
    url: str,
    *,
    timeout: int,
    max_bytes: int,
    accept: str,
) -> tuple[int, dict[str, str], bytes, str]:
    current = url.strip()
    for _ in range(MAX_REDIRECTS + 1):
        status, headers, body = _request_once(
            current,
            timeout=timeout,
            max_bytes=max_bytes,
            accept=accept,
        )
        if 300 <= status < 400:
            location = headers.get("location")
            if not location:
                raise ManualFetchError("The manual source redirected without a destination.")
            next_url = urljoin(current, location)
            if urlparse(current).scheme == "https" and urlparse(next_url).scheme != "https":
                raise ManualFetchError("The manual source tried to redirect to an insecure URL.")
            current = next_url
            continue
        return status, headers, body, current
    raise ManualFetchError("The manual source redirected too many times.")


def fetch_manual_pdf(url: str) -> FetchedManual:
    settings = get_settings()
    status, headers, body, final_url = _request_following_redirects(
        url,
        timeout=settings.manual_search_timeout_seconds,
        max_bytes=settings.max_upload_bytes,
        accept="application/pdf",
    )
    if status != 200:
        raise ManualFetchError(f"The manual source returned HTTP {status}.")
    content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type in {"text/html", "application/xhtml+xml"}:
        raise ManualFetchError("The manual source returned a web page, not a PDF manual.")
    if not body.startswith(b"%PDF-"):
        raise ManualFetchError("Only PDF manual downloads are supported from online sources.")
    filename = unquote(urlparse(final_url).path.rsplit("/", 1)[-1]) or "manual.pdf"
    if not filename.lower().endswith(".pdf"):
        filename = "manual.pdf"
    return FetchedManual(
        content=body,
        content_type="application/pdf",
        filename=filename[:255],
        final_url=final_url,
        retrieved_at=datetime.now(UTC),
    )
