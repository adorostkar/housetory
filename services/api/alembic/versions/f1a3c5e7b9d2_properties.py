"""properties within one household

Revision ID: f1a3c5e7b9d2
Revises: e9f3a5b7c1d2
Create Date: 2026-11-05 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f1a3c5e7b9d2"
down_revision: str | None = "e9f3a5b7c1d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "properties",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("is_archived", sa.Boolean(), server_default="false", nullable=False),
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
        sa.CheckConstraint(
            "length(name) between 1 and 120",
            name=op.f("ck_properties_name_length"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_properties_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_properties")),
        sa.UniqueConstraint("household_id", "name", name="uq_properties_household_name"),
    )
    op.create_index(
        "ix_properties_household_sort",
        "properties",
        ["household_id", "sort_order", "name"],
        unique=False,
    )
    op.create_index(
        "ix_properties_household_archived",
        "properties",
        ["household_id", "is_archived"],
        unique=False,
    )

    # Give every existing household one explicit property without touching any
    # room/item/container IDs or their update timestamps.
    op.execute(
        """
        INSERT INTO properties (household_id, name, description, sort_order, is_archived)
        SELECT id, 'Home', NULL, 0, false FROM households
        """
    )

    op.add_column("voice_notes", sa.Column("default_property_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_voice_notes_default_property_id_properties"),
        "voice_notes",
        "properties",
        ["default_property_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_voice_notes_household_property",
        "voice_notes",
        ["household_id", "default_property_id"],
        unique=False,
    )

    op.add_column("rooms", sa.Column("property_id", sa.UUID(), nullable=True))
    op.execute(
        """
        UPDATE rooms AS r
        SET property_id = p.id
        FROM properties AS p
        WHERE p.household_id = r.household_id
        """
    )
    op.alter_column("rooms", "property_id", nullable=False)
    op.create_foreign_key(
        op.f("fk_rooms_property_id_properties"),
        "rooms",
        "properties",
        ["property_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint("uq_rooms_id_property", "rooms", ["id", "property_id"])
    op.create_foreign_key(
        "fk_rooms_parent_property",
        "rooms",
        "rooms",
        ["parent_id", "property_id"],
        ["id", "property_id"],
        ondelete="NO ACTION",
    )
    op.create_index(
        "ix_rooms_household_property_parent",
        "rooms",
        ["household_id", "property_id", "parent_id"],
        unique=False,
    )

    op.drop_constraint(
        "valid_entity_type",
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        "valid_entity_type",
        "activity_events",
        "entity_type in ('item', 'container', 'loan', 'batch', 'room')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "valid_entity_type",
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        "valid_entity_type",
        "activity_events",
        "entity_type in ('item', 'container', 'loan', 'batch')",
    )

    op.drop_index("ix_rooms_household_property_parent", table_name="rooms")
    op.drop_constraint("fk_rooms_parent_property", "rooms", type_="foreignkey")
    op.drop_constraint("uq_rooms_id_property", "rooms", type_="unique")
    op.drop_constraint("fk_rooms_property_id_properties", "rooms", type_="foreignkey")
    op.drop_column("rooms", "property_id")

    op.drop_index("ix_voice_notes_household_property", table_name="voice_notes")
    op.drop_constraint(
        "fk_voice_notes_default_property_id_properties",
        "voice_notes",
        type_="foreignkey",
    )
    op.drop_column("voice_notes", "default_property_id")

    op.drop_index("ix_properties_household_archived", table_name="properties")
    op.drop_index("ix_properties_household_sort", table_name="properties")
    op.drop_table("properties")
