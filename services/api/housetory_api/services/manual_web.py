"""Optional external manual search and SSRF-safe document retrieval.

There is no built-in browser or crawling. An operator may configure one generic
JSON search endpoint through MANUAL_SEARCH_URL. It receives only manufacturer,
model/variant identifiers and (for online questions) the question. Candidate
files are downloaded only after explicit user review, and only from public
HTTP(S) destinations with pinned DNS resolution, no redirects to private
addresses, bounded bytes/time and PDF signature validation.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urljoin, urlparse

from ..config import get_settings

MAX_SEARCH_RESPONSE_BYTES = 1_000_000
MAX_REDIRECTS = 3
SEARCH_MODES = {"manual", "question"}


class ManualWebError(RuntimeError):
    pass


class ManualSearchUnavailable(ManualWebError):
    pass


class ManualFetchError(ManualWebError):
    pass


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


@dataclass(frozen=True)
class OnlineSourceData:
    title: str
    url: str
    publisher: str | None
    language: str | None
    source_type: str
    snippet: str


def search_configuration() -> tuple[bool, str | None, str | None]:
    settings = get_settings()
    url = settings.manual_search_url.strip()
    if not url:
        return (
            False,
            None,
            "Online manual search is not configured. An operator can set "
            "MANUAL_SEARCH_URL to a JSON search service; manual upload and "
            "attached-manual questions do not require it.",
        )
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False, None, "MANUAL_SEARCH_URL is not a valid http(s) URL."
    return True, settings.manual_search_provider_label.strip() or "Configured manual search", None


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


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
        # for example DCD791Z. Accept that only for the confirmed variant.
        combined = re.escape(_normalized(f"{model}{variant}"))
        if re.search(rf"(?<![a-z0-9]){combined}(?![a-z0-9])", normalized):
            return True
        separated = re.escape(_normalized(model)) + r"[\s\-]*" + re.escape(_normalized(variant))
        if re.search(rf"(?<![a-z0-9]){separated}(?![a-z0-9])", normalized):
            return True
    return False


def _candidate_text(item: dict[str, Any], coverage: list[str]) -> str:
    parts = [
        str(item.get("title") or ""),
        str(item.get("snippet") or ""),
        str(item.get("publisher") or ""),
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


def _post_search(payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    url = settings.manual_search_url.strip()
    configured, _label, reason = search_configuration()
    if not configured:
        raise ManualSearchUnavailable(reason or "Manual search is not configured.")
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


def search_manual_candidates(
    *,
    manufacturer: str,
    model: str,
    variant: str | None,
) -> SearchOutcome:
    raw = _post_search(
        {
            "mode": "manual",
            "manufacturer": manufacturer,
            "model": model,
            "variant": variant,
        }
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
) -> SearchOutcome:
    raw = _post_search(
        {
            "mode": "question",
            "manufacturer": manufacturer,
            "model": model,
            "variant": variant,
            "question": question,
        }
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


def _request_once(url: str, *, timeout: int, max_bytes: int) -> tuple[int, dict[str, str], bytes]:
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
        "Accept": "application/pdf",
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


def fetch_manual_pdf(url: str) -> FetchedManual:
    settings = get_settings()
    current = url.strip()
    for _ in range(MAX_REDIRECTS + 1):
        status, headers, body = _request_once(
            current,
            timeout=settings.manual_search_timeout_seconds,
            max_bytes=settings.max_upload_bytes,
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
        if status != 200:
            raise ManualFetchError(f"The manual source returned HTTP {status}.")
        content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if content_type in {"text/html", "application/xhtml+xml"}:
            raise ManualFetchError("The manual source returned a web page, not a PDF manual.")
        if not body.startswith(b"%PDF-"):
            raise ManualFetchError("Only PDF manual downloads are supported from online sources.")
        filename = unquote(urlparse(current).path.rsplit("/", 1)[-1]) or "manual.pdf"
        if not filename.lower().endswith(".pdf"):
            filename = "manual.pdf"
        return FetchedManual(
            content=body,
            content_type="application/pdf",
            filename=filename[:255],
            final_url=current,
            retrieved_at=datetime.now(UTC),
        )
    raise ManualFetchError("The manual source redirected too many times.")
