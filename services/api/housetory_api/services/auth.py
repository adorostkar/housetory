import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from ..config import Settings
from ..models import AuthSession, Household, HouseholdMember, Property, User
from ..schemas.auth import HouseholdOut, SessionState, UserOut
from ..schemas.households import HouseholdMembershipOut
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
    db.add(
        Property(
            household_id=household.id,
            name="Home",
            sort_order=0,
        )
    )
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


def list_memberships(
    db: Session, user_id: uuid.UUID
) -> list[tuple[Household, HouseholdMember, int]]:
    rows = db.execute(
        select(
            Household,
            HouseholdMember,
            func.count(Property.id),
        )
        .join(HouseholdMember, HouseholdMember.household_id == Household.id)
        .outerjoin(Property, Property.household_id == Household.id)
        .where(HouseholdMember.user_id == user_id)
        .group_by(
            Household.id,
            HouseholdMember.household_id,
            HouseholdMember.user_id,
            HouseholdMember.role,
            HouseholdMember.created_at,
        )
        .order_by(HouseholdMember.created_at, func.lower(Household.name))
    ).all()
    return [
        (household, membership, int(property_count or 0))
        for household, membership, property_count in rows
    ]


def membership_count(db: Session, user_id: uuid.UUID) -> int:
    return int(
        db.scalar(
            select(func.count(HouseholdMember.household_id)).where(
                HouseholdMember.user_id == user_id
            )
        )
        or 0
    )


def build_session_state(
    db: Session,
    *,
    user: User,
    session: AuthSession,
    setup_needed_override: bool | None = None,
) -> SessionState:
    setup_needed = (
        setup_needed_override if setup_needed_override is not None else setup_required(db)
    )
    memberships = list_memberships(db, user.id)
    chosen: tuple[Household, HouseholdMember, int] | None = None
    if session.household_id is not None:
        chosen = next(
            (entry for entry in memberships if entry[0].id == session.household_id),
            None,
        )
    if chosen is None and memberships:
        chosen = memberships[0]
        if session.household_id != chosen[0].id:
            session.household_id = chosen[0].id
            db.commit()
    elif chosen is None and not memberships and session.household_id is not None:
        session.household_id = None
        db.commit()
    return SessionState(
        authenticated=True,
        setup_required=setup_needed,
        user=UserOut.model_validate(user),
        household=(
            HouseholdOut(
                id=chosen[0].id,
                name=chosen[0].name,
                default_currency=chosen[0].default_currency,
                warranty_reminder_days=chosen[0].warranty_reminder_days,
                item_image_auto_reference=chosen[0].item_image_auto_reference,
            )
            if chosen is not None
            else None
        ),
        role=chosen[1].role if chosen is not None else None,
        households=[
            HouseholdMembershipOut(
                id=household.id,
                name=household.name,
                role=membership.role,
                default_currency=household.default_currency,
                warranty_reminder_days=household.warranty_reminder_days,
                property_count=property_count,
                is_current=chosen is not None and household.id == chosen[0].id,
            )
            for household, membership, property_count in memberships
        ],
    )


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
    household_id: uuid.UUID | None = None,
) -> str:
    now = datetime.now(UTC)
    db.execute(delete(AuthSession).where(AuthSession.expires_at < now))
    token = generate_session_token()
    db.add(
        AuthSession(
            user_id=user.id,
            household_id=household_id,
            token_hash=hash_session_token(token),
            expires_at=now + timedelta(days=settings.session_ttl_days),
            user_agent=(user_agent or "")[:512] or None,
            ip_address=ip_address,
        )
    )
    return token


def get_session_by_token(db: Session, token: str) -> AuthSession | None:
    return db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_session_token(token)))


def revoke_session(db: Session, token: str | None) -> None:
    if not token:
        return
    db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_session_token(token)))


def revoke_user_sessions(db: Session, user_id: uuid.UUID) -> None:
    db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))


def revoke_household_sessions(db: Session, user_id: uuid.UUID, household_id: uuid.UUID) -> None:
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user_id,
            AuthSession.household_id == household_id,
        )
    )
