import re
import uuid
from datetime import date
from pathlib import PurePosixPath
from typing import Annotated
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_db
from ...domain import ImportSourceType, ImportStatus
from ...models import ImportBatch, ImportEntry, ImportSourceFile, Room, StorageLocation
from ...schemas.imports import (
    ImportApplyRequest,
    ImportApplyResult,
    ImportBatchDetail,
    ImportBatchList,
    ImportBatchOut,
)
from ...services import properties as property_service
from ...services import storage
from ...services.import_pipeline import (
    apply_import,
    enqueue_import,
    serialize_batch,
)
from ...services.import_readers import SUPPORTED_EXTENSIONS
from ...services.recognition_import import create_batch_from_recognition
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/imports", tags=["imports"])

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def _batch_out(db: Session, batch: ImportBatch) -> ImportBatchOut:
    return ImportBatchOut(
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
        entry_count=int(
            db.scalar(select(func.count(ImportEntry.id)).where(ImportEntry.batch_id == batch.id))
            or 0
        ),
    )


def _get_batch(db: Session, household_id: uuid.UUID, batch_id: uuid.UUID) -> ImportBatch:
    batch = db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.household_id == household_id
        )
    )
    if batch is None:
        raise ApiError(404, "import_not_found", "Import not found.")
    return batch


@router.get("", response_model=ImportBatchList)
def list_imports(
    status: Annotated[str | None, Query(pattern=r"^[a-z_]+$")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportBatchList:
    conditions = [ImportBatch.household_id == auth.household.id]
    if status:
        conditions.append(ImportBatch.status == status)
    total = int(db.scalar(select(func.count(ImportBatch.id)).where(*conditions)) or 0)
    batches = db.scalars(
        select(ImportBatch)
        .where(*conditions)
        .order_by(ImportBatch.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return ImportBatchList(
        items=[_batch_out(db, batch) for batch in batches],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=ImportBatchDetail, status_code=201)
def create_import(
    file: Annotated[UploadFile | None, File()] = None,
    text: Annotated[str | None, Form()] = None,
    title: Annotated[str | None, Form(max_length=200)] = None,
    product_url: Annotated[str | None, Form(max_length=2000)] = None,
    purchase_date: Annotated[date | None, Form()] = None,
    property_id: Annotated[uuid.UUID | None, Form()] = None,
    room_id: Annotated[uuid.UUID | None, Form()] = None,
    location_id: Annotated[uuid.UUID | None, Form()] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportBatchDetail:
    has_file = file is not None and bool(file.filename)
    has_text = bool(text and text.strip())
    has_product_url = bool(product_url and product_url.strip())
    if sum((has_file, has_text, has_product_url)) != 1:
        raise ApiError(
            422,
            "import_source_required",
            "Choose exactly one source: a file, a ZIP vault, pasted text, or one product URL.",
        )
    if purchase_date is not None and not has_product_url:
        raise ApiError(
            422,
            "purchase_date_requires_product_url",
            "A purchase date can only be supplied with a product URL.",
        )
    if has_product_url:
        parsed_url = urlparse(product_url.strip())
        if (
            parsed_url.scheme not in {"http", "https"}
            or not parsed_url.hostname
            or parsed_url.username
            or parsed_url.password
        ):
            raise ApiError(
                422,
                "invalid_product_url",
                "Enter a valid public HTTP or HTTPS product URL without credentials.",
            )
    if has_text and len(text) > 2_000_000:
        raise ApiError(413, "text_too_large", "Pasted imports are limited to 2 MB of text.")

    filename = None
    content_type = None
    source_type = ImportSourceType.TEXT
    if has_file:
        filename = file.filename or "import"
        suffix = PurePosixPath(filename).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            raise ApiError(
                422,
                "unsupported_import_type",
                "Supported imports are txt, md, markdown, csv, xlsx, docx, pdf, "
                "images and ZIP vaults.",
            )
        content_type = (file.content_type or "application/octet-stream").split(";", 1)[0]
        source_type = (
            ImportSourceType.VAULT
            if suffix == ".zip"
            else ImportSourceType.IMAGE
            if suffix in IMAGE_EXTENSIONS
            else ImportSourceType.FILE
        )
    context: dict[str, str] = {}
    context_room: Room | None = None
    context_location: StorageLocation | None = None
    if room_id is not None:
        context_room = db.scalar(
            select(Room).where(Room.id == room_id, Room.household_id == auth.household.id)
        )
        if context_room is None:
            raise ApiError(404, "room_not_found", "Room not found.")
    if location_id is not None:
        context_location = db.scalar(
            select(StorageLocation).where(
                StorageLocation.id == location_id,
                StorageLocation.household_id == auth.household.id,
                StorageLocation.active(),
            )
        )
        if context_location is None:
            raise ApiError(404, "location_not_found", "Storage location not found.")
        if context_room is not None and context_location.room_id != context_room.id:
            raise ApiError(
                422,
                "context_mismatch",
                "The selected place does not belong to the selected room.",
            )
        if context_room is None:
            context_room = db.get(Room, context_location.room_id)
    property_record = None
    if context_room is not None:
        property_record = context_room.property
        if property_id is not None and property_id != property_record.id:
            raise ApiError(
                422,
                "context_mismatch",
                "The selected room belongs to a different property.",
            )
    elif location_id is not None:
        property_record = context_location.room.property if context_location is not None else None
    elif property_id is not None:
        property_record = property_service.get_property(db, auth.household.id, property_id)
    else:
        property_record = property_service.resolve_room_property(db, auth.household.id, None)
    if property_record is not None:
        context["property_id"] = str(property_record.id)
        context["property_name"] = property_record.name
    if context_room is not None:
        context["room_id"] = str(context_room.id)
        context["room_name"] = context_room.name
    if context_location is not None:
        context["location_id"] = str(context_location.id)
        context["location_name"] = context_location.name
        context["location_identifier"] = context_location.identifier or ""
    clean_title = (title or "").strip()
    if has_text and not clean_title:
        clean_title = "Pasted notes"
    if has_file and not clean_title:
        clean_title = (filename or "Import").rsplit(".", 1)[0][:200] or "Import"
    if has_product_url and not clean_title:
        clean_title = "Product link"

    batch = ImportBatch(
        household_id=auth.household.id,
        title=clean_title[:200],
        source_type=source_type.value,
        status=ImportStatus.QUEUED.value,
        original_filename=filename,
        content_type=content_type,
        warnings=[],
        metadata_json={
            **({"context": context} if context else {}),
            **(
                {
                    "product_url": product_url.strip(),
                    "purchase_date": purchase_date.isoformat() if purchase_date else None,
                }
                if has_product_url
                else {}
            ),
        },
    )
    db.add(batch)
    try:
        db.flush()
        if has_text:
            stored = storage.store_import_text(auth.household.id, batch.id, text or "")
        elif has_product_url:
            source_text = f"Product URL: {product_url.strip()}\n"
            if purchase_date:
                source_text += f"Purchase date (explicit user fact): {purchase_date.isoformat()}\n"
            stored = storage.store_import_text(auth.household.id, batch.id, source_text)
        else:
            if file is None:
                raise ApiError(422, "import_source_required", "Choose a file to import.")
            stored = storage.store_import_source(auth.household.id, batch.id, file)
        batch.storage_key = stored.storage_key
        batch.byte_size = stored.byte_size
        if has_text or has_product_url:
            batch.original_filename = "product-url.txt" if has_product_url else "pasted-notes.txt"
            batch.content_type = "text/plain"
        enqueue_import(db, batch)
    except Exception:
        db.rollback()
        raise
    return serialize_batch(db, batch)


@router.post(
    "/from-recognition/{recognition_id}",
    response_model=ImportBatchDetail,
    status_code=201,
)
def create_import_from_recognition_route(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportBatchDetail:
    batch = create_batch_from_recognition(db, auth.household.id, recognition_id)
    return serialize_batch(db, batch)


@router.get("/{batch_id}", response_model=ImportBatchDetail)
def read_import(
    batch_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportBatchDetail:
    return serialize_batch(db, _get_batch(db, auth.household.id, batch_id))


@router.get("/{batch_id}/source")
def download_import_source(
    batch_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    batch = _get_batch(db, auth.household.id, batch_id)
    if not batch.storage_key:
        raise ApiError(404, "source_not_found", "Import source not found.")
    path = storage.resolve_import_key(batch.storage_key)
    filename = batch.original_filename or "import-source"
    filename = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename)[:255] or "import-source"
    return FileResponse(
        path,
        media_type=batch.content_type or "application/octet-stream",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.get("/{batch_id}/files/{file_id}/download")
def download_import_file(
    batch_id: uuid.UUID,
    file_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    _get_batch(db, auth.household.id, batch_id)
    source = db.scalar(
        select(ImportSourceFile).where(
            ImportSourceFile.id == file_id, ImportSourceFile.batch_id == batch_id
        )
    )
    if source is None:
        raise ApiError(404, "source_file_not_found", "Import source file not found.")
    path = storage.resolve_import_key(source.storage_key)
    filename = (
        re.sub(r"[^A-Za-z0-9._ -]+", "_", PurePosixPath(source.relative_path).name)[:255]
        or "import-file"
    )
    return FileResponse(
        path,
        media_type=source.content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.post("/{batch_id}/retry", response_model=ImportBatchDetail)
def retry_import(
    batch_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportBatchDetail:
    batch = _get_batch(db, auth.household.id, batch_id)
    if batch.status != ImportStatus.FAILED.value:
        raise ApiError(409, "import_not_failed", "Only failed imports can be retried.")
    enqueue_import(db, batch)
    batch = _get_batch(db, auth.household.id, batch.id)
    return serialize_batch(db, batch)


@router.post("/{batch_id}/apply", response_model=ImportApplyResult)
def apply_import_route(
    batch_id: uuid.UUID,
    payload: ImportApplyRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ImportApplyResult:
    batch = _get_batch(db, auth.household.id, batch_id)
    try:
        return apply_import(db, batch, payload.entries)
    except ValueError as exc:
        raise ApiError(422, "import_apply_failed", str(exc)) from None


@router.delete("/{batch_id}", status_code=204)
def delete_import(
    batch_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    batch = _get_batch(db, auth.household.id, batch_id)
    keys = [batch.storage_key] if batch.storage_key else []
    files = db.scalars(select(ImportSourceFile).where(ImportSourceFile.batch_id == batch.id)).all()
    keys.extend(source.storage_key for source in files)
    db.delete(batch)
    db.commit()
    for key in keys:
        storage.delete_import_key(key)
    return Response(status_code=204)
