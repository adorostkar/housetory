"""Successful AI input coverage; local checks and suggestion decisions stay independent."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ...models import InventoryReviewCoverage, Item
from .scope import _hash

CAPABILITY = "ai_organisation"
CAPABILITY_VERSION = 1


def item_input(item: Item) -> dict:
    return {
        "name": item.name[:200],
        "description": (item.description or "")[:300],
        "brand": (item.brand or "")[:120],
        "model": (item.model or "")[:120],
        "current_category": item.category.name if item.category else None,
        "current_tags": sorted(tag.name for tag in item.tags),
    }


def fingerprints(items, categories, tags, status) -> dict[uuid.UUID, str]:
    context = {
        "version": CAPABILITY_VERSION,
        "provider": status.provider,
        "provider_id": status.provider_id,
        "model": status.model,
        "capabilities": sorted(status.capabilities),
        "categories": [(str(row.id), row.name) for row in categories],
        "tags": [(str(row.id), row.name) for row in tags],
    }
    return {item.id: _hash({"context": context, "item": item_input(item)}) for item in items}


def matching(db: Session, household_id: uuid.UUID, inputs: dict[uuid.UUID, str]) -> set[uuid.UUID]:
    rows = db.scalars(
        select(InventoryReviewCoverage).where(
            InventoryReviewCoverage.household_id == household_id,
            InventoryReviewCoverage.capability == CAPABILITY,
            InventoryReviewCoverage.item_id.in_(inputs),
        )
    )
    return {row.item_id for row in rows if inputs[row.item_id] == row.input_fingerprint}


def remember(db: Session, household_id: uuid.UUID, run_id: uuid.UUID, inputs: dict[str, str]):
    if not inputs:
        return
    statement = insert(InventoryReviewCoverage).values(
        [
            {
                "household_id": household_id,
                "item_id": uuid.UUID(item_id),
                "capability": CAPABILITY,
                "input_fingerprint": fingerprint,
                "run_id": run_id,
                "reviewed_at": datetime.now(UTC),
            }
            for item_id, fingerprint in inputs.items()
        ]
    )
    db.execute(
        statement.on_conflict_do_update(
            index_elements=["household_id", "item_id", "capability"],
            set_={
                "input_fingerprint": statement.excluded.input_fingerprint,
                "run_id": statement.excluded.run_id,
                "reviewed_at": statement.excluded.reviewed_at,
            },
        )
    )
