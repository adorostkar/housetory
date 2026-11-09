"""expanded AI organisation review

Revision ID: f5a7c9e1b3d5
Revises: e4f6a8b0c2d4
Create Date: 2026-11-09 18:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f5a7c9e1b3d5"
down_revision: str | None = "e4f6a8b0c2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "inventory_review_runs",
        sa.Column("ai_item_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.drop_constraint(
        op.f("ck_inventory_review_suggestions_valid_type"),
        "inventory_review_suggestions",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_inventory_review_suggestions_valid_type"),
        "inventory_review_suggestions",
        "type in ('category', 'name', 'organisation', 'possible_duplicate', "
        "'missing_detail', 'location_conflict')",
    )
    op.drop_constraint(
        op.f("ck_inventory_review_suggestions_valid_action_kind"),
        "inventory_review_suggestions",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_inventory_review_suggestions_valid_action_kind"),
        "inventory_review_suggestions",
        "action_kind in ('apply_category', 'apply_name', 'apply_organisation', 'advisory')",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_inventory_review_suggestions_valid_action_kind"),
        "inventory_review_suggestions",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_inventory_review_suggestions_valid_action_kind"),
        "inventory_review_suggestions",
        "action_kind in ('apply_category', 'apply_name', 'advisory')",
    )
    op.drop_constraint(
        op.f("ck_inventory_review_suggestions_valid_type"),
        "inventory_review_suggestions",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_inventory_review_suggestions_valid_type"),
        "inventory_review_suggestions",
        "type in ('category', 'name', 'possible_duplicate', 'missing_detail', 'location_conflict')",
    )
    op.drop_column("inventory_review_runs", "ai_item_count")
