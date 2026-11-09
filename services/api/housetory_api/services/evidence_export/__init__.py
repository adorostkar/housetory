"""Inventory evidence package generation.

This module intentionally reuses the recorded documents, photos, purchases,
allocations, warranties and lending facts already in the household. It does not
invent valuations, stocktake verification, insurance acceptance or per-item
purchase splits. The PDF is a standalone, offline-readable report; the optional
CSV and ZIP carry the same reviewed snapshot and exact-or-normalized evidence
bytes with a manifest.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...config import get_settings
from ...jobs import enqueue
from ...models import (
    Household,
    InventoryEvidenceExport,
)
from ...schemas.evidence_exports import (
    EvidenceCreateIn,
    EvidenceExportOut,
    EvidenceOptionsIn,
    EvidencePreviewIn,
    EvidencePreviewOut,
)
from .. import storage
from .bundle import build_csv, write_bundle
from .pdf import build_pdf
from .snapshot import _fingerprint as _fingerprint
from .snapshot import _preview_from_snapshot, build_snapshot
from .snapshot import _selected_item_rows as _selected_item_rows

EVIDENCE_EXPORT_TASK = "exports.evidence"
EVIDENCE_PRUNE_TASK = "maintenance.prune_exports"


def _missing_evidence(snapshot: dict[str, Any]) -> list[str]:
    options = EvidenceOptionsIn.model_validate(snapshot["options"])
    missing: list[str] = []
    if not options.include_attachments:
        return missing
    for document in snapshot["documents"]:
        if not document["included"]:
            continue
        if not storage.evidence_export_key_exists(document["storage_key"]):
            missing.append(f"Normalized file for “{document['title']}” is missing.")
        if options.include_document_originals and not storage.evidence_export_key_exists(
            document["original_storage_key"]
        ):
            missing.append(f"Original file for “{document['title']}” is missing.")
        if options.include_document_originals:
            for page in document["scan_pages"]:
                if not storage.evidence_export_key_exists(page["original_storage_key"]):
                    missing.append(
                        f"Source scan page {page['index']} for “{document['title']}” is missing."
                    )
    if options.include_photos:
        for photo in snapshot["photos"]:
            if not storage.evidence_export_key_exists(photo["storage_key"]):
                missing.append(
                    f"Photo “{photo['original_filename']}” for “{photo['item_name']}” is missing."
                )
    return missing


def _clear_artifact_fields(package: InventoryEvidenceExport) -> None:
    package.pdf_key = None
    package.pdf_name = None
    package.pdf_bytes = None
    package.pdf_sha256 = None
    package.csv_key = None
    package.csv_name = None
    package.csv_bytes = None
    package.csv_sha256 = None
    package.bundle_key = None
    package.bundle_name = None
    package.bundle_bytes = None
    package.bundle_sha256 = None


def _expire_if_needed(db: Session, package: InventoryEvidenceExport) -> None:
    if package.expires_at is None or package.status == "expired":
        return
    now = datetime.now(UTC)
    expires = package.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires > now:
        return
    package.status = "expired"
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    db.commit()


def get_export(
    db: Session,
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> InventoryEvidenceExport:
    query = select(InventoryEvidenceExport).where(
        InventoryEvidenceExport.id == export_id,
        InventoryEvidenceExport.household_id == household_id,
    )
    if for_update:
        query = query.with_for_update()
    package = db.scalar(query)
    if package is None:
        raise ApiError(404, "evidence_export_not_found", "Evidence package not found.")
    _expire_if_needed(db, package)
    return package


def export_out(package: InventoryEvidenceExport, *, can_manage: bool) -> EvidenceExportOut:
    return EvidenceExportOut(
        id=package.id,
        status=package.status,  # type: ignore[arg-type]
        format_version=package.format_version,
        scope_label=package.scope_label,
        scope=package.scope or {},
        include_archived=package.include_archived,
        options=EvidenceOptionsIn.model_validate(package.options or {}),
        item_count=package.item_count,
        unit_count=package.unit_count,
        evidence_counts=package.evidence_counts or {},
        warnings=package.warnings or [],
        error=package.error,
        created_at=package.created_at,
        completed_at=package.completed_at,
        expires_at=package.expires_at,
        pdf_available=bool(package.status == "succeeded" and package.pdf_key),
        csv_available=bool(package.status == "succeeded" and package.csv_key),
        bundle_available=bool(package.status == "succeeded" and package.bundle_key),
        pdf_bytes=package.pdf_bytes,
        csv_bytes=package.csv_bytes,
        bundle_bytes=package.bundle_bytes,
        pdf_sha256=package.pdf_sha256,
        csv_sha256=package.csv_sha256,
        bundle_sha256=package.bundle_sha256,
        can_manage=can_manage,
    )


def preview_export(
    db: Session, household: Household, payload: EvidencePreviewIn
) -> EvidencePreviewOut:
    snapshot = build_snapshot(
        db,
        household,
        payload.scope,
        payload.include_archived,
        payload.options,
    )
    return _preview_from_snapshot(snapshot)


def create_export(
    db: Session,
    household: Household,
    payload: EvidenceCreateIn,
    *,
    user_id: uuid.UUID,
) -> InventoryEvidenceExport:
    existing = db.scalar(
        select(InventoryEvidenceExport).where(
            InventoryEvidenceExport.household_id == household.id,
            InventoryEvidenceExport.request_id == payload.request_id,
        )
    )
    if existing is not None:
        _expire_if_needed(db, existing)
        same_selection = (
            existing.scope == payload.scope.as_json()
            and existing.options == payload.options.model_dump(mode="json")
            and existing.include_archived == payload.include_archived
        )
        if not same_selection or existing.snapshot_fingerprint != payload.fingerprint:
            raise ApiError(
                409,
                "export_request_conflict",
                "This request id was already used for a different evidence selection.",
            )
        return existing
    snapshot = build_snapshot(
        db,
        household,
        payload.scope,
        payload.include_archived,
        payload.options,
    )
    if snapshot["item_count"] == 0:
        raise ApiError(
            422,
            "export_empty",
            "No items are in this selection. Choose another room, container or item.",
        )
    if snapshot["fingerprint"] != payload.fingerprint:
        raise ApiError(
            409,
            "inventory_changed",
            "Inventory or evidence changed after the preview. Review the new preview "
            "and confirm the export again.",
        )
    if snapshot["bundle_estimated_bytes"] > snapshot["max_bundle_bytes"]:
        raise ApiError(
            422,
            "export_too_large",
            "The selected attachments are too large for one package. Exclude manuals, "
            "originals or photos, then preview again.",
        )
    package = InventoryEvidenceExport(
        household_id=household.id,
        created_by_user_id=user_id,
        request_id=payload.request_id,
        status="queued",
        format_version=snapshot["format_version"],
        scope=payload.scope.as_json(),
        scope_label=snapshot["scope_label"],
        include_archived=payload.include_archived,
        options=payload.options.model_dump(mode="json"),
        snapshot=snapshot,
        snapshot_fingerprint=snapshot["fingerprint"],
        item_count=snapshot["item_count"],
        unit_count=snapshot["unit_count"],
        evidence_counts={
            "items": snapshot["item_count"],
            "units": snapshot["unit_count"],
            "photos": snapshot["photo_count"],
            "included_photos": snapshot["included_photo_count"],
            "documents": snapshot["document_count"],
            "included_documents": snapshot["included_document_count"],
            "evidence_references": snapshot["evidence_reference_count"],
            "bundle_estimated_bytes": snapshot["bundle_estimated_bytes"],
        },
        manifest={},
        warnings=snapshot["warnings"],
        expires_at=None,
    )
    db.add(package)
    try:
        db.flush()
        job = enqueue(
            db,
            EVIDENCE_EXPORT_TASK,
            {"export_id": str(package.id)},
            commit=False,
            priority=3,
            max_attempts=2,
            queue="default",
        )
        package.job_id = job.id
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(package)
    return package


def list_exports(
    db: Session,
    household_id: uuid.UUID,
    *,
    user_id: uuid.UUID,
    role: str,
    limit: int = 20,
) -> list[InventoryEvidenceExport]:
    packages = list(
        db.scalars(
            select(InventoryEvidenceExport)
            .where(InventoryEvidenceExport.household_id == household_id)
            .order_by(InventoryEvidenceExport.created_at.desc())
            .limit(max(1, min(limit, 50)))
        ).all()
    )
    for package in packages:
        _expire_if_needed(db, package)
    return packages


def cancel_export(
    db: Session,
    package: InventoryEvidenceExport,
    *,
    user_id: uuid.UUID,
    role: str,
) -> InventoryEvidenceExport:
    if role == "viewer" and package.created_by_user_id != user_id:
        raise ApiError(403, "read_only_role", "Viewers can only manage their own exports.")
    if package.status in {"succeeded", "failed", "expired"}:
        if package.status == "succeeded":
            raise ApiError(409, "export_already_ready", "This evidence package is ready.")
        return package
    package.status = "cancelled"
    package.error = None
    package.completed_at = datetime.now(UTC)
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    db.commit()
    db.refresh(package)
    return package


def retry_export(
    db: Session,
    package: InventoryEvidenceExport,
    *,
    user_id: uuid.UUID,
    role: str,
) -> InventoryEvidenceExport:
    if role == "viewer" and package.created_by_user_id != user_id:
        raise ApiError(403, "read_only_role", "Viewers can only manage their own exports.")
    if package.status in {"queued", "running", "succeeded"}:
        raise ApiError(
            409, "export_not_retryable", "This evidence package is already active or ready."
        )
    _clear_artifact_fields(package)
    storage.delete_evidence_export_artifacts(package.household_id, package.id)
    package.status = "queued"
    package.error = None
    package.completed_at = None
    package.expires_at = None
    package.manifest = {}
    package.warnings = (package.snapshot or {}).get("warnings", [])
    db.flush()
    job = enqueue(
        db,
        EVIDENCE_EXPORT_TASK,
        {"export_id": str(package.id)},
        commit=False,
        priority=3,
        max_attempts=2,
    )
    package.job_id = job.id
    db.commit()
    db.refresh(package)
    return package


def download_artifact(
    db: Session,
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    kind: str,
) -> tuple[Path, str, str]:
    package = get_export(db, household_id, export_id)
    _expire_if_needed(db, package)
    if package.status == "expired":
        raise ApiError(
            410,
            "export_expired",
            "This evidence package expired. Generate a new package to download it.",
        )
    if package.status != "succeeded":
        raise ApiError(409, "export_not_ready", "This evidence package is not ready yet.")
    if kind == "pdf":
        key, name, media_type = package.pdf_key, package.pdf_name, "application/pdf"
    elif kind == "csv":
        key, name, media_type = package.csv_key, package.csv_name, "text/csv; charset=utf-8"
    elif kind == "bundle":
        key, name, media_type = (
            package.bundle_key,
            package.bundle_name,
            "application/zip",
        )
    else:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.")
    if not key or not name:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.")
    try:
        path = storage.resolve_export_key(key)
    except (ApiError, OSError) as exc:
        raise ApiError(404, "export_artifact_not_found", "Evidence artifact not found.") from exc
    return path, name, media_type


def _safe_export_error() -> str:
    return "The evidence package could not be generated. Review the selection and try again."


def run_evidence_export(payload: dict[str, Any]) -> dict[str, Any]:
    from ...db import SessionLocal

    export_id = uuid.UUID(str(payload["export_id"]))
    with SessionLocal() as db:
        package = db.get(InventoryEvidenceExport, export_id)
        if package is None:
            return {"skipped": True}
        if package.status in {"cancelled", "expired"}:
            return {"skipped": True}
        package.status = "running"
        package.error = None
        db.commit()
        snapshot = dict(package.snapshot or {})
        snapshot["export_id"] = str(package.id)
        pdf_bytes = b""
        pdf_key = csv_key = bundle_key = None
        pdf_name = csv_name = bundle_name = None
        pdf_bytes_size = csv_bytes_size = bundle_bytes_size = 0
        pdf_sha = csv_sha = bundle_sha = None
        manifest: dict[str, Any] = {}
        warnings: list[str] = list(snapshot.get("warnings") or [])
        try:
            settings = get_settings()
            deadline = time.monotonic() + settings.evidence_export_timeout_seconds
            missing = _missing_evidence(snapshot)
            pdf_bytes = build_pdf(snapshot, missing, deadline=deadline)
            date_label = datetime.fromisoformat(snapshot["generated_at"]).strftime("%Y%m%d")
            pdf_name = f"housetory-inventory-evidence-{date_label}-{package.id.hex[:8]}.pdf"
            pdf_key, pdf_bytes_size, pdf_sha = storage.write_evidence_export_bytes(
                package.household_id, package.id, pdf_name, pdf_bytes
            )
            csv_bytes = None
            if snapshot["options"].get("include_csv", True):
                csv_bytes = build_csv(snapshot, deadline=deadline)
                csv_name = f"housetory-inventory-evidence-{date_label}-{package.id.hex[:8]}.csv"
                csv_key, csv_bytes_size, csv_sha = storage.write_evidence_export_bytes(
                    package.household_id, package.id, csv_name, csv_bytes
                )
            if snapshot["options"].get("include_attachments", True):
                bundle_name = f"housetory-evidence-{package.id}.zip"
                (
                    bundle_key,
                    bundle_bytes_size,
                    bundle_sha,
                    manifest,
                    missing_from_bundle,
                ) = write_bundle(
                    package.household_id,
                    package.id,
                    snapshot,
                    pdf_bytes=pdf_bytes,
                    csv_bytes=csv_bytes,
                    pdf_name=pdf_name,
                    csv_name=csv_name,
                    max_bytes=settings.evidence_export_max_bundle_mb * 1024 * 1024,
                    deadline=deadline,
                )
                warnings.extend(missing_from_bundle)
            db.refresh(package)
            if package.status in {"cancelled", "expired"}:
                storage.delete_evidence_export_artifacts(package.household_id, package.id)
                return {"skipped": True, "cancelled": True}
            package.pdf_key = pdf_key
            package.pdf_name = pdf_name
            package.pdf_bytes = pdf_bytes_size
            package.pdf_sha256 = pdf_sha
            package.csv_key = csv_key
            package.csv_name = csv_name
            package.csv_bytes = csv_bytes_size
            package.csv_sha256 = csv_sha
            package.bundle_key = bundle_key
            package.bundle_name = bundle_name
            package.bundle_bytes = bundle_bytes_size
            package.bundle_sha256 = bundle_sha
            package.manifest = manifest
            package.warnings = list(dict.fromkeys(warnings + missing))
            package.status = "succeeded"
            package.completed_at = datetime.now(UTC)
            package.expires_at = package.completed_at + timedelta(
                hours=settings.evidence_export_retention_hours
            )
            package.error = None
            db.commit()
            return {
                "export_id": str(package.id),
                "status": "succeeded",
                "pdf_bytes": pdf_bytes_size,
                "csv_bytes": csv_bytes_size,
                "bundle_bytes": bundle_bytes_size,
            }
        except Exception:
            db.rollback()
            with SessionLocal() as failure_db:
                failed = failure_db.get(InventoryEvidenceExport, export_id)
                if failed is not None and failed.status not in {"cancelled", "expired"}:
                    failed.status = "failed"
                    failed.error = _safe_export_error()
                    failed.completed_at = datetime.now(UTC)
                    _clear_artifact_fields(failed)
                    storage.delete_evidence_export_artifacts(failed.household_id, failed.id)
                    failure_db.commit()
            raise


def prune_expired_exports() -> int:
    from ...db import SessionLocal

    now = datetime.now(UTC)
    with SessionLocal() as db:
        packages = list(
            db.scalars(
                select(InventoryEvidenceExport).where(
                    InventoryEvidenceExport.expires_at.is_not(None),
                    InventoryEvidenceExport.expires_at <= now,
                    InventoryEvidenceExport.status != "expired",
                )
            ).all()
        )
        for package in packages:
            package.status = "expired"
            _clear_artifact_fields(package)
            storage.delete_evidence_export_artifacts(package.household_id, package.id)
        db.commit()
        return len(packages)
