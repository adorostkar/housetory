"""Insurance replacement estimates and immutable PDF/CSV list snapshots."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..db import SessionLocal
from ..domain import JobStatus
from ..jobs import enqueue
from ..models import Item, ItemValuationPreview, Job
from ..schemas.insurance import (
    InsuranceBatchIn,
    InsuranceBatchOut,
    InsuranceEstimateEntryOut,
    InsuranceItemOut,
    InsuranceListIn,
    InsuranceScopePreviewOut,
)
from ..schemas.valuation import ItemValuationEstimateIn
from . import current_value as current_value_service
from .evidence_export import _selected_item_rows
from .valuation import _preview_metadata, create_preview, valuation_fingerprint

ESTIMATE_TASK = "insurance.estimate"
LIST_TASK = "insurance.list"


def _eligible(item: Item) -> tuple[bool, str | None]:
    if item.quantity <= 0:
        return False, "Zero quantity has no replacement total to estimate."
    if len(item.name.strip()) < 3:
        return False, "Add a more specific item name for AI estimation."
    if not (item.brand or item.model or len((item.description or "").strip()) >= 10):
        return False, "Add a brand, model or short description for AI estimation."
    return True, None


def scope_preview(db: Session, household_id: uuid.UUID, payload) -> InsuranceScopePreviewOut:
    rows, scope_label = _selected_item_rows(db, household_id, payload.scope)
    archived_excluded = (
        0 if payload.include_archived else sum(1 for _item_id, archived in rows if archived)
    )
    selected_ids = [
        item_id for item_id, archived in rows if payload.include_archived or not archived
    ]
    max_items = get_settings().evidence_export_max_items
    if len(selected_ids) > max_items:
        raise ApiError(
            422,
            "export_too_many_items",
            f"This selection has {len(selected_ids)} items; the limit is {max_items}.",
        )
    items = (
        list(
            db.scalars(
                select(Item)
                .where(
                    Item.household_id == household_id,
                    Item.id.in_(selected_ids or [uuid.UUID(int=0)]),
                )
                .order_by(Item.name)
            ).all()
        )
        if selected_ids
        else []
    )
    output = []
    for item in items:
        eligible, reason = _eligible(item)
        output.append(
            InsuranceItemOut(
                item_id=item.id,
                name=item.name,
                description=item.description,
                brand=item.brand,
                model=item.model,
                serial_number=item.serial_number,
                quantity=item.quantity,
                condition=item.condition,
                is_archived=item.is_archived,
                valuation_fingerprint=valuation_fingerprint(item),
                ai_eligible=eligible,
                ai_ineligible_reason=reason,
            )
        )
    return InsuranceScopePreviewOut(
        items=output,
        scope_label=scope_label,
        archived_excluded_count=archived_excluded,
        max_items=max_items,
    )


def _batch_jobs(db: Session, household_id: uuid.UUID, request_id: uuid.UUID) -> list[Job]:
    jobs = list(
        db.scalars(
            select(Job)
            .where(Job.task == ESTIMATE_TASK, Job.payload["request_id"].astext == str(request_id))
            .order_by(Job.created_at, Job.id)
        ).all()
    )
    if jobs and any((job.payload or {}).get("household_id") != str(household_id) for job in jobs):
        raise ApiError(404, "insurance_batch_not_found", "Insurance valuation batch not found.")
    return jobs


def _batch_out(jobs: list[Job], request_id: uuid.UUID) -> InsuranceBatchOut:
    entries = []
    estimated = failed = processed = 0
    for job in jobs:
        result = job.result or {}
        estimate = result.get("estimate")
        if job.status == JobStatus.SUCCEEDED.value and estimate:
            status = "estimated"
            estimated += 1
            processed += 1
        elif job.status == JobStatus.FAILED.value:
            status = "failed"
            failed += 1
            processed += 1
        elif job.status == JobStatus.CANCELLED.value:
            status = "cancelled"
            processed += 1
        elif job.status == JobStatus.RUNNING.value:
            status = "running"
        else:
            status = "queued"
        entries.append(
            InsuranceEstimateEntryOut(
                item_id=uuid.UUID(str(job.payload["item_id"])),
                status=status,  # type: ignore[arg-type]
                estimate=estimate,
                error=(job.last_error or result.get("error"))[:500] if status == "failed" else None,
            )
        )
    if not jobs:
        status = "completed"
    elif all(job.status == JobStatus.CANCELLED.value for job in jobs):
        status = "cancelled"
    elif processed == len(jobs):
        status = "completed" if failed == 0 and estimated == len(jobs) else "partial"
    else:
        status = "running"
    return InsuranceBatchOut(
        request_id=request_id,
        status=status,  # type: ignore[arg-type]
        total=len(jobs),
        processed=processed,
        estimated=estimated,
        failed=failed,
        items=entries,
    )


def create_batch(
    db: Session, household_id: uuid.UUID, actor_user_id: uuid.UUID, payload: InsuranceBatchIn
) -> InsuranceBatchOut:
    item_ids = list(dict.fromkeys(payload.item_ids))
    if not item_ids:
        raise ApiError(422, "no_eligible_items", "Select at least one eligible item.")
    if len(item_ids) > 10:
        raise ApiError(
            422, "insurance_batch_too_large", "AI estimates are limited to 10 items per batch."
        )
    existing = _batch_jobs(db, household_id, payload.request_id)
    if existing:
        expected = {
            "item_ids": [str(value) for value in item_ids],
            "currency": payload.currency,
            "include_web": payload.include_web,
        }
        actual = {
            "item_ids": sorted(str(job.payload["item_id"]) for job in existing),
            "currency": existing[0].payload.get("currency"),
            "include_web": existing[0].payload.get("include_web"),
        }
        if actual != {**expected, "item_ids": sorted(expected["item_ids"])}:
            raise ApiError(
                409,
                "request_id_reused",
                "That request id was used for a different valuation batch.",
            )
        return _batch_out(existing, payload.request_id)
    active = db.scalar(
        select(Job)
        .where(
            Job.task == ESTIMATE_TASK,
            Job.payload["household_id"].astext == str(household_id),
            Job.status.in_([JobStatus.QUEUED.value, JobStatus.RUNNING.value]),
        )
        .limit(1)
    )
    if active is not None:
        raise ApiError(
            409, "insurance_valuation_busy", "Another insurance valuation batch is already running."
        )
    items = list(
        db.scalars(
            select(Item).where(Item.household_id == household_id, Item.id.in_(item_ids))
        ).all()
    )
    if len(items) != len(item_ids):
        raise ApiError(422, "scope_not_found", "One or more selected items do not exist.")
    for item in items:
        eligible, reason = _eligible(item)
        if not eligible:
            raise ApiError(422, "insurance_item_ineligible", f"{item.name}: {reason}")
    for item_id in item_ids:
        enqueue(
            db,
            ESTIMATE_TASK,
            {
                "request_id": str(payload.request_id),
                "household_id": str(household_id),
                "created_by_user_id": str(actor_user_id),
                "item_id": str(item_id),
                "currency": payload.currency,
                "include_web": payload.include_web,
            },
            max_attempts=1,
            commit=False,
            priority=4,
        )
    db.commit()
    return _batch_out(_batch_jobs(db, household_id, payload.request_id), payload.request_id)


def read_batch(db: Session, household_id: uuid.UUID, request_id: uuid.UUID) -> InsuranceBatchOut:
    jobs = _batch_jobs(db, household_id, request_id)
    if not jobs:
        raise ApiError(404, "insurance_batch_not_found", "Insurance valuation batch not found.")
    return _batch_out(jobs, request_id)


def cancel_batch(db: Session, household_id: uuid.UUID, request_id: uuid.UUID) -> InsuranceBatchOut:
    jobs = _batch_jobs(db, household_id, request_id)
    if not jobs:
        raise ApiError(404, "insurance_batch_not_found", "Insurance valuation batch not found.")
    now = datetime.now(UTC)
    for job in jobs:
        if job.status == JobStatus.QUEUED.value:
            job.status = JobStatus.CANCELLED.value
            job.finished_at = now
    db.commit()
    return _batch_out(jobs, request_id)


def process_estimate(payload: dict[str, Any]) -> dict[str, Any]:
    with SessionLocal() as db:
        preview = create_preview(
            db,
            uuid.UUID(str(payload["household_id"])),
            uuid.UUID(str(payload["item_id"])),
            ItemValuationEstimateIn(
                purpose="replacement",
                currency=str(payload["currency"]),
                include_web=bool(payload.get("include_web")),
            ),
            actor_user_id=uuid.UUID(str(payload["created_by_user_id"])),
        )
        db.commit()
        return {"estimate": preview.model_dump(mode="json")}


def _job_out(job: Job) -> dict[str, Any]:
    prefix = get_settings().api_prefix
    succeeded = job.status == JobStatus.SUCCEEDED.value
    return {
        "id": job.id,
        "status": job.status,
        "error": job.last_error,
        "pdf_url": f"{prefix}/insurance-lists/{job.id}/pdf" if succeeded else None,
        "csv_url": f"{prefix}/insurance-lists/{job.id}/csv" if succeeded else None,
    }


def create_list(
    db: Session,
    household_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    payload: InsuranceListIn,
) -> dict[str, Any]:
    existing = db.scalar(
        select(Job).where(
            Job.task == LIST_TASK, Job.payload["request_id"].astext == str(payload.request_id)
        )
    )
    if existing is not None:
        if (existing.payload or {}).get("household_id") != str(household_id):
            raise ApiError(404, "insurance_list_not_found", "Insurance list not found.")
        expected = payload.model_dump(mode="json")
        comparable = {key: value for key, value in existing.payload.items() if key in expected}
        if comparable != expected:
            raise ApiError(
                409, "request_id_reused", "That request id was used for a different insurance list."
            )
        return _job_out(existing)
    job = enqueue(
        db,
        LIST_TASK,
        {
            "request_id": str(payload.request_id),
            "household_id": str(household_id),
            "created_by_user_id": str(actor_user_id),
            **payload.model_dump(mode="json"),
        },
        max_attempts=1,
        commit=False,
        priority=3,
    )
    job.payload["job_id"] = str(job.id)
    db.commit()
    db.refresh(job)
    return _job_out(job)


def read_list_job(db: Session, household_id: uuid.UUID, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if (
        job is None
        or job.task != LIST_TASK
        or (job.payload or {}).get("household_id") != str(household_id)
    ):
        raise ApiError(404, "insurance_list_not_found", "Insurance list not found.")
    return job


def _replacement_snapshot(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    household_id = uuid.UUID(str(payload["household_id"]))
    item_ids = list(dict.fromkeys(uuid.UUID(str(value)) for value in payload["item_ids"]))
    items = list(
        db.scalars(
            select(Item).where(Item.household_id == household_id, Item.id.in_(item_ids))
        ).all()
    )
    by_id = {item.id: item for item in items}
    if len(by_id) != len(item_ids):
        raise ApiError(422, "scope_not_found", "One or more selected items do not exist.")
    values = payload.get("values") or []
    seen: set[uuid.UUID] = set()
    resolved: dict[uuid.UUID, dict[str, Any]] = {}
    for value in values:
        item_id = uuid.UUID(str(value["item_id"]))
        if item_id in seen:
            raise ApiError(
                422, "insurance_value_duplicate", "Each item can have only one reviewed value."
            )
        seen.add(item_id)
        item = by_id.get(item_id)
        if item is None:
            raise ApiError(
                422,
                "insurance_value_out_of_scope",
                "A reviewed value is outside this insurance list.",
            )
        fingerprint = valuation_fingerprint(item)
        if value["expected_fingerprint"] != fingerprint:
            raise ApiError(
                422, "insurance_value_stale", f"{item.name} changed after valuation review."
            )
        amount = int(value["amount_cents"])
        current_value_service.validate_current_value(
            amount, item.quantity, current_value_service.PER_UNIT
        )
        estimate = None
        if value.get("estimate_id"):
            preview = db.scalar(
                select(ItemValuationPreview).where(
                    ItemValuationPreview.id == uuid.UUID(str(value["estimate_id"])),
                    ItemValuationPreview.household_id == household_id,
                    ItemValuationPreview.item_id == item_id,
                )
            )
            if preview is None or preview.expires_at <= datetime.now(UTC):
                raise ApiError(
                    422, "insurance_estimate_expired", f"The estimate for {item.name} expired."
                )
            if preview.purpose != "replacement" or preview.currency != payload["currency"]:
                raise ApiError(
                    422,
                    "insurance_estimate_currency_changed",
                    f"The estimate for {item.name} no longer matches the list.",
                )
            if preview.item_fingerprint != fingerprint:
                raise ApiError(
                    422, "insurance_value_stale", f"{item.name} changed after valuation review."
                )
            estimate = {
                "estimate_id": str(preview.id),
                **_preview_metadata(preview).model_dump(mode="json"),
            }
        resolved[item_id] = {
            "amount_cents": amount,
            "total_cents": amount * max(item.quantity, 0),
            "estimate": estimate,
        }
    output = []
    for item_id in item_ids:
        item = by_id[item_id]
        value = resolved.get(item_id)
        output.append(
            {
                "item_id": str(item_id),
                "name": item.name,
                "brand": item.brand,
                "model": item.model,
                "serial_number": item.serial_number,
                "quantity": item.quantity,
                "condition": item.condition,
                "amount_cents": value["amount_cents"] if value else None,
                "total_cents": value["total_cents"] if value else None,
                "estimate": value["estimate"] if value else None,
            }
        )
    return {
        "currency": payload["currency"],
        "reviewed_on": payload["reviewed_on"],
        "generated_at": datetime.now(UTC).isoformat(),
        "items": output,
    }


def process_list(payload: dict[str, Any]) -> dict[str, Any]:
    with SessionLocal() as db:
        snapshot = _replacement_snapshot(db, payload)
        return {"insurance": snapshot}


def _csv_value(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value


def _paragraph(value: Any) -> str:
    return escape(str(value))


def _csv(snapshot: dict[str, Any]) -> bytes:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "name",
            "brand",
            "model",
            "serial_number",
            "quantity",
            "condition",
            "replacement_value_unit_cents",
            "replacement_value_total_cents",
            "replacement_value_currency",
            "replacement_value_reviewed_on",
            "estimate_as_of",
            "estimate_source",
            "estimate_low_cents",
            "estimate_high_cents",
            "estimate_sources_json",
        ]
    )
    for item in snapshot["items"]:
        estimate = item.get("estimate") or {}
        writer.writerow(
            [
                _csv_value(value)
                for value in (
                    item["name"],
                    item.get("brand"),
                    item.get("model"),
                    item.get("serial_number"),
                    item["quantity"],
                    item["condition"],
                    item.get("amount_cents"),
                    item.get("total_cents"),
                    snapshot["currency"],
                    snapshot["reviewed_on"],
                    estimate.get("as_of"),
                    estimate.get("source"),
                    estimate.get("low_cents"),
                    estimate.get("high_cents"),
                    estimate.get("sources"),
                )
            ]
        )
    return output.getvalue().encode("utf-8-sig")


def _pdf(snapshot: dict[str, Any]) -> bytes:
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title="Insurance replacement list",
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Small", parent=styles["Normal"], fontSize=7.5, leading=9.5))
    story = [
        Paragraph("Insurance replacement list", styles["Title"]),
        Paragraph(
            f"Reviewed {snapshot['reviewed_on']} · "
            f"Generated {snapshot['generated_at'][:10]} · {snapshot['currency']}",
            styles["Small"],
        ),
        Spacer(1, 6 * mm),
        Paragraph(
            "Replacement estimates apply only to this export and were not written back "
            "to item records. "
            "Blank values are unknown, not zero. Historical purchase prices are separate. "
            "Estimates are not professional appraisals or guaranteed insurer payouts.",
            styles["Small"],
        ),
        Spacer(1, 4 * mm),
    ]
    rows = [["Item", "Qty", "Unit", "Total", "Estimate"]]
    for item in snapshot["items"]:
        identity = _paragraph(item["name"])
        details = " · ".join(
            _paragraph(value)
            for value in (item.get("brand"), item.get("model"), item.get("serial_number"))
            if value
        )
        if details:
            identity += f"\n{details}"
        amount = item.get("amount_cents")
        estimate = item.get("estimate") or {}
        rows.append(
            [
                Paragraph(identity, styles["Small"]),
                str(item["quantity"]),
                "Unknown" if amount is None else f"{amount / 100:.2f}",
                "Unknown"
                if item.get("total_cents") is None
                else f"{item['total_cents'] / 100:.2f}",
                Paragraph(
                    _paragraph(estimate.get("source") or "Not estimated")
                    if estimate
                    else "Not estimated",
                    styles["Small"],
                ),
            ]
        )
    table = Table(rows, colWidths=[82 * mm, 14 * mm, 24 * mm, 26 * mm, 32 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8ece5")),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#b8bdb5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(table)
    for item in snapshot["items"]:
        estimate = item.get("estimate")
        if not estimate:
            continue
        story.append(Spacer(1, 3 * mm))
        story.append(
            Paragraph(
                f"<b>{_paragraph(item['name'])}</b> · as of {_paragraph(estimate.get('as_of'))}",
                styles["Small"],
            )
        )
        if estimate.get("confidence"):
            story.append(
                Paragraph(f"{_paragraph(estimate['confidence'])} confidence", styles["Small"])
            )
        if estimate.get("reasoning"):
            story.append(Paragraph(_paragraph(estimate["reasoning"]), styles["Small"]))
        for source in estimate.get("sources") or []:
            story.append(
                Paragraph(
                    f"{_paragraph(source.get('title'))}: {_paragraph(source.get('url'))}",
                    styles["Small"],
                )
            )
    document.build(story)
    return buffer.getvalue()


def list_file(job: Job, kind: str) -> tuple[bytes, str, str]:
    snapshot = (job.result or {}).get("insurance")
    if not snapshot:
        raise ApiError(409, "insurance_list_not_ready", "The insurance list is not ready yet.")
    reviewed = snapshot["reviewed_on"].replace("-", "")
    if kind == "csv":
        return _csv(snapshot), "text/csv", f"housetory-insurance-replacement-{reviewed}.csv"
    if kind == "pdf":
        return _pdf(snapshot), "application/pdf", f"housetory-insurance-replacement-{reviewed}.pdf"
    raise ApiError(404, "insurance_file_not_found", "Insurance file not found.")


__all__ = [
    "cancel_batch",
    "create_batch",
    "create_list",
    "list_file",
    "process_estimate",
    "process_list",
    "read_batch",
    "read_list_job",
    "scope_preview",
]
