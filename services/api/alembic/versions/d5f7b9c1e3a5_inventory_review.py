"""inventory review runs and suggestions

Revision ID: d5f7b9c1e3a5
Revises: b3d5f7a9c1e3
Create Date: 2026-11-06 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d5f7b9c1e3a5"
down_revision: str | None = "b3d5f7a9c1e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "inventory_review_runs",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("scope_type", sa.String(length=20), nullable=False),
        sa.Column("scope_id", sa.UUID(), nullable=True),
        sa.Column("scope_label", sa.String(length=200), nullable=False),
        sa.Column("include_ai", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("status", sa.String(length=20), server_default="completed", nullable=False),
        sa.Column("total_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("item_count_scanned", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_suggestion_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("existing_suggestion_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("stale_suggestion_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("suppressed_suggestion_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("ai_used", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("ai_provider_label", sa.String(length=160), nullable=True),
        sa.Column("ai_model", sa.String(length=160), nullable=True),
        sa.Column("ai_error", sa.Text(), nullable=True),
        sa.Column("partial_reason", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
            "scope_type in ('items', 'room', 'container', 'property', 'household')",
            name=op.f("ck_inventory_review_runs_valid_scope_type"),
        ),
        sa.CheckConstraint(
            "status in ('completed', 'partial', 'failed')",
            name=op.f("ck_inventory_review_runs_valid_status"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_review_runs_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_inventory_review_runs_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_review_runs")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name="uq_inventory_review_runs_household_request",
        ),
    )
    op.create_index(
        "ix_inventory_review_runs_household_created",
        "inventory_review_runs",
        ["household_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "inventory_review_suggestions",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.UUID(), nullable=True),
        sa.Column("type", sa.String(length=30), nullable=False),
        sa.Column("action_kind", sa.String(length=30), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("source", sa.String(length=20), server_default="rules", nullable=False),
        sa.Column("priority", sa.Integer(), server_default="0", nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("scope_type", sa.String(length=20), nullable=False),
        sa.Column("scope_id", sa.UUID(), nullable=True),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("secondary_item_id", sa.UUID(), nullable=True),
        sa.Column("category_id", sa.UUID(), nullable=True),
        sa.Column(
            "before_json",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "after_json",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "evidence_json",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_item_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_history_event_id", sa.UUID(), nullable=True),
        sa.Column("applied_by_user_id", sa.UUID(), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_by_user_id", sa.UUID(), nullable=True),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revert_history_event_id", sa.UUID(), nullable=True),
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
            "action_kind in ('apply_category', 'apply_name', 'advisory')",
            name=op.f("ck_inventory_review_suggestions_valid_action_kind"),
        ),
        sa.CheckConstraint(
            "scope_type in ('items', 'room', 'container', 'property', 'household')",
            name=op.f("ck_inventory_review_suggestions_valid_scope_type"),
        ),
        sa.CheckConstraint(
            "status in ('pending', 'accepted', 'dismissed', 'stale', 'reverted')",
            name=op.f("ck_inventory_review_suggestions_valid_status"),
        ),
        sa.CheckConstraint(
            "type in ('category', 'name', 'possible_duplicate', 'missing_detail', "
            "'location_conflict')",
            name=op.f("ck_inventory_review_suggestions_valid_type"),
        ),
        sa.ForeignKeyConstraint(
            ["applied_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_review_suggestions_applied_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["applied_history_event_id"],
            ["activity_events.id"],
            name=op.f("fk_inventory_review_suggestions_applied_history_event_id_activity_events"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_inventory_review_suggestions_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["dismissed_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_review_suggestions_dismissed_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_inventory_review_suggestions_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_inventory_review_suggestions_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["revert_history_event_id"],
            ["activity_events.id"],
            name=op.f("fk_inventory_review_suggestions_revert_history_event_id_activity_events"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["inventory_review_runs.id"],
            name=op.f("fk_inventory_review_suggestions_run_id_inventory_review_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["secondary_item_id"],
            ["items.id"],
            name=op.f("fk_inventory_review_suggestions_secondary_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_review_suggestions")),
    )
    op.create_index(
        "ix_inventory_review_suggestions_fingerprint",
        "inventory_review_suggestions",
        ["household_id", "fingerprint"],
        unique=False,
    )
    op.create_index(
        "ix_inventory_review_suggestions_household_status",
        "inventory_review_suggestions",
        ["household_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_inventory_review_suggestions_household_type",
        "inventory_review_suggestions",
        ["household_id", "type"],
        unique=False,
    )
    op.create_index(
        "ix_inventory_review_suggestions_item",
        "inventory_review_suggestions",
        ["item_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_table("inventory_review_suggestions")
    op.drop_table("inventory_review_runs")
