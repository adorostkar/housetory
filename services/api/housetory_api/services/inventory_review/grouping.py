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
from collections import Counter
from dataclasses import dataclass
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


@dataclass
class ScopeUsage:
    """How the selected scope uses categories: its items and the proposals that wait."""

    # (item id, item name, category id or None)
    items: list[tuple[uuid.UUID, str, uuid.UUID | None]]
    # (item id, proposed category name, id of an existing category or None)
    proposals: list[tuple[uuid.UUID, str, uuid.UUID | None]]

    def category_ids(self) -> list[uuid.UUID]:
        """Existing categories the scope uses or is proposed to use, most used first."""
        counts = Counter(
            [category_id for _item, _name, category_id in self.items if category_id]
            + [category_id for _item, _name, category_id in self.proposals if category_id]
        )
        return sorted(counts, key=lambda category_id: (-counts[category_id], str(category_id)))


def scope_usage(
    db: Session,
    household_id: uuid.UUID,
    *,
    conditions: list[Any] | None,
    items: list[Item],
) -> ScopeUsage:
    """Read the selected scope once.

    ``conditions`` select the whole scope of a batched review; without them the loaded
    ``items`` are the scope. Proposals for items outside the scope are left out.
    """
    if conditions is not None:
        rows = [
            tuple(row)
            for row in db.execute(select(Item.id, Item.name, Item.category_id).where(*conditions))
        ]
    else:
        rows = [(item.id, item.name, item.category_id) for item in items]
    in_scope = {item_id for item_id, _name, _category_id in rows}
    proposals: list[tuple[uuid.UUID, str, uuid.UUID | None]] = []
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
        if item_id not in in_scope or not isinstance(label, str) or not _normalized(label):
            continue
        try:
            category_id = uuid.UUID(str(after["category_id"])) if after.get("category_id") else None
        except ValueError:
            continue
        proposals.append((item_id, label.strip(), category_id))
    return ScopeUsage(items=rows, proposals=proposals)


def _distinct_names(names: list[str], limit: int) -> list[str]:
    distinct = {_normalized(name): name[:MAX_CONTEXT_NAME_LENGTH] for name in sorted(names)}
    return [distinct[key] for key in sorted(distinct) if key][:limit]


def scope_context(
    usage: ScopeUsage,
    *,
    sent_ids: set[uuid.UUID],
    offered: dict[uuid.UUID, Category],
) -> dict[str, Any]:
    """Categories used or proposed in the scope, and what is still uncategorised.

    Items in the current request are left out, because the model answers for those. An
    existing category is one record, known by its id: two categories can have the same
    name. Only ids in ``offered`` are given, which are the ids an answer may use. A
    proposed category has no id yet; its name is what related proposals share.
    """
    names = {item_id: name for item_id, name, _category_id in usage.items}
    groups: dict[str, dict[str, Any]] = {}

    def add(category_id: uuid.UUID | None, label: str, item_id: uuid.UUID) -> None:
        if item_id in sent_ids:
            return
        if category_id is not None:
            if category_id not in offered:
                return
            key, label = str(category_id), offered[category_id].name
        else:
            key = f"new:{_normalized(label)}"
        group = groups.setdefault(
            key, {"name": label, "id": str(category_id) if category_id else None, "items": []}
        )
        group["items"].append(names[item_id])

    for item_id, _name, category_id in usage.items:
        if category_id is not None:
            add(category_id, "", item_id)
    for item_id, label, category_id in usage.proposals:
        add(category_id, label, item_id)
    proposed = {item_id for item_id, _label, _category_id in usage.proposals}

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
                "examples": _distinct_names(group["items"], MAX_CONTEXT_EXAMPLES),
            }
            for group in ordered
        ]
    uncategorised = _distinct_names(
        [
            name
            for item_id, name, category_id in usage.items
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
