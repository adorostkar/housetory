"""Persist resumable review coverage.

Revision ID: f2a4c6e8b0d2
Revises: f7a9c1e3b5d7
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "f2a4c6e8b0d2"
down_revision = "f7a9c1e3b5d7"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "inventory_review_runs",
        sa.Column("progress_json", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    for name in ("ai_eligible_count", "ai_reviewed_count"):
        op.add_column(
            "inventory_review_runs",
            sa.Column(name, sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade():
    for name in ("ai_reviewed_count", "ai_eligible_count", "progress_json"):
        op.drop_column("inventory_review_runs", name)
