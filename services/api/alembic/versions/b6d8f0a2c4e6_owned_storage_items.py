"""owned items that provide storage and contents loans

Revision ID: b6d8f0a2c4e6
Revises: e7b9d1f3a5c7
Create Date: 2026-11-07 20:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b6d8f0a2c4e6"
down_revision: str | None = "e7b9d1f3a5c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "storage_locations",
        sa.Column("owner_item_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_storage_locations_owner_item_id_items"),
        "storage_locations",
        "items",
        ["owner_item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("uq_storage_locations_owner_item_id"),
        "storage_locations",
        ["owner_item_id"],
        unique=True,
    )
    op.add_column(
        "loans",
        sa.Column("parent_loan_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "loans",
        sa.Column(
            "includes_contents",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_foreign_key(
        op.f("fk_loans_parent_loan_id_loans"),
        "loans",
        "loans",
        ["parent_loan_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_loans_parent_loan_id"),
        "loans",
        ["parent_loan_id"],
    )
    op.create_check_constraint(
        op.f("ck_loans_not_own_parent"),
        "loans",
        "parent_loan_id IS NULL OR parent_loan_id <> id",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_loans_not_own_parent"), "loans", type_="check")
    op.drop_index(op.f("ix_loans_parent_loan_id"), table_name="loans")
    op.drop_constraint(op.f("fk_loans_parent_loan_id_loans"), "loans", type_="foreignkey")
    op.drop_column("loans", "includes_contents")
    op.drop_column("loans", "parent_loan_id")
    op.drop_index(op.f("uq_storage_locations_owner_item_id"), table_name="storage_locations")
    op.drop_constraint(
        op.f("fk_storage_locations_owner_item_id_items"),
        "storage_locations",
        type_="foreignkey",
    )
    op.drop_column("storage_locations", "owner_item_id")
