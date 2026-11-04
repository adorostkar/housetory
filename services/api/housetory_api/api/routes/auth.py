from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_db
from ...schemas.auth import LoginRequest, SessionState, SetupRequest
from ...services import auth as auth_service
from ..abuse import enforce_login_limit, login_limiter
from ..deps import (
    SESSION_COOKIE,
    AccountContext,
    clear_session_cookie,
    get_optional_account,
    set_session_cookie,
)
from ..errors import ApiError

router = APIRouter(prefix="/auth", tags=["auth"])


def _session_state(
    db: Session,
    account: AccountContext | None,
) -> SessionState:
    setup_needed = auth_service.setup_required(db)
    if account is None:
        return SessionState(authenticated=False, setup_required=setup_needed)
    membership = None
    if account.session.household_id is not None:
        membership = auth_service.get_membership(db, account.user.id, account.session.household_id)
    else:
        primary = auth_service.get_primary_membership(db, account.user)
        membership = primary
    if membership is None:
        return SessionState(
            authenticated=True,
            setup_required=False,
            user=account.user,
            household=None,
            role=None,
        )
    household, role = (
        membership if isinstance(membership[1], str) else (membership[0], membership[1].role)
    )
    return SessionState(
        authenticated=True,
        setup_required=False,
        user=account.user,
        household=household,
        role=role,
    )


@router.get("/session", response_model=SessionState)
def get_session(
    db: Session = Depends(get_db),
    account: AccountContext | None = Depends(get_optional_account),
) -> SessionState:
    return _session_state(db, account)


@router.post("/setup", response_model=SessionState, status_code=201)
def setup(
    payload: SetupRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> SessionState:
    try:
        user, household = auth_service.create_user_with_household(
            db,
            name=payload.name,
            email=str(payload.email),
            password=payload.password,
            household_name=payload.household_name,
        )
    except ValueError as exc:
        db.rollback()
        raise ApiError(409, "setup_complete", str(exc)) from exc

    settings = get_settings()
    token = auth_service.create_session(
        db,
        user=user,
        settings=settings,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
        household_id=household.id,
    )
    db.commit()
    set_session_cookie(response, token, settings)
    return SessionState(
        authenticated=True,
        setup_required=False,
        user=user,
        household=household,
        role="owner",
    )


@router.post("/login", response_model=SessionState)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> SessionState:
    limiter_keys = [login_limiter.email_key(str(payload.email))]
    ip_key = login_limiter.ip_key(request.client.host if request.client else None)
    if ip_key:
        limiter_keys.append(ip_key)
    enforce_login_limit(limiter_keys)

    user = auth_service.authenticate(db, email=str(payload.email), password=payload.password)
    if user is None:
        login_limiter.record_failure(limiter_keys)
        db.rollback()
        raise ApiError(401, "invalid_credentials", "The email or password is incorrect.")

    login_limiter.clear(limiter_keys)
    membership = auth_service.get_primary_membership(db, user)
    settings = get_settings()
    household, role = membership if membership is not None else (None, None)
    token = auth_service.create_session(
        db,
        user=user,
        settings=settings,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
        household_id=household.id if household is not None else None,
    )
    db.commit()
    set_session_cookie(response, token, settings)
    return SessionState(
        authenticated=True,
        setup_required=False,
        user=user,
        household=household,
        role=role,
    )


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> Response:
    auth_service.revoke_session(db, request.cookies.get(SESSION_COOKIE))
    db.commit()
    clear_session_cookie(response, get_settings())
    response.status_code = 204
    return response
