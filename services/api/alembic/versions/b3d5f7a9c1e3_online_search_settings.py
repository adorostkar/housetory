"""household online search settings

Revision ID: b3d5f7a9c1e3
Revises: a1c3e5f7b9d2
Create Date: 2026-11-06 17:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b3d5f7a9c1e3"
down_revision: str | None = "a1c3e5f7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "household_online_search_settings",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(length=20), server_default="brave", nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("api_key_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("manual_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("reference_enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "permitted_source_domains",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
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
            "provider in ('brave')",
            name=op.f("ck_household_online_search_settings_valid_provider"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(permitted_source_domains) = 'array'",
            name=op.f("ck_household_online_search_settings_valid_permitted_domains"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_online_search_settings_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("household_id", name=op.f("pk_household_online_search_settings")),
    )


def downgrade() -> None:
    op.drop_table("household_online_search_settings")
