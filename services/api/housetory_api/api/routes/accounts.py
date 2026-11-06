import hashlib
import uuid

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import get_db
from ...models import User
from ...schemas.accounts import (
    AccountOut,
    AccountUpdate,
    InvitationAccept,
    InvitationCreate,
    InvitationList,
    InvitationOut,
    InvitationPublic,
    MemberList,
    MemberOut,
    MemberRoleUpdate,
    PasswordChange,
    PasswordResetConfirm,
    PasswordResetPublic,
    PasswordResetRequest,
    SimpleMessage,
)
from ...schemas.auth import SessionState
from ...services import accounts as accounts_service
from ...services import auth as auth_service
from ...services import email as email_service
from ..abuse import enforce_login_limit, login_limiter
from ..deps import (
    AccountContext,
    AuthContext,
    get_optional_account,
    require_account,
    require_owner,
    set_session_cookie,
)
from ..errors import ApiError

router = APIRouter(tags=["accounts"])


def _action_keys(*values: str) -> list[str]:
    return [hashlib.sha256(value.encode("utf-8")).hexdigest() for value in values if value]


def _enforce_action(keys: list[str]) -> None:
    if not keys:
        return
    enforce_login_limit(keys)
    login_limiter.record_failure(keys)


def _request_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _email_configured() -> bool:
    return email_service.email_configured(get_settings())


def _session_state(db: Session, user: User, token: str) -> SessionState:
    session = auth_service.get_session_by_token(db, token)
    if session is None:  # pragma: no cover - the token was just created
        raise ApiError(500, "session_creation_failed", "Could not start a session.")
    return auth_service.build_session_state(
        db,
        user=user,
        session=session,
        setup_needed_override=False,
    )


@router.get("/account", response_model=AccountOut)
def get_account(account: AccountContext = Depends(require_account)) -> AccountOut:
    return AccountOut.model_validate(account.user)


@router.patch("/account", response_model=AccountOut)
def update_account(
    payload: AccountUpdate,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> AccountOut:
    if payload.name is not None:
        account.user.name = payload.name
    db.commit()
    db.refresh(account.user)
    return AccountOut.model_validate(account.user)


@router.post("/account/password", status_code=204)
def change_account_password(
    payload: PasswordChange,
    account: AccountContext = Depends(require_account),
    db: Session = Depends(get_db),
) -> Response:
    accounts_service.change_password(
        db,
        account.user,
        current_password=payload.current_password,
        new_password=payload.new_password,
        keep_session_id=account.session.id,
    )
    return Response(status_code=204)


@router.get("/household/members", response_model=MemberList)
def list_household_members(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> MemberList:
    return MemberList(
        members=accounts_service.list_members(db, auth.household.id),
        email_configured=_email_configured(),
    )


@router.patch("/household/members/{user_id}", response_model=MemberOut)
def change_household_member(
    user_id: uuid.UUID,
    payload: MemberRoleUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> MemberOut:
    return accounts_service.update_member_role(db, auth.household.id, user_id, payload)


@router.delete("/household/members/{user_id}", status_code=204)
def remove_household_member(
    user_id: uuid.UUID,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    accounts_service.remove_member(db, auth.household.id, user_id)
    return Response(status_code=204)


@router.get("/household/invitations", response_model=InvitationList)
def list_household_invitations(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> InvitationList:
    return InvitationList(
        items=accounts_service.list_invitations(db, auth.household.id),
        email_configured=_email_configured(),
    )


@router.post(
    "/household/invitations",
    response_model=InvitationOut,
    status_code=201,
)
def invite_household_member(
    payload: InvitationCreate,
    request: Request,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> InvitationOut:
    _enforce_action(
        _action_keys(f"invite:{auth.household.id}", f"invite-ip:{_request_ip(request)}")
    )
    if not _email_configured():
        raise ApiError(
            503,
            "email_not_configured",
            "Email is not configured. Set the SMTP settings before inviting members.",
        )
    return accounts_service.create_invitation(
        db, auth.household.id, inviter=auth.user, payload=payload
    )


@router.post(
    "/household/invitations/{invitation_id}/resend",
    response_model=InvitationOut,
)
def resend_household_invitation(
    invitation_id: uuid.UUID,
    request: Request,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> InvitationOut:
    _enforce_action(
        _action_keys(f"invite:{auth.household.id}", f"invite-ip:{_request_ip(request)}")
    )
    if not _email_configured():
        raise ApiError(
            503,
            "email_not_configured",
            "Email is not configured. Set the SMTP settings before inviting members.",
        )
    return accounts_service.resend_invitation(
        db, auth.household.id, invitation_id, inviter=auth.user
    )


@router.delete("/household/invitations/{invitation_id}", status_code=204)
def revoke_household_invitation(
    invitation_id: uuid.UUID,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    accounts_service.revoke_invitation(db, auth.household.id, invitation_id)
    return Response(status_code=204)


@router.get("/invitations/{token}", response_model=InvitationPublic)
def read_invitation(
    token: str,
    request: Request,
    account: AccountContext | None = Depends(get_optional_account),
    db: Session = Depends(get_db),
) -> InvitationPublic:
    _enforce_action(_action_keys(f"invite-lookup:{_request_ip(request)}"))
    return accounts_service.public_invitation(
        db, token, current_user=account.user if account else None
    )


@router.post("/invitations/{token}/accept", response_model=SessionState)
def accept_invitation(
    token: str,
    payload: InvitationAccept,
    request: Request,
    response: Response,
    account: AccountContext | None = Depends(get_optional_account),
    db: Session = Depends(get_db),
) -> SessionState:
    _enforce_action(_action_keys(f"invite-accept:{_request_ip(request)}"))
    user, household, role = accounts_service.accept_invitation(
        db,
        token,
        current_user=account.user if account else None,
        payload=payload,
    )
    settings = get_settings()
    session_token = auth_service.create_session(
        db,
        user=user,
        settings=settings,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
        household_id=household.id,
    )
    db.commit()
    set_session_cookie(response, session_token, settings)
    return _session_state(db, user, session_token)


@router.post("/auth/password-reset/request", response_model=SimpleMessage)
def request_password_reset(
    payload: PasswordResetRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SimpleMessage:
    _enforce_action(
        _action_keys(
            f"reset:{str(payload.email).lower()}",
            f"reset-ip:{_request_ip(request)}",
        )
    )
    accounts_service.request_password_reset(db, str(payload.email))
    return SimpleMessage(
        message="If an account exists for that email, a password reset link has been sent."
    )


@router.get("/auth/password-reset/{token}", response_model=PasswordResetPublic)
def read_password_reset(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> PasswordResetPublic:
    _enforce_action(_action_keys(f"reset-lookup:{_request_ip(request)}"))
    valid, expires_at = accounts_service.password_reset_status(db, token)
    return PasswordResetPublic(valid=valid, expires_at=expires_at)


@router.post("/auth/password-reset/confirm", response_model=SimpleMessage)
def confirm_password_reset(
    payload: PasswordResetConfirm,
    request: Request,
    db: Session = Depends(get_db),
) -> SimpleMessage:
    _enforce_action(_action_keys(f"reset-confirm:{_request_ip(request)}"))
    accounts_service.reset_password(db, payload.token, payload.password)
    return SimpleMessage(message="Your password has been reset. Sign in with the new password.")
