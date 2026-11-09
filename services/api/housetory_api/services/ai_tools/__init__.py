"""Read-only, household-scoped tools used by the assistant and smart search."""

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import (
    Document,
    Item,
)
from ...services.serializers import (
    item_load_options,
    item_summary,
)
from .catalog_tools import (
    tool_count_items,
    tool_find_missing_information,
    tool_get_container_contents,
    tool_get_inventory_summary,
    tool_get_item_details,
    tool_get_purchase_history,
    tool_get_warranty_status,
    tool_list_room_contents,
    tool_search_documents,
    tool_search_items,
    tool_search_locations,
)
from .inventory_query import search_inventory as search_inventory
from .references import ToolResult
from .references import _human_date as _human_date
from .references import _summaries_with_paths as _summaries_with_paths
from .whereabouts_tools import (
    tool_find_borrowed_owner,
    tool_get_loan_history,
    tool_list_borrowed_items,
    tool_list_outstanding_loans,
    tool_locate_item,
)


def execute_tool(
    db: Session,
    household_id: uuid.UUID,
    tool: str,
    arguments: dict[str, Any],
    *,
    household_reminder_days: int,
) -> ToolResult:
    handlers = {
        "search_items": lambda: tool_search_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_item_details": lambda: tool_get_item_details(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "search_locations": lambda: tool_search_locations(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_room_contents": lambda: tool_list_room_contents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_container_contents": lambda: tool_get_container_contents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "search_documents": lambda: tool_search_documents(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_purchase_history": lambda: tool_get_purchase_history(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_warranty_status": lambda: tool_get_warranty_status(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_inventory_summary": lambda: tool_get_inventory_summary(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "find_missing_information": lambda: tool_find_missing_information(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_outstanding_loans": lambda: tool_list_outstanding_loans(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "list_borrowed_items": lambda: tool_list_borrowed_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "find_borrowed_owner": lambda: tool_find_borrowed_owner(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "locate_item": lambda: tool_locate_item(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "count_items": lambda: tool_count_items(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
        "get_loan_history": lambda: tool_get_loan_history(
            db, household_id, arguments, household_reminder_days=household_reminder_days
        ),
    }
    handler = handlers.get(tool)
    if handler is None:
        raise ValueError("Unknown tool")
    return handler()


def document_relations(
    db: Session,
    household_id: uuid.UUID,
    document: Document,
    *,
    household_reminder_days: int,
    limit: int = 8,
) -> list[dict[str, Any]]:
    metadata = document.extracted_metadata or {}
    text = " ".join(
        [
            str(metadata.get("merchant") or ""),
            " ".join(str(name) for name in metadata.get("product_names") or []),
            " ".join(str(serial) for serial in metadata.get("serial_numbers") or []),
            document.merchant or "",
        ]
    )
    if not text.strip():
        return []
    items = db.scalars(
        select(Item)
        .options(*item_load_options())
        .where(Item.household_id == household_id, Item.is_archived.is_(False))
    ).all()
    serials = {str(value).lower() for value in metadata.get("serial_numbers") or []}
    results = []
    for item in items:
        score = 0
        reasons = []
        if item.serial_number and item.serial_number.lower() in serials:
            score += 80
            reasons.append("serial number matches the document")
        haystack = " ".join(
            filter(
                None,
                [item.name, item.brand, item.model, item.serial_number, item.description],
            )
        ).lower()
        tokens = [
            token.lower()
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9-]{2,}", text)
            if len(token) >= 4
            and token.lower()
            not in {"with", "from", "that", "this", "your", "their", "receipt", "invoice"}
        ]
        matched = [token for token in tokens if token in haystack]
        if matched:
            score += min(35, len(set(matched)) * 8)
            reasons.append("text matches " + ", ".join(sorted(set(matched))[:3]))
        if score >= 20:
            results.append((score, reasons, item))
    results.sort(key=lambda entry: entry[0], reverse=True)
    return [
        {
            "item": item_summary(item, household_reminder_days=household_reminder_days).model_dump(
                mode="json"
            ),
            "score": score,
            "reasons": reasons,
        }
        for score, reasons, item in results[:limit]
    ]
