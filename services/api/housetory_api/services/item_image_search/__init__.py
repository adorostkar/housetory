"""Brave Image Search adapter with public-web provenance and automatic selection.

The matcher builds a temporary, query-only product profile from the item. It
never writes inferred brands, dimensions, technologies or model guesses back to
inventory records. Candidate selection requires compatible known attributes and
a public HTTP(S) destination with pinned DNS, bounded redirects/downloads and a
decodable re-encoded image. An optional legacy source-domain restriction can
narrow candidates; an empty restriction means the public web.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import UTC, datetime
from urllib.parse import urlencode, urlparse

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...models import Item, ItemImage
from .. import storage
from ..item_images import (
    active_image,
    clear_active_images,
    image_search_fingerprint,
)
from ..manual_web import (
    ManualFetchError,
    _read_bounded,
    _request_following_redirects,
)
from .ranking import (
    ImageCandidate,
    RankedImage,
    _compact,
    _profile_search_ready,
    _query,
    _reference_dimensions_ok,
    build_product_profile,
    parse_brave_image_results,
    rank_candidates,
)
from .ranking import reference_search_ready as reference_search_ready
from .sources import (
    ImageSearchProvider,
    SourcePermission,
    _url_permitted,
    resolve_image_search_provider,
    source_permission,
    source_restriction_enabled,
)

BRAVE_IMAGE_SEARCH_PATH = "/res/v1/images/search"
MAX_SEARCH_RESPONSE_BYTES = 1_000_000


MAX_REFERENCE_IMAGE_ATTEMPTS = 6


SKIPPABLE_IMAGE_ERRORS = {
    "empty_image",
    "invalid_image",
    "unsupported_image_type",
    "image_dimensions",
    "image_too_large",
}


def brave_image_connection_test(provider: ImageSearchProvider) -> None:
    """User-triggered bounded probe using a fixed neutral query."""
    if not provider.configured:
        raise ApiError(
            503,
            "image_search_unconfigured",
            provider.reason or "Image search is not configured.",
        )
    _brave_image_results(provider, "Housetory connectivity test")


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
    require_reference_quality: bool = False,
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
        if require_reference_quality:
            try:
                _image_format, width, height, _has_alpha = storage.inspect_item_image_bytes(body)
            except ApiError as exc:
                last_error = ManualFetchError(_image_attempt_reason(exc))
                continue
            if not _reference_dimensions_ok(width, height):
                last_error = ManualFetchError(
                    f"decoded image is only {width}x{height}, below the minimum "
                    "reference-image quality"
                )
                continue
        return body, final_url, label
    detail = (
        "The selected image could not be downloaded safely; the category icon "
        "fallback remains available."
    )
    if last_error is not None:
        detail = f"{detail[:-1]} ({str(last_error)[:240]})."
    raise ApiError(422, "image_download_failed", detail) from last_error


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
    if (
        existing is None
        or existing.storage_key is None
        or existing.width is None
        or existing.height is None
        or not _reference_dimensions_ok(existing.width, existing.height)
    ):
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


def _image_attempt_reason(exc: ApiError) -> str:
    if exc.code == "unsupported_image_type":
        return "unsupported image format"
    if exc.code == "invalid_image":
        return "invalid or corrupt image"
    if exc.code == "image_too_large":
        return "image exceeded the size limit"
    if exc.code == "image_dimensions":
        return "unsupported image dimensions"
    if exc.code == "empty_image":
        return "empty image response"
    return exc.message


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
            and current.width is not None
            and current.height is not None
            and _reference_dimensions_ok(current.width, current.height)
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
    profile = build_product_profile(item)
    if not _profile_search_ready(profile):
        raise ApiError(
            422,
            "image_description_required",
            "This item does not have enough recognizable brand plus product-type or "
            "exact-model context for an automatic public image search. Add a brand and "
            "either a product type (for example toolbox or drill) or the exact model. "
            "For packaging or an empty box, keep the word “box” so a product image is "
            "not mistaken for the actual item. The category icon fallback remains "
            "available.",
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
        if source_restriction_enabled(provider):
            detail = (
                "A compatible public image was found, but it falls outside your "
                "optional source-domain restriction. Clear or adjust that restriction "
                "in Settings → Online search; the category icon fallback remains "
                "available."
            )
        else:
            detail = (
                "A compatible image was found, but its source provenance or license "
                "evidence could not be verified. The category icon fallback remains "
                "available."
            )
        raise ApiError(422, "no_permitted_image_candidate", detail)
    if not permitted:
        raise ApiError(
            422,
            "no_image_candidate",
            "No suitable compatible image source was found. The category icon "
            "fallback remains available.",
        )
    selected: tuple[RankedImage, SourcePermission, str, storage.StoredItemImage] | None = None
    attempt_errors: list[str] = []
    attempted = 0
    for candidate_rank, permission in permitted[:MAX_REFERENCE_IMAGE_ATTEMPTS]:
        attempted += 1
        try:
            content, final_url, _kind = _download_candidate(
                candidate_rank.candidate,
                permission=permission,
                provider=provider,
                require_reference_quality=True,
            )
        except ApiError as exc:
            attempt_errors.append(
                f"{candidate_rank.candidate.source_domain or 'public source'}: {exc.message}"
            )
            continue
        # The decoder is authoritative. Metadata dimensions and the downloaded
        # URL's apparent role are not enough: tiny search thumbnails and
        # deceptive full-size claims are rejected before anything is stored.
        try:
            _image_format, decoded_width, decoded_height, _has_alpha = (
                storage.inspect_item_image_bytes(content)
            )
        except ApiError as exc:
            attempt_errors.append(
                f"{candidate_rank.candidate.source_domain or 'public source'}: "
                f"{_image_attempt_reason(exc)}"
            )
            continue
        if not _reference_dimensions_ok(decoded_width, decoded_height):
            attempt_errors.append(
                f"{candidate_rank.candidate.source_domain or 'public source'}: "
                f"decoded image is only {decoded_width}x{decoded_height}, below "
                "the minimum reference-image quality"
            )
            continue
        # Recheck after the network call so a real photo cannot be overwritten.
        db.refresh(item, attribute_names=["photos", "updated_at"])
        if item.photos:
            raise ApiError(
                409,
                "actual_photo_exists",
                "A real photo was added while the reference image was downloading; "
                "it takes priority.",
            )
        try:
            stored = storage.store_item_image_bytes(
                household_id,
                item.id,
                content,
                source_type="reference",
                filename=(
                    f"{_compact(profile.brand) or 'reference'}."
                    f"{candidate_rank.candidate.image_url.rsplit('.', 1)[-1][:5]}"
                ),
            )
        except ApiError as exc:
            if exc.code not in SKIPPABLE_IMAGE_ERRORS:
                raise
            attempt_errors.append(
                f"{candidate_rank.candidate.source_domain or 'public source'}: "
                f"{_image_attempt_reason(exc)}"
            )
            continue
        selected = (candidate_rank, permission, final_url, stored)
        break

    if selected is None:
        detail = (
            f"No downloadable reference image was found after trying {attempted} "
            "compatible public candidate(s)."
        )
        unique_errors = list(dict.fromkeys(attempt_errors))
        if unique_errors:
            detail += " " + "; ".join(unique_errors[:3]) + "."
        detail += " The category icon fallback remains available."
        raise ApiError(422, "image_download_failed", detail)

    chosen, permission, final_url, stored = selected
    # Recheck after normalization/storage too. A concurrent real photo always wins.
    db.refresh(item, attribute_names=["photos", "updated_at"])
    if item.photos:
        storage.delete_key(stored.storage_key)
        storage.delete_key(stored.thumbnail_key)
        raise ApiError(
            409,
            "actual_photo_exists",
            "A real photo was added while the reference image was downloading; it takes priority.",
        )
    try:
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
    except Exception:
        storage.delete_key(stored.storage_key)
        storage.delete_key(stored.thumbnail_key)
        raise
    return image
