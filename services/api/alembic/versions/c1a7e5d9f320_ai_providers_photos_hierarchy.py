"""ai providers, entity photos and hierarchical imports

Revision ID: c1a7e5d9f320
Revises: 4d8e1a6c2b90
Create Date: 2026-11-04 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c1a7e5d9f320"
down_revision: str | None = "4d8e1a6c2b90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_providers",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=True),
        sa.Column("default_model", sa.String(length=160), nullable=True),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("api_key_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("cloud_consent", sa.Boolean(), server_default="false", nullable=False),
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
        sa.CheckConstraint(
            "provider in ('openai', 'anthropic', 'gemini', 'xai', 'openrouter', 'ollama')",
            name=op.f("ck_ai_providers_valid_provider"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_ai_providers_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_providers")),
        sa.UniqueConstraint(
            "household_id", "provider", name="uq_ai_providers_household_provider"
        ),
    )
    op.create_index("ix_ai_providers_household", "ai_providers", ["household_id"], unique=False)

    op.create_table(
        "ai_task_settings",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("task", sa.String(length=20), nullable=False),
        sa.Column("provider_id", sa.UUID(), nullable=True),
        sa.Column("model", sa.String(length=160), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "task in ('assistant', 'imports', 'documents', 'search', 'vision', 'labels')",
            name=op.f("ck_ai_task_settings_valid_task"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_ai_task_settings_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["ai_providers.id"],
            name=op.f("fk_ai_task_settings_provider_id_ai_providers"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint(
            "household_id", "task", name=op.f("pk_ai_task_settings")
        ),
    )

    op.create_table(
        "room_photos",
        sa.Column("room_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("thumbnail_key", sa.String(length=500), nullable=True),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("byte_size > 0", name=op.f("ck_room_photos_byte_size_positive")),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name=op.f("fk_room_photos_room_id_rooms"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_room_photos")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_room_photos_storage_key")),
        sa.UniqueConstraint("thumbnail_key", name=op.f("uq_room_photos_thumbnail_key")),
    )
    op.create_index("ix_room_photos_room_id", "room_photos", ["room_id"], unique=False)

    op.create_table(
        "location_photos",
        sa.Column("location_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("thumbnail_key", sa.String(length=500), nullable=True),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "byte_size > 0", name=op.f("ck_location_photos_byte_size_positive")
        ),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["storage_locations.id"],
            name=op.f("fk_location_photos_location_id_storage_locations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_location_photos")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_location_photos_storage_key")),
        sa.UniqueConstraint("thumbnail_key", name=op.f("uq_location_photos_thumbnail_key")),
    )
    op.create_index(
        "ix_location_photos_location_id", "location_photos", ["location_id"], unique=False
    )

    op.add_column("storage_locations", sa.Column("legacy_identifier", sa.String(length=120)))
    op.add_column(
        "storage_locations",
        sa.Column("aliases", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False),
    )
    op.create_index(
        "ix_storage_locations_household_legacy",
        "storage_locations",
        ["household_id", "legacy_identifier"],
        unique=False,
    )

    op.add_column(
        "import_entries",
        sa.Column("entity_type", sa.String(length=20), server_default="item", nullable=False),
    )
    op.add_column("import_entries", sa.Column("parent_entry_id", sa.UUID(), nullable=True))
    op.add_column("import_entries", sa.Column("created_room_id", sa.UUID(), nullable=True))
    op.add_column("import_entries", sa.Column("created_location_id", sa.UUID(), nullable=True))
    op.add_column("import_entries", sa.Column("legacy_identifier", sa.String(length=120)))
    op.create_foreign_key(
        op.f("fk_import_entries_parent_entry_id_import_entries"),
        "import_entries",
        "import_entries",
        ["parent_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_import_entries_created_room_id_rooms"),
        "import_entries",
        "rooms",
        ["created_room_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_import_entries_created_location_id_storage_locations"),
        "import_entries",
        "storage_locations",
        ["created_location_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_import_entries_parent_entry", "import_entries", ["parent_entry_id"], unique=False
    )

    op.alter_column(
        "ai_recognitions",
        "model_name",
        existing_type=sa.String(length=120),
        type_=sa.String(length=160),
        existing_nullable=True,
    )
    op.add_column("ai_recognitions", sa.Column("room_id", sa.UUID(), nullable=True))
    op.add_column("ai_recognitions", sa.Column("location_id", sa.UUID(), nullable=True))
    op.add_column(
        "ai_recognitions",
        sa.Column(
            "processing_mode",
            sa.String(length=20),
            server_default="unavailable",
            nullable=False,
        ),
    )
    op.add_column("ai_recognitions", sa.Column("applied_at", sa.DateTime(timezone=True)))
    op.add_column(
        "ai_recognitions",
        sa.Column(
            "applied_items",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    op.create_foreign_key(
        op.f("fk_ai_recognitions_room_id_rooms"),
        "ai_recognitions",
        "rooms",
        ["room_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_ai_recognitions_location_id_storage_locations"),
        "ai_recognitions",
        "storage_locations",
        ["location_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_ai_recognitions_location", "ai_recognitions", ["location_id"], unique=False
    )

    op.create_table(
        "recognition_item_links",
        sa.Column("recognition_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("suggestion_index", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["recognition_id"],
            ["ai_recognitions.id"],
            name=op.f("fk_recognition_item_links_recognition_id_ai_recognitions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_recognition_item_links_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recognition_item_links")),
        sa.UniqueConstraint("recognition_id", "item_id", name="uq_recognition_item"),
    )
    op.create_index(
        "ix_recognition_item_links_recognition",
        "recognition_item_links",
        ["recognition_id"],
        unique=False,
    )
    op.create_index(
        "ix_recognition_item_links_item", "recognition_item_links", ["item_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_recognition_item_links_item", table_name="recognition_item_links")
    op.drop_index("ix_recognition_item_links_recognition", table_name="recognition_item_links")
    op.drop_table("recognition_item_links")

    op.drop_index("ix_ai_recognitions_location", table_name="ai_recognitions")
    op.drop_constraint(
        op.f("fk_ai_recognitions_room_id_rooms"),
        "ai_recognitions",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_ai_recognitions_location_id_storage_locations"),
        "ai_recognitions",
        type_="foreignkey",
    )
    op.drop_column("ai_recognitions", "applied_items")
    op.drop_column("ai_recognitions", "applied_at")
    op.drop_column("ai_recognitions", "processing_mode")
    op.alter_column(
        "ai_recognitions",
        "model_name",
        existing_type=sa.String(length=160),
        type_=sa.String(length=120),
        existing_nullable=True,
    )
    op.drop_column("ai_recognitions", "location_id")
    op.drop_column("ai_recognitions", "room_id")

    op.drop_index("ix_import_entries_parent_entry", table_name="import_entries")
    op.drop_constraint(
        op.f("fk_import_entries_created_location_id_storage_locations"),
        "import_entries",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_import_entries_created_room_id_rooms"),
        "import_entries",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_import_entries_parent_entry_id_import_entries"),
        "import_entries",
        type_="foreignkey",
    )
    op.drop_column("import_entries", "legacy_identifier")
    op.drop_column("import_entries", "created_location_id")
    op.drop_column("import_entries", "created_room_id")
    op.drop_column("import_entries", "parent_entry_id")
    op.drop_column("import_entries", "entity_type")

    op.drop_index("ix_storage_locations_household_legacy", table_name="storage_locations")
    op.drop_column("storage_locations", "aliases")
    op.drop_column("storage_locations", "legacy_identifier")

    op.drop_index("ix_location_photos_location_id", table_name="location_photos")
    op.drop_table("location_photos")
    op.drop_index("ix_room_photos_room_id", table_name="room_photos")
    op.drop_table("room_photos")

    op.drop_table("ai_task_settings")
    op.drop_index("ix_ai_providers_household", table_name="ai_providers")
    op.drop_table("ai_providers")
