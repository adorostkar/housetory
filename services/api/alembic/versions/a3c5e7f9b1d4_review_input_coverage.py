"""Remember successful review inputs without replacing review history."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "a3c5e7f9b1d4"
down_revision = "f2a4c6e8b0d2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "inventory_review_runs",
        sa.Column("ai_reused_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "inventory_review_coverage",
        sa.Column(
            "household_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("households.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("items.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("capability", sa.String(40), primary_key=True),
        sa.Column("input_fingerprint", sa.String(64), nullable=False),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_review_runs.id", ondelete="SET NULL"),
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("inventory_review_coverage")
    op.drop_column("inventory_review_runs", "ai_reused_count")
