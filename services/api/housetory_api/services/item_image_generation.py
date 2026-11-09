"""Background item-image jobs for public reference-image lookup.

Illustration generation was retired. The legacy task names remain here so
already-queued jobs can finish truthfully without making provider generation
calls or deleting existing media.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..jobs import enqueue, is_cancelled, update_result
from ..models import Household, Item, Job
from .item_image_search import find_and_select_reference, resolve_image_search_provider

NEW_ITEM_TASK = "item_images.new_item"
BATCH_TASK = "item_images.batch"


def _lock_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"housetory-item-image-{item_id}"},
    )
    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == household_id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    db.refresh(item)
    return item


def sufficient_description(item: Item) -> bool:
    if len(item.name.strip()) < 3:
        return False
    return bool(
        (item.description and len(item.description.strip()) >= 10)
        or item.brand
        or item.model
        or item.category_id
    )


def maybe_enqueue_new_item_image(db: Session, item: Item) -> Job | None:
    household = db.get(Household, item.household_id)
    if household is None or not household.item_image_auto_reference:
        return None
    if not sufficient_description(item):
        return None
    active = db.scalar(
        select(Job.id)
        .where(
            Job.task == NEW_ITEM_TASK,
            Job.status.in_(["queued", "running"]),
            Job.payload["item_id"].astext == str(item.id),
        )
        .limit(1)
    )
    if active is not None:
        return None
    return enqueue(
        db,
        NEW_ITEM_TASK,
        {"household_id": str(item.household_id), "item_id": str(item.id)},
        max_attempts=1,
        commit=False,
    )


def run_new_item_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Automatic reference lookup only; never generate an illustration."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        household_id = uuid.UUID(str(payload["household_id"]))
        item_id = uuid.UUID(str(payload["item_id"]))
        item = _lock_item(db, household_id, item_id)
        household = item.household
        if (
            item.photos
            or item.is_archived
            or not sufficient_description(item)
            or not household.item_image_auto_reference
        ):
            return {"status": "skipped"}
        provider = resolve_image_search_provider(db, household_id)
        if not provider.configured:
            return {"status": "skipped", "reason": "Reference-image search is not configured."}
        try:
            find_and_select_reference(
                db,
                household_id,
                item,
                actor_user_id=None,
                force=False,
            )
            db.commit()
            return {"status": "reference"}
        except ApiError as exc:
            db.rollback()
            return {"status": "skipped", "reason": exc.message}


def run_batch_job(payload: dict[str, Any], job_id: uuid.UUID) -> dict[str, Any]:
    """Run public reference lookup batches; retire legacy illustration batches."""
    from ..db import SessionLocal

    household_id = uuid.UUID(str(payload["household_id"]))
    action = str(payload["action"])
    item_ids = [uuid.UUID(str(value)) for value in payload.get("item_ids", [])]
    if action != "reference":
        # Jobs queued before illustration generation was removed.
        return {
            "status": "skipped",
            "completed": 0,
            "failed": 0,
            "skipped": len(item_ids),
            "processed": len(item_ids),
        }

    completed = failed = skipped = 0
    with SessionLocal() as db:
        for index, item_id in enumerate(item_ids):
            db.expire_all()
            if is_cancelled(db, job_id):
                skipped += len(item_ids) - index
                break
            try:
                item = _lock_item(db, household_id, item_id)
                if item.photos or item.is_archived:
                    skipped += 1
                else:
                    provider = resolve_image_search_provider(db, household_id)
                    if not provider.configured:
                        failed += 1
                    else:
                        find_and_select_reference(
                            db,
                            household_id,
                            item,
                            actor_user_id=None,
                            force=False,
                        )
                        db.commit()
                        completed += 1
            except Exception:  # noqa: BLE001 - one item must not abort the batch
                db.rollback()
                failed += 1
            update_result(
                db,
                job_id,
                {
                    "completed": completed,
                    "failed": failed,
                    "skipped": skipped,
                    "processed": completed + failed + skipped,
                },
            )
    return {
        "completed": completed,
        "failed": failed,
        "skipped": skipped,
        "processed": completed + failed + skipped,
    }
