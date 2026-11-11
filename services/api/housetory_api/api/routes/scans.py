import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.documents import (
    DocumentOut,
    DocumentPageOut,
    DocumentScanCommit,
    DocumentScanCreate,
    DocumentScanOut,
    DocumentScanPageUpdate,
    DocumentScanReorder,
)
from ...services import scan as scan_service
from ...services import storage
from ...services.serializers import document_out
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/documents/scans", tags=["document-scans"])


def _file_headers(page, *, original: bool) -> dict[str, str]:  # noqa: ANN001
    filename = page.original_filename if original else f"page-{page.page_index + 1}.jpg"
    return {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": f'inline; filename="{filename}"',
        "X-Housetory-Original": "true" if original else "false",
    }


@router.post("", response_model=DocumentScanOut, status_code=201)
def create_scan(
    payload: DocumentScanCreate | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentScanOut:
    scan = scan_service.create_scan(
        db,
        auth.household.id,
        actor_user_id=auth.user.id,
        target_document_id=payload.target_document_id if payload else None,
    )
    return scan_service.scan_out(scan)


@router.get("/{scan_id}", response_model=DocumentScanOut)
def read_scan(
    scan_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentScanOut:
    return scan_service.scan_out(scan_service.get_scan(db, auth.household.id, scan_id))


@router.post("/{scan_id}/pages", response_model=DocumentPageOut, status_code=201)
def upload_scan_page(
    scan_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentPageOut:
    page = scan_service.add_page(db, auth.household.id, scan_id, file)
    return scan_service.page_out(page)


@router.patch("/{scan_id}/pages/{page_id}", response_model=DocumentPageOut)
def update_scan_page(
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    payload: DocumentScanPageUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentPageOut:
    page = scan_service.update_page(db, auth.household.id, scan_id, page_id, payload)
    return scan_service.page_out(page)


@router.delete("/{scan_id}/pages/{page_id}", status_code=204)
def delete_scan_page(
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    scan_service.delete_page(db, auth.household.id, scan_id, page_id)
    return Response(status_code=204)


@router.post("/{scan_id}/pages/reorder", response_model=DocumentScanOut)
def reorder_scan_pages(
    scan_id: uuid.UUID,
    payload: DocumentScanReorder,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentScanOut:
    scan = scan_service.reorder_pages(db, auth.household.id, scan_id, payload.page_ids)
    return scan_service.scan_out(scan)


@router.post("/{scan_id}/commit", response_model=DocumentOut)
def commit_scan(
    scan_id: uuid.UUID,
    payload: DocumentScanCommit,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    document = scan_service.commit_scan(
        db,
        auth.household.id,
        scan_id,
        payload,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )
    return document_out(document)


@router.delete("/{scan_id}", status_code=204)
def cancel_scan(
    scan_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    scan_service.cancel_scan(db, auth.household.id, scan_id)
    return Response(status_code=204)


@router.get("/{scan_id}/pages/{page_id}/file")
def get_scan_page_file(
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    page = scan_service.get_page(db, auth.household.id, scan_id, page_id)
    return FileResponse(
        storage.resolve_key(page.cleaned_storage_key),
        media_type=page.cleaned_content_type,
        headers=_file_headers(page, original=False),
    )


@router.get("/{scan_id}/pages/{page_id}/original")
def get_scan_page_original(
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    page = scan_service.get_page(db, auth.household.id, scan_id, page_id)
    return FileResponse(
        storage.resolve_key(page.original_storage_key),
        media_type=page.original_content_type,
        headers=_file_headers(page, original=True),
    )
