"""Household-scoped online search configuration and domain validation.

Only Brave is currently implemented. The model keeps a provider field so a
future supported adapter can be added without pretending it already works.
"""

from __future__ import annotations

import ipaddress
import re
import uuid
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import HouseholdOnlineSearchSettings
from .ai_credentials import CredentialError, decrypt_secret

MAX_PERMITTED_DOMAINS = 50
MANUAL_DISABLED_REASON = "Online manual search is disabled in Settings → Online search."
REFERENCE_DISABLED_REASON = "Reference-image search is disabled in Settings → Online search."
NO_KEY_REASON = "Add a Brave Search API key in Settings → Online search."
NO_DOMAINS_REASON = (
    "Add at least one permitted source domain in Settings → Online search before "
    "downloading reference images."
)
MULTI_PART_SUFFIXES = {
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
}
# Shared hosting/tenant suffixes are registrable one label deeper. Treating them
# as ordinary suffixes would let "a.github.io" silently become "github.io" and
# permit every unrelated tenant, so keep the tenant label in the policy.
SHARED_HOSTING_SUFFIXES = {
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
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class DomainValidationError(ValueError):
    pass


def get_row(db: Session, household_id: uuid.UUID) -> HouseholdOnlineSearchSettings | None:
    return db.scalar(
        select(HouseholdOnlineSearchSettings).where(
            HouseholdOnlineSearchSettings.household_id == household_id
        )
    )


def ensure_row(db: Session, household_id: uuid.UUID) -> HouseholdOnlineSearchSettings:
    row = get_row(db, household_id)
    if row is None:
        row = HouseholdOnlineSearchSettings(
            household_id=household_id,
            provider="brave",
            api_key_version=0,
            manual_enabled=False,
            reference_enabled=False,
            permitted_source_domains=[],
        )
        db.add(row)
        db.flush()
    return row


def decrypt_household_key(
    row: HouseholdOnlineSearchSettings,
) -> tuple[str | None, str | None]:
    if not row.encrypted_api_key:
        return None, NO_KEY_REASON
    try:
        key = decrypt_secret(row.encrypted_api_key)
    except CredentialError:
        return None, (
            "The saved Brave Search key cannot be decrypted with the current "
            "installation key. Replace it in Settings → Online search."
        )
    if not key:
        return None, NO_KEY_REASON
    return key, None


def registrable_domain(value: str) -> str:
    labels = [label for label in value.strip().strip(".").lower().split(".") if label]
    if len(labels) <= 2:
        return ".".join(labels)
    suffix = ".".join(labels[-2:])
    if suffix in MULTI_PART_SUFFIXES or suffix in SHARED_HOSTING_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def normalize_domain(value: str) -> str:
    raw = value.strip().lower().rstrip(".")
    if not raw:
        raise DomainValidationError("Permitted source domains cannot be empty.")
    if len(raw) > 253:
        raise DomainValidationError("A permitted source domain is too long.")
    if any(character in raw for character in ("/", ":", "@", "*", "?", "#", "[", "]", " ")):
        raise DomainValidationError(
            "Enter domains only, without scheme, path, port, credentials or wildcards."
        )
    try:
        ipaddress.ip_address(raw)
    except ValueError:
        pass
    else:
        raise DomainValidationError("IP addresses are not valid permitted source domains.")
    labels = raw.split(".")
    if len(labels) < 2:
        raise DomainValidationError("Enter a full domain such as example.com.")
    if not all(_LABEL_RE.match(label) for label in labels):
        raise DomainValidationError("One or more permitted source domains are invalid.")
    if labels[-1].isdigit():
        raise DomainValidationError("Top-level domains cannot be numeric.")
    if raw in MULTI_PART_SUFFIXES or raw in SHARED_HOSTING_SUFFIXES:
        raise DomainValidationError(
            "Enter a full registrable domain such as example.com or example.co.uk."
        )
    return registrable_domain(raw)


def normalize_domains(values: list[str]) -> list[str]:
    if len(values) > MAX_PERMITTED_DOMAINS:
        raise DomainValidationError(
            f"Use at most {MAX_PERMITTED_DOMAINS} permitted source domains."
        )
    normalized: list[str] = []
    for value in values:
        domain = normalize_domain(value)
        if domain not in normalized:
            normalized.append(domain)
    return normalized


def effective_domains(
    row: HouseholdOnlineSearchSettings | None,
) -> frozenset[str]:
    if row is None:
        return frozenset()
    values = row.permitted_source_domains or []
    result: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        clean = value.strip().lower()
        if clean:
            result.add(clean)
    return frozenset(result)


def source_for_row(
    row: HouseholdOnlineSearchSettings | None,
) -> Literal["household", "none"]:
    return "household" if row is not None else "none"
