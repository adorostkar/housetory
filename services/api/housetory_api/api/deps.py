from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from fastapi import Depends, Request, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..models import AuthSession, Household, HouseholdMember, User
from ..security import hash_session_token
from .errors import ApiError

SESSION_COOKIE = "housetory_session"


@dataclass(frozen=True)
class AuthContext:
    user: User
    household: Household
    role: str
    session: AuthSession


def _session_from_request(request: Request, db: Session) -> AuthSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    token_hash = hash_session_token(token)
    auth_session = db.scalar(
        select(AuthSession)
        .join(User)
        .where(
            AuthSession.token_hash == token_hash,
            AuthSession.expires_at > datetime.now(UTC),
            User.is_active.is_(True),
        )
    )
    if auth_session is None:
        return None
    now = datetime.now(UTC)
    if auth_session.last_used_at < now - timedelta(minutes=5):
        db.execute(
            update(AuthSession).where(AuthSession.id == auth_session.id).values(last_used_at=now)
        )
        db.commit()
    return auth_session


def get_optional_auth(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthContext | None:
    auth_session = _session_from_request(request, db)
    if auth_session is None:
        return None
    membership = db.scalar(
        select(HouseholdMember)
        .where(HouseholdMember.user_id == auth_session.user_id)
        .order_by(HouseholdMember.created_at)
        .limit(1)
    )
    if membership is None:
        return None
    household = db.get(Household, membership.household_id)
    if household is None:
        return None
    return AuthContext(
        user=auth_session.user,
        household=household,
        role=membership.role,
        session=auth_session,
    )


def require_auth(
    auth: AuthContext | None = Depends(get_optional_auth),
) -> AuthContext:
    if auth is None:
        raise ApiError(401, "not_authenticated", "Sign in to continue.")
    return auth


def require_owner(auth: AuthContext = Depends(require_auth)) -> AuthContext:
    if auth.role != "owner":
        raise ApiError(403, "owner_required", "Only the household owner can do that.")
    return auth


def set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    max_age = settings.session_ttl_days * 24 * 60 * 60
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def validate_origin(request: Request) -> None:
    """Reject cross-site state-changing browser requests.

    Session cookies are SameSite=Lax, and this gives a second layer of
    protection without requiring a separate CSRF token dance.
    """
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return

    origin = request.headers.get("origin")
    if not origin:
        # Some browsers omit Origin on older form posts. Validate Referer when
        # available; non-browser API clients without either header remain usable.
        referer = request.headers.get("referer")
        if not referer:
            return
        parsed_referer = urlsplit(referer)
        origin = f"{parsed_referer.scheme}://{parsed_referer.netloc}"

    settings = get_settings()
    allowed = {settings.app_base_url, *(o.strip() for o in settings.extra_origins.split(",") if o)}
    if settings.environment == "development":
        allowed.add("http://localhost:5173")
        allowed.add("http://127.0.0.1:5173")
    normalized = {value.rstrip("/").lower() for value in allowed if value}
    if origin.rstrip("/").lower() not in normalized:
        raise ApiError(403, "origin_not_allowed", "This origin is not allowed to change data.")
