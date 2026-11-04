from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.ownership import FinancialOverview
from ...services.ownership import financial_overview
from ..deps import AuthContext, require_auth

router = APIRouter(tags=["ownership"])


@router.get("/financial-overview", response_model=FinancialOverview)
def financial_overview_route(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FinancialOverview:
    return financial_overview(
        db,
        auth.household.id,
        household_reminder_days=auth.household.warranty_reminder_days,
    )
