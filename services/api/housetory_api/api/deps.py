import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from fastapi import Depends, Request, Response
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..models import AuthSession, Household, HouseholdMember, User
from ..security import hash_session_token
from .errors import ApiError

SESSION_COOKIE = "housetory_session"


@dataclass(frozen=True)
class AccountContext:
    user: User
    session: AuthSession


@dataclass(frozen=True)
class AuthContext:
    user: User
    household: Household
    role: str
    session: AuthSession
    membership_count: int | None = None


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


def get_optional_account(
    request: Request,
    db: Session = Depends(get_db),
) -> AccountContext | None:
    auth_session = _session_from_request(request, db)
    if auth_session is None:
        return None
    return AccountContext(user=auth_session.user, session=auth_session)


def require_account(
    account: AccountContext | None = Depends(get_optional_account),
) -> AccountContext:
    if account is None:
        raise ApiError(401, "not_authenticated", "Sign in to continue.")
    return account


def get_optional_auth(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthContext | None:
    auth_session = _session_from_request(request, db)
    if auth_session is None:
        return None
    if auth_session.household_id is not None:
        membership = db.scalar(
            select(HouseholdMember).where(
                HouseholdMember.user_id == auth_session.user_id,
                HouseholdMember.household_id == auth_session.household_id,
            )
        )
        if membership is None:
            # The membership may have been revoked or the session may have been
            # carried across account changes. The session-state endpoint falls
            # back to another current membership or the no-household state.
            raise ApiError(
                401,
                "household_access_revoked",
                "Your access to the selected household changed. Refresh to continue.",
            )
    else:
        # Compatibility for sessions created before selected-household sessions.
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
    if auth_session.household_id is None:
        auth_session.household_id = membership.household_id
        db.commit()
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


def require_writer(auth: AuthContext = Depends(require_auth)) -> AuthContext:
    if auth.role not in {"owner", "member"}:
        raise ApiError(
            403,
            "read_only_role",
            "Viewers have read-only access to this household.",
        )
    return auth


READ_ONLY_POST_SUFFIXES = (
    "/assistant/query",
    "/search/natural",
    "/search/items",
    "/manual-questions",
    "/manual-questions/online",
)
READ_ONLY_POST_PATTERNS = (
    re.compile(r"/evidence-exports/preview$"),
    re.compile(r"/evidence-exports$"),
    re.compile(r"/evidence-exports/[0-9a-f-]+/(cancel|retry)$"),
)


def _read_only_post(path: str) -> bool:
    return any(path.endswith(suffix) for suffix in READ_ONLY_POST_SUFFIXES) or any(
        pattern.search(path) for pattern in READ_ONLY_POST_PATTERNS
    )


def enforce_household_context(
    request: Request,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AuthContext:
    """Require an explicit, current household context for mutations.

    Multi-household accounts must send ``X-Household-Id`` on unsafe requests.
    The header must match the selected session household. This rejects a stale
    tab that still shows the previous household after another tab switched.
    A single-household account keeps working for existing API clients.
    """
    if request.method in {"GET", "HEAD", "OPTIONS"} or _read_only_post(request.url.path):
        return auth
    header = request.headers.get("x-household-id")
    if header:
        try:
            supplied = uuid.UUID(header)
        except ValueError:
            raise ApiError(
                400,
                "invalid_household_context",
                "The household context header is not a valid id.",
            ) from None
        if supplied != auth.household.id:
            raise ApiError(
                409,
                "household_context_changed",
                "The selected household changed. Reload before changing data.",
            )
        return auth
    count = int(
        db.scalar(
            select(func.count(HouseholdMember.household_id)).where(
                HouseholdMember.user_id == auth.user.id
            )
        )
        or 0
    )
    if count > 1:
        raise ApiError(
            409,
            "household_context_required",
            "Choose a household for this change and retry.",
        )
    return auth


def enforce_household_write_access(
    request: Request,
    auth: AuthContext = Depends(require_auth),
) -> AuthContext:
    """Block all household mutations for viewers.

    Applied at router level so new inventory mutations cannot forget the role
    check. The two POST endpoints that only answer questions are explicitly
    read-only.
    """
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return auth
    if auth.role in {"owner", "member"}:
        return auth
    if _read_only_post(request.url.path):
        return auth
    raise ApiError(
        403,
        "read_only_role",
        "Viewers have read-only access to this household.",
    )


def require_owner(
    request: Request,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AuthContext:
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        enforce_household_context(request, auth, db)
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

    # Treat the loopback spellings as equivalent. Browsers, terminal links and
    # documentation disagree about "localhost" vs "127.0.0.1" vs "[::1]" even
    # though they reach the same local instance. Only add aliases when the
    # configured URL itself is loopback, and keep the same scheme/port.
    parsed_base = urlsplit(settings.app_base_url)
    if parsed_base.hostname in {"localhost", "127.0.0.1", "::1"}:
        port = f":{parsed_base.port}" if parsed_base.port else ""
        scheme = parsed_base.scheme
        allowed.update(
            {
                f"{scheme}://localhost{port}",
                f"{scheme}://127.0.0.1{port}",
                f"{scheme}://[::1]{port}",
            }
        )

    normalized = {value.rstrip("/").lower() for value in allowed if value}
    if origin.rstrip("/").lower() not in normalized:
        raise ApiError(
            403,
            "origin_not_allowed",
            "This origin is not allowed to change data. Open Housetory at its "
            "configured address, or add this origin to EXTRA_ORIGINS.",
        )
