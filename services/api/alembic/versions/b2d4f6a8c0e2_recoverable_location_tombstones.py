"""recoverable storage-place tombstones

Revision ID: b2d4f6a8c0e2
Revises: a1c3e5f7b9d1
Create Date: 2026-11-07 01:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b2d4f6a8c0e2"
down_revision: str | None = "a1c3e5f7b9d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "storage_locations",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "storage_locations",
        sa.Column("deleted_by_user_id", sa.UUID(), nullable=True),
    )
    op.add_column(
        "storage_locations",
        sa.Column("deleted_by_name", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "storage_locations",
        sa.Column(
            "deletion_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column(
        "storage_locations",
        sa.Column("restored_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "storage_locations",
        sa.Column("restored_by_user_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_storage_locations_deleted_by_user_id_users"),
        "storage_locations",
        "users",
        ["deleted_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_storage_locations_restored_by_user_id_users"),
        "storage_locations",
        "users",
        ["restored_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_storage_locations_household_deleted",
        "storage_locations",
        ["household_id", "deleted_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_storage_locations_household_deleted",
        table_name="storage_locations",
    )
    op.drop_constraint(
        op.f("fk_storage_locations_restored_by_user_id_users"),
        "storage_locations",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_storage_locations_deleted_by_user_id_users"),
        "storage_locations",
        type_="foreignkey",
    )
    op.drop_column("storage_locations", "restored_by_user_id")
    op.drop_column("storage_locations", "restored_at")
    op.drop_column("storage_locations", "deletion_snapshot")
    op.drop_column("storage_locations", "deleted_by_name")
    op.drop_column("storage_locations", "deleted_by_user_id")
    op.drop_column("storage_locations", "deleted_at")
