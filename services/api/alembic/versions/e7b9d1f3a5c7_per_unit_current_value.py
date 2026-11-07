"""track per-unit current value basis

Revision ID: e7b9d1f3a5c7
Revises: d4f6b8c0e2a4
Create Date: 2026-11-07 08:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e7b9d1f3a5c7"
down_revision: str | None = "d4f6b8c0e2a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("current_value_basis", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "items",
        sa.Column("current_value_estimated_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing values were entered as one amount for the item record. Mark them
    # explicitly so they are never silently multiplied by quantity. New and
    # reviewed converted values use the per_unit basis.
    op.execute(
        "UPDATE items SET current_value_basis = 'legacy_record_total' "
        "WHERE current_value_cents IS NOT NULL"
    )
    op.create_check_constraint(
        op.f("ck_items_valid_current_value_basis"),
        "items",
        "current_value_basis IS NULL OR current_value_basis IN ('per_unit', 'legacy_record_total')",
    )
    op.create_check_constraint(
        op.f("ck_items_current_value_basis_present"),
        "items",
        "(current_value_cents IS NULL AND current_value_basis IS NULL) OR "
        "(current_value_cents IS NOT NULL AND current_value_basis IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_items_current_value_basis_present"),
        "items",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_items_valid_current_value_basis"),
        "items",
        type_="check",
    )
    op.drop_column("items", "current_value_estimated_at")
    op.drop_column("items", "current_value_basis")
