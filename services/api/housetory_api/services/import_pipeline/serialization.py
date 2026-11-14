"""Import batch serialisation and user-safe error messages."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...models import (
    ImportBatch,
    ImportEntry,
    ImportSourceFile,
)
from ...schemas.imports import (
    DuplicateCandidate,
    ImportBatchDetail,
    ImportBatchOut,
    ImportEntryOut,
    ImportSourceFileOut,
    ProposedItem,
)


def _safe_error(exc: Exception) -> str:
    known = {
        "This Word document is not a readable .docx file.",
        "This spreadsheet is not a readable .xlsx file.",
        "This CSV file is empty.",
        "This workbook contains no readable sheets.",
        "The uploaded ZIP is not a valid vault archive.",
        "The vault exceeds the decompressed size limit.",
        "Unsupported import file type.",
    }
    message = str(exc)
    if message in known or message.startswith("Vault archives are limited"):
        return message[:2000]
    if message.startswith("Could not read this file:") or type(exc).__name__ == "ProductPageError":
        return message[:2000]
    if message.startswith(
        (
            "Approve the parent",
            "Choose a room",
            "Choose an item",
            "Choose at least",
            "Choose a valid",
            "A possible duplicate",
            "The selected hierarchy",
        )
    ):
        return message[:2000]
    return "Import processing failed. Check the source file and try again."


def serialize_import_entry(entry: ImportEntry) -> ImportEntryOut:
    return ImportEntryOut(
        id=entry.id,
        source_file_id=entry.source_file_id,
        source_path=entry.source_path,
        source_excerpt=entry.source_excerpt,
        note_title=entry.note_title,
        proposed=ProposedItem.model_validate(entry.proposed),
        field_sources=entry.field_sources or {},
        confidence=entry.confidence,
        status=entry.status,
        duplicate_candidates=[
            DuplicateCandidate.model_validate(candidate)
            for candidate in entry.duplicate_candidates or []
        ],
        duplicate_resolution=entry.duplicate_resolution,
        matched_item_id=entry.matched_item_id,
        imported_item_id=entry.imported_item_id,
        entity_type=entry.entity_type,
        parent_entry_id=entry.parent_entry_id,
        created_room_id=entry.created_room_id,
        created_location_id=entry.created_location_id,
        legacy_identifier=entry.legacy_identifier,
        error=entry.error,
        position=entry.position,
    )


def serialize_source_file(source: ImportSourceFile) -> ImportSourceFileOut:
    return ImportSourceFileOut(
        id=source.id,
        relative_path=source.relative_path,
        kind=source.kind,
        content_type=source.content_type,
        byte_size=source.byte_size,
        is_referenced=source.is_referenced,
        url=f"{get_settings().api_prefix}/imports/{source.batch_id}/files/{source.id}/download",
    )


def serialize_batch(db: Session, batch: ImportBatch) -> ImportBatchDetail:
    from ..enrichment import enhancement_state

    enhancement = enhancement_state(db, batch)
    entries = list(
        db.scalars(
            select(ImportEntry)
            .where(ImportEntry.batch_id == batch.id)
            .order_by(ImportEntry.position)
        ).all()
    )
    files = list(
        db.scalars(
            select(ImportSourceFile)
            .where(ImportSourceFile.batch_id == batch.id)
            .order_by(ImportSourceFile.relative_path)
        ).all()
    )
    base = ImportBatchOut(
        id=batch.id,
        title=batch.title,
        source_type=batch.source_type,
        status=batch.status,
        original_filename=batch.original_filename,
        content_type=batch.content_type,
        byte_size=batch.byte_size,
        error=batch.error,
        warnings=batch.warnings or [],
        total_entries=batch.total_entries,
        imported_entries=batch.imported_entries,
        skipped_entries=batch.skipped_entries,
        failed_entries=batch.failed_entries,
        created_at=batch.created_at,
        updated_at=batch.updated_at,
        completed_at=batch.completed_at,
        source_url=(
            f"{get_settings().api_prefix}/imports/{batch.id}/source" if batch.storage_key else None
        ),
        entry_count=len(entries),
    )
    metadata = batch.metadata_json or {}
    return ImportBatchDetail(
        **base.model_dump(),
        entries=[serialize_import_entry(entry) for entry in entries],
        files=[serialize_source_file(source) for source in files],
        vault_tree=metadata.get("vault_tree") or [],
        ignored_notes=metadata.get("ignored_notes") or [],
        broken_links=metadata.get("broken_links") or [],
        metadata={key: value for key, value in metadata.items() if not key.startswith("_")},
        enhancement=enhancement,
    )


def _batch_detail(db: Session, batch: ImportBatch) -> ImportBatchDetail:
    return serialize_batch(db, batch)
