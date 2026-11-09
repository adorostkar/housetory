import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.insurance import (
    InsuranceBatchIn,
    InsuranceBatchOut,
    InsuranceListIn,
    InsuranceScopePreviewIn,
    InsuranceScopePreviewOut,
)
from ...services import insurance
from ..deps import AuthContext, require_auth

router = APIRouter(tags=["insurance"])


@router.post("/insurance-valuations/scope-preview", response_model=InsuranceScopePreviewOut)
def preview_scope(
    payload: InsuranceScopePreviewIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> InsuranceScopePreviewOut:
    return insurance.scope_preview(db, auth.household.id, payload)


@router.post("/insurance-valuations/batches", response_model=InsuranceBatchOut, status_code=202)
def create_batch(
    payload: InsuranceBatchIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> InsuranceBatchOut:
    return insurance.create_batch(db, auth.household.id, auth.user.id, payload)


@router.get("/insurance-valuations/batches/{request_id}", response_model=InsuranceBatchOut)
def read_batch(
    request_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> InsuranceBatchOut:
    return insurance.read_batch(db, auth.household.id, request_id)


@router.post("/insurance-valuations/batches/{request_id}/cancel", response_model=InsuranceBatchOut)
def cancel_batch(
    request_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> InsuranceBatchOut:
    return insurance.cancel_batch(db, auth.household.id, request_id)


@router.post("/insurance-lists", status_code=202)
def create_list(
    payload: InsuranceListIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    return insurance.create_list(db, auth.household.id, auth.user.id, payload)


@router.get("/insurance-lists/{job_id}")
def read_list(
    job_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
):
    return insurance._job_out(insurance.read_list_job(db, auth.household.id, job_id))


@router.get("/insurance-lists/{job_id}/{kind}")
def download_list(
    job_id: uuid.UUID,
    kind: str,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    job = insurance.read_list_job(db, auth.household.id, job_id)
    content, media_type, filename = insurance.list_file(job, kind)
    return Response(
        content,
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
