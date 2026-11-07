"""Owner-facing online search settings, credentials and bounded connection tests."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..schemas.online_search import (
    OnlineSearchChannelOut,
    OnlineSearchReferenceChannelOut,
    OnlineSearchSettingsOut,
    OnlineSearchSettingsUpdate,
    OnlineSearchTestOut,
)
from . import ai_credentials, item_image_search, manual_web, online_search


def _channel_for_manual(provider: manual_web.SearchProviderConfig) -> OnlineSearchChannelOut:
    return OnlineSearchChannelOut(
        enabled=False,
        configured=provider.kind != "none",
        source=provider.source,
        provider=provider.kind if provider.kind != "none" else None,
        provider_label=provider.label,
        reason=provider.reason,
    )


def _channel_for_reference(
    provider: item_image_search.ImageSearchProvider,
) -> OnlineSearchReferenceChannelOut:
    return OnlineSearchReferenceChannelOut(
        enabled=False,
        configured=provider.configured,
        source=provider.source,
        provider=provider.kind if provider.kind != "none" else None,
        provider_label=provider.label,
        reason=provider.reason,
        permitted_source_domains=sorted(provider.permitted_domains),
        # Public-web lookup is the default. A non-empty list is an optional
        # advanced restriction, not a readiness prerequisite.
        policy_configured=provider.configured,
    )


def serialize_settings(db: Session, household_id: uuid.UUID) -> OnlineSearchSettingsOut:
    row = online_search.get_row(db, household_id)
    settings = get_settings()
    env_manual = manual_web.resolve_search_provider()
    env_image = item_image_search.resolve_image_search_provider()
    manual = manual_web.resolve_search_provider(db, household_id)
    reference = item_image_search.resolve_image_search_provider(db, household_id)
    manual_channel = _channel_for_manual(manual)
    reference_channel = _channel_for_reference(reference)
    if row is not None:
        manual_channel = manual_channel.model_copy(update={"enabled": row.manual_enabled})
        reference_channel = reference_channel.model_copy(update={"enabled": row.reference_enabled})
    environment_key = bool(settings.brave_search_api_key.strip())
    if row is not None:
        credential_source = "household"
        has_api_key = bool(row.encrypted_api_key)
        version = row.api_key_version
        domains = list(row.permitted_source_domains or [])
        updated_at = row.updated_at
        provider = row.provider
    else:
        credential_source = "environment" if environment_key else "none"
        has_api_key = False
        version = 0
        domains = []
        updated_at = None
        provider = "brave"
    warning = None
    if not ai_credentials.key_configured():
        warning = (
            "AI_CREDENTIAL_KEY is not configured in this installation. A Brave Search "
            "key cannot be saved until the deployment credential key is set."
        )
    return OnlineSearchSettingsOut(
        provider=provider,  # type: ignore[arg-type]
        manual_enabled=bool(row.manual_enabled) if row is not None else False,
        reference_enabled=bool(row.reference_enabled) if row is not None else False,
        has_api_key=has_api_key,
        environment_api_key_available=environment_key,
        credential_source=credential_source,  # type: ignore[arg-type]
        api_key_version=version,
        credential_storage_ready=ai_credentials.key_configured(),
        permitted_source_domains=domains,
        manual=manual_channel,
        reference=reference_channel,
        environment_manual_available=env_manual.kind != "none",
        environment_reference_available=env_image.configured,
        updated_at=updated_at,
        warning=warning,
    )


def update_settings(
    db: Session,
    household_id: uuid.UUID,
    payload: OnlineSearchSettingsUpdate,
) -> OnlineSearchSettingsOut:
    row = online_search.get_row(db, household_id)
    if row is None:
        row = online_search.ensure_row(db, household_id)
    fields = payload.model_fields_set

    domains: list[str] | None = None
    if "permitted_source_domains" in fields and payload.permitted_source_domains is not None:
        try:
            domains = online_search.normalize_domains(payload.permitted_source_domains)
        except online_search.DomainValidationError as exc:
            raise ApiError(422, "invalid_permitted_domains", str(exc)) from None

    has_key_after = bool(row.encrypted_api_key) or bool(payload.api_key)
    if payload.clear_api_key:
        has_key_after = False
    manual_after = (
        payload.manual_enabled if payload.manual_enabled is not None else row.manual_enabled
    )
    reference_after = (
        payload.reference_enabled
        if payload.reference_enabled is not None
        else row.reference_enabled
    )
    if payload.clear_api_key and (manual_after or reference_after):
        raise ApiError(
            422,
            "online_search_disable_required",
            "Disable manual and reference-image search before removing the Brave key.",
        )
    if (manual_after or reference_after) and not has_key_after:
        raise ApiError(
            422,
            "online_search_key_required",
            "Add a Brave Search API key before enabling manual or reference-image search.",
        )
    if payload.manual_enabled is not None:
        row.manual_enabled = payload.manual_enabled
    if payload.reference_enabled is not None:
        row.reference_enabled = payload.reference_enabled
    if domains is not None:
        row.permitted_source_domains = domains
    if payload.clear_api_key:
        row.encrypted_api_key = None
        row.api_key_version += 1
    elif payload.api_key:
        try:
            row.encrypted_api_key = ai_credentials.encrypt_secret(payload.api_key)
        except ai_credentials.CredentialError as exc:
            raise ApiError(422, "credential_key_unavailable", str(exc)) from None
        row.api_key_version += 1
    db.commit()
    db.refresh(row)
    return serialize_settings(db, household_id)


def _combined_reason(
    manual: manual_web.SearchProviderConfig,
    reference: item_image_search.ImageSearchProvider,
) -> str:
    reasons = []
    if manual.kind == "none" and manual.reason:
        reasons.append(f"Manual: {manual.reason}")
    if reference.kind == "none" and reference.reason:
        reasons.append(f"Reference: {reference.reason}")
    return " ".join(reasons) or "No Brave online search features are enabled."


def test_connection(db: Session, household_id: uuid.UUID, *, confirm: bool) -> OnlineSearchTestOut:
    tested_at = datetime.now(UTC)
    if not confirm:
        raise ApiError(
            422,
            "online_search_test_confirmation_required",
            "Confirm the connection test. It sends one bounded request with a fixed "
            "neutral query to Brave and may use subscription quota. No inventory or "
            "manual contents are transmitted.",
        )
    row = online_search.get_row(db, household_id)
    manual = manual_web.resolve_search_provider(db, household_id)
    reference = item_image_search.resolve_image_search_provider(db, household_id)
    source = (
        "household"
        if row is not None
        else (
            "environment"
            if manual.source == "environment" or reference.source == "environment"
            else "none"
        )
    )
    manual_ok: bool | None = None
    reference_ok: bool | None = None
    parts: list[str] = []
    testable = False

    if manual.kind == "brave":
        testable = True
        try:
            manual_web.brave_connection_test(manual)
            manual_ok = True
            parts.append("Manual search connected.")
        except manual_web.ManualSearchUnavailable as exc:
            manual_ok = False
            parts.append(str(exc))
    elif manual.kind == "gateway":
        parts.append(
            "The advanced installation manual-search gateway is configured; this card "
            "tests the Brave credential only."
        )

    if reference.configured:
        testable = True
        try:
            item_image_search.brave_image_connection_test(reference)
            reference_ok = True
            parts.append("Reference-image search connected.")
        except ApiError as exc:
            reference_ok = False
            parts.append(exc.message)
    elif reference.reason:
        parts.append(f"Reference image search: {reference.reason}")

    if not testable:
        return OnlineSearchTestOut(
            ok=False,
            message=_combined_reason(manual, reference),
            manual_ok=manual_ok,
            reference_ok=reference_ok,
            source=source,  # type: ignore[arg-type]
            provider_label=None,
            tested_at=tested_at,
        )
    ok = manual_ok is not False and reference_ok is not False
    return OnlineSearchTestOut(
        ok=ok,
        message=" ".join(part for part in parts if part) or "Connection test completed.",
        manual_ok=manual_ok,
        reference_ok=reference_ok,
        source=source,  # type: ignore[arg-type]
        provider_label="Brave Search API",
        tested_at=tested_at,
    )


__all__ = ["serialize_settings", "test_connection", "update_settings"]
