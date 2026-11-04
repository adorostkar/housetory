"""accounts, membership roles and email tokens

Revision ID: f3c1a9b7d245
Revises: c1a7e5d9f320
Create Date: 2026-11-04 21:40:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3c1a9b7d245"
down_revision: str | None = "c1a7e5d9f320"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_household_members_valid_role"),
        "household_members",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_household_members_valid_role"),
        "household_members",
        "role in ('owner', 'member', 'viewer')",
    )

    op.add_column("auth_sessions", sa.Column("household_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_auth_sessions_household_id_households"),
        "auth_sessions",
        "households",
        ["household_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_auth_sessions_household_id",
        "auth_sessions",
        ["household_id"],
        unique=False,
    )
    # Existing sessions keep working by selecting the account's earliest
    # membership. New sessions store their selected household explicitly.
    op.execute(
        sa.text(
            """
            UPDATE auth_sessions AS sessions
            SET household_id = memberships.household_id
            FROM (
                SELECT DISTINCT ON (user_id) user_id, household_id
                FROM household_members
                ORDER BY user_id, created_at, household_id
            ) AS memberships
            WHERE sessions.user_id = memberships.user_id
            """
        )
    )

    op.create_table(
        "household_invitations",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", sa.String(length=16), server_default="member", nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("invited_by_user_id", sa.UUID(), nullable=True),
        sa.Column("accepted_by_user_id", sa.UUID(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role in ('owner', 'member', 'viewer')",
            name=op.f("ck_household_invitations_valid_role"),
        ),
        sa.ForeignKeyConstraint(
            ["accepted_by_user_id"],
            ["users.id"],
            name=op.f("fk_household_invitations_accepted_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_invitations_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["invited_by_user_id"],
            ["users.id"],
            name=op.f("fk_household_invitations_invited_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_household_invitations")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_household_invitations_token_hash")),
    )
    op.create_index(
        "ix_household_invitations_expires_at",
        "household_invitations",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_household_invitations_household_email",
        "household_invitations",
        ["household_id", "email"],
        unique=False,
    )

    op.create_table(
        "password_reset_tokens",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_password_reset_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_password_reset_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_password_reset_tokens_token_hash")),
    )
    op.create_index(
        "ix_password_reset_tokens_expires_at",
        "password_reset_tokens",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_password_reset_tokens_user_id",
        "password_reset_tokens",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_password_reset_tokens_user_id", table_name="password_reset_tokens")
    op.drop_index("ix_password_reset_tokens_expires_at", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
    op.drop_index(
        "ix_household_invitations_household_email",
        table_name="household_invitations",
    )
    op.drop_index(
        "ix_household_invitations_expires_at",
        table_name="household_invitations",
    )
    op.drop_table("household_invitations")
    op.drop_index("ix_auth_sessions_household_id", table_name="auth_sessions")
    op.drop_constraint(
        op.f("fk_auth_sessions_household_id_households"),
        "auth_sessions",
        type_="foreignkey",
    )
    op.drop_column("auth_sessions", "household_id")
    op.drop_constraint(
        op.f("ck_household_members_valid_role"),
        "household_members",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_household_members_valid_role"),
        "household_members",
        "role in ('owner', 'member')",
    )
