from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from ..config import Settings
from ..models import AuthSession, Household, HouseholdMember, User
from ..security import (
    dummy_verify,
    generate_session_token,
    hash_password,
    hash_session_token,
    password_needs_rehash,
    verify_password,
)


def count_users(db: Session) -> int:
    return int(db.scalar(select(func.count(User.id))) or 0)


def setup_required(db: Session) -> bool:
    return count_users(db) == 0


def create_user_with_household(
    db: Session,
    *,
    name: str,
    email: str,
    password: str,
    household_name: str,
) -> tuple[User, Household]:
    # Serialize first-run setup across API processes.
    db.execute(text("SELECT pg_advisory_xact_lock(72439211)"))
    if count_users(db) > 0:
        raise ValueError("Setup has already been completed.")

    user = User(name=name, email=email, password_hash=hash_password(password))
    household = Household(name=household_name)
    db.add_all([user, household])
    db.flush()
    db.add(HouseholdMember(household_id=household.id, user_id=user.id, role="owner"))
    db.flush()
    return user, household


def get_primary_membership(db: Session, user: User) -> tuple[Household, str] | None:
    membership = db.scalar(
        select(HouseholdMember)
        .where(HouseholdMember.user_id == user.id)
        .order_by(HouseholdMember.created_at)
        .limit(1)
    )
    if membership is None:
        return None
    household = db.get(Household, membership.household_id)
    if household is None:
        return None
    return household, membership.role


def authenticate(db: Session, *, email: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not user.is_active:
        dummy_verify(password)
        return None
    if not verify_password(password, user.password_hash):
        return None
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = datetime.now(UTC)
    return user


def create_session(
    db: Session,
    *,
    user: User,
    settings: Settings,
    user_agent: str | None,
    ip_address: str | None,
) -> str:
    now = datetime.now(UTC)
    db.execute(delete(AuthSession).where(AuthSession.expires_at < now))
    token = generate_session_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            expires_at=now + timedelta(days=settings.session_ttl_days),
            user_agent=(user_agent or "")[:512] or None,
            ip_address=ip_address,
        )
    )
    return token


def revoke_session(db: Session, token: str | None) -> None:
    if not token:
        return
    db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_session_token(token)))
