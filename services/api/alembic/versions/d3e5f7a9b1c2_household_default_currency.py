"""household default currency

Revision ID: d3e5f7a9b1c2
Revises: c2d3e4f5a6b7
Create Date: 2026-11-09 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d3e5f7a9b1c2"
down_revision: str | None = "c2d3e4f5a6b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "households",
        sa.Column(
            "default_currency",
            sa.String(length=3),
            nullable=False,
            server_default="USD",
        ),
    )
    op.create_check_constraint(
        op.f("ck_households_default_currency_format"),
        "households",
        "default_currency ~ '^[A-Z]{3}$'",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_households_default_currency_format"),
        "households",
        type_="check",
    )
    op.drop_column("households", "default_currency")
