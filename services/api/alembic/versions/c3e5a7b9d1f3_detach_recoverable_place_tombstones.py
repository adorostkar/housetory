"""detach recoverable place tombstones from deleted parents

Revision ID: c3e5a7b9d1f3
Revises: b2d4f6a8c0e2
Create Date: 2026-11-07 02:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c3e5a7b9d1f3"
down_revision: str | None = "b2d4f6a8c0e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "storage_locations",
        sa.Column("detached_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "storage_locations",
        sa.Column("detached_reason", sa.String(length=200), nullable=True),
    )
    op.alter_column(
        "storage_locations",
        "room_id",
        existing_type=sa.UUID(),
        nullable=True,
    )
    op.drop_constraint(
        "fk_storage_locations_room_id_rooms",
        "storage_locations",
        type_="foreignkey",
    )
    op.create_foreign_key(
        op.f("fk_storage_locations_room_id_rooms"),
        "storage_locations",
        "rooms",
        ["room_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    detached = op.get_bind().scalar(
        sa.text("select count(*) from storage_locations where room_id is null")
    )
    if detached:
        raise RuntimeError(
            "Cannot downgrade while detached storage-place tombstones exist. "
            "Their original room metadata is retained only in deletion snapshots."
        )
    op.drop_constraint(
        op.f("fk_storage_locations_room_id_rooms"),
        "storage_locations",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_storage_locations_room_id_rooms",
        "storage_locations",
        "rooms",
        ["room_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.alter_column(
        "storage_locations",
        "room_id",
        existing_type=sa.UUID(),
        nullable=False,
    )
    op.drop_column("storage_locations", "detached_reason")
    op.drop_column("storage_locations", "detached_at")
