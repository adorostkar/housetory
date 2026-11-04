"""physical containers and printable identifiers

Revision ID: 4d8e1a6c2b90
Revises: 9b4f2c7a1e3d
Create Date: 2026-11-04 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4d8e1a6c2b90"
down_revision: str | None = "9b4f2c7a1e3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


CONTAINER_COLUMNS = (
    ("is_container", sa.Boolean(), sa.text("false")),
    ("container_type", sa.String(length=20), None),
    ("identifier", sa.String(length=32), None),
    ("summary_short", sa.Text(), None),
    ("summary_detailed", sa.Text(), None),
    ("summary_headline", sa.Text(), None),
    ("summary_source", sa.String(length=20), None),
    ("summary_generated_at", sa.DateTime(timezone=True), None),
    ("summary_contents_hash", sa.String(length=64), None),
    ("label_generated_at", sa.DateTime(timezone=True), None),
)


def upgrade() -> None:
    for name, column_type, server_default in CONTAINER_COLUMNS:
        op.add_column(
            "storage_locations",
            sa.Column(name, column_type, server_default=server_default, nullable=True),
        )
    op.alter_column("storage_locations", "is_container", nullable=False)

    op.create_check_constraint(
        "valid_container_type",
        "storage_locations",
        "container_type is null or container_type in "
        "('box', 'bin', 'crate', 'suitcase', 'bag', 'other')",
    )
    op.create_check_constraint(
        "identifier_format",
        "storage_locations",
        "identifier is null or identifier ~ '^[A-Z]{2,12}-[0-9]{3,6}$'",
    )
    op.create_check_constraint(
        "container_type_required",
        "storage_locations",
        "is_container = false or container_type is not null",
    )
    op.create_unique_constraint(
        "uq_storage_locations_household_identifier",
        "storage_locations",
        ["household_id", "identifier"],
    )
    op.create_index(
        "ix_storage_locations_household_container",
        "storage_locations",
        ["household_id", "is_container"],
        unique=False,
    )

    op.drop_constraint("valid_kind", "storage_locations", type_="check")
    op.create_check_constraint(
        "valid_kind",
        "storage_locations",
        "kind in ('room', 'closet', 'cabinet', 'shelf', 'drawer', 'box', 'bin', "
        "'crate', 'suitcase', 'bag', 'other')",
    )

    op.create_table(
        "location_identifier_counters",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("last_value", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint("last_value >= 0", name="ck_location_identifier_counters_last_value"),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_location_identifier_counters_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "household_id", "prefix", name=op.f("pk_location_identifier_counters")
        ),
    )


def downgrade() -> None:
    op.drop_table("location_identifier_counters")
    op.drop_index(
        "ix_storage_locations_household_container", table_name="storage_locations"
    )
    op.drop_constraint(
        "uq_storage_locations_household_identifier",
        "storage_locations",
        type_="unique",
    )
    op.drop_constraint("container_type_required", "storage_locations", type_="check")
    op.drop_constraint("identifier_format", "storage_locations", type_="check")
    op.drop_constraint("valid_container_type", "storage_locations", type_="check")
    op.drop_constraint("valid_kind", "storage_locations", type_="check")
    op.create_check_constraint(
        "valid_kind",
        "storage_locations",
        "kind in ('room', 'closet', 'cabinet', 'shelf', 'drawer', 'box', 'bin', 'other')",
    )
    for name, _, _ in reversed(CONTAINER_COLUMNS):
        op.drop_column("storage_locations", name)
