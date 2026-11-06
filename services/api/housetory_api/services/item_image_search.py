"""Official Brave Image Search adapter with conservative, lawful reference selection."""

from __future__ import annotations

import contextlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode, urlparse

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..models import Item, ItemImage
from . import storage
from .item_images import (
    active_image,
    builtin_key_for_item,
    clear_active_images,
    image_search_fingerprint,
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


@dataclass(frozen=True)
class ImageSearchProvider:
    kind: str
    label: str | None = None
    reason: str | None = None
    api_key: str | None = None
    base_url: str | None = None

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


@dataclass(frozen=True)
class RankedImage:
    candidate: ImageCandidate
    score: int
    exact_model_confirmed: bool


def resolve_image_search_provider() -> ImageSearchProvider:
    settings = get_settings()
    configured_mode = settings.item_image_search_provider
    if configured_mode == "none":
        return ImageSearchProvider(
            kind="none",
            reason=(
                "Online reference-image search is disabled. Built-in illustrations "
                "remain available offline."
            ),
        )
    key = settings.brave_search_api_key.strip()
    if not key:
        return ImageSearchProvider(
            kind="none",
            reason=(
                "Reference-image search is not configured. Set BRAVE_SEARCH_API_KEY "
                "on the server to use the Brave Image Search API. Built-in "
                "illustrations remain available without it."
            ),
        )
    base = settings.brave_search_base_url.strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ImageSearchProvider(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must be an absolute http(s) URL.",
        )
    if parsed.username or parsed.password:
        return ImageSearchProvider(
            kind="none",
            reason="BRAVE_SEARCH_BASE_URL must not contain embedded credentials.",
        )
    return ImageSearchProvider(
        kind="brave",
        label="Brave Image Search API",
        api_key=key,
        base_url=base,
    )


def _normalized(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _compact(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def _query(item: Item) -> str:
    text = " ".join(
        part
        for part in (
            item.brand,
            item.name,
            item.model,
            item.description,
        )
        if part and part.strip()
    )
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


def _brand_present(item: Item, *texts: str | None) -> bool:
    brand = _compact(item.brand)
    if not brand:
        return False
    return any(brand in _compact(text) for text in texts)


def _type_conflict(item: Item, text: str) -> bool:
    item_type = builtin_key_for_item(item)
    if item_type is None:
        return False
    lowered = _normalized(text)
    conflicts = _TYPE_CONFLICTS.get(item_type, ())
    current_terms = {
        "tv": (" tv", "television "),
        "laptop": ("laptop", "notebook"),
        "drill": ("drill",),
        "suitcase": ("suitcase", "luggage"),
        "chair": ("chair",),
        "sofa": ("sofa", "couch"),
        "camera": ("camera",),
        "kettle": ("kettle",),
        "bicycle": ("bicycle", "bike"),
    }.get(item_type, (item_type.replace("-", " "),))
    if any(term in f" {lowered} " for term in conflicts):
        return not any(term in lowered for term in current_terms)
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
                image_url=image_url or thumbnail_url or "",
                thumbnail_url=thumbnail_url,
                width=width,
                height=height,
            )
        )
    return candidates


def rank_candidates(item: Item, candidates: list[ImageCandidate]) -> list[RankedImage]:
    brand = _compact(item.brand)
    if not brand:
        return []
    item_type = builtin_key_for_item(item)
    model = _compact(item.model)
    ranked: list[RankedImage] = []
    for candidate in candidates:
        image_host = (urlparse(candidate.image_url).hostname or "").lower()
        page_host = (urlparse(candidate.page_url).hostname or "").lower()
        if any(
            image_host == host or image_host.endswith(f".{host}")
            for host in STOCK_OR_WATERMARK_HOSTS
        ):
            continue
        if any(
            page_host == host or page_host.endswith(f".{host}") for host in STOCK_OR_WATERMARK_HOSTS
        ):
            continue
        text = " ".join(
            [
                candidate.title,
                candidate.source_domain,
                page_host,
                image_host,
                candidate.page_url,
            ]
        )
        if not _brand_present(
            item, candidate.title, candidate.source_domain, page_host, image_host
        ):
            continue
        if _type_conflict(item, text):
            continue
        score = 0
        if brand in _compact(candidate.title):
            score += 8
        if brand in _compact(page_host) or brand in _compact(image_host):
            score += 8
        if item_type and item_type.replace("-", " ") in _normalized(candidate.title):
            score += 6
        exact = bool(model and model in _compact(text))
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
            )
        )
    ranked.sort(key=lambda entry: (-entry.score, entry.candidate.page_url))
    return ranked


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


def _download_candidate(candidate: ImageCandidate) -> tuple[bytes, str, str]:
    settings = get_settings()
    max_bytes = settings.item_image_max_download_bytes
    last_error: Exception | None = None
    for url, label in (
        (candidate.image_url, "original"),
        (candidate.thumbnail_url, "thumbnail"),
    ):
        if not url:
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
        "The selected image could not be downloaded safely; the built-in "
        "illustration remains available.",
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
    provider = resolve_image_search_provider()
    if not provider.configured:
        raise ApiError(
            503, "image_search_unconfigured", provider.reason or "Image search is not configured."
        )
    query = _query(item)
    if not query.strip():
        raise ApiError(
            422,
            "image_description_required",
            "Add a product name or description before finding a reference image.",
        )
    candidates = _brave_image_results(provider, query)
    ranked = rank_candidates(item, candidates)
    if not ranked:
        raise ApiError(
            422,
            "no_image_candidate",
            "No suitable manufacturer-hosted image was found. The built-in "
            "illustration remains available.",
        )
    chosen = ranked[0]
    content, final_url, _kind = _download_candidate(chosen.candidate)
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
            f"{_compact(item.brand) or 'reference'}."
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
        license_note=(
            "Manufacturer-hosted image selected from a public search result. "
            "Source page recorded; reuse and licensing rights are not independently verified."
        ),
        retrieved_at=datetime.now(UTC),
        exact_model_confirmed=chosen.exact_model_confirmed,
        model_label=item.model if chosen.exact_model_confirmed else None,
        search_fingerprint=fingerprint,
    )
    db.add(image)
    db.flush()
    return image
