"""Image search provider configuration and source permission policy."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ...config import get_settings
from .. import online_search
from .ranking import (
    ImageCandidate,
    _candidate_hosts,
    _compact,
    _registrable_domain,
    _source_domain_consistent,
    _split_config,
)

DEFAULT_PERMITTED_LICENSES = ("cc0", "cc-by", "cc-by-sa", "public-domain")


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
class SourcePermission:
    kind: Literal["public_web", "configured_source_policy", "provider_license"]
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
        if self.kind == "public_web":
            return (
                f"Selected automatically from a public web result for {self.label}. "
                "No license metadata or reuse permission was established by the search "
                "result. Source page and retrieval time are recorded; review the "
                "source's terms before reuse. This is a reference image, not a user "
                "photo, and is not a legal determination."
            )
        return (
            f"Download allowed by the server's optional source-domain restriction "
            f"for {self.label}. Source page and retrieval time are recorded. This "
            "records an operator restriction, not a legal determination or permission "
            "guarantee; review the source's terms before reuse."
        )


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


def source_restriction_enabled(provider: ImageSearchProvider | None = None) -> bool:
    """Whether an optional legacy source-domain restriction is active."""
    return bool(_permitted_source_domains(provider))


def _asset_host_permitted(
    candidate: ImageCandidate,
    provider: ImageSearchProvider | None = None,
) -> bool:
    domains = _permitted_source_domains(provider)
    if not domains:
        return True
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
    domains = _permitted_source_domains(provider)
    if not domains:
        return SourcePermission(
            kind="public_web",
            label=domain or candidate.source_domain or "public web",
            evidence_url=candidate.page_url,
        )
    if domain and domain in domains and _asset_host_permitted(candidate, provider):
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
    if permission.kind in {"provider_license", "public_web"}:
        return True
    host = (urlparse(url).hostname or "").lower()
    return bool(host and _registrable_domain(host) in _permitted_source_domains(provider))
