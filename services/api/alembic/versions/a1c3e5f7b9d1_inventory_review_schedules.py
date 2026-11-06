"""optional scheduled inventory review

Revision ID: a1c3e5f7b9d1
Revises: d5f7b9c1e3a5
Create Date: 2026-11-06 23:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1c3e5f7b9d1"
down_revision: str | None = "d5f7b9c1e3a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "inventory_review_schedules",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("scope_type", sa.String(length=20), server_default="household", nullable=False),
        sa.Column("scope_id", sa.UUID(), nullable=True),
        sa.Column(
            "scope_label",
            sa.String(length=200),
            server_default="Whole household",
            nullable=False,
        ),
        sa.Column("frequency", sa.String(length=10), server_default="weekly", nullable=False),
        sa.Column("timezone", sa.String(length=64), server_default="UTC", nullable=False),
        sa.Column("weekday", sa.Integer(), server_default="0", nullable=False),
        sa.Column("monthly_day", sa.Integer(), server_default="1", nullable=False),
        sa.Column("local_hour", sa.Integer(), server_default="9", nullable=False),
        sa.Column("max_items", sa.Integer(), server_default="200", nullable=False),
        sa.Column("max_runs_per_day", sa.Integer(), server_default="1", nullable=False),
        sa.Column("include_ai", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("ai_consent", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("ai_consent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ai_consent_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("ai_consent_provider_id", sa.UUID(), nullable=True),
        sa.Column("ai_consent_provider_label", sa.String(length=160), nullable=True),
        sa.Column("ai_consent_model", sa.String(length=160), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_status", sa.String(length=20), server_default="never", nullable=False),
        sa.Column("last_run_detail", sa.Text(), nullable=True),
        sa.Column("last_run_id", sa.UUID(), nullable=True),
        sa.Column("last_run_job_id", sa.UUID(), nullable=True),
        sa.Column("last_dispatch_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("scan_cursor", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("updated_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "scope_type in ('household', 'property', 'room', 'container')",
            name=op.f("ck_inventory_review_schedules_valid_scope_type"),
        ),
        sa.CheckConstraint(
            "(scope_type = 'household' and scope_id is null) or "
            "(scope_type in ('property', 'room', 'container') and scope_id is not null)",
            name=op.f("ck_inventory_review_schedules_scope_shape"),
        ),
        sa.CheckConstraint(
            "frequency in ('weekly', 'monthly')",
            name=op.f("ck_inventory_review_schedules_valid_frequency"),
        ),
        sa.CheckConstraint(
            "weekday between 0 and 6",
            name=op.f("ck_inventory_review_schedules_valid_weekday"),
        ),
        sa.CheckConstraint(
            "monthly_day between 1 and 28",
            name=op.f("ck_inventory_review_schedules_valid_monthly_day"),
        ),
        sa.CheckConstraint(
            "local_hour between 0 and 23",
            name=op.f("ck_inventory_review_schedules_valid_local_hour"),
        ),
        sa.CheckConstraint(
            "max_items between 1 and 500",
            name=op.f("ck_inventory_review_schedules_valid_max_items"),
        ),
        sa.CheckConstraint(
            "max_runs_per_day between 1 and 4",
            name=op.f("ck_inventory_review_schedules_valid_max_runs_per_day"),
        ),
        sa.CheckConstraint(
            "last_run_status in ('never', 'queued', 'running', 'completed', "
            "'partial', 'failed', 'skipped', 'disabled')",
            name=op.f("ck_inventory_review_schedules_valid_last_run_status"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_inventory_review_schedules_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["ai_consent_provider_id"],
            ["ai_providers.id"],
            name=op.f("fk_inventory_review_schedules_ai_consent_provider_id_ai_providers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["last_run_id"],
            ["inventory_review_runs.id"],
            name=op.f("fk_inventory_review_schedules_last_run_id_inventory_review_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["last_run_job_id"],
            ["jobs.id"],
            name=op.f("fk_inventory_review_schedules_last_run_job_id_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_review_schedules_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_review_schedules_updated_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_review_schedules")),
        sa.UniqueConstraint("household_id", name="uq_inventory_review_schedules_household"),
    )
    op.create_index(
        "ix_inventory_review_schedules_due",
        "inventory_review_schedules",
        ["enabled", "next_due_at"],
        unique=False,
    )

    op.add_column(
        "inventory_review_runs",
        sa.Column(
            "trigger_type",
            sa.String(length=20),
            server_default="manual",
            nullable=False,
        ),
    )
    op.add_column("inventory_review_runs", sa.Column("schedule_id", sa.UUID(), nullable=True))
    op.create_check_constraint(
        op.f("ck_inventory_review_runs_valid_trigger_type"),
        "inventory_review_runs",
        "trigger_type in ('manual', 'scheduled')",
    )
    op.create_foreign_key(
        op.f("fk_inventory_review_runs_schedule_id_inventory_review_schedules"),
        "inventory_review_runs",
        "inventory_review_schedules",
        ["schedule_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_inventory_review_runs_schedule_id_inventory_review_schedules"),
        "inventory_review_runs",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("ck_inventory_review_runs_valid_trigger_type"),
        "inventory_review_runs",
        type_="check",
    )
    op.drop_column("inventory_review_runs", "schedule_id")
    op.drop_column("inventory_review_runs", "trigger_type")
    op.drop_index(
        "ix_inventory_review_schedules_due",
        table_name="inventory_review_schedules",
    )
    op.drop_table("inventory_review_schedules")
