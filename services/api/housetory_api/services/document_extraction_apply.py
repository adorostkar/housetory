"""Reviewed apply of document extraction proposals.

Apply is one transaction. Any invalid item, destination, purchase or warranty rolls
the whole request back. A household-scoped request id makes retries return the
stored result instead of creating another purchase or stock increment.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..models import Document, DocumentExtractionApply, Item, Purchase, PurchaseAllocation
from ..schemas.common import ItemReference
from ..schemas.extraction import (
    ExtractionApplyRequest,
    ExtractionApplyResult,
    ExtractionLineDecision,
    ExtractionWarranty,
)
from ..schemas.items import ItemCreate, ItemUpdate
from ..schemas.purchases import PurchaseIn
from ..schemas.warranties import WarrantyIn
from .documents import get_document
from .items import create_item_record, update_item_record
from .purchases import apply_purchase_fields, get_purchase
from .serializers import document_out


def _items_by_id(db: Session, household_id: uuid.UUID, item_ids: set[uuid.UUID]) -> dict:
    if not item_ids:
        return {}
    items = list(
        db.scalars(
            select(Item)
            .where(Item.household_id == household_id, Item.id.in_(item_ids))
            .order_by(Item.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).all()
    )
    if len(items) != len(item_ids):
        raise ApiError(
            404,
            "extracted_item_unavailable",
            "One or more matched items are unavailable or belong to another household.",
        )
    if any(item.is_archived for item in items):
        raise ApiError(
            409,
            "extracted_item_archived",
            "A matched item is archived. Restore it or choose another match.",
        )
    return {item.id: item for item in items}


def _warranty_in(
    decision: ExtractionLineDecision,
    warranty: ExtractionWarranty,
    document: Document,
) -> WarrantyIn:
    return WarrantyIn(
        provider=warranty.provider,
        start_date=warranty.start_date,
        duration_months=warranty.duration_months,
        end_date=warranty.end_date,
        reminder_days=warranty.reminder_days,
        notes=warranty.notes,
        document_id=document.id,
    )


def _merge_update_fields(
    target: dict[str, Any],
    update,
    decision: ExtractionLineDecision,
) -> None:  # noqa: ANN001
    for field in update.model_fields_set:
        value = getattr(update, field)
        if field in target and target[field] != value:
            raise ApiError(
                422,
                "conflicting_item_updates",
                "Multiple reviewed lines propose different updates for the same item.",
            )
        target[field] = value
    if decision.warranty is not None:
        if target.get("warranty") is not None and target["warranty"] != decision.warranty:
            raise ApiError(
                422,
                "conflicting_warranty_updates",
                "Multiple reviewed lines propose different warranty details for the same item.",
            )
        target["warranty"] = decision.warranty


def _payload_fingerprint(payload: ExtractionApplyRequest) -> str:
    canonical = json.dumps(
        payload.model_dump(mode="json", exclude={"request_id"}),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _stored_summary(
    *,
    request_id: uuid.UUID,
    payload_fingerprint: str,
    created_item_ids: list[uuid.UUID],
    updated_item_ids: list[uuid.UUID],
    linked_item_ids: list[uuid.UUID],
    skipped_line_ids: list[str],
    purchase_id: uuid.UUID | None,
    warranty_item_ids: list[uuid.UUID],
    warnings: list[str],
    applied_lines: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "request_id": str(request_id),
        "payload_fingerprint": payload_fingerprint,
        "created_item_ids": [str(value) for value in created_item_ids],
        "updated_item_ids": [str(value) for value in updated_item_ids],
        "linked_item_ids": [str(value) for value in linked_item_ids],
        "skipped_line_ids": skipped_line_ids,
        "purchase_id": str(purchase_id) if purchase_id else None,
        "warranty_item_ids": [str(value) for value in warranty_item_ids],
        "warnings": warnings,
        "applied_lines": applied_lines,
        "applied_at": datetime.now(UTC).isoformat(),
    }


def _result_from_stored(
    db: Session,
    document: Document,
    result: dict[str, Any],
) -> ExtractionApplyResult:
    item_ids = [
        uuid.UUID(str(value))
        for key in ("created_item_ids", "updated_item_ids", "linked_item_ids")
        for value in result.get(key, [])
    ]
    items = (
        list(
            db.scalars(
                select(Item).where(
                    Item.household_id == document.household_id,
                    Item.id.in_(set(item_ids)),
                )
            ).all()
        )
        if item_ids
        else []
    )
    return ExtractionApplyResult(
        document=document_out(document),
        request_id=uuid.UUID(str(result["request_id"])),
        created_item_ids=[uuid.UUID(str(value)) for value in result.get("created_item_ids", [])],
        updated_item_ids=[uuid.UUID(str(value)) for value in result.get("updated_item_ids", [])],
        linked_item_ids=[uuid.UUID(str(value)) for value in result.get("linked_item_ids", [])],
        skipped_line_ids=list(result.get("skipped_line_ids", [])),
        purchase_id=uuid.UUID(str(result["purchase_id"])) if result.get("purchase_id") else None,
        warranty_item_ids=[uuid.UUID(str(value)) for value in result.get("warranty_item_ids", [])],
        warnings=list(result.get("warnings", [])),
        applied_at=datetime.fromisoformat(str(result["applied_at"])),
        items=[
            ItemReference(id=item.id, name=item.name)
            for item in sorted(items, key=lambda entry: entry.name.lower())
        ],
    )


def apply_extraction(
    db: Session,
    household_id: uuid.UUID,
    document: Document,
    payload: ExtractionApplyRequest,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> ExtractionApplyResult:
    document = db.scalar(
        select(Document)
        .where(Document.id == document.id, Document.household_id == household_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if document is None:
        raise ApiError(404, "document_not_found", "Document not found.")
    existing = db.scalar(
        select(DocumentExtractionApply).where(
            DocumentExtractionApply.household_id == household_id,
            DocumentExtractionApply.request_id == payload.request_id,
        )
    )
    fingerprint = _payload_fingerprint(payload)
    if existing is not None:
        if (
            existing.document_id != document.id
            or existing.result.get("payload_fingerprint") != fingerprint
        ):
            raise ApiError(
                409,
                "request_id_reused",
                "That request id was used for a different document extraction payload.",
            )
        return _result_from_stored(db, document, existing.result)

    metadata = document.extracted_metadata or {}
    base_extraction = metadata.get("extraction")
    if not isinstance(base_extraction, dict):
        raise ApiError(409, "extraction_unavailable", "Run extraction before applying changes.")
    base_version = str(base_extraction.get("version"))
    extraction = base_extraction
    if payload.extraction_version != base_version:
        refinements = metadata.get("extraction_refinements")
        refinement = (
            refinements.get(payload.extraction_version) if isinstance(refinements, dict) else None
        )
        if not isinstance(refinement, dict) or refinement.get("base_version") != base_version:
            raise ApiError(
                409,
                "extraction_stale",
                "The extracted document changed. Refresh and review the proposal again.",
            )
        from .enrichment import source_version

        if refinement.get("source_version") and refinement["source_version"] != source_version(
            db,
            document,
        ):
            raise ApiError(
                409,
                "extraction_stale",
                "The document changed after these AI suggestions. Keep your current edits "
                "and request a new refinement.",
            )
        extraction = refinement

    previous_applies = list(
        db.scalars(
            select(DocumentExtractionApply).where(
                DocumentExtractionApply.household_id == household_id,
                DocumentExtractionApply.document_id == document.id,
            )
        ).all()
    )
    if previous_applies and not payload.allow_reapply:
        raise ApiError(
            409,
            "already_applied",
            "This extraction was already applied. Review the previous result or "
            "explicitly allow a re-apply.",
        )

    lines = {str(line.get("id")): line for line in extraction.get("lines", [])}
    purchase_eligible = bool(base_extraction.get("purchase_eligible"))
    if payload.purchase_action != "none" and not purchase_eligible:
        raise ApiError(
            422,
            "purchase_evidence_required",
            "This document type is not treated as proof of purchase.",
        )
    if payload.purchase_action == "none" and (payload.purchase is not None or payload.purchase_id):
        raise ApiError(
            422,
            "purchase_action_required",
            "Choose create or existing purchase before sending purchase fields.",
        )
    if payload.purchase_action == "create" and payload.purchase is None:
        raise ApiError(422, "purchase_required", "Purchase details are required.")
    if payload.purchase_action == "existing" and payload.purchase_id is None:
        raise ApiError(422, "purchase_required", "Choose the existing purchase to update.")

    existing_decisions = [
        decision
        for decision in payload.lines
        if decision.action in {"link", "update"} and decision.item_id is not None
    ]
    item_ids = {decision.item_id for decision in existing_decisions if decision.item_id}
    items = _items_by_id(db, household_id, item_ids)
    grouped: dict[uuid.UUID, dict[str, Any]] = {}
    created_drafts: list[tuple[ExtractionLineDecision, dict[str, Any]]] = []
    skipped: list[str] = []
    linked_ids: list[uuid.UUID] = []
    warnings: list[str] = []

    for decision in payload.lines:
        line = lines.get(decision.line_id)
        if line is None:
            raise ApiError(
                422, "extraction_line_not_found", "An extracted line is no longer available."
            )
        if decision.action == "skip":
            skipped.append(decision.line_id)
            continue
        if line.get("kind") != "product":
            raise ApiError(
                422,
                "line_not_inventory",
                "Only product lines can create or update inventory.",
            )
        if decision.action == "create":
            if decision.new_item is None:
                raise ApiError(422, "new_item_required", "New item details are required.")
            if decision.item_id is not None:
                raise ApiError(
                    422, "ambiguous_line_action", "Choose one existing item or create a new one."
                )
            created_drafts.append((decision, line))
            continue
        if decision.item_id is None:
            raise ApiError(422, "item_required", "Choose an existing item or create a new one.")
        item = items.get(decision.item_id)
        if item is None:
            raise ApiError(404, "extracted_item_unavailable", "The matched item is unavailable.")
        if decision.new_item is not None:
            raise ApiError(
                422, "ambiguous_line_action", "Do not send new item details for an existing item."
            )
        if decision.action == "update" and decision.updates is None:
            raise ApiError(422, "update_required", "Choose item fields to update.")
        linked_ids.append(item.id)
        target = grouped.setdefault(
            item.id,
            {"item": item, "updates": {}, "quantity": 0, "warranty": None},
        )
        if decision.updates is not None:
            _merge_update_fields(target["updates"], decision.updates, decision)
        if decision.warranty is not None:
            if target["warranty"] is not None and target["warranty"] != decision.warranty:
                raise ApiError(
                    422,
                    "conflicting_warranty_updates",
                    "Multiple reviewed lines propose different warranty details for the same item.",
                )
            target["warranty"] = decision.warranty
        if decision.add_quantity:
            target["quantity"] += decision.quantity or int(line.get("quantity") or 1)

    selected_count = len(created_drafts) + len(grouped)
    if payload.purchase_action != "none" and selected_count == 0:
        raise ApiError(422, "item_required", "Choose at least one item for the purchase.")
    if payload.purchase_action == "none" and not payload.lines and payload.document_fields is None:
        raise ApiError(422, "no_changes", "Choose at least one change to apply.")

    purchase: Purchase | None = None
    if payload.purchase_action == "existing":
        purchase = get_purchase(db, household_id, payload.purchase_id)  # type: ignore[arg-type]
        if payload.purchase is not None:
            apply_purchase_fields(
                purchase,
                payload.purchase,
                fields=set(payload.purchase.model_fields_set) - {"receipt_document_id"},
            )
    elif payload.purchase_action == "create":
        purchase_input: PurchaseIn = payload.purchase  # type: ignore[assignment]
        purchase = Purchase(
            household_id=household_id,
            currency=purchase_input.currency,
        )
        apply_purchase_fields(
            purchase,
            purchase_input,
            fields=set(purchase_input.model_fields_set) - {"receipt_document_id"},
        )
        db.add(purchase)
        db.flush()

    created_ids: list[uuid.UUID] = []
    updated_ids: list[uuid.UUID] = []
    warranty_item_ids: list[uuid.UUID] = []
    applied_lines: list[dict[str, Any]] = []
    allocation_drafts: list[dict[str, Any]] = []
    document_items: list[Item] = []

    for decision, line in created_drafts:
        draft = decision.new_item
        assert draft is not None
        warranty = (
            _warranty_in(decision, decision.warranty, document)
            if decision.warranty is not None
            else None
        )
        item = create_item_record(
            db,
            household_id,
            ItemCreate(
                name=draft.name,
                description=draft.description,
                brand=draft.brand,
                model=draft.model,
                serial_number=draft.serial_number,
                quantity=draft.quantity,
                room_id=draft.room_id,
                storage_location_id=draft.storage_location_id,
                category_id=draft.category_id,
                purchase_id=purchase.id if purchase is not None else None,
                warranty=warranty,
            ),
        )
        created_ids.append(item.id)
        document_items.append(item)
        if warranty is not None:
            warranty_item_ids.append(item.id)
        applied_lines.append(
            {
                "line_id": decision.line_id,
                "action": "create",
                "item_id": str(item.id),
                "quantity": draft.quantity,
                "line_total_cents": decision.line_total_cents
                if decision.line_total_cents is not None
                else line.get("line_total_cents"),
            }
        )
        if purchase is not None:
            reviewed_amount = (
                decision.line_total_cents
                if decision.line_total_cents is not None
                else line.get("line_total_cents")
            )
            allocation_drafts.append(
                {
                    "item_id": item.id,
                    "source_line_id": decision.line_id,
                    "description": draft.name,
                    "quantity": draft.quantity,
                    "unit_price_cents": line.get("unit_price_cents"),
                    "line_total_cents": reviewed_amount,
                    "allocated_cents": reviewed_amount,
                    "source_evidence": (line.get("evidence") or {}).get("text"),
                }
            )

    for _item_id, target in grouped.items():
        item = target["item"]
        updates: dict[str, Any] = dict(target["updates"])
        if target["quantity"]:
            new_quantity = item.quantity + target["quantity"]
            updates["quantity"] = new_quantity
            warnings.append(
                f"Explicit stock increase recorded for {item.name}: +{target['quantity']}."
            )
        if purchase is not None:
            updates["purchase_id"] = purchase.id
        if target["warranty"] is not None:
            updates["warranty"] = _warranty_in(
                next(
                    decision
                    for decision in existing_decisions
                    if decision.item_id == item.id and decision.warranty is not None
                ),
                target["warranty"],
                document,
            )
        if updates:
            update_item_record(
                db,
                household_id,
                item,
                ItemUpdate(**updates),
                actor_user_id=actor_user_id,
                actor_name=actor_name,
            )
            updated_ids.append(item.id)
            if target["warranty"] is not None:
                warranty_item_ids.append(item.id)
        document_items.append(item)
        for decision in existing_decisions:
            if decision.item_id != item.id:
                continue
            line_record = lines[decision.line_id]
            reviewed_amount = (
                decision.line_total_cents
                if decision.line_total_cents is not None
                else line_record.get("line_total_cents")
            )
            reviewed_quantity = decision.quantity or int(line_record.get("quantity") or 1)
            applied_lines.append(
                {
                    "line_id": decision.line_id,
                    "action": decision.action,
                    "item_id": str(item.id),
                    "quantity": reviewed_quantity,
                    "line_total_cents": reviewed_amount,
                }
            )
            if purchase is not None:
                allocation_drafts.append(
                    {
                        "item_id": item.id,
                        "source_line_id": decision.line_id,
                        "description": line_record.get("description") or "Purchase line",
                        "quantity": reviewed_quantity,
                        "unit_price_cents": line_record.get("unit_price_cents"),
                        "line_total_cents": reviewed_amount,
                        "allocated_cents": reviewed_amount,
                        "source_evidence": (line_record.get("evidence") or {}).get("text"),
                    }
                )

    if len(linked_ids) > 1 and len(set(linked_ids)) < len(linked_ids):
        warnings.append(
            "Multiple reviewed lines were explicitly linked to the same item; verify their totals."
        )
    if purchase is not None:
        if payload.attach_as_receipt:
            purchase.receipt_document_id = document.id
        if not document_items:
            raise ApiError(422, "item_required", "Choose at least one item for the purchase.")
        extraction_currency = (extraction.get("fields") or {}).get("currency")
        if extraction_currency and str(extraction_currency).upper() != purchase.currency.upper():
            raise ApiError(
                422,
                "allocation_currency_mismatch",
                "The receipt currency does not match the purchase currency. "
                "Choose the matching currency before applying allocations.",
            )
        allocated_total = sum(int(draft["allocated_cents"] or 0) for draft in allocation_drafts)
        discount_cents = int((extraction.get("fields") or {}).get("discount_cents") or 0)
        if purchase.price_cents is not None:
            if allocated_total > purchase.price_cents + discount_cents + 1:
                raise ApiError(
                    422,
                    "allocation_exceeds_purchase",
                    "The reviewed product allocations exceed the purchase total plus recorded "
                    "discounts. Correct the line amounts or purchase total before applying.",
                )
            if allocated_total > purchase.price_cents:
                warnings.append(
                    f"Product allocations exceed the purchase total by "
                    f"{allocated_total - purchase.price_cents}¢ because of recorded discounts; "
                    "no amounts were rebalanced automatically."
                )
            elif allocated_total < purchase.price_cents:
                warnings.append(
                    f"{purchase.price_cents - allocated_total}¢ of the purchase total remains "
                    "unallocated to product lines (tax, shipping or discounts may be included)."
                )
        if any(draft["allocated_cents"] is None for draft in allocation_drafts):
            warnings.append(
                "Some reviewed lines have no monetary amount. Their evidence is retained without "
                "a monetary allocation."
            )
        source_ids = [str(draft["source_line_id"]) for draft in allocation_drafts]
        existing_allocations = {
            allocation.source_line_id: allocation
            for allocation in db.scalars(
                select(PurchaseAllocation).where(
                    PurchaseAllocation.household_id == household_id,
                    PurchaseAllocation.purchase_id == purchase.id,
                    PurchaseAllocation.source_line_id.in_(source_ids),
                )
            ).all()
        }
        for draft in allocation_drafts:
            allocation = existing_allocations.get(str(draft["source_line_id"]))
            if allocation is None:
                allocation = PurchaseAllocation(
                    household_id=household_id,
                    purchase_id=purchase.id,
                    item_id=draft["item_id"],
                    document_id=document.id,
                    extraction_version=payload.extraction_version,
                    source_line_id=str(draft["source_line_id"]),
                    currency=purchase.currency,
                    created_by_user_id=actor_user_id,
                    request_id=payload.request_id,
                    description=str(draft["description"])[:300],
                    quantity=int(draft["quantity"]),
                    unit_price_cents=draft["unit_price_cents"],
                    line_total_cents=draft["line_total_cents"],
                    allocated_cents=draft["allocated_cents"],
                    source_evidence=(
                        str(draft["source_evidence"])[:4000] if draft["source_evidence"] else None
                    ),
                )
                db.add(allocation)
            else:
                allocation.item_id = draft["item_id"]
                allocation.document_id = document.id
                allocation.extraction_version = payload.extraction_version
                allocation.description = str(draft["description"])[:300]
                allocation.quantity = int(draft["quantity"])
                allocation.unit_price_cents = draft["unit_price_cents"]
                allocation.line_total_cents = draft["line_total_cents"]
                allocation.allocated_cents = draft["allocated_cents"]
                allocation.currency = purchase.currency
                allocation.source_evidence = (
                    str(draft["source_evidence"])[:4000] if draft["source_evidence"] else None
                )
                allocation.request_id = payload.request_id
                allocation.created_by_user_id = actor_user_id
    if payload.document_fields is not None:
        fields = payload.document_fields.model_fields_set
        if "merchant" in fields:
            document.merchant = payload.document_fields.merchant
        if "document_date" in fields:
            document.document_date = payload.document_fields.document_date

    if payload.link_document:
        existing_ids = {item.id for item in document.items}
        for item in document_items:
            if item.id not in existing_ids:
                document.items.append(item)
                existing_ids.add(item.id)

    if payload.purchase_action != "none" and payload.attach_as_receipt and purchase is not None:
        # Explicitly set after item updates; update_item_record may prune old linkage.
        purchase.receipt_document_id = document.id

    extraction_fields = extraction.get("fields") or {}
    unallocated = (
        (extraction_fields.get("tax_cents") or 0)
        + (extraction_fields.get("shipping_cents") or 0)
        - (extraction_fields.get("discount_cents") or 0)
    )
    if unallocated:
        warnings.append(
            f"{unallocated}¢ of tax/shipping/discount evidence remains "
            "unallocated to product lines."
        )

    summary = _stored_summary(
        request_id=payload.request_id,
        payload_fingerprint=fingerprint,
        created_item_ids=created_ids,
        updated_item_ids=updated_ids,
        linked_item_ids=sorted(set(linked_ids)),
        skipped_line_ids=skipped,
        purchase_id=purchase.id if purchase is not None else None,
        warranty_item_ids=sorted(set(warranty_item_ids)),
        warnings=warnings,
        applied_lines=applied_lines,
    )
    try:
        apply_record = DocumentExtractionApply(
            household_id=household_id,
            document_id=document.id,
            request_id=payload.request_id,
            result=summary,
            created_by_user_id=actor_user_id,
        )
        db.add(apply_record)
        metadata = dict(document.extracted_metadata or {})
        metadata["extraction_applied"] = summary
        metadata["applied_at"] = summary["applied_at"]
        metadata["applied_item_ids"] = sorted(
            {str(value) for value in [*created_ids, *updated_ids, *linked_ids]}
        )
        document.extracted_metadata = metadata
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was already used for another extraction apply.",
        ) from exc
    except Exception:
        db.rollback()
        raise

    return _result_from_stored(db, get_document(db, household_id, document.id), summary)
