import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.system import (
    JobRetryOut,
    SystemStatusOut,
    SystemStatusSummaryOut,
)
from ...services.system_status import retry_job, system_status, system_status_summary
from ..deps import AuthContext, require_owner

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/status/summary", response_model=SystemStatusSummaryOut)
def read_system_status_summary(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> SystemStatusSummaryOut:
    return system_status_summary(db, auth.household.id)


@router.get("/status", response_model=SystemStatusOut)
def read_system_status(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> SystemStatusOut:
    return system_status(db, auth.household.id)


@router.post("/jobs/{job_id}/retry", response_model=JobRetryOut)
def retry_system_job(
    job_id: uuid.UUID,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> JobRetryOut:
    return retry_job(db, auth.household.id, job_id)
