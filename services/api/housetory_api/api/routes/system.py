import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.system import JobRetryOut, SystemStatusOut
from ...services.system_status import retry_job, system_status
from ..deps import AuthContext, require_owner

router = APIRouter(prefix="/system", tags=["system"])


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
    del auth
    return retry_job(db, job_id)
