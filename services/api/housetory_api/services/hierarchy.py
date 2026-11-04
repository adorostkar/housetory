"""Helpers for room and storage-location hierarchies.

The database stays flat (``parent_id`` columns); these functions provide the
closure operations needed for browsing and aggregation without recursive SQL.
"""

import uuid
from collections.abc import Iterable


def descendant_ids(
    rows: Iterable[tuple[uuid.UUID, uuid.UUID | None]], root_id: uuid.UUID
) -> set[uuid.UUID]:
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for item_id, parent_id in rows:
        children.setdefault(parent_id, []).append(item_id)

    result: set[uuid.UUID] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        if current in result:
            continue
        result.add(current)
        stack.extend(children.get(current, ()))
    return result


def descendant_totals(
    rows: Iterable[tuple[uuid.UUID, uuid.UUID | None]],
    direct_counts: dict[uuid.UUID, int],
) -> dict[uuid.UUID, int]:
    """Sum each node's direct count into all of its ancestors."""
    parents = {item_id: parent_id for item_id, parent_id in rows}
    totals = dict(direct_counts)
    for item_id, direct in direct_counts.items():
        cursor = parents.get(item_id)
        seen: set[uuid.UUID] = set()
        while cursor is not None and cursor not in seen:
            seen.add(cursor)
            totals[cursor] = totals.get(cursor, 0) + direct
            cursor = parents.get(cursor)
    return totals
