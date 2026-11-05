import re
import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.evidence_exports import (
    EvidenceCreateIn,
    EvidenceExportList,
    EvidenceExportOut,
    EvidencePreviewIn,
    EvidencePreviewOut,
)
from ...services import evidence_export as service
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/evidence-exports", tags=["exports"])


def _safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "housetory-evidence"


def _can_manage(package, auth: AuthContext) -> bool:
    return auth.role != "viewer" or package.created_by_user_id == auth.user.id


def _out(package, auth: AuthContext) -> EvidenceExportOut:
    return service.export_out(package, can_manage=_can_manage(package, auth))


@router.post("/preview", response_model=EvidencePreviewOut)
def preview_evidence_export(
    payload: EvidencePreviewIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidencePreviewOut:
    return service.preview_export(db, auth.household, payload)


@router.post("", response_model=EvidenceExportOut, status_code=202)
def create_evidence_export(
    payload: EvidenceCreateIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidenceExportOut:
    package = service.create_export(db, auth.household, payload, user_id=auth.user.id)
    return _out(package, auth)


@router.get("", response_model=EvidenceExportList)
def list_evidence_exports(
    limit: int = Query(default=20, ge=1, le=50),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidenceExportList:
    packages = service.list_exports(
        db,
        auth.household.id,
        user_id=auth.user.id,
        role=auth.role,
        limit=limit,
    )
    return EvidenceExportList(items=[_out(package, auth) for package in packages])


@router.get("/{export_id}", response_model=EvidenceExportOut)
def read_evidence_export(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidenceExportOut:
    return _out(service.get_export(db, auth.household.id, export_id), auth)


@router.post("/{export_id}/cancel", response_model=EvidenceExportOut)
def cancel_evidence_export(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidenceExportOut:
    package = service.cancel_export(
        db,
        service.get_export(db, auth.household.id, export_id, for_update=True),
        user_id=auth.user.id,
        role=auth.role,
    )
    return _out(package, auth)


@router.post("/{export_id}/retry", response_model=EvidenceExportOut)
def retry_evidence_export(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> EvidenceExportOut:
    package = service.retry_export(
        db,
        service.get_export(db, auth.household.id, export_id, for_update=True),
        user_id=auth.user.id,
        role=auth.role,
    )
    return _out(package, auth)


def _download(export_id: uuid.UUID, kind: str, auth: AuthContext, db: Session) -> FileResponse:
    path, name, media_type = service.download_artifact(db, auth.household.id, export_id, kind)
    safe_name = _safe_filename(name)
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'attachment; filename="{safe_name}"',
        },
    )


@router.get("/{export_id}/pdf")
def download_evidence_pdf(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    return _download(export_id, "pdf", auth, db)


@router.get("/{export_id}/csv")
def download_evidence_csv(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    return _download(export_id, "csv", auth, db)


@router.get("/{export_id}/bundle")
def download_evidence_bundle(
    export_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    return _download(export_id, "bundle", auth, db)
