"""Read-only copies of a household's inventory for use on a device without the server."""

import io
import uuid
from pathlib import Path

from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..models import Household, Item, ItemPhoto, StorageLocation
from ..schemas.items import ItemDetail
from . import lending, storage, storage_items
from .container_serializers import location_path_map
from .households import offline_copy_allowed
from .serializers import item_detail, item_load_options

SMALL_PHOTO_EDGE = 480
SMALL_PHOTO_QUALITY = 70


def require_offline_copy(household: Household, role: str) -> None:
    if not offline_copy_allowed(household, role):
        raise ApiError(
            403,
            "offline_copy_not_allowed",
            "This household does not allow an offline copy for your role.",
        )


def snapshot_items(db: Session, household: Household) -> list[ItemDetail]:
    """Every item of the household, archived ones included, as the item page shows it.

    Document text is left out: documents cannot be opened offline and their
    text can be large.
    """
    household_id = household.id
    items = list(
        db.scalars(
            select(Item)
            .options(*item_load_options())
            .where(Item.household_id == household_id)
            .order_by(Item.created_at.desc(), Item.id.asc())
        ).all()
    )
    paths = location_path_map(db, household_id)
    on_loan = lending.loan_quantities_for_items(db, household_id, [item.id for item in items])
    storage_owner_ids = set(
        db.scalars(
            select(StorageLocation.owner_item_id).where(
                StorageLocation.household_id == household_id,
                StorageLocation.owner_item_id.is_not(None),
            )
        ).all()
    )
    details: list[ItemDetail] = []
    for item in items:
        detail = item_detail(
            item,
            household_reminder_days=household.warranty_reminder_days,
            location_path=(
                paths.get(item.storage_location_id, []) if item.storage_location_id else []
            ),
            storage=(
                storage_items.storage_out(db, household_id, item.id)
                if item.id in storage_owner_ids
                else None
            ),
            on_loan_quantity=on_loan.get(item.id, 0),
        )
        for document in detail.documents:
            document.extracted_text = None
            document.extracted_metadata = {}
        details.append(detail)
    return details


def small_photo(db: Session, household_id: uuid.UUID, photo_id: uuid.UUID) -> bytes:
    """A small WebP copy of an item photo, made on request and not kept."""
    photo = db.scalar(
        select(ItemPhoto)
        .join(Item)
        .where(ItemPhoto.id == photo_id, Item.household_id == household_id)
    )
    if photo is None:
        raise ApiError(404, "photo_not_found", "Photo not found.")
    path: Path = storage.resolve_key(photo.thumbnail_key or photo.storage_key)
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((SMALL_PHOTO_EDGE, SMALL_PHOTO_EDGE), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=SMALL_PHOTO_QUALITY, method=4)
    except OSError as exc:
        raise ApiError(404, "file_not_found", "File not found.") from exc
    return buffer.getvalue()


__all__ = ["require_offline_copy", "small_photo", "snapshot_items"]
