"""Item image display priority and provenance helpers.

Actual photographs remain in ``item_photos`` and always take priority. The only
selectable non-photo sources are downloaded reference images and existing legacy
AI illustrations. New illustration generation is retired. No-photo fallback is
rendered by the frontend as a simple category icon, not generated line art.
"""

from __future__ import annotations

import hashlib
import re
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..models import Item, ItemImage
from ..schemas.item_images import ItemImageOut, ItemImageSettingsOut, ItemImageState

# Product-type vocabulary used by reference-image matching. It contains no
# artwork or presentation data.
_ITEM_TYPE_TERMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ethernet-cable", ("ethernet cable", "ethernet", "network cable", "cat6", "cat 6", "rj45")),
    ("drill", ("drill", "impact driver", "hammer drill", "cordless drill")),
    ("tv", ("television", "oled tv", "qled tv", "smart tv", " tv", "tv ")),
    ("suitcase", ("suitcase", "luggage", "travel case", "carry-on case")),
    ("camera", ("camera", "dslr", "mirrorless", "camera lens")),
    ("laptop", ("laptop", "notebook computer", "macbook")),
    ("kettle", ("kettle", "electric kettle", "teapot")),
    ("bicycle", ("bicycle", "bike", "cycle")),
    ("sofa", ("sofa", "couch", "settee")),
    ("chair", ("chair", "stool", "armchair")),
    ("box", ("empty box", "storage box", "cardboard box", "plastic box", "storage bin", "crate")),
    ("book", ("book", "novel", "hardcover", "paperback")),
)


def _normalize(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def item_type_key(item: Item) -> str | None:
    """Conservatively classify a product type for reference-image matching.

    Name matches take precedence. Two different strong type matches in the name
    are ambiguous and intentionally return ``None`` rather than guessing.
    """
    name = f" {_normalize(item.name)} "
    matches: list[str] = []
    for key, terms in _ITEM_TYPE_TERMS:
        if any(term in name for term in terms):
            matches.append(key)
    if len(set(matches)) == 1:
        return matches[0]
    if len(set(matches)) > 1:
        return None
    category = f" {_normalize(item.category.name if item.category else '')} "
    text = f" {_normalize(item.description)} "
    for key, terms in _ITEM_TYPE_TERMS:
        if any(term in category for term in terms):
            matches.append(key)
    if len(set(matches)) == 1:
        return matches[0]
    if len(set(matches)) > 1:
        return None
    for key, terms in _ITEM_TYPE_TERMS:
        if any(term in text for term in terms):
            matches.append(key)
    return matches[0] if len(set(matches)) == 1 else None


def active_image(item: Item) -> ItemImage | None:
    """Return the selected display image, ignoring legacy built-in rows."""
    active = [
        image
        for image in item.images
        if image.status == "active" and image.source_type in {"reference", "ai"}
    ]
    if not active:
        return None
    return max(active, key=lambda image: image.created_at)


def _image_urls(image: ItemImage) -> tuple[str | None, str | None]:
    if image.id is None or image.storage_key is None:
        return None, None
    prefix = get_settings().api_prefix
    return (
        f"{prefix}/item-images/{image.id}/file",
        f"{prefix}/item-images/{image.id}/thumbnail",
    )


def image_out(image: ItemImage) -> ItemImageOut:
    url, thumbnail_url = _image_urls(image)
    labels = {
        "reference": "Reference image",
        "ai": "AI illustration",
    }
    label = labels.get(image.source_type)
    if label is None:
        raise ValueError("Legacy built-in illustrations are not displayable.")
    return ItemImageOut(
        id=image.id,
        source_type=image.source_type,
        label=label,
        status=image.status,
        url=url,
        thumbnail_url=thumbnail_url,
        width=image.width,
        height=image.height,
        source_name=image.source_name,
        source_url=image.source_url,
        source_page_url=image.source_page_url,
        license_note=image.license_note,
        license_name=image.license_name,
        license_url=image.license_url,
        permission_basis=image.permission_basis,
        retrieved_at=image.retrieved_at,
        exact_model_confirmed=image.exact_model_confirmed,
        model_label=image.model_label,
        provider_label=image.provider.display_name if image.provider else None,
        created_at=image.created_at,
    )


def representative_image_out(item: Item) -> ItemImageOut | None:
    selected = active_image(item)
    if selected is None:
        return None
    return image_out(selected)


def image_search_fingerprint(item: Item) -> str:
    payload = "\x1f".join(
        [
            _normalize(item.name),
            _normalize(item.brand),
            _normalize(item.model),
            _normalize(item.description)[:800],
        ]
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def product_text(item: Item, limit: int = 600) -> str:
    parts = [
        item.name,
        item.brand or "",
        item.model or "",
        item.description or "",
        item.category.name if item.category else "",
    ]
    return " · ".join(part.strip() for part in parts if part and part.strip())[:limit]


def settings_out(household) -> ItemImageSettingsOut:  # noqa: ANN001
    return ItemImageSettingsOut(auto_reference=household.item_image_auto_reference)


def state_out(
    item: Item,
    *,
    search_configured: bool,
    search_provider_label: str | None,
    search_reason: str | None,
) -> ItemImageState:
    selected = active_image(item)
    return ItemImageState(
        item_id=item.id,
        actual_photo_count=len(item.photos),
        image=image_out(selected) if selected is not None else None,
        selected=image_out(selected) if selected is not None else None,
        settings=settings_out(item.household),
        search_configured=search_configured,
        search_provider_label=search_provider_label,
        search_reason=search_reason,
    )


def delete_item_image(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    image_id: uuid.UUID,
) -> None:
    image = db.scalar(
        select(ItemImage).where(
            ItemImage.id == image_id,
            ItemImage.item_id == item_id,
            ItemImage.household_id == household_id,
        )
    )
    if image is None:
        raise ApiError(404, "item_image_not_found", "Item image not found.")
    from . import storage

    storage.delete_key(image.storage_key)
    storage.delete_key(image.thumbnail_key)
    db.delete(image)
    db.flush()


def clear_active_images(db: Session, item_id: uuid.UUID) -> None:
    active = db.scalars(
        select(ItemImage).where(
            ItemImage.item_id == item_id,
            ItemImage.status == "active",
        )
    ).all()
    for image in active:
        image.status = "superseded"
    db.flush()
