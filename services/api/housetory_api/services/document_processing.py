"""Safe lifecycle and owner-facing diagnostics for document processing."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import AiTask, JobStatus, OcrStatus
from ..models import Document, Job, WorkerHeartbeat
from ..schemas.document_processing import (
    DocumentProcessingSnapshot,
    ProcessingTimings,
)

LOCAL_QUEUE = "documents"
AI_QUEUE = "ai-documents"
INTERACTIVE_DEADLINE_SECONDS = 90
MAX_INTERACTIVE_PAGES = 3
HEARTBEAT_MAX_AGE_SECONDS = 45
TERMINAL_STAGES = {"ready", "needs_attention", "failed", "cancelled"}
ZERO_TIMINGS = {
    "upload_ms": None,
    "local_preprocess_ms": None,
    "local_queue_ms": None,
    "local_processing_ms": None,
    "ai_queue_ms": None,
    "provider_ms": None,
    "validation_ms": None,
}


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _processing(document: Document) -> dict[str, Any]:
    metadata = document.extracted_metadata or {}
    return dict(metadata.get("processing") or {})


def _store(document: Document, state: dict[str, Any]) -> None:
    metadata = dict(document.extracted_metadata or {})
    metadata["processing"] = state
    document.extracted_metadata = metadata


def initialize_processing(
    document: Document,
    *,
    page_count: int | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    is_background = page_count is not None and page_count > MAX_INTERACTIVE_PAGES
    state = {
        "correlation_id": uuid.uuid4().hex,
        "stage": "waiting",
        "started_at": _iso(now),
        "updated_at": _iso(now),
        "source_generation": document.source_generation,
        "deadline_at": _iso(
            now + timedelta(seconds=15 * 60 if is_background else INTERACTIVE_DEADLINE_SECONDS)
        ),
        "mode": "background" if is_background else "interactive",
        "background_reason": "document_over_3_pages" if is_background else None,
        "page_count": page_count,
        "page_limit": get_settings().ocr_max_pdf_pages,
        "local_queue": "default" if is_background else LOCAL_QUEUE,
        "timings": dict(ZERO_TIMINGS),
        "reason": None,
        "can_retry": False,
    }
    _store(document, state)
    return state


def update_processing(
    document: Document,
    *,
    correlation_id: str | None = None,
    **updates: Any,
) -> dict[str, Any] | None:
    state = _processing(document)
    if not state or (correlation_id and state.get("correlation_id") != correlation_id):
        return None
    state.update(updates)
    state["updated_at"] = _iso(datetime.now(UTC))
    _store(document, state)
    return state


def _job_by_correlation(db: Session, correlation_id: str, task: str | None = None) -> Job | None:
    query = select(Job).where(Job.payload["correlation_id"].astext == correlation_id)
    if task:
        query = query.where(Job.task == task)
    return db.scalar(query.order_by(Job.created_at.desc()).limit(1))


def _worker_available(db: Session, queue: str | None) -> bool | None:
    if queue is None:
        return None
    now = datetime.now(UTC)
    workers = db.scalars(select(WorkerHeartbeat)).all()
    matching = [worker for worker in workers if f":{queue}:" in worker.worker_id]
    if not matching:
        return False
    return any(
        now
        - (
            worker.updated_at.replace(tzinfo=UTC)
            if worker.updated_at.tzinfo is None
            else worker.updated_at
        )
        <= timedelta(seconds=HEARTBEAT_MAX_AGE_SECONDS)
        for worker in matching
    )


def processing_snapshot(db: Session, document: Document) -> DocumentProcessingSnapshot:
    state = _processing(document)
    if not state:
        state = initialize_processing(document)
        enhancement = (document.extracted_metadata or {}).get("enhancement") or {}
        if document.ocr_status == OcrStatus.SUCCEEDED.value:
            state["stage"] = (
                "interpreting"
                if enhancement.get("status") in {"queued", "running"}
                else "needs_attention"
                if enhancement.get("status") == "failed"
                else "ready"
            )
            state["can_retry"] = enhancement.get("status") == "failed"
        elif document.ocr_status == OcrStatus.FAILED.value:
            state.update(stage="failed", reason="local_processing_failed", can_retry=True)
        elif document.ocr_status == OcrStatus.PROCESSING.value:
            state["stage"] = "reading"
        elif document.ocr_status == OcrStatus.NOT_REQUESTED.value:
            state["stage"] = "ready"
        db.commit()
        db.refresh(document)
    now = datetime.now(UTC)
    started_at = datetime.fromisoformat(state["started_at"])
    updated_at = datetime.fromisoformat(state["updated_at"])
    correlation_id = str(state["correlation_id"])
    stage = state.get("stage", "waiting")
    timings = {**ZERO_TIMINGS, **(state.get("timings") or {})}
    local_job = _job_by_correlation(db, correlation_id, "documents.ocr")
    if local_job is not None:
        if timings["local_queue_ms"] is None and local_job.locked_at:
            timings["local_queue_ms"] = max(
                0,
                int((local_job.locked_at - local_job.created_at).total_seconds() * 1000),
            )
        elif timings["local_queue_ms"] is None and local_job.status == JobStatus.QUEUED.value:
            timings["local_queue_ms"] = max(
                0,
                int((now - local_job.created_at).total_seconds() * 1000),
            )
    ai_job_id = (_metadata := (document.extracted_metadata or {}).get("enhancement") or {}).get(
        "job_id"
    )
    ai_job = db.get(Job, uuid.UUID(ai_job_id)) if ai_job_id else None
    deadline_value = state.get("deadline_at")
    if stage in {"waiting", "reading", "interpreting"} and deadline_value:
        try:
            deadline = datetime.fromisoformat(deadline_value)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=UTC)
            expired = now >= deadline.astimezone(UTC)
        except (TypeError, ValueError):
            expired = True
        if expired:
            _cancel_job(
                ai_job if stage == "interpreting" else local_job,
                now,
            )
            metadata = dict(document.extracted_metadata or {})
            if stage == "interpreting":
                enhancement = dict(metadata.get("enhancement") or {})
                invalidated = _invalidate_attempt_refinements(metadata, enhancement)
                if invalidated:
                    prior = list(metadata.get("cancelled_refinement_versions") or [])
                    metadata["cancelled_refinement_versions"] = list(
                        dict.fromkeys([*prior, *invalidated])
                    )[-50:]
                if ai_job is not None and enhancement.get("job_id") == str(ai_job.id):
                    enhancement.update(status="skipped", reason="deadline_exceeded")
                    metadata["enhancement"] = enhancement
            else:
                document.ocr_status = OcrStatus.FAILED.value
                document.ocr_error = "Document processing did not finish within its time limit."
            document.extracted_metadata = metadata
            state.update(
                stage="failed",
                reason="deadline_exceeded",
                can_retry=True,
                updated_at=_iso(now),
            )
            _store(document, state)
            db.commit()
            db.refresh(document)
            started_at = datetime.fromisoformat(state["started_at"])
            updated_at = datetime.fromisoformat(state["updated_at"])
            stage = "failed"
    if ai_job is not None:
        if timings["ai_queue_ms"] is None and ai_job.locked_at:
            timings["ai_queue_ms"] = max(
                0,
                int((ai_job.locked_at - ai_job.created_at).total_seconds() * 1000),
            )
        elif timings["ai_queue_ms"] is None and ai_job.status == JobStatus.QUEUED.value:
            timings["ai_queue_ms"] = max(
                0,
                int((now - ai_job.created_at).total_seconds() * 1000),
            )
    queue = (
        (
            ai_job.queue
            if ai_job is not None
            else "ai"
            if state.get("mode") == "background"
            else AI_QUEUE
        )
        if stage == "interpreting"
        else state.get("local_queue", LOCAL_QUEUE)
        if stage in {"waiting", "reading"}
        else None
    )
    return DocumentProcessingSnapshot(
        correlation_id=correlation_id,
        stage=stage,
        started_at=started_at,
        updated_at=updated_at,
        elapsed_ms=max(0, int((now - started_at).total_seconds() * 1000)),
        local_available=True,
        can_cancel=stage in {"waiting", "reading", "interpreting"},
        can_retry=bool(
            state.get("can_retry", stage == "failed") and stage in {"needs_attention", "failed"}
        ),
        worker_available=_worker_available(db, queue),
        reason=state.get("reason"),
        timings=ProcessingTimings(**timings),
        mode=state.get("mode", "interactive"),
        background_reason=state.get("background_reason"),
        page_count=state.get("page_count"),
        page_limit=state.get("page_limit"),
    )


def _cancel_job(job: Job | None, now: datetime) -> None:
    if job is not None and job.status in {JobStatus.QUEUED.value, JobStatus.RUNNING.value}:
        job.status = JobStatus.CANCELLED.value
        job.finished_at = now
        job.locked_by = None
        job.locked_at = None


def _invalidate_attempt_refinements(
    metadata: dict[str, Any],
    enhancement: dict[str, Any],
) -> list[str]:
    refinements = dict(metadata.get("extraction_refinements") or {})
    if not refinements:
        return []
    before = set(enhancement.get("refinement_versions_before") or [])
    remove = set(refinements) - before
    if not before:
        version = enhancement.get("version")
        remove = {
            key
            for key, refinement in refinements.items()
            if refinement.get("source_version") == version
        }
    for version in remove:
        refinements.pop(version, None)
    if refinements:
        metadata["extraction_refinements"] = refinements
    else:
        metadata.pop("extraction_refinements", None)
    return sorted(remove)


def cancel_processing(db: Session, document: Document) -> Document:
    document = db.scalar(
        select(Document)
        .where(
            Document.id == document.id,
            Document.household_id == document.household_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if document is None:
        raise ApiError(404, "document_not_found", "Document not found.")
    state = _processing(document)
    if state.get("stage") not in {"waiting", "reading", "interpreting"}:
        raise ApiError(409, "processing_not_cancellable", "This document is no longer processing.")

    now = datetime.now(UTC)
    correlation_id = state["correlation_id"]
    _cancel_job(_job_by_correlation(db, correlation_id, "documents.ocr"), now)
    enhancement = dict((document.extracted_metadata or {}).get("enhancement") or {})
    ai_job = db.get(Job, uuid.UUID(enhancement["job_id"])) if enhancement.get("job_id") else None
    _cancel_job(ai_job, now)
    metadata = dict(document.extracted_metadata or {})
    refinement_versions = _invalidate_attempt_refinements(metadata, enhancement)
    if refinement_versions:
        cancelled = list(metadata.get("cancelled_refinement_versions") or [])
        metadata["cancelled_refinement_versions"] = list(
            dict.fromkeys([*cancelled, *refinement_versions])
        )[-50:]
    if enhancement.get("status") in {"queued", "running", "ready"}:
        enhancement.update(status="skipped", reason="cancelled")
        metadata["enhancement"] = enhancement
    state.update(
        stage="cancelled",
        reason="cancelled",
        can_retry=False,
        updated_at=_iso(now),
    )
    state["cancelled_refinement_versions"] = refinement_versions
    metadata["processing"] = state
    document.extracted_metadata = metadata
    if document.ocr_status in {OcrStatus.QUEUED.value, OcrStatus.PROCESSING.value}:
        document.ocr_status = OcrStatus.NOT_REQUESTED.value
    db.commit()
    db.refresh(document)
    return document


def retry_processing(
    db: Session,
    document: Document,
    *,
    actor_user_id: uuid.UUID,
    operation: str | None = None,
) -> Document:
    document = db.scalar(
        select(Document)
        .where(Document.id == document.id, Document.household_id == document.household_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if document is None:
        raise ApiError(404, "document_not_found", "Document not found.")
    state = _processing(document)
    if operation is not None:
        enhancement = dict((document.extracted_metadata or {}).get("enhancement") or {})
        if state.get("stage") in {"waiting", "reading", "interpreting"}:
            if (
                state.get("stage") == "interpreting"
                and enhancement.get("status") in {"queued", "running"}
                and enhancement.get("operation", "interpret") == operation
            ):
                return document
            raise ApiError(409, "processing_in_progress", "Another document operation is active.")
        if document.ocr_status != OcrStatus.SUCCEEDED.value:
            raise ApiError(409, "extraction_unavailable", "Complete local extraction first.")
        base = (document.extracted_metadata or {}).get("extraction")
        if not isinstance(base, dict) or not base.get("version"):
            raise ApiError(409, "extraction_unavailable", "Complete local extraction first.")
        from . import ai
        from .enrichment import schedule_enhancement

        config = ai.config_for(db, document.household_id, AiTask.DOCUMENTS.value)
        if not config.configured or (config.mode == "cloud" and not config.cloud_consent):
            raise ApiError(409, "ai_refinement_unavailable", "Document AI is not configured.")
        previous_timings = dict(state.get("timings") or {})
        current = initialize_processing(document, page_count=state.get("page_count"))
        timings = dict(current["timings"])
        for key in ("upload_ms", "local_preprocess_ms", "local_queue_ms", "local_processing_ms"):
            timings[key] = previous_timings.get(key)
        update_processing(document, timings=timings)
        schedule_enhancement(
            db, document, kind="document", actor_user_id=actor_user_id, operation=operation
        )
        if ((document.extracted_metadata or {}).get("enhancement") or {}).get("status") != "queued":
            raise ApiError(409, "ai_refinement_unavailable", "Document AI is not configured.")
        update_processing(document, stage="interpreting", reason=None, can_retry=False)
        db.commit()
        db.refresh(document)
        return document

    if state.get("stage") not in {"needs_attention", "failed"} or not state.get(
        "can_retry", state.get("stage") == "failed"
    ):
        raise ApiError(409, "processing_not_retryable", "This document cannot be retried yet.")
    previous_timings = dict(state.get("timings") or {})
    if document.ocr_status != OcrStatus.SUCCEEDED.value:
        current = initialize_processing(
            document,
            page_count=state.get("page_count"),
        )
        current_timings = dict(current["timings"])
        current_timings.update(
            upload_ms=previous_timings.get("upload_ms"),
            local_preprocess_ms=previous_timings.get("local_preprocess_ms"),
        )
        update_processing(document, timings=current_timings)
        from .document_ocr import enqueue_ocr

        enqueue_ocr(db, document, commit=False, actor_user_id=actor_user_id)
        db.commit()
        db.refresh(document)
        return document

    enhancement = dict((document.extracted_metadata or {}).get("enhancement") or {})
    if enhancement.get("status") not in {"failed", "skipped", "off"}:
        raise ApiError(409, "processing_not_retryable", "No failed AI stage can be retried.")
    if enhancement.get("status") == "off":
        raise ApiError(409, "processing_not_retryable", "AI interpretation is not configured.")
    current = initialize_processing(
        document,
        page_count=state.get("page_count"),
    )
    current_timings = dict(current["timings"])
    for key in ("upload_ms", "local_preprocess_ms", "local_queue_ms", "local_processing_ms"):
        current_timings[key] = previous_timings.get(key)
    update_processing(document, timings=current_timings)
    from .enrichment import retry_enhancement

    retry_enhancement(db, document, actor_user_id=actor_user_id)
    enhancement = dict((document.extracted_metadata or {}).get("enhancement") or {})
    current = _processing(document)
    update_processing(
        document,
        correlation_id=current["correlation_id"],
        stage="interpreting" if enhancement.get("status") == "queued" else "ready",
        reason=None,
    )
    db.commit()
    db.refresh(document)
    return document


def fail_processing_for_job(
    db: Session,
    job: Job,
    *,
    reason: str,
) -> None:
    document_id = job.payload.get("document_id") or (
        job.payload.get("source_id") if job.payload.get("kind") == "document" else None
    )
    correlation_id = job.payload.get("correlation_id")
    if not document_id or not correlation_id:
        return
    household_id = job.payload.get("household_id")
    if not household_id:
        return
    document = db.scalar(
        select(Document)
        .where(
            Document.id == uuid.UUID(str(document_id)),
            Document.household_id == uuid.UUID(str(household_id)),
        )
        .with_for_update()
    )
    if document is None:
        return
    state = _processing(document)
    if state.get("correlation_id") != correlation_id or state.get("stage") in TERMINAL_STAGES:
        return
    expected_generation = job.payload.get("source_generation")
    if expected_generation is not None and document.source_generation != expected_generation:
        return
    update_processing(
        document,
        correlation_id=correlation_id,
        stage="failed",
        reason=reason,
        can_retry=True,
    )
    if job.task == "documents.ocr":
        document.ocr_status = OcrStatus.FAILED.value
        document.ocr_error = "Document processing did not finish within its time limit."
    else:
        metadata = dict(document.extracted_metadata or {})
        enhancement = dict(metadata.get("enhancement") or {})
        if enhancement.get("job_id") == str(job.id):
            from .enrichment import _guard

            stale_reason = _guard(db, document, job.payload)
            invalidated = _invalidate_attempt_refinements(metadata, enhancement)
            if invalidated:
                cancelled = list(metadata.get("cancelled_refinement_versions") or [])
                metadata["cancelled_refinement_versions"] = list(
                    dict.fromkeys([*cancelled, *invalidated])
                )[-50:]
            enhancement.update(
                status="skipped" if stale_reason else "failed",
                reason=stale_reason or reason,
            )
            metadata["enhancement"] = enhancement
            document.extracted_metadata = metadata
            if stale_reason:
                update_processing(
                    document,
                    correlation_id=correlation_id,
                    stage="needs_attention",
                    reason=stale_reason,
                    can_retry=False,
                )
    db.commit()


__all__ = [
    "AI_QUEUE",
    "HEARTBEAT_MAX_AGE_SECONDS",
    "INTERACTIVE_DEADLINE_SECONDS",
    "LOCAL_QUEUE",
    "MAX_INTERACTIVE_PAGES",
    "cancel_processing",
    "fail_processing_for_job",
    "initialize_processing",
    "processing_snapshot",
    "update_processing",
]
