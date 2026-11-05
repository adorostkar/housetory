"""explicit purchase information status

Revision ID: e2f4a6c8b0d2
Revises: a7c9e1f3b5d4
Create Date: 2026-11-06 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e2f4a6c8b0d2"
down_revision: str | None = "a7c9e1f3b5d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("purchase_info_status", sa.String(length=20), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_items_valid_purchase_info_status"),
        "items",
        "purchase_info_status IS NULL OR purchase_info_status IN ('unknown', 'not_applicable')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_items_valid_purchase_info_status"), "items", type_="check")
    op.drop_column("items", "purchase_info_status")
