"""borrowed from others records, returns, private photos and history

Revision ID: a1c3e5f7b9d2
Revises: f2b4d6c8a0e1
Create Date: 2026-11-06 15:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1c3e5f7b9d2"
down_revision: str | None = "f2b4d6c8a0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "borrowed_records",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_name", sa.String(length=200), nullable=False),
        sa.Column("brand", sa.String(length=120), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("owner_name", sa.String(length=120), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("returned_quantity", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=24), server_default="outstanding", nullable=False),
        sa.Column("borrowed_on", sa.Date(), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("property_id", sa.UUID(), nullable=True),
        sa.Column("property_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("room_id", sa.UUID(), nullable=True),
        sa.Column("room_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("storage_location_id", sa.UUID(), nullable=True),
        sa.Column("location_name_snapshot", sa.String(length=120), nullable=True),
        sa.Column("location_identifier_snapshot", sa.String(length=32), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
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
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_borrowed_records_quantity_positive")),
        sa.CheckConstraint(
            "returned_quantity >= 0 and returned_quantity <= quantity",
            name=op.f("ck_borrowed_records_returned_quantity_range"),
        ),
        sa.CheckConstraint(
            "status in ('outstanding', 'partially_returned', 'returned', 'cancelled')",
            name=op.f("ck_borrowed_records_valid_status"),
        ),
        sa.CheckConstraint(
            "due_on is null or due_on >= borrowed_on",
            name=op.f("ck_borrowed_records_dates_in_order"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_borrowed_records_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_borrowed_records_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["property_id"],
            ["properties.id"],
            name=op.f("fk_borrowed_records_property_id_properties"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name=op.f("fk_borrowed_records_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["storage_location_id"],
            ["storage_locations.id"],
            name=op.f("fk_borrowed_records_storage_location_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_borrowed_records")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name=op.f("uq_borrowed_records_household_request_id"),
        ),
    )
    op.create_index(
        "ix_borrowed_records_household_status_due",
        "borrowed_records",
        ["household_id", "status", "due_on"],
    )
    op.create_index(
        "ix_borrowed_records_household_borrowed",
        "borrowed_records",
        ["household_id", "borrowed_on"],
    )
    op.create_index(
        "ix_borrowed_records_household_room",
        "borrowed_records",
        ["household_id", "room_id"],
    )
    op.create_index(
        "ix_borrowed_records_household_location",
        "borrowed_records",
        ["household_id", "storage_location_id"],
    )

    op.create_table(
        "borrowed_returns",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("borrowed_record_id", sa.UUID(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("returned_on", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_borrowed_returns_quantity_positive")),
        sa.ForeignKeyConstraint(
            ["borrowed_record_id"],
            ["borrowed_records.id"],
            name=op.f("fk_borrowed_returns_borrowed_record_id_borrowed_records"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_borrowed_returns_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_borrowed_returns_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_borrowed_returns")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name=op.f("uq_borrowed_returns_household_request_id"),
        ),
    )
    op.create_index(
        "ix_borrowed_returns_household_record",
        "borrowed_returns",
        ["household_id", "borrowed_record_id"],
    )
    op.create_index(
        "ix_borrowed_returns_record_created",
        "borrowed_returns",
        ["borrowed_record_id", "created_at"],
    )

    op.create_table(
        "borrowed_photos",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("borrowed_record_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("thumbnail_key", sa.String(length=500), nullable=True),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("byte_size > 0", name=op.f("ck_borrowed_photos_byte_size_positive")),
        sa.ForeignKeyConstraint(
            ["borrowed_record_id"],
            ["borrowed_records.id"],
            name=op.f("fk_borrowed_photos_borrowed_record_id_borrowed_records"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_borrowed_photos_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_borrowed_photos")),
        sa.UniqueConstraint("borrowed_record_id", name=op.f("uq_borrowed_photos_record")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_borrowed_photos_storage_key")),
        sa.UniqueConstraint("thumbnail_key", name=op.f("uq_borrowed_photos_thumbnail_key")),
    )
    op.create_index("ix_borrowed_photos_household", "borrowed_photos", ["household_id"])

    op.add_column("activity_events", sa.Column("borrowed_item_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_activity_events_borrowed_item_id_borrowed_records"),
        "activity_events",
        "borrowed_records",
        ["borrowed_item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_activity_events_household_borrowed",
        "activity_events",
        ["household_id", "borrowed_item_id", "created_at"],
    )
    op.drop_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        "entity_type in ('item', 'container', 'loan', 'batch', 'room', 'borrowed')",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        "entity_type in ('item', 'container', 'loan', 'batch', 'room')",
    )
    op.drop_index("ix_activity_events_household_borrowed", table_name="activity_events")
    op.drop_constraint(
        op.f("fk_activity_events_borrowed_item_id_borrowed_records"),
        "activity_events",
        type_="foreignkey",
    )
    op.drop_column("activity_events", "borrowed_item_id")
    op.drop_table("borrowed_photos")
    op.drop_table("borrowed_returns")
    op.drop_table("borrowed_records")
