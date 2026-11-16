import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import AssistantRun
from ...schemas.assistant_tools import RunOut, RunRequest
from ...services import assistant_tools
from ...services.assistant_tools.registry import TOOLS
from ..abuse import enforce_search_limit
from ..deps import AccountContext, require_account

router = APIRouter(prefix="/assistant", tags=["assistant-tools"])


@router.get("/tools")
def registry(account: AccountContext = Depends(require_account)):
    return {
        "tools": [tool.schema() for tool in TOOLS.values()],
        "limits": {
            "model_calls": assistant_tools.MAX_MODEL_CALLS,
            "deadline_seconds": assistant_tools.MAX_SECONDS,
        },
    }


@router.post("/runs", response_model=RunOut)
def create_run(
    payload: RunRequest,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
):
    enforce_search_limit(account.user.id)
    return assistant_tools.snapshot(db, assistant_tools.create(db, account, payload))


@router.get("/runs", response_model=list[RunOut])
def list_runs(
    household_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
):
    conditions = [AssistantRun.actor_user_id == account.user.id]
    if household_id:
        conditions.append(AssistantRun.household_id == household_id)
    conditions.append(AssistantRun.property_id == property_id)
    runs = list(
        db.scalars(
            select(AssistantRun)
            .where(*conditions)
            .order_by(AssistantRun.created_at.desc(), AssistantRun.id)
            .limit(30)
        )
    )
    output = []
    for run in runs:
        # Revoked scopes are not returned, even from the user's own history.
        from ...models import HouseholdMember

        if not db.scalar(
            select(HouseholdMember.household_id).where(
                HouseholdMember.household_id == run.household_id,
                HouseholdMember.user_id == account.user.id,
            )
        ):
            continue
        assistant_tools.owned(db, account, run.id)
        output.append(assistant_tools.snapshot(db, run))
    return list(reversed(output))


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(
    run_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
):
    return assistant_tools.snapshot(db, assistant_tools.owned(db, account, run_id))


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(
    run_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
):
    run = assistant_tools.owned(db, account, run_id, lock=True)
    assistant_tools.cancel(db, run)
    return assistant_tools.snapshot(db, run)


@router.post("/runs/{run_id}/retry", response_model=RunOut)
def retry_run(
    run_id: uuid.UUID,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
):
    enforce_search_limit(account.user.id)
    run = assistant_tools.owned(db, account, run_id, lock=True)
    assistant_tools.retry(db, account, run)
    return assistant_tools.snapshot(db, run)
