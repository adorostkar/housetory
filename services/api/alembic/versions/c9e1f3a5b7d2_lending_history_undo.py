"""lending, movement history and safe undo

Revision ID: c9e1f3a5b7d2
Revises: a4b6c8d0e2f1
Create Date: 2026-11-05 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c9e1f3a5b7d2"
down_revision: str | None = "a4b6c8d0e2f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "loans",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("item_name_snapshot", sa.String(length=200), nullable=False),
        sa.Column("home_room_id", sa.UUID(), nullable=True),
        sa.Column("home_room_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("home_location_id", sa.UUID(), nullable=True),
        sa.Column("home_location_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("home_location_identifier_snapshot", sa.String(length=32), nullable=True),
        sa.Column("borrower_name", sa.String(length=120), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("returned_quantity", sa.Integer(), server_default="0", nullable=False),
        sa.Column("lent_on", sa.Date(), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=24), server_default="outstanding", nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
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
        sa.CheckConstraint("quantity > 0", name=op.f("ck_loans_quantity_positive")),
        sa.CheckConstraint(
            "returned_quantity >= 0 and returned_quantity <= quantity",
            name=op.f("ck_loans_returned_quantity_range"),
        ),
        sa.CheckConstraint(
            "status in ('outstanding', 'partially_returned', 'returned', 'cancelled')",
            name=op.f("ck_loans_valid_status"),
        ),
        sa.CheckConstraint(
            "due_on is null or due_on >= lent_on", name=op.f("ck_loans_dates_in_order")
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_loans_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_loans_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_loans_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_loans")),
        sa.UniqueConstraint("household_id", "request_id", name="uq_loans_household_request_id"),
    )
    op.create_index(
        "ix_loans_household_status_due",
        "loans",
        ["household_id", "status", "due_on"],
        unique=False,
    )
    op.create_index("ix_loans_household_item", "loans", ["household_id", "item_id"], unique=False)
    op.create_index("ix_loans_household_lent", "loans", ["household_id", "lent_on"], unique=False)

    op.create_table(
        "loan_returns",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("loan_id", sa.UUID(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("returned_on", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_by_event_id", sa.UUID(), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_loan_returns_quantity_positive")),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_loan_returns_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_loan_returns_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["loan_id"],
            ["loans.id"],
            name=op.f("fk_loan_returns_loan_id_loans"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_loan_returns")),
        sa.UniqueConstraint(
            "household_id", "request_id", name="uq_loan_returns_household_request_id"
        ),
    )
    op.create_index(
        "ix_loan_returns_household_loan",
        "loan_returns",
        ["household_id", "loan_id"],
        unique=False,
    )
    op.create_index(
        "ix_loan_returns_loan_created",
        "loan_returns",
        ["loan_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "activity_events",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("actor_user_id", sa.UUID(), nullable=True),
        sa.Column("actor_name_snapshot", sa.String(length=120), nullable=False),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("entity_type", sa.String(length=16), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=True),
        sa.Column("item_id", sa.UUID(), nullable=True),
        sa.Column("container_id", sa.UUID(), nullable=True),
        sa.Column("loan_id", sa.UUID(), nullable=True),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("undoes_event_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "entity_type in ('item', 'container', 'loan')",
            name=op.f("ck_activity_events_valid_entity_type"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_activity_events_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["container_id"],
            ["storage_locations.id"],
            name=op.f("fk_activity_events_container_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_activity_events_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_activity_events_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["loan_id"],
            ["loans.id"],
            name=op.f("fk_activity_events_loan_id_loans"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["undoes_event_id"],
            ["activity_events.id"],
            name=op.f("fk_activity_events_undoes_event_id_activity_events"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_activity_events")),
        sa.UniqueConstraint(
            "household_id", "request_id", name="uq_activity_events_household_request_id"
        ),
        sa.UniqueConstraint("undoes_event_id", name="uq_activity_events_undoes_event_id"),
    )
    op.create_index(
        "ix_activity_events_household_created",
        "activity_events",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_activity_events_household_item",
        "activity_events",
        ["household_id", "item_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_activity_events_household_container",
        "activity_events",
        ["household_id", "container_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_activity_events_household_loan",
        "activity_events",
        ["household_id", "loan_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_activity_events_household_loan", table_name="activity_events")
    op.drop_index("ix_activity_events_household_container", table_name="activity_events")
    op.drop_index("ix_activity_events_household_item", table_name="activity_events")
    op.drop_index("ix_activity_events_household_created", table_name="activity_events")
    op.drop_table("activity_events")
    op.drop_index("ix_loan_returns_loan_created", table_name="loan_returns")
    op.drop_index("ix_loan_returns_household_loan", table_name="loan_returns")
    op.drop_table("loan_returns")
    op.drop_index("ix_loans_household_lent", table_name="loans")
    op.drop_index("ix_loans_household_item", table_name="loans")
    op.drop_index("ix_loans_household_status_due", table_name="loans")
    op.drop_table("loans")
