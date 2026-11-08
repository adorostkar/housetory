"""on-demand item valuation previews and estimate metadata

Revision ID: c2d3e4f5a6b7
Revises: a1b2c3d4e5f7
Create Date: 2026-11-08 05:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: str | None = "a1b2c3d4e5f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "current_value_estimate_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.create_table(
        "item_valuation_previews",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("household_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("low_cents", sa.BigInteger(), nullable=False),
        sa.Column("suggested_cents", sa.BigInteger(), nullable=False),
        sa.Column("high_cents", sa.BigInteger(), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=True),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column(
            "assumptions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "web_used",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("web_reason", sa.Text(), nullable=True),
        sa.Column(
            "sources",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("item_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "low_cents >= 0 and suggested_cents >= 0 and high_cents >= 0",
            name=op.f("ck_item_valuation_previews_non_negative"),
        ),
        sa.CheckConstraint(
            "low_cents <= suggested_cents and suggested_cents <= high_cents",
            name=op.f("ck_item_valuation_previews_range_in_order"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_item_valuation_previews_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_item_valuation_previews_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_item_valuation_previews_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_item_valuation_previews")),
    )
    op.create_index(
        "ix_item_valuation_previews_household_item",
        "item_valuation_previews",
        ["household_id", "item_id"],
    )
    op.create_index(
        "ix_item_valuation_previews_expires",
        "item_valuation_previews",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_item_valuation_previews_expires",
        table_name="item_valuation_previews",
    )
    op.drop_index(
        "ix_item_valuation_previews_household_item",
        table_name="item_valuation_previews",
    )
    op.drop_table("item_valuation_previews")
    op.drop_column("items", "current_value_estimate_metadata")
