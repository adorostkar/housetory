"""Household membership, invitations and account recovery."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api.errors import ApiError
from ..config import get_settings
from ..domain import MemberRole
from ..models import (
    AuthSession,
    Household,
    HouseholdInvitation,
    HouseholdMember,
    PasswordResetToken,
    User,
)
from ..schemas.accounts import (
    InvitationAccept,
    InvitationCreate,
    InvitationOut,
    InvitationPublic,
    MemberOut,
    MemberRoleUpdate,
)
from ..security import (
    generate_session_token,
    hash_password,
    hash_session_token,
    verify_password,
)
from . import email as email_service
from .auth import revoke_household_sessions, revoke_user_sessions

logger = logging.getLogger("housetory.accounts")


def _now() -> datetime:
    return datetime.now(UTC)


def _lock_household(db: Session, household_id: uuid.UUID) -> Household:
    household = db.scalar(select(Household).where(Household.id == household_id).with_for_update())
    if household is None:
        raise ApiError(404, "household_not_found", "Household not found.")
    return household


def _owner_count(db: Session, household_id: uuid.UUID) -> int:
    return int(
        db.scalar(
            select(func.count(HouseholdMember.user_id)).where(
                HouseholdMember.household_id == household_id,
                HouseholdMember.role == MemberRole.OWNER.value,
            )
        )
        or 0
    )


def list_members(db: Session, household_id: uuid.UUID) -> list[MemberOut]:
    rows = db.execute(
        select(HouseholdMember, User)
        .join(User, User.id == HouseholdMember.user_id)
        .where(HouseholdMember.household_id == household_id)
        .order_by(HouseholdMember.created_at, func.lower(User.name))
    ).all()
    return [
        MemberOut(
            user_id=user.id,
            name=user.name,
            email=user.email,
            role=membership.role,
            joined_at=membership.created_at,
        )
        for membership, user in rows
    ]


def update_member_role(
    db: Session,
    household_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: MemberRoleUpdate,
) -> MemberOut:
    _lock_household(db, household_id)
    membership = db.scalar(
        select(HouseholdMember)
        .where(
            HouseholdMember.household_id == household_id,
            HouseholdMember.user_id == user_id,
        )
        .with_for_update()
    )
    if membership is None:
        raise ApiError(404, "member_not_found", "Household member not found.")
    new_role = payload.role
    if (
        membership.role == MemberRole.OWNER.value
        and new_role != MemberRole.OWNER.value
        and _owner_count(db, household_id) <= 1
    ):
        raise ApiError(
            409,
            "last_owner",
            "The household must keep at least one owner.",
        )
    membership.role = new_role
    user = db.get(User, user_id)
    if user is None:
        raise ApiError(404, "member_not_found", "Household member not found.")
    db.commit()
    return MemberOut(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=membership.role,
        joined_at=membership.created_at,
    )


def remove_member(
    db: Session,
    household_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    _lock_household(db, household_id)
    membership = db.scalar(
        select(HouseholdMember)
        .where(
            HouseholdMember.household_id == household_id,
            HouseholdMember.user_id == user_id,
        )
        .with_for_update()
    )
    if membership is None:
        raise ApiError(404, "member_not_found", "Household member not found.")
    if membership.role == MemberRole.OWNER.value and _owner_count(db, household_id) <= 1:
        raise ApiError(
            409,
            "last_owner",
            "The household must keep at least one owner.",
        )
    db.delete(membership)
    revoke_household_sessions(db, user_id, household_id)
    db.commit()


def _invitation_status(invitation: HouseholdInvitation) -> str:
    now = _now()
    if invitation.revoked_at is not None:
        return "revoked"
    if invitation.accepted_at is not None:
        return "accepted"
    if invitation.expires_at <= now:
        return "expired"
    return "pending"


def serialize_invitation(invitation: HouseholdInvitation) -> InvitationOut:
    return InvitationOut(
        id=invitation.id,
        email=invitation.email,
        role=invitation.role,
        status=_invitation_status(invitation),
        expires_at=invitation.expires_at,
        last_sent_at=invitation.last_sent_at,
        created_at=invitation.created_at,
    )


def list_invitations(db: Session, household_id: uuid.UUID) -> list[InvitationOut]:
    invitations = db.scalars(
        select(HouseholdInvitation)
        .where(HouseholdInvitation.household_id == household_id)
        .order_by(HouseholdInvitation.created_at.desc())
    ).all()
    return [serialize_invitation(invitation) for invitation in invitations]


def _email_already_member(db: Session, household_id: uuid.UUID, email: str) -> bool:
    return (
        db.scalar(
            select(User.id)
            .join(HouseholdMember, HouseholdMember.user_id == User.id)
            .where(
                HouseholdMember.household_id == household_id,
                func.lower(User.email) == email,
            )
        )
        is not None
    )


def _send_invitation(
    invitation: HouseholdInvitation,
    *,
    household_name: str,
    inviter_name: str,
    token: str,
) -> None:
    email_service.send_invitation(
        to=invitation.email,
        household_name=household_name,
        inviter_name=inviter_name,
        role=invitation.role,
        token=token,
        expires_at=invitation.expires_at,
    )


def create_invitation(
    db: Session,
    household_id: uuid.UUID,
    *,
    inviter: User,
    payload: InvitationCreate,
) -> InvitationOut:
    household = _lock_household(db, household_id)
    email = str(payload.email).lower()
    if _email_already_member(db, household_id, email):
        raise ApiError(
            409,
            "already_member",
            "That email already belongs to a household member.",
        )
    active = db.scalar(
        select(HouseholdInvitation).where(
            HouseholdInvitation.household_id == household_id,
            HouseholdInvitation.email == email,
            HouseholdInvitation.accepted_at.is_(None),
            HouseholdInvitation.revoked_at.is_(None),
            HouseholdInvitation.expires_at > _now(),
        )
    )
    if active is not None:
        raise ApiError(
            409,
            "invitation_exists",
            "An invitation is already pending for that email. Resend or revoke it.",
        )
    token = generate_session_token()
    settings = get_settings()
    invitation = HouseholdInvitation(
        household_id=household_id,
        email=email,
        role=payload.role,
        token_hash=hash_session_token(token),
        invited_by_user_id=inviter.id,
        expires_at=_now() + timedelta(hours=settings.invitation_ttl_hours),
        last_sent_at=_now(),
    )
    db.add(invitation)
    db.commit()
    try:
        _send_invitation(
            invitation,
            household_name=household.name,
            inviter_name=inviter.name,
            token=token,
        )
    except email_service.EmailNotConfigured:
        invitation.revoked_at = _now()
        db.commit()
        raise ApiError(
            503,
            "email_not_configured",
            "Email is not configured. Set the SMTP settings before inviting members.",
        ) from None
    except email_service.EmailError:
        invitation.revoked_at = _now()
        db.commit()
        raise ApiError(
            502,
            "email_delivery_failed",
            "The invitation could not be emailed. Check the SMTP configuration and retry.",
        ) from None
    return serialize_invitation(invitation)


def _invitation_by_token(
    db: Session, token: str, *, for_update: bool = False
) -> HouseholdInvitation:
    query = select(HouseholdInvitation).where(
        HouseholdInvitation.token_hash == hash_session_token(token)
    )
    if for_update:
        query = query.with_for_update()
    invitation = db.scalar(query)
    if invitation is None:
        raise ApiError(404, "invitation_invalid", "This invitation link is not valid.")
    return invitation


def _ensure_invitation_open(invitation: HouseholdInvitation) -> None:
    status = _invitation_status(invitation)
    if status == "accepted":
        raise ApiError(410, "invitation_used", "This invitation has already been used.")
    if status == "revoked":
        raise ApiError(410, "invitation_revoked", "This invitation was revoked.")
    if status == "expired":
        raise ApiError(410, "invitation_expired", "This invitation has expired.")


def public_invitation(
    db: Session,
    token: str,
    *,
    current_user: User | None = None,
) -> InvitationPublic:
    invitation = _invitation_by_token(db, token)
    _ensure_invitation_open(invitation)
    household = db.get(Household, invitation.household_id)
    if household is None:
        raise ApiError(404, "invitation_invalid", "This invitation link is not valid.")
    account = db.scalar(select(User).where(func.lower(User.email) == invitation.email.lower()))
    return InvitationPublic(
        household_name=household.name,
        email=invitation.email,
        role=invitation.role,
        expires_at=invitation.expires_at,
        account_exists=account is not None and account.is_active,
        authenticated_email_matches=bool(
            current_user is not None and current_user.email.lower() == invitation.email.lower()
        ),
    )


def revoke_invitation(db: Session, household_id: uuid.UUID, invitation_id: uuid.UUID) -> None:
    _lock_household(db, household_id)
    invitation = db.scalar(
        select(HouseholdInvitation)
        .where(
            HouseholdInvitation.household_id == household_id,
            HouseholdInvitation.id == invitation_id,
        )
        .with_for_update()
    )
    if invitation is None:
        raise ApiError(404, "invitation_not_found", "Invitation not found.")
    if _invitation_status(invitation) == "accepted":
        raise ApiError(409, "invitation_used", "Accepted invitations cannot be revoked.")
    invitation.revoked_at = _now()
    db.commit()


def resend_invitation(
    db: Session,
    household_id: uuid.UUID,
    invitation_id: uuid.UUID,
    *,
    inviter: User,
) -> InvitationOut:
    household = _lock_household(db, household_id)
    invitation = db.scalar(
        select(HouseholdInvitation)
        .where(
            HouseholdInvitation.household_id == household_id,
            HouseholdInvitation.id == invitation_id,
        )
        .with_for_update()
    )
    if invitation is None:
        raise ApiError(404, "invitation_not_found", "Invitation not found.")
    status = _invitation_status(invitation)
    if status in {"accepted", "revoked"}:
        raise ApiError(
            409,
            "invitation_not_resendable",
            "Accepted or revoked invitations cannot be resent.",
        )
    token = generate_session_token()
    invitation.token_hash = hash_session_token(token)
    invitation.expires_at = _now() + timedelta(hours=get_settings().invitation_ttl_hours)
    invitation.last_sent_at = _now()
    db.commit()
    try:
        _send_invitation(
            invitation,
            household_name=household.name,
            inviter_name=inviter.name,
            token=token,
        )
    except email_service.EmailNotConfigured:
        invitation.revoked_at = _now()
        db.commit()
        raise ApiError(
            503,
            "email_not_configured",
            "Email is not configured. Set the SMTP settings before inviting members.",
        ) from None
    except email_service.EmailError:
        invitation.revoked_at = _now()
        db.commit()
        raise ApiError(
            502,
            "email_delivery_failed",
            "The invitation could not be emailed. Check the SMTP configuration and retry.",
        ) from None
    return serialize_invitation(invitation)


def accept_invitation(
    db: Session,
    token: str,
    *,
    current_user: User | None,
    payload: InvitationAccept,
) -> tuple[User, Household, str]:
    invitation = _invitation_by_token(db, token, for_update=True)
    _ensure_invitation_open(invitation)
    household = _lock_household(db, invitation.household_id)
    if current_user is not None:
        if current_user.email.lower() != invitation.email.lower():
            raise ApiError(
                403,
                "invitation_email_mismatch",
                f"Sign in as {invitation.email} to accept this invitation.",
            )
        user = current_user
        if not user.is_active:
            raise ApiError(403, "account_inactive", "This account is inactive.")
    else:
        existing = db.scalar(select(User).where(func.lower(User.email) == invitation.email.lower()))
        if existing is not None:
            raise ApiError(
                401,
                "login_required",
                f"Sign in as {invitation.email} to accept this invitation.",
            )
        if not payload.name or not payload.password:
            raise ApiError(
                422,
                "account_details_required",
                "Enter your name and a password to create the account.",
            )
        user = User(
            name=payload.name,
            email=invitation.email,
            password_hash=hash_password(payload.password),
        )
        db.add(user)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise ApiError(
                409,
                "account_exists",
                "An account already exists for this email. Sign in to accept.",
            ) from None
    existing_membership = db.scalar(
        select(HouseholdMember).where(
            HouseholdMember.household_id == invitation.household_id,
            HouseholdMember.user_id == user.id,
        )
    )
    if existing_membership is not None:
        raise ApiError(
            409,
            "already_member",
            "This account already belongs to the household.",
        )
    db.add(
        HouseholdMember(
            household_id=invitation.household_id,
            user_id=user.id,
            role=invitation.role,
        )
    )
    invitation.accepted_at = _now()
    invitation.accepted_by_user_id = user.id
    db.commit()
    db.refresh(user)
    return user, household, invitation.role


def request_password_reset(
    db: Session,
    email: str,
    *,
    settings=None,
) -> None:
    settings = settings or get_settings()
    user = db.scalar(select(User).where(func.lower(User.email) == email.lower()))
    if user is None or not user.is_active:
        return
    db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id))
    token = generate_session_token()
    reset = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_session_token(token),
        expires_at=_now() + timedelta(minutes=settings.password_reset_ttl_minutes),
    )
    db.add(reset)
    db.commit()
    try:
        email_service.send_password_reset(
            to=user.email,
            name=user.name,
            token=token,
            expires_at=reset.expires_at,
            settings=settings,
        )
    except email_service.EmailError:
        db.execute(delete(PasswordResetToken).where(PasswordResetToken.id == reset.id))
        db.commit()
        logger.warning(
            "Password reset email was not delivered (%s)", type(email_service.EmailError).__name__
        )


def password_reset_status(db: Session, token: str) -> tuple[bool, datetime | None]:
    reset = db.scalar(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_session_token(token))
    )
    if reset is None or reset.used_at is not None or reset.expires_at <= _now():
        return False, reset.expires_at if reset is not None else None
    return True, reset.expires_at


def reset_password(db: Session, token: str, password: str) -> None:
    reset = db.scalar(
        select(PasswordResetToken)
        .where(PasswordResetToken.token_hash == hash_session_token(token))
        .with_for_update()
    )
    if reset is None or reset.used_at is not None or reset.expires_at <= _now():
        raise ApiError(
            400,
            "invalid_or_expired_token",
            "This password reset link is invalid or has expired.",
        )
    user = db.get(User, reset.user_id)
    if user is None or not user.is_active:
        raise ApiError(
            400,
            "invalid_or_expired_token",
            "This password reset link is invalid or has expired.",
        )
    user.password_hash = hash_password(password)
    reset.used_at = _now()
    db.execute(
        delete(PasswordResetToken).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.id != reset.id,
        )
    )
    revoke_user_sessions(db, user.id)
    db.commit()


def change_password(
    db: Session,
    user: User,
    *,
    current_password: str,
    new_password: str,
    keep_session_id: uuid.UUID,
) -> None:
    if not verify_password(current_password, user.password_hash):
        raise ApiError(400, "invalid_current_password", "The current password is incorrect.")
    user.password_hash = hash_password(new_password)
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user.id,
            AuthSession.id != keep_session_id,
        )
    )
    db.commit()
