"""Worker-side product URL retrieval for ordinary text imports."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import ImportBatch
from . import storage
from .product_pages import fetch_product_page, render_product_note


def refresh_product_source(db: Session, batch: ImportBatch) -> None:
    url = str((batch.metadata_json or {}).get("product_url") or "").strip()
    if not url:
        return
    page = fetch_product_page(url)
    purchase_date = (batch.metadata_json or {}).get("purchase_date")
    text = render_product_note(page, str(purchase_date) if purchase_date else None)
    stored = storage.store_import_text(batch.household_id, batch.id, text)
    previous_key = batch.storage_key
    batch.storage_key = stored.storage_key
    batch.byte_size = stored.byte_size
    batch.original_filename = "product-page.txt"
    batch.content_type = "text/plain"
    if batch.title == "Product link":
        batch.title = page.title[:200]
    storage.delete_import_key(previous_key)


__all__ = ["refresh_product_source"]
