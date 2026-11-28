"""Selected-scope context that lets AI category proposals group related items.

Each AI request sees only a bounded batch. Without more, a tent in one batch and camp
pillows in the next get two narrow categories. The context tells every batch which
categories the selected scope already uses, which ones earlier batches proposed (they do
not exist until a person approves them), and what else is still uncategorised.

It is background for the model only: answers never refer to it by index, and nothing in
it comes from outside the selected scope.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Category, InventoryReviewSuggestion, Item
from .scope import _normalized

MAX_CONTEXT_CATEGORIES = 40
MAX_CONTEXT_EXAMPLES = 3
MAX_CONTEXT_NAMES = 80
MAX_CONTEXT_NAME_LENGTH = 80
CONTEXT_PREFIX = "Inventory context: "


def _distinct_names(names: list[str], limit: int) -> list[str]:
    distinct = {_normalized(name): name[:MAX_CONTEXT_NAME_LENGTH] for name in sorted(names)}
    return [distinct[key] for key in sorted(distinct) if key][:limit]


def scope_context(
    db: Session,
    household_id: uuid.UUID,
    *,
    conditions: list[Any] | None,
    items: list[Item],
    sent_ids: set[uuid.UUID],
    item_names: bool,
) -> dict[str, Any]:
    """Categories used or proposed in the selected scope, and what is still uncategorised.

    ``conditions`` select the whole scope of a batched review; without them the loaded
    ``items`` are the scope. Items in the current request are left out, because the
    model answers for those. With ``item_names`` off, only category names and counts are
    given.
    """
    if conditions is not None:
        rows = db.execute(
            select(Item.id, Item.name, Item.category_id, Category.name)
            .outerjoin(Category, Category.id == Item.category_id)
            .where(*conditions)
        ).all()
    else:
        rows = [
            (item.id, item.name, item.category_id, item.category.name if item.category else None)
            for item in items
        ]
    names = {item_id: name for item_id, name, _category_id, _category in rows}
    groups: dict[str, dict[str, Any]] = {}

    def add(category_id: Any, label: str, item_id: uuid.UUID) -> None:
        # A proposed category has no id yet; its name is what related proposals share.
        key = str(category_id) if category_id else f"new:{_normalized(label)}"
        group = groups.setdefault(
            key, {"name": label, "id": str(category_id) if category_id else None, "items": []}
        )
        group["items"].append(names[item_id])

    for item_id, _name, category_id, category in rows:
        if item_id not in sent_ids and category_id is not None and category:
            add(category_id, category, item_id)
    proposed: set[uuid.UUID] = set()
    for item_id, after in db.execute(
        select(InventoryReviewSuggestion.item_id, InventoryReviewSuggestion.after_json)
        .where(
            InventoryReviewSuggestion.household_id == household_id,
            InventoryReviewSuggestion.status == "pending",
            InventoryReviewSuggestion.type.in_(("category", "organisation")),
            InventoryReviewSuggestion.item_id.is_not(None),
        )
        .order_by(InventoryReviewSuggestion.created_at, InventoryReviewSuggestion.id)
    ).all():
        label = (after or {}).get("category_name")
        # Proposals for items outside the selected scope are not context.
        if item_id in sent_ids or item_id not in names:
            continue
        if not isinstance(label, str) or not _normalized(label):
            continue
        add((after or {}).get("category_id"), label.strip(), item_id)
        proposed.add(item_id)

    ordered = sorted(
        groups.values(),
        key=lambda group: (-len(group["items"]), _normalized(group["name"]), group["id"] or ""),
    )[:MAX_CONTEXT_CATEGORIES]
    context: dict[str, Any] = {}
    if ordered:
        context["categories"] = [
            {
                "name": group["name"][:MAX_CONTEXT_NAME_LENGTH],
                "id": group["id"],
                "item_count": len(group["items"]),
                **(
                    {"examples": _distinct_names(group["items"], MAX_CONTEXT_EXAMPLES)}
                    if item_names
                    else {}
                ),
            }
            for group in ordered
        ]
    if item_names:
        uncategorised = _distinct_names(
            [
                name
                for item_id, name, category_id, _category in rows
                if category_id is None and item_id not in sent_ids and item_id not in proposed
            ],
            MAX_CONTEXT_NAMES,
        )
        if uncategorised:
            context["other_uncategorised_items"] = uncategorised
    return context


def context_line(context: dict[str, Any]) -> str:
    return f"{CONTEXT_PREFIX}{json.dumps(context)}\n" if context else ""


def answer_inputs(prompt: str) -> str:
    """The prompt without the context line.

    Answers refer to the items and taxonomy ids of the request, never to the context. A
    decision on another suggestion while a request is out changes only the context, so
    it must not make the answer unusable.
    """
    return "\n".join(line for line in prompt.split("\n") if not line.startswith(CONTEXT_PREFIX))
