"""CSV and ZIP bundle rendering of an evidence snapshot."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import uuid
import zipfile
from pathlib import Path
from typing import Any

from ...api.errors import ApiError
from ...schemas.evidence_exports import (
    EvidenceOptionsIn,
)
from .. import storage
from .limits import EvidenceExportTooLarge, _check_deadline
from .snapshot import _clean_text, _slug, _snapshot_current_value

CSV_COLUMNS = [
    "export_id",
    "exported_at",
    "timezone",
    "household_name",
    "scope_label",
    "format_version",
    "export_item_count",
    "export_unit_count",
    "item_id",
    "item_name",
    "description",
    "brand",
    "model",
    "serial_number",
    "quantity",
    "at_home_quantity",
    "on_loan_quantity",
    "condition",
    "category",
    "tags",
    "room_path",
    "property_id",
    "property_name",
    "location_path",
    "full_location_path",
    "archived",
    "purchase_status",
    "purchase_merchant",
    "purchase_date",
    "purchase_currency",
    "purchase_total_cents",
    "purchase_total_scope",
    "purchase_item_allocation_cents",
    "purchase_unallocated_cents",
    "current_value_unit_cents",
    "current_value_quantity",
    "current_value_total_cents",
    "current_value_currency",
    "current_value_basis",
    "current_value_estimated_at",
    "warranty_provider",
    "warranty_end_date",
    "warranty_status",
    "last_checked_at",
    "last_checked_status",
    "last_checked_quantity",
    "last_checked_owned_quantity",
    "last_checked_on_loan_quantity",
    "last_checked_location_path",
    "last_checked_stale",
    "photo_count",
    "evidence_count",
    "evidence_references",
]


def _csv_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = _clean_text(value, 10000)
    if text.lstrip()[:1] in {"=", "+", "-", "@", "\t", "\r"}:
        return "'" + text
    return text


def build_csv(snapshot: dict[str, Any], *, deadline: float | None = None) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for item in snapshot["items"]:
        _check_deadline(deadline)
        purchase = item.get("purchase") or {}
        current = _snapshot_current_value(item)
        if not purchase:
            total_scope = "no purchase record"
        elif purchase.get("total_cents") is None:
            total_scope = "purchase total not recorded"
        elif purchase.get("has_unselected_items"):
            total_scope = "purchase transaction total; includes items outside selection"
        elif purchase.get("item_count", 0) > 1:
            total_scope = "purchase transaction total; all linked items selected"
        else:
            total_scope = "purchase transaction total"
        row = [
            snapshot.get("export_id") or "",
            snapshot["generated_at"],
            snapshot["timezone"],
            snapshot["household"]["name"],
            snapshot["scope_label"],
            snapshot["format_version"],
            snapshot["item_count"],
            snapshot["unit_count"],
            item["id"],
            item["name"],
            item.get("description") or "",
            item.get("brand") or "",
            item.get("model") or "",
            item.get("serial_number") or "",
            item["quantity"],
            item["at_home_quantity"],
            item["on_loan_quantity"],
            item["condition"],
            item.get("category") or "",
            "; ".join(item.get("tags") or []),
            item.get("room_path") or "",
            item.get("property_id") or "",
            item.get("property_name") or "",
            item.get("location_path") or "",
            item.get("full_location_path") or "",
            "yes" if item.get("is_archived") else "no",
            item.get("purchase_info_status") or "",
            purchase.get("merchant") or "",
            purchase.get("purchase_date") or "",
            purchase.get("currency") or "",
            purchase.get("total_cents") if purchase.get("total_cents") is not None else "",
            total_scope,
            purchase.get("item_allocation_cents")
            if purchase.get("item_allocation_cents") is not None
            else "",
            purchase.get("unallocated_cents")
            if purchase.get("unallocated_cents") is not None
            else "",
            current["unit_cents"] if current["unit_cents"] is not None else "",
            current["quantity"],
            current["total_cents"] if current["total_cents"] is not None else "",
            current["currency"] or "",
            current["basis"] or "",
            current["estimated_at"] or "",
            (item.get("warranty") or {}).get("provider") or "",
            (item.get("warranty") or {}).get("end_date") or "",
            (item.get("warranty") or {}).get("status") or "",
            (item.get("last_checked") or {}).get("at") or "",
            (item.get("last_checked") or {}).get("status") or "",
            (item.get("last_checked") or {}).get("quantity")
            if (item.get("last_checked") or {}).get("quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("owned_quantity")
            if (item.get("last_checked") or {}).get("owned_quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("on_loan_quantity")
            if (item.get("last_checked") or {}).get("on_loan_quantity") is not None
            else "",
            (item.get("last_checked") or {}).get("location_path") or "",
            "yes" if (item.get("last_checked") or {}).get("stale") else "no",
            item.get("photo_count") or 0,
            item.get("document_count") or 0,
            "; ".join(item.get("document_refs") or []),
        ]
        writer.writerow([_csv_value(value) for value in row])
    return buffer.getvalue().encode("utf-8-sig")


def _zip_readme(snapshot: dict[str, Any], pdf_name: str, csv_name: str | None) -> str:
    lines = [
        "Housetory inventory evidence package",
        "====================================",
        "",
        f"Household: {snapshot['household']['name']}",
        f"Generated: {snapshot['generated_at']} ({snapshot['timezone']})",
        f"Scope: {snapshot['scope_label']}",
        f"Items: {snapshot['item_count']} · units: {snapshot['unit_count']}",
        "",
        "This package records what is currently recorded in Housetory.",
        "It is not a physical stocktake, an appraisal, an insurance acceptance,",
        "a claim or a guarantee of coverage. Missing information is marked, not",
        "invented. Currencies are kept separate and never converted.",
        "Current-value estimates are per owned unit and extended by owned quantity.",
        "Legacy record totals are reported once and are not multiplied by quantity.",
        "",
        f"Main report: {pdf_name}",
    ]
    if csv_name:
        lines.append(f"Spreadsheet: {csv_name}")
    lines.extend(
        [
            "Manifest: manifest.json",
            "",
            "Evidence files are under documents/ and photos/. The manifest maps each",
            "file to its item/document, role, SHA-256 and byte count. Original means",
            "the exact stored upload bytes; normalized/download means the safe or",
            "cleaned derivative. A missing file is listed in manifest.json and in the",
            "report notes rather than silently omitted.",
            "",
            "No borrower names, loan notes, purchase notes or document notes are included.",
            "The package is private and should be stored securely. It is not uploaded",
            "or shared automatically by Housetory.",
        ]
    )
    return "\n".join(lines) + "\n"


def _zip_name(parts: str, fallback: str) -> str:
    cleaned = _slug(parts, fallback)
    return cleaned or fallback


def write_bundle(
    household_id: uuid.UUID,
    export_id: uuid.UUID,
    snapshot: dict[str, Any],
    *,
    pdf_bytes: bytes,
    csv_bytes: bytes | None,
    pdf_name: str,
    csv_name: str | None,
    max_bytes: int,
    deadline: float | None = None,
) -> tuple[str, int, str, dict[str, Any], list[str]]:
    temp_path = storage.evidence_export_temp_path(household_id, export_id, ".zip")
    warnings: list[str] = []
    manifest_files: list[dict[str, Any]] = []
    missing: list[str] = []
    added = len(pdf_bytes) + (len(csv_bytes) if csv_bytes else 0)
    if added > max_bytes:
        raise EvidenceExportTooLarge("The selected files exceed the package size limit.")
    options = EvidenceOptionsIn.model_validate(snapshot["options"])
    try:
        with zipfile.ZipFile(
            temp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            archive.writestr(pdf_name, pdf_bytes)
            manifest_files.append(
                {
                    "path": pdf_name,
                    "role": "report_pdf",
                    "bytes": len(pdf_bytes),
                    "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
                }
            )
            if csv_bytes is not None and csv_name:
                archive.writestr(csv_name, csv_bytes)
                manifest_files.append(
                    {
                        "path": csv_name,
                        "role": "spreadsheet_csv",
                        "bytes": len(csv_bytes),
                        "sha256": hashlib.sha256(csv_bytes).hexdigest(),
                    }
                )

            documents = [entry for entry in snapshot["documents"] if entry["included"]]
            manifest_documents: list[dict[str, Any]] = []
            for document in documents:
                _check_deadline(deadline)
                folder = _zip_name(
                    f"{document.get('reference') or 'evidence'}-{document['title']}",
                    "document",
                )
                files: list[dict[str, Any]] = []

                def add_document_file(
                    key: str,
                    role: str,
                    suffix: str,
                    *,
                    document: dict[str, Any] = document,
                    folder: str = folder,
                    files: list[dict[str, Any]] = files,
                ) -> None:
                    nonlocal added
                    if not storage.evidence_export_key_exists(key):
                        missing.append(
                            f"Missing {role.replace('_', ' ')} file for "
                            f"“{document['title']}” ({document.get('reference') or 'evidence'})."
                        )
                        return
                    try:
                        source = storage.resolve_key(key)
                        size = source.stat().st_size
                    except (ApiError, OSError):
                        missing.append(
                            f"Missing {role.replace('_', ' ')} file for “{document['title']}”."
                        )
                        return
                    if added + size > max_bytes:
                        raise EvidenceExportTooLarge(
                            "The selected attachments exceed the package size limit."
                        )
                    try:
                        digest = storage.file_sha256(key)
                    except (OSError, ApiError):
                        missing.append(
                            f"Could not read {role.replace('_', ' ')} file for "
                            f"“{document['title']}”."
                        )
                        return
                    existing_file = next(
                        (entry for entry in files if entry.get("sha256") == digest),
                        None,
                    )
                    if existing_file is not None:
                        alias = {
                            **existing_file,
                            "role": role,
                            "alias_of": existing_file["path"],
                        }
                        files.append(alias)
                        manifest_files.append({**alias, "document_id": document["id"]})
                        return
                    arcname = f"documents/{folder}/{suffix}"
                    try:
                        archive.write(source, arcname)
                    except OSError:
                        missing.append(
                            f"Could not include {role.replace('_', ' ')} file for "
                            f"“{document['title']}”."
                        )
                        return
                    added += size
                    record = {
                        "path": arcname,
                        "role": role,
                        "bytes": size,
                        "sha256": digest,
                        "content_type": (
                            document["original_content_type"]
                            if role.startswith("original")
                            else document["content_type"]
                        ),
                    }
                    files.append(record)
                    manifest_files.append({**record, "document_id": document["id"]})

                if options.include_document_originals:
                    add_document_file(
                        document["original_storage_key"],
                        "original",
                        f"original{Path(document['original_filename']).suffix or '.bin'}",
                    )
                    if document["storage_key"] != document["original_storage_key"]:
                        add_document_file(
                            document["storage_key"],
                            "normalized_download",
                            f"download{Path(document['original_filename']).suffix or '.bin'}",
                        )
                    for page in document.get("scan_pages") or []:
                        add_document_file(
                            page["original_storage_key"],
                            f"scan_source_page_{page['index']}",
                            (
                                f"source-page-{page['index']:02d}"
                                f"{Path(page['original_filename']).suffix or '.bin'}"
                            ),
                        )
                else:
                    add_document_file(
                        document["storage_key"],
                        "normalized_download",
                        f"download{Path(document['original_filename']).suffix or '.bin'}",
                    )
                manifest_documents.append(
                    {
                        "reference": document.get("reference"),
                        "id": document["id"],
                        "title": document["title"],
                        "document_type": document["document_type"],
                        "evidence_kind": document["evidence_kind"],
                        "selected_item_ids": document["selected_item_ids"],
                        "shared_with_unselected": document["shared_with_unselected"],
                        "files": files,
                    }
                )

            photos_manifest: list[dict[str, Any]] = []
            if options.include_photos:
                for photo in snapshot["photos"]:
                    _check_deadline(deadline)
                    key = photo["storage_key"]
                    if not storage.evidence_export_key_exists(key):
                        missing.append(
                            f"Missing photo “{photo['original_filename']}” for "
                            f"“{photo['item_name']}”."
                        )
                        continue
                    try:
                        source = storage.resolve_key(key)
                        size = source.stat().st_size
                    except (ApiError, OSError):
                        missing.append(f"Missing photo “{photo['original_filename']}”.")
                        continue
                    if added + size > max_bytes:
                        raise EvidenceExportTooLarge(
                            "The selected photos and attachments exceed the package size limit."
                        )
                    folder = _zip_name(f"{photo['item_name']}-{photo['item_id'][:8]}", "item")
                    suffix = Path(photo["original_filename"]).suffix or ".bin"
                    stem = Path(photo["original_filename"]).stem or "photo"
                    arcname = (
                        f"photos/{folder}/"
                        f"{_zip_name(photo['id'][:8] + '-' + stem, 'photo')}"
                        f"{suffix}"
                    )
                    try:
                        archive.write(source, arcname)
                        digest = storage.file_sha256(key)
                    except (OSError, ApiError):
                        missing.append(f"Could not include photo “{photo['original_filename']}”.")
                        continue
                    added += size
                    record = {
                        "path": arcname,
                        "role": "item_photo",
                        "bytes": size,
                        "sha256": digest,
                        "content_type": photo["content_type"],
                        "photo_id": photo["id"],
                        "item_id": photo["item_id"],
                        "item_name": photo["item_name"],
                    }
                    photos_manifest.append(record)
                    manifest_files.append(record)

            all_warnings = [*snapshot["warnings"], *warnings, *missing]
            manifest = {
                "format_version": snapshot["format_version"],
                "export_id": str(export_id),
                "generated_at": snapshot["generated_at"],
                "timezone": snapshot["timezone"],
                "household": snapshot["household"],
                "scope": snapshot["scope"],
                "scope_label": snapshot["scope_label"],
                "include_archived": snapshot["include_archived"],
                "options": snapshot["options"],
                "counts": {
                    "items": snapshot["item_count"],
                    "units": snapshot["unit_count"],
                    "at_home_units": snapshot["at_home_unit_count"],
                    "on_loan_units": snapshot["on_loan_unit_count"],
                    "photos": snapshot["photo_count"],
                    "included_photos": snapshot["included_photo_count"],
                    "documents": snapshot["document_count"],
                    "included_documents": snapshot["included_document_count"],
                },
                "items": [
                    {
                        "id": item["id"],
                        "name": item["name"],
                        "quantity": item["quantity"],
                        "on_loan_quantity": item["on_loan_quantity"],
                        "at_home_quantity": item["at_home_quantity"],
                        "full_location_path": item["full_location_path"],
                        "property_id": item["property_id"],
                        "property_name": item["property_name"],
                        "evidence_references": item["document_refs"],
                        "current_value_unit_cents": _snapshot_current_value(item)["unit_cents"],
                        "current_value_quantity": _snapshot_current_value(item)["quantity"],
                        "current_value_total_cents": _snapshot_current_value(item)["total_cents"],
                        "current_value_currency": _snapshot_current_value(item)["currency"],
                        "current_value_basis": _snapshot_current_value(item)["basis"],
                        "current_value_estimated_at": _snapshot_current_value(item)["estimated_at"],
                        "last_checked": item.get("last_checked"),
                    }
                    for item in snapshot["items"]
                ],
                "documents": manifest_documents,
                "photos": photos_manifest,
                "files": manifest_files,
                "missing_files": missing,
                "warnings": all_warnings,
                "note": (
                    "Recorded inventory only. Not a physical stocktake, appraisal, "
                    "insurance acceptance, coverage guarantee or claim."
                ),
            }
            readme = _zip_readme(snapshot, pdf_name, csv_name)
            archive.writestr("README.txt", readme.encode("utf-8"))
            manifest_json = json.dumps(
                manifest, ensure_ascii=False, indent=2, sort_keys=True
            ).encode("utf-8")
            archive.writestr("manifest.json", manifest_json)
        artifact = storage.finalize_evidence_export_temp(
            household_id, export_id, temp_path, f"housetory-evidence-{export_id}.zip"
        )
        return *artifact, manifest, missing
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
