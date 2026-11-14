"""Background import processing and approved-import application."""

import logging
import uuid
from datetime import date
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ...db import SessionLocal
from ...domain import ImportStatus
from ...jobs import enqueue
from ...models import (
    ImportBatch,
    ImportEntry,
    ImportSourceFile,
)
from ...schemas.imports import (
    ProposedItem,
    ProposedPurchase,
)
from .. import ai as ai
from .. import storage
from ..import_hierarchy import parse_hierarchy
from ..import_matching import build_index, find_duplicates, to_proposed_item
from ..import_parse import ProposalDraft, parse_documents
from ..import_readers import read_source_bundle
from .apply import _apply_context_destination, _context_property
from .apply import _item_create_from_proposal as _item_create_from_proposal
from .apply import apply_import as apply_import
from .serialization import _safe_error
from .serialization import serialize_batch as serialize_batch

logger = logging.getLogger("housetory.imports")

IMPORT_TASK = "imports.process"


def enqueue_import(db: Session, batch: ImportBatch) -> Any:
    batch.status = ImportStatus.QUEUED.value
    batch.error = None
    job = enqueue(
        db,
        IMPORT_TASK,
        {"batch_id": str(batch.id)},
        commit=False,
        max_attempts=3,
        priority=4,
        queue="ai" if (batch.metadata_json or {}).get("product_url") else "default",
    )
    db.commit()
    return job


def _clear_previous_attempt(db: Session, batch: ImportBatch) -> None:
    files = list(
        db.scalars(select(ImportSourceFile).where(ImportSourceFile.batch_id == batch.id)).all()
    )
    keys = [source.storage_key for source in files]
    db.execute(delete(ImportEntry).where(ImportEntry.batch_id == batch.id))
    db.execute(delete(ImportSourceFile).where(ImportSourceFile.batch_id == batch.id))
    db.commit()
    for key in keys:
        storage.delete_import_key(key)


def _store_vault_files(db: Session, batch: ImportBatch, bundle) -> dict[str, ImportSourceFile]:
    mapping: dict[str, ImportSourceFile] = {}
    for extracted in bundle.files:
        stored = storage.store_import_file(
            batch.household_id,
            batch.id,
            extracted.relative_path,
            extracted.data,
            extracted.content_type,
        )
        source = ImportSourceFile(
            batch_id=batch.id,
            relative_path=extracted.relative_path,
            kind=extracted.kind,
            content_type=extracted.content_type,
            storage_key=stored.storage_key,
            byte_size=stored.byte_size,
            is_referenced=extracted.kind == "attachment",
        )
        db.add(source)
        db.flush()
        mapping[extracted.relative_path] = source
    return mapping


def _create_hierarchy_entries(
    db: Session,
    batch: ImportBatch,
    hierarchy,
    bundle,
    file_mapping,
    index,
) -> int:
    entry_by_key: dict[str, ImportEntry] = {}
    position = 0
    for node in hierarchy.nodes:
        source_file = file_mapping.get(node.source_path)
        proposed = ProposedItem(
            name=node.name,
            quantity=1,
            relationships={
                "entity_type": node.entity_type,
                "legacy_identifier": node.legacy_identifier,
                "container_type": node.container_type,
                "ambiguous": node.ambiguous,
                "parent_name": next(
                    (
                        candidate.name
                        for candidate in hierarchy.nodes
                        if candidate.key == node.parent_key
                    ),
                    None,
                ),
            },
            confidence=node.confidence,
            field_sources={"name": "explicit"},
        )
        parent_entry = entry_by_key.get(node.parent_key) if node.parent_key else None
        entry = ImportEntry(
            batch_id=batch.id,
            source_file_id=source_file.id if source_file else None,
            source_path=node.source_path,
            source_excerpt=node.source_excerpt,
            note_title=node.name,
            proposed=proposed.model_dump(mode="json"),
            field_sources={"name": "explicit"},
            confidence=node.confidence,
            duplicate_candidates=[],
            entity_type=node.entity_type,
            parent_entry_id=parent_entry.id if parent_entry else None,
            legacy_identifier=node.legacy_identifier,
            position=position,
        )
        db.add(entry)
        db.flush()
        entry_by_key[node.key] = entry
        position += 1
    for item in hierarchy.items:
        parent_entry = entry_by_key.get(item.parent_key)
        proposed = to_proposed_item(item.draft, index)
        duplicates = find_duplicates(db, batch.household_id, proposed)
        source_file = file_mapping.get(item.draft.source_file_path or "")
        entry = ImportEntry(
            batch_id=batch.id,
            source_file_id=source_file.id if source_file else None,
            source_path=item.draft.source_path,
            source_excerpt=item.draft.source_excerpt,
            note_title=item.draft.note_title,
            proposed=proposed.model_dump(mode="json"),
            field_sources=proposed.field_sources,
            confidence=item.confidence,
            duplicate_candidates=[candidate.model_dump(mode="json") for candidate in duplicates],
            entity_type="item",
            parent_entry_id=parent_entry.id if parent_entry else None,
            position=position,
        )
        db.add(entry)
        db.flush()
        position += 1
    return position


def process_import_batch(
    batch_id: uuid.UUID | str, *, force: bool = False
) -> dict[str, Any] | None:
    with SessionLocal() as db:
        batch = db.get(ImportBatch, batch_id)
        if batch is None:
            return None
        if batch.status in {ImportStatus.REVIEW.value, ImportStatus.COMPLETED.value} and not force:
            return {"batch_id": str(batch.id), "skipped": True}
        _clear_previous_attempt(db, batch)
        batch.status = ImportStatus.PROCESSING.value
        batch.error = None
        batch.metadata_json = {
            **(batch.metadata_json or {}),
            "progress": {"stage": "reading source", "message": "Reading source file"},
        }
        db.commit()
        try:
            if (batch.metadata_json or {}).get("product_url"):
                from ..product_import import refresh_product_source

                refresh_product_source(db, batch)
            if not batch.storage_key:
                raise ValueError("This import has no source file.")
            path = storage.resolve_import_key(batch.storage_key)
            bundle = read_source_bundle(
                path, batch.original_filename or "import.txt", batch.content_type
            )
            batch.metadata_json = {
                **(batch.metadata_json or {}),
                "progress": {"stage": "extracting", "message": "Extracting inventory entries"},
            }
            db.commit()
            parsed = parse_documents(bundle)
            if (batch.metadata_json or {}).get("product_url") and not parsed.drafts:
                parsed.drafts = [
                    ProposalDraft(
                        name=batch.title,
                        source_path=batch.original_filename,
                        source_excerpt=(
                            f"Product page: {(batch.metadata_json or {}).get('product_url')}"
                        ),
                        field_sources={"name": "explicit"},
                    )
                ]
            file_mapping = _store_vault_files(db, batch, bundle)
            property_record = _context_property(db, batch)
            index = build_index(db, batch.household_id, property_record.id)
            room_names = {room.id: room.name for room in index.rooms}
            authorized_places = {
                "rooms": [
                    {
                        "name": room.name,
                        "parent": room_names.get(room.parent_id),
                    }
                    for room in index.rooms[:100]
                ],
                "storage_locations": [
                    {
                        "name": location.name,
                        "identifier": location.identifier,
                        "room": room_names.get(location.room_id),
                    }
                    for location in index.locations[:100]
                ],
            }
            hierarchy = parse_hierarchy(bundle)
            assistant_capture = bool((batch.metadata_json or {}).get("assistant_capture"))
            ai_metadata: dict[str, Any] = {
                "ai_used": False,
                "ai_consulted": False,
                "ai_error": None,
            }
            hierarchy_mode = (
                not assistant_capture and hierarchy.active and bool(hierarchy.items)
            )
            if hierarchy_mode:
                entry_count = _create_hierarchy_entries(
                    db, batch, hierarchy, bundle, file_mapping, index
                )
                drafts = [item.draft for item in hierarchy.items]
                warnings = [*hierarchy.warnings]
                ignored_notes = [*parsed.ignored_notes, *hierarchy.ignored]
                hierarchy_metadata = {
                    "hierarchy": True,
                    "hierarchy_nodes": len(hierarchy.nodes),
                    "hierarchy_items": len(hierarchy.items),
                }
            else:
                drafts = parsed.drafts
                for position, draft in enumerate(drafts):
                    proposed = to_proposed_item(draft, index)
                    proposed = _apply_context_destination(db, batch, proposed)
                    explicit_purchase_date = (batch.metadata_json or {}).get("purchase_date")
                    if explicit_purchase_date:
                        purchase = proposed.purchase or ProposedPurchase()
                        if purchase.purchase_date is None:
                            purchase.purchase_date = date.fromisoformat(explicit_purchase_date)
                        proposed.purchase = purchase
                        proposed.field_sources = {
                            **proposed.field_sources,
                            "purchase_date": "explicit",
                        }
                    duplicates = find_duplicates(db, batch.household_id, proposed)
                    source_file = file_mapping.get(draft.source_file_path or "")
                    entry = ImportEntry(
                        batch_id=batch.id,
                        source_file_id=source_file.id if source_file else None,
                        source_path=draft.source_path,
                        source_excerpt=draft.source_excerpt,
                        note_title=draft.note_title,
                        proposed=proposed.model_dump(mode="json"),
                        field_sources=proposed.field_sources,
                        confidence=proposed.confidence,
                        duplicate_candidates=[
                            candidate.model_dump(mode="json") for candidate in duplicates
                        ],
                        position=position,
                    )
                    db.add(entry)
                entry_count = len(drafts)
                warnings = [*parsed.warnings]
                ignored_notes = parsed.ignored_notes
                hierarchy_metadata = {"hierarchy": False}
            if not drafts:
                warnings.append(
                    {
                        "type": "no_entries",
                        "message": (
                            "No inventory entries were detected. Review ignored notes "
                            "or try a clearer source."
                        ),
                    }
                )
            if ai_metadata.get("ai_error"):
                warnings.append({"type": "ai_fallback", "message": ai_metadata["ai_error"]})
            for message in ai_metadata.get("ai_warnings") or []:
                warnings.append({"type": "ai_warning", "message": str(message)[:500]})
            batch.warnings = warnings
            batch.metadata_json = {
                **(batch.metadata_json or {}),
                **parsed.metadata,
                **ai_metadata,
                **hierarchy_metadata,
                "source_format": bundle.source_format,
                "vault_tree": bundle.vault_tree,
                "ignored_notes": ignored_notes,
                "broken_links": bundle.broken_links,
                "progress": (
                    {
                        "stage": "interpreting",
                        "message": "Interpreting your item description",
                    }
                    if assistant_capture
                    else {"stage": "review", "message": "Ready for review"}
                ),
            }
            batch.total_entries = entry_count
            batch.imported_entries = 0
            batch.skipped_entries = 0
            batch.failed_entries = 0
            batch.status = (
                ImportStatus.PROCESSING.value if assistant_capture else ImportStatus.REVIEW.value
            )
            batch.completed_at = None
            db.flush()
            from ..enrichment import schedule_enhancement
            from .ai_enrichment import _ai_chunks

            entries = db.scalars(
                select(ImportEntry)
                .where(ImportEntry.batch_id == batch.id)
                .order_by(ImportEntry.position)
            ).all()
            settings = ai._settings()
            source_documents = [
                {
                    "relative_path": label,
                    "title": label,
                    "text": chunk,
                    "content_type": "text/plain",
                    "source_format": "text",
                }
                for label, chunk in _ai_chunks(
                    bundle,
                    settings.ai_max_context_chars,
                    settings.ai_import_max_chunks,
                )
            ]
            schedule_enhancement(
                db,
                batch,
                kind="import",
                inputs={
                    "documents": source_documents,
                    "drafts": (
                        []
                        if assistant_capture
                        else TypeAdapter(list[ProposalDraft]).dump_python(drafts, mode="json")
                    ),
                    "hierarchy": (
                        TypeAdapter(type(hierarchy)).dump_python(hierarchy, mode="json")
                        if hierarchy_mode
                        else None
                    ),
                    "entry_ids": (
                        [] if assistant_capture else [str(entry.id) for entry in entries]
                    ),
                    "primary_extraction": assistant_capture,
                    "authorized_places": authorized_places,
                },
            )
            if assistant_capture:
                enhancement = (batch.metadata_json or {}).get("enhancement") or {}
                if enhancement.get("status") != "queued":
                    batch.status = ImportStatus.REVIEW.value
                    batch.metadata_json = {
                        **(batch.metadata_json or {}),
                        "ai_error": (
                            "AI extraction is unavailable; deterministic results are shown."
                        ),
                        "progress": {
                            "stage": "review",
                            "message": "Review the deterministic item description fallback",
                        },
                    }
                    batch.warnings = [
                        *batch.warnings,
                        {
                            "type": "ai_fallback",
                            "message": (
                                "AI extraction is unavailable; deterministic results are shown."
                            ),
                        },
                    ]
            db.commit()
            return {"batch_id": str(batch.id), "entries": entry_count}
        except Exception as exc:  # noqa: BLE001 - persisted for recovery
            db.rollback()
            batch = db.get(ImportBatch, batch_id)
            logger.error(
                "Import batch %s failed (%s): %s",
                batch_id,
                type(exc).__name__,
                exc if type(exc).__name__ == "ProductPageError" else "see exception cause",
                exc_info=exc.__cause__,
            )
            if batch is not None:
                batch.status = ImportStatus.FAILED.value
                batch.error = _safe_error(exc)
                batch.metadata_json = {
                    **(batch.metadata_json or {}),
                    "progress": {"stage": "failed", "message": batch.error},
                }
                db.commit()
            return {"batch_id": str(batch_id), "failed": True}


def run_import_job(payload: dict[str, Any]) -> dict[str, Any] | None:
    batch_id = payload.get("batch_id")
    if not batch_id:
        raise ValueError("Import job payload is missing batch_id.")
    return process_import_batch(batch_id)
