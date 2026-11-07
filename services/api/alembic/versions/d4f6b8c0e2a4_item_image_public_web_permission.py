"""allow public-web item image provenance

Revision ID: d4f6b8c0e2a4
Revises: c3e5a7b9d1f3
Create Date: 2026-11-07 03:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4f6b8c0e2a4"
down_revision: str | None = "c3e5a7b9d1f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        "permission_basis IS NULL OR permission_basis in "
        "('public_web', 'configured_source_policy', 'provider_license')",
    )


def downgrade() -> None:
    public_web = op.get_bind().scalar(
        sa.text("select count(*) from item_images where permission_basis = 'public_web'")
    )
    if public_web:
        raise RuntimeError(
            "Cannot downgrade while public-web reference-image provenance rows exist."
        )
    op.drop_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_item_images_valid_permission_basis"),
        "item_images",
        "permission_basis IS NULL OR permission_basis in "
        "('configured_source_policy', 'provider_license')",
    )
