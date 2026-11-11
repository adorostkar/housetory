"""Optional proposals from persisted local results; never applies inventory changes."""

import hashlib
import json
import logging
import time
import uuid
from dataclasses import asdict
from datetime import UTC, datetime

from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..db import SessionLocal
from ..domain import AiTask
from ..jobs import enqueue
from ..models import Document, ImportBatch, ImportEntry, ImportSourceFile, Job
from ..schemas.extraction import LineMatch
from ..schemas.imports import ImportEnhancementEntry
from . import ai
from .ai_runtime import AiRuntimeConfig

TASK = "ai.enrich"
logger = logging.getLogger("housetory.enrichment")


def fingerprint(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def source_version(db: Session, source: Document | ImportBatch) -> str:
    if isinstance(source, Document):
        metadata = source.extracted_metadata or {}
        return fingerprint(
            {
                # Generation one retains the fingerprint of pre-generation proposals.
                **(
                    {"generation": source.source_generation} if source.source_generation > 1 else {}
                ),
                "text": source.extracted_text,
                "base": metadata.get("extraction"),
                "applied": metadata.get("extraction_applied"),
                "merchant": source.merchant,
                "date": source.document_date,
            }
        )
    entries = db.scalars(
        select(ImportEntry).where(ImportEntry.batch_id == source.id).order_by(ImportEntry.id)
    ).all()
    return fingerprint(
        {
            "status": source.status,
            "context": {
                k: v
                for k, v in (source.metadata_json or {}).items()
                if k.startswith("context_") or k in {"context", "hierarchy", "product_url"}
            },
            "entries": [
                {
                    "id": entry.id,
                    "proposed": entry.proposed,
                    "status": entry.status,
                    "parent": entry.parent_entry_id,
                    "type": entry.entity_type,
                    "identifier": entry.legacy_identifier,
                }
                for entry in entries
            ],
        }
    )


def _metadata(source: Document | ImportBatch) -> dict:
    return dict(
        (source.extracted_metadata if isinstance(source, Document) else source.metadata_json) or {}
    )


def _write(source: Document | ImportBatch, state: dict) -> None:
    metadata = _metadata(source)
    metadata["enhancement"] = state
    if isinstance(source, Document):
        source.extracted_metadata = metadata
    else:
        source.metadata_json = metadata


def _task(source: Document | ImportBatch) -> str:
    return AiTask.DOCUMENTS.value if isinstance(source, Document) else AiTask.IMPORTS.value


def enhancement_state(
    db: Session,
    source: Document | ImportBatch,
    *,
    document_matches: list[LineMatch] | None = None,
) -> dict | None:
    state = _metadata(source).get("enhancement")
    if (
        state
        and state.get("status") == "ready"
        and state.get("version") != source_version(db, source)
    ):
        return {**state, "status": "skipped", "reason": "source_changed"}
    if (
        isinstance(source, Document)
        and state
        and state.get("status") == "ready"
        and state.get("proposal")
    ):
        from .document_refinement import refinement_has_changes

        if not refinement_has_changes(db, source, state["proposal"], matches=document_matches):
            return {**state, "status": "skipped", "reason": "no_changes", "proposal": None}
    if not state or state.get("status") not in {"queued", "running"}:
        return state
    job = db.get(Job, uuid.UUID(state["job_id"]))
    if job is None or job.status in {"failed", "cancelled"}:
        return {
            **state,
            "status": "failed",
            "reason": "worker_interrupted",
            "error": "AI enhancement was interrupted. Local results are unchanged; retry AI only.",
        }
    return state


def _lock_source(db: Session, source: Document | ImportBatch):
    model = type(source)
    locked = db.scalar(
        select(model)
        .where(model.id == source.id, model.household_id == source.household_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )
    if locked is None:
        raise ApiError(404, "source_not_found", "The source no longer exists.")
    return locked


def cancel_enhancement(db: Session, source: Document | ImportBatch) -> None:
    source = _lock_source(db, source)
    state = _metadata(source).get("enhancement") or {}
    if state.get("status") not in {"queued", "running", "ready"}:
        raise ApiError(409, "enhancement_not_active", "No active suggestions to cancel.")
    _write(source, {**state, "status": "skipped", "reason": "cancelled"})
    job = db.get(Job, uuid.UUID(state["job_id"])) if state.get("job_id") else None
    if job is not None and job.status == "queued":
        job.status = "cancelled"
        job.finished_at = datetime.now(UTC)
    db.commit()


def schedule_enhancement(
    db: Session,
    source: Document | ImportBatch,
    *,
    kind: str,
    inputs: dict | None = None,
) -> None:
    if isinstance(source, ImportBatch) and inputs is not None:
        source.metadata_json = {
            **_metadata(source),
            "_enhancement_snapshot": {
                "version": source_version(db, source),
                "inputs": inputs,
            },
        }
    config = ai.config_for(db, source.household_id, _task(source))
    state = {
        "status": "off",
        "reason": (
            "consent_required"
            if config.mode == "cloud" and not config.cloud_consent
            else "disabled"
            if not config.enabled
            else "not_configured"
        ),
        "provider": config.provider,
        "model": config.model,
        "ai_attempted": False,
        "ai_succeeded": False,
    }
    if config.configured:
        if config.mode == "cloud" and not config.cloud_consent:
            state["reason"] = "consent_required"
        else:
            version = source_version(db, source)
            job = enqueue(
                db,
                TASK,
                {},
                queue="ai",
                commit=False,
                max_attempts=1,
            )
            db.flush()
            job.payload = {
                "kind": kind,
                "source_id": str(source.id),
                "household_id": str(source.household_id),
                "version": version,
                "config": fingerprint(asdict(config)),
                "inputs": inputs or {},
                "job_id": str(job.id),
            }
            state.update(status="queued", reason=None, version=version, job_id=str(job.id))
    _write(source, state)


def retry_enhancement(db: Session, source: Document | ImportBatch) -> None:
    source = _lock_source(db, source)
    state = enhancement_state(db, source) or {}
    if state.get("status") in {"queued", "running", "accepted"}:
        raise ApiError(409, "enhancement_not_retryable", "This enhancement cannot be retried yet.")
    inputs = None
    if isinstance(source, ImportBatch):
        if source.status != "review":
            raise ApiError(409, "import_not_reviewable", "Only unapplied imports can be enhanced.")
        snapshot = _metadata(source).get("_enhancement_snapshot")
        if snapshot is None:
            raise ApiError(
                409,
                "enhancement_source_unavailable",
                "This older import has no saved enhancement snapshot. "
                "Local review remains available.",
            )
        if source_version(db, source) != snapshot["version"]:
            raise ApiError(409, "enhancement_stale", "The import changed. Keep the current review.")
        inputs = snapshot["inputs"]
    schedule_enhancement(
        db,
        source,
        kind="document" if isinstance(source, Document) else "import",
        inputs=inputs,
    )
    db.commit()


def _load(db: Session, payload: dict, *, lock: bool = False):
    model = Document if payload["kind"] == "document" else ImportBatch
    query = (
        select(model)
        .where(
            model.id == uuid.UUID(payload["source_id"]),
            model.household_id == uuid.UUID(payload["household_id"]),
        )
        .execution_options(populate_existing=True)
    )
    return db.scalar(query.with_for_update() if lock else query)


def _guard(db: Session, source, payload: dict) -> str | None:
    if source_version(db, source) != payload["version"]:
        return "source_changed"
    config = ai.config_for(db, source.household_id, _task(source))
    if fingerprint(asdict(config)) != payload["config"]:
        return "configuration_changed"
    if not config.configured or (config.mode == "cloud" and not config.cloud_consent):
        return "consent_or_configuration_required"
    return None


def _import_proposals(db: Session, batch: ImportBatch, inputs: dict, config: AiRuntimeConfig):
    from ..schemas.imports import ProposedItem
    from .import_hierarchy import HierarchyResult
    from .import_matching import build_index, to_proposed_item
    from .import_parse import ProposalDraft
    from .import_pipeline.ai_enrichment import _apply_ai_enhancement, _apply_ai_hierarchy
    from .import_pipeline.apply import _apply_context_destination, _context_property
    from .import_types import ParsedDocument, SourceBundle

    ids = inputs["entry_ids"]
    entries = {
        str(entry.id): entry
        for entry in db.scalars(select(ImportEntry).where(ImportEntry.batch_id == batch.id))
    }
    index = build_index(db, batch.household_id, property_id=_context_property(db, batch).id)
    proposals = []
    if inputs.get("hierarchy") is not None:
        hierarchy = TypeAdapter(HierarchyResult).validate_python(inputs["hierarchy"])
        metadata = _apply_ai_hierarchy(db, batch.household_id, hierarchy, config=config)
        for entry_id, value in zip(ids, [*hierarchy.nodes, *hierarchy.items], strict=True):
            entry = entries[entry_id]
            proposed = ProposedItem.model_validate(entry.proposed)
            is_item = hasattr(value, "draft")
            proposed = proposed.model_copy(
                update={
                    "name": value.draft.name if is_item else value.name,
                    "quantity": value.draft.quantity if is_item else proposed.quantity,
                }
            )
            if not is_item:
                proposed.relationships = {
                    **proposed.relationships,
                    "container_type": value.container_type,
                }
            proposals.append(
                ImportEnhancementEntry(
                    entry_id=entry.id,
                    proposed=proposed,
                    entity_type=entry.entity_type if is_item else value.entity_type,
                    legacy_identifier=entry.legacy_identifier
                    if is_item
                    else value.legacy_identifier,
                )
            )
    else:
        drafts = TypeAdapter(list[ProposalDraft]).validate_python(inputs["drafts"])
        files = {
            file.relative_path: file.id
            for file in db.scalars(
                select(ImportSourceFile).where(ImportSourceFile.batch_id == batch.id),
            )
        }
        bundle = SourceBundle(documents=[ParsedDocument(**item) for item in inputs["documents"]])
        drafts, metadata = _apply_ai_enhancement(
            db,
            batch.household_id,
            bundle,
            drafts,
            draft_keys=ids,
            single_subject=bool((batch.metadata_json or {}).get("product_url")),
            config=config,
            chunks=[(document.relative_path, document.text) for document in bundle.documents],
        )
        for position, draft in enumerate(drafts):
            proposed = to_proposed_item(draft, index)
            proposed = _apply_context_destination(db, batch, proposed)
            entry_id = ids[position] if position < len(ids) else None
            if entry_id is not None:
                original = ProposedItem.model_validate(entries[entry_id].proposed)
                if original.field_sources.get("purchase_date") == "explicit" and original.purchase:
                    if proposed.purchase:
                        proposed.purchase.purchase_date = original.purchase.purchase_date
                    else:
                        proposed.purchase = original.purchase
            proposals.append(
                ImportEnhancementEntry(
                    entry_id=entry_id,
                    proposed=proposed,
                    source_path=draft.source_path,
                    source_excerpt=draft.source_excerpt,
                    source_file_id=files.get(draft.source_file_path),
                )
            )
    if not (metadata.get("ai_used") or metadata.get("ai_consulted")):
        raise ai.AiUnavailable(
            metadata.get("ai_error") or "AI did not produce suggestions.",
            code=metadata.get("ai_reason") or "invalid_output",
        )
    changed = []
    for proposal in proposals:
        original = entries.get(str(proposal.entry_id)) if proposal.entry_id else None
        if original is not None:
            fields = proposal.proposed.model_dump(
                mode="json", exclude={"confidence", "field_sources"}
            )
            base = {
                key: value
                for key, value in original.proposed.items()
                if key not in {"confidence", "field_sources"}
            }
            if (
                fingerprint(fields) == fingerprint(base)
                and proposal.entity_type == original.entity_type
                and proposal.legacy_identifier == original.legacy_identifier
            ):
                continue
        changed.append(proposal.model_dump(mode="json"))
    return changed


def run_enhancement(payload: dict) -> dict:
    started = time.monotonic()
    with SessionLocal() as db:
        source = _load(db, payload, lock=True)
        if source is None:
            return {"status": "skipped", "reason": "source_deleted"}
        state = _metadata(source).get("enhancement") or {}
        if state.get("job_id") != payload["job_id"] or state.get("status") != "queued":
            return {"status": "skipped", "reason": "superseded"}
        reason = _guard(db, source, payload)
        state = {**state, "status": "skipped" if reason else "running", "reason": reason}
        _write(source, state)
        config = ai.config_for(db, source.household_id, _task(source))
        db.commit()
        if reason:
            return {"status": "skipped", "reason": reason}
        state["ai_attempted"] = True
        _write(source, state)
        db.commit()
        error = None
        result = None
        try:
            if isinstance(source, Document):
                from .document_refinement import refine_extraction

                result = refine_extraction(
                    db,
                    source.household_id,
                    source,
                    config=config,
                    expected_job_id=payload["job_id"],
                ).model_dump(mode="json")
            else:
                result = _import_proposals(db, source, payload["inputs"], config)
        except ai.AiError as exc:
            error = exc.code
        except ApiError as exc:
            error = exc.__cause__.code if isinstance(exc.__cause__, ai.AiError) else exc.code
        except ValueError:
            error = "invalid_output"
        db.rollback()
        source = _load(db, payload, lock=True)
        if source is None:
            return {"status": "skipped", "reason": "source_deleted"}
        current = _metadata(source).get("enhancement") or {}
        if current.get("job_id") != payload["job_id"] or current.get("status") != "running":
            return {"status": "skipped", "reason": "superseded"}
        reason = _guard(db, source, payload)
        state = {
            **current,
            "status": "skipped" if reason else "failed" if error else "ready",
            "reason": reason or error,
            "ai_attempted": True,
            "ai_succeeded": result is not None,
            "error": (
                "AI suggestions could not be completed. Local results are unchanged."
                if error
                else None
            ),
        }
        if not reason and (
            result == []
            or (isinstance(source, Document) and result is not None and not result.get("ai_used"))
        ):
            if isinstance(source, Document):
                state["status"] = "skipped"
            state["reason"] = "no_changes"
        if (
            not reason
            and result is not None
            and (not isinstance(source, Document) or state["reason"] != "no_changes")
        ):
            state["proposal" if isinstance(source, Document) else "proposals"] = result
        _write(source, state)
        db.commit()
        logger.info(
            "Enhancement kind=%s provider=%s status=%s reason=%s duration_ms=%d",
            payload["kind"],
            config.provider,
            state["status"],
            state["reason"],
            (time.monotonic() - started) * 1000,
        )
        return {"status": state["status"], "reason": state["reason"]}


def accept_import_enhancement(db: Session, batch: ImportBatch) -> None:
    batch = db.scalar(
        select(ImportBatch)
        .where(
            ImportBatch.id == batch.id,
            ImportBatch.household_id == batch.household_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    state = _metadata(batch).get("enhancement") or {}
    if state.get("status") != "ready" or state.get("version") != source_version(db, batch):
        raise ApiError(409, "enhancement_stale", "These suggestions are no longer current.")
    entries = {
        entry.id: entry
        for entry in db.scalars(select(ImportEntry).where(ImportEntry.batch_id == batch.id))
    }
    position = max((entry.position for entry in entries.values()), default=-1) + 1
    total = len(entries)
    from .import_matching import find_duplicates

    for data in state.get("proposals") or []:
        proposal = ImportEnhancementEntry.model_validate(data)
        entry = entries.get(proposal.entry_id) if proposal.entry_id else None
        if entry is None:
            entry = ImportEntry(
                batch_id=batch.id,
                position=position,
                status="proposed",
                entity_type="item",
                proposed={},
                field_sources={},
                source_path=proposal.source_path,
                source_excerpt=proposal.source_excerpt,
                source_file_id=proposal.source_file_id,
            )
            db.add(entry)
            position += 1
            total += 1
        entry.proposed = proposal.proposed.model_dump(mode="json")
        entry.field_sources = proposal.proposed.field_sources
        entry.confidence = proposal.proposed.confidence
        entry.entity_type = proposal.entity_type
        entry.legacy_identifier = proposal.legacy_identifier
        entry.duplicate_candidates = [
            candidate.model_dump(mode="json")
            for candidate in find_duplicates(db, batch.household_id, proposal.proposed)
        ]
    db.flush()
    batch.total_entries = total
    _write(batch, {**state, "status": "accepted"})
    db.commit()
