"""stocktake observations and last verified state

Revision ID: e9f3a5b7c1d2
Revises: b8d1e3f5a7c9
Create Date: 2026-11-05 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e9f3a5b7c1d2"
down_revision: str | None = "b8d1e3f5a7c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
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
    ]


def upgrade() -> None:
    op.create_table(
        "stocktake_sessions",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("completed_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_by_name_snapshot",
            sa.String(length=120),
            server_default="Housetory",
            nullable=False,
        ),
        sa.Column("completed_by_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("close_request_id", sa.UUID(), nullable=True),
        sa.Column(
            "status", sa.String(length=16), server_default="in_progress", nullable=False
        ),
        sa.Column(
            "scope",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("scope_label", sa.String(length=300), server_default="", nullable=False),
        sa.Column(
            "snapshot_fingerprint", sa.String(length=64), server_default="", nullable=False
        ),
        sa.Column("expected_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("expected_unit_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "expected_at_home_unit_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "expected_on_loan_unit_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("checked_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("checked_unit_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("verified_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("missing_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "quantity_discrepancy_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("unknown_item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("unexpected_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "coverage",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("abandoned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_refreshed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "status in ('in_progress', 'completed', 'abandoned')",
            name=op.f("ck_stocktake_sessions_valid_status"),
        ),
        sa.CheckConstraint(
            "expected_item_count >= 0",
            name=op.f("ck_stocktake_sessions_item_count_non_negative"),
        ),
        sa.CheckConstraint(
            "expected_unit_count >= 0",
            name=op.f("ck_stocktake_sessions_unit_count_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["completed_by_user_id"],
            ["users.id"],
            name=op.f("fk_stocktake_sessions_completed_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_stocktake_sessions_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_sessions_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_sessions")),
        sa.UniqueConstraint(
            "household_id", "request_id", name="uq_stocktake_sessions_request"
        ),
        sa.UniqueConstraint(
            "household_id", "close_request_id", name="uq_stocktake_sessions_close_request"
        ),
    )
    op.create_index(
        "ix_stocktake_sessions_household_status",
        "stocktake_sessions",
        ["household_id", "status", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_sessions_household_created",
        "stocktake_sessions",
        ["household_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "stocktake_snapshot_items",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.Column("item_name", sa.String(length=200), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("at_home_quantity", sa.Integer(), nullable=False),
        sa.Column("on_loan_quantity", sa.Integer(), nullable=False),
        sa.Column("room_id", sa.UUID(), nullable=True),
        sa.Column("room_name", sa.String(length=120), nullable=True),
        sa.Column("location_id", sa.UUID(), nullable=True),
        sa.Column("location_name", sa.String(length=120), nullable=True),
        sa.Column("location_identifier", sa.String(length=32), nullable=True),
        sa.Column("location_path", sa.String(length=600), server_default="", nullable=False),
        sa.Column("item_updated_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "quantity >= 0", name=op.f("ck_stocktake_snapshot_items_quantity_non_negative")
        ),
        sa.CheckConstraint(
            "at_home_quantity >= 0",
            name=op.f("ck_stocktake_snapshot_items_at_home_non_negative"),
        ),
        sa.CheckConstraint(
            "on_loan_quantity >= 0",
            name=op.f("ck_stocktake_snapshot_items_on_loan_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_snapshot_items_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_stocktake_snapshot_items_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["storage_locations.id"],
            name=op.f("fk_stocktake_snapshot_items_location_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name=op.f("fk_stocktake_snapshot_items_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["stocktake_sessions.id"],
            name=op.f("fk_stocktake_snapshot_items_session_id_stocktake_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_snapshot_items")),
        sa.UniqueConstraint(
            "session_id", "item_id", name="uq_stocktake_snapshot_session_item"
        ),
    )
    op.create_index(
        "ix_stocktake_snapshot_session_position",
        "stocktake_snapshot_items",
        ["session_id", "position"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_snapshot_household_item",
        "stocktake_snapshot_items",
        ["household_id", "item_id"],
        unique=False,
    )

    op.create_table(
        "stocktake_observations",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("snapshot_item_id", sa.UUID(), nullable=True),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("counted_quantity", sa.Integer(), nullable=True),
        sa.Column("observed_room_id", sa.UUID(), nullable=True),
        sa.Column("observed_location_id", sa.UUID(), nullable=True),
        sa.Column("observed_room_name", sa.String(length=120), nullable=True),
        sa.Column("observed_location_name", sa.String(length=120), nullable=True),
        sa.Column("observed_location_identifier", sa.String(length=32), nullable=True),
        sa.Column("observed_location_path", sa.String(length=600), nullable=True),
        sa.Column("unexpected_name", sa.String(length=200), nullable=True),
        sa.Column("linked_item_id", sa.UUID(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("owned_quantity_at_observation", sa.Integer(), nullable=True),
        sa.Column(
            "on_loan_quantity_at_observation",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "at_home_quantity_at_observation",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "item_updated_at_at_observation", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "verifier_name_snapshot",
            sa.String(length=120),
            server_default="Housetory",
            nullable=False,
        ),
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "status in ('present', 'missing', 'moved', 'quantity_discrepancy', "
            "'unknown', 'unexpected')",
            name=op.f("ck_stocktake_observations_valid_status"),
        ),
        sa.CheckConstraint(
            "counted_quantity is null or counted_quantity >= 0",
            name=op.f("ck_stocktake_observations_counted_non_negative"),
        ),
        sa.CheckConstraint(
            "status = 'unexpected' or snapshot_item_id is not null",
            name=op.f("ck_stocktake_observations_snapshot_required_for_item_observation"),
        ),
        sa.CheckConstraint(
            "status <> 'unexpected' or (snapshot_item_id is null and unexpected_name is not null)",
            name=op.f("ck_stocktake_observations_unexpected_shape"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_stocktake_observations_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_observations_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_stocktake_observations_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["linked_item_id"],
            ["items.id"],
            name=op.f("fk_stocktake_observations_linked_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["observed_location_id"],
            ["storage_locations.id"],
            name=op.f("fk_stocktake_observations_observed_location_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["observed_room_id"],
            ["rooms.id"],
            name=op.f("fk_stocktake_observations_observed_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["stocktake_sessions.id"],
            name=op.f("fk_stocktake_observations_session_id_stocktake_sessions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["snapshot_item_id"],
            ["stocktake_snapshot_items.id"],
            name=op.f("fk_stocktake_observations_snapshot_item_id_stocktake_snapshot_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_observations")),
        sa.UniqueConstraint(
            "household_id", "request_id", name="uq_stocktake_observations_request"
        ),
    )
    op.create_index(
        "ix_stocktake_observations_session_created",
        "stocktake_observations",
        ["session_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_observations_snapshot_created",
        "stocktake_observations",
        ["snapshot_item_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_observations_household_item",
        "stocktake_observations",
        ["household_id", "item_id"],
        unique=False,
    )

    op.create_table(
        "stocktake_applications",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("review_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("applied_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "applied_count >= 0",
            name=op.f("ck_stocktake_applications_applied_count_non_negative"),
        ),
        sa.CheckConstraint(
            "skipped_count >= 0",
            name=op.f("ck_stocktake_applications_skipped_count_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_stocktake_applications_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_applications_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["stocktake_sessions.id"],
            name=op.f("fk_stocktake_applications_session_id_stocktake_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_applications")),
        sa.UniqueConstraint(
            "household_id", "request_id", name="uq_stocktake_applications_request"
        ),
    )
    op.create_index(
        "ix_stocktake_applications_session",
        "stocktake_applications",
        ["session_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "stocktake_corrections",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("application_id", sa.UUID(), nullable=False),
        sa.Column("observation_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column(
            "previous",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "applied",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("activity_event_id", sa.UUID(), nullable=True),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["activity_event_id"],
            ["activity_events.id"],
            name=op.f("fk_stocktake_corrections_activity_event_id_activity_events"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["application_id"],
            ["stocktake_applications.id"],
            name=op.f("fk_stocktake_corrections_application_id_stocktake_applications"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_corrections_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_stocktake_corrections_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["observation_id"],
            ["stocktake_observations.id"],
            name=op.f("fk_stocktake_corrections_observation_id_stocktake_observations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["stocktake_sessions.id"],
            name=op.f("fk_stocktake_corrections_session_id_stocktake_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_corrections")),
        sa.UniqueConstraint(
            "observation_id", name="uq_stocktake_corrections_observation"
        ),
    )
    op.create_index(
        "ix_stocktake_corrections_session",
        "stocktake_corrections",
        ["session_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_corrections_household_item",
        "stocktake_corrections",
        ["household_id", "item_id"],
        unique=False,
    )

    op.create_table(
        "stocktake_item_states",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=True),
        sa.Column("observation_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("counted_quantity", sa.Integer(), nullable=False),
        sa.Column("owned_quantity", sa.Integer(), nullable=False),
        sa.Column("on_loan_quantity", sa.Integer(), nullable=False),
        sa.Column("room_id", sa.UUID(), nullable=True),
        sa.Column("location_id", sa.UUID(), nullable=True),
        sa.Column("location_path", sa.String(length=600), server_default="", nullable=False),
        sa.Column("item_updated_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "counted_quantity >= 0",
            name=op.f("ck_stocktake_item_states_counted_non_negative"),
        ),
        sa.CheckConstraint(
            "owned_quantity >= 0",
            name=op.f("ck_stocktake_item_states_owned_non_negative"),
        ),
        sa.CheckConstraint(
            "on_loan_quantity >= 0",
            name=op.f("ck_stocktake_item_states_on_loan_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_stocktake_item_states_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_stocktake_item_states_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["storage_locations.id"],
            name=op.f("fk_stocktake_item_states_location_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["observation_id"],
            ["stocktake_observations.id"],
            name=op.f("fk_stocktake_item_states_observation_id_stocktake_observations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name=op.f("fk_stocktake_item_states_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["stocktake_sessions.id"],
            name=op.f("fk_stocktake_item_states_session_id_stocktake_sessions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stocktake_item_states")),
        sa.UniqueConstraint("item_id", name="uq_stocktake_item_states_item"),
    )
    op.create_index(
        "ix_stocktake_item_states_household_verified",
        "stocktake_item_states",
        ["household_id", "verified_at"],
        unique=False,
    )
    op.create_index(
        "ix_stocktake_item_states_session",
        "stocktake_item_states",
        ["session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_stocktake_item_states_session", table_name="stocktake_item_states")
    op.drop_index(
        "ix_stocktake_item_states_household_verified",
        table_name="stocktake_item_states",
    )
    op.drop_table("stocktake_item_states")

    op.drop_index(
        "ix_stocktake_corrections_household_item", table_name="stocktake_corrections"
    )
    op.drop_index("ix_stocktake_corrections_session", table_name="stocktake_corrections")
    op.drop_table("stocktake_corrections")

    op.drop_index(
        "ix_stocktake_applications_session", table_name="stocktake_applications"
    )
    op.drop_table("stocktake_applications")

    op.drop_index(
        "ix_stocktake_observations_household_item",
        table_name="stocktake_observations",
    )
    op.drop_index(
        "ix_stocktake_observations_snapshot_created",
        table_name="stocktake_observations",
    )
    op.drop_index(
        "ix_stocktake_observations_session_created",
        table_name="stocktake_observations",
    )
    op.drop_table("stocktake_observations")

    op.drop_index(
        "ix_stocktake_snapshot_household_item", table_name="stocktake_snapshot_items"
    )
    op.drop_index(
        "ix_stocktake_snapshot_session_position", table_name="stocktake_snapshot_items"
    )
    op.drop_table("stocktake_snapshot_items")

    op.drop_index(
        "ix_stocktake_sessions_household_created", table_name="stocktake_sessions"
    )
    op.drop_index(
        "ix_stocktake_sessions_household_status", table_name="stocktake_sessions"
    )
    op.drop_table("stocktake_sessions")
