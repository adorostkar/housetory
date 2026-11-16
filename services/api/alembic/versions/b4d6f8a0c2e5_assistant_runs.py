"""Durable bounded assistant work over shared application tools."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "b4d6f8a0c2e5"
down_revision = "a3c5e7f9b1d4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "assistant_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "actor_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "household_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("households.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("property_id", postgresql.UUID(as_uuid=True)),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assistant_runs.id", ondelete="SET NULL"),
        ),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("job_id", postgresql.UUID(as_uuid=True)),
        sa.Column("data", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("actor_user_id", "request_id"),
    )


def downgrade():
    op.drop_table("assistant_runs")
