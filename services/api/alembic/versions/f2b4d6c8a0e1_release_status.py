"""release status task tests and worker heartbeat

Revision ID: f2b4d6c8a0e1
Revises: d6f8b0c2e4a6
Create Date: 2026-11-06 11:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f2b4d6c8a0e1"
down_revision: str | None = "d6f8b0c2e4a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_task_settings",
        sa.Column("last_test_status", sa.String(length=24), nullable=True),
    )
    op.add_column(
        "ai_task_settings",
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ai_task_settings",
        sa.Column("last_test_error", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_ai_task_settings_valid_last_test_status"),
        "ai_task_settings",
        "last_test_status is null or last_test_status in "
        "('passed', 'failed', 'unsupported')",
    )

    op.create_table(
        "worker_heartbeats",
        sa.Column("worker_id", sa.String(length=120), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("worker_id", name=op.f("pk_worker_heartbeats")),
    )


def downgrade() -> None:
    op.drop_table("worker_heartbeats")
    op.drop_constraint(
        op.f("ck_ai_task_settings_valid_last_test_status"),
        "ai_task_settings",
        type_="check",
    )
    op.drop_column("ai_task_settings", "last_test_error")
    op.drop_column("ai_task_settings", "last_test_at")
    op.drop_column("ai_task_settings", "last_test_status")
