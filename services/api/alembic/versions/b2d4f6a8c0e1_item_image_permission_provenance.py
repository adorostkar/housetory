"""item image permission and license provenance

Revision ID: b2d4f6a8c0e1
Revises: a8c0e2f4b6d8
Create Date: 2026-11-06 05:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b2d4f6a8c0e1"
down_revision: str | None = "a8c0e2f4b6d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "item_images",
        sa.Column("license_name", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "item_images",
        sa.Column("license_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "item_images",
        sa.Column("permission_basis", sa.String(length=40), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        "permission_basis IS NULL OR permission_basis in "
        "('configured_source_policy', 'provider_license')",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        type_="check",
    )
    op.drop_column("item_images", "permission_basis")
    op.drop_column("item_images", "license_url")
    op.drop_column("item_images", "license_name")
