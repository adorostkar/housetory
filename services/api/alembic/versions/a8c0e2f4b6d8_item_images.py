"""item images and household image settings

Revision ID: a8c0e2f4b6d8
Revises: f1a3c5e7b9d2
Create Date: 2026-11-06 03:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a8c0e2f4b6d8"
down_revision: str | None = "f1a3c5e7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "households",
        sa.Column(
            "item_image_auto_reference",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column(
        "households",
        sa.Column(
            "item_image_auto_generate",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column(
        "households",
        sa.Column(
            "item_image_daily_generation_cap",
            sa.Integer(),
            server_default="10",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "item_image_generation_cap",
        "households",
        "item_image_daily_generation_cap between 1 and 100",
    )

    op.add_column(
        "jobs",
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )

    op.drop_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        type_="check",
    )
    op.create_check_constraint(
        "valid_task",
        "ai_task_settings",
        "task in ('assistant', 'imports', 'documents', 'search', 'vision', "
        "'labels', 'transcription', 'item_images')",
    )

    op.create_table(
        "item_images",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("provider_id", sa.UUID(), nullable=True),
        sa.Column("source_type", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("illustration_key", sa.String(length=40), nullable=True),
        sa.Column("storage_key", sa.String(length=500), nullable=True),
        sa.Column("thumbnail_key", sa.String(length=500), nullable=True),
        sa.Column("original_filename", sa.String(length=255), nullable=True),
        sa.Column("content_type", sa.String(length=100), nullable=True),
        sa.Column("byte_size", sa.BigInteger(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("source_name", sa.String(length=200), nullable=True),
        sa.Column("source_page_url", sa.Text(), nullable=True),
        sa.Column("license_note", sa.String(length=400), nullable=True),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "exact_model_confirmed",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
        sa.Column("model_label", sa.String(length=160), nullable=True),
        sa.Column("search_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
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
            "source_type in ('reference', 'ai', 'builtin')",
            name=op.f("ck_item_images_valid_source_type"),
        ),
        sa.CheckConstraint(
            "status in ('pending', 'active', 'superseded', 'rejected', 'failed')",
            name=op.f("ck_item_images_valid_status"),
        ),
        sa.CheckConstraint(
            "byte_size IS NULL OR byte_size > 0",
            name=op.f("ck_item_images_byte_size_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_item_images_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_item_images_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_item_images_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["ai_providers.id"],
            name=op.f("fk_item_images_provider_id_ai_providers"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_item_images")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_item_images_storage_key")),
        sa.UniqueConstraint("thumbnail_key", name=op.f("uq_item_images_thumbnail_key")),
    )
    op.create_index(
        "ix_item_images_item_status",
        "item_images",
        ["item_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_item_images_household_created",
        "item_images",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "uq_item_images_active_item",
        "item_images",
        ["item_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("uq_item_images_active_item", table_name="item_images")
    op.drop_index("ix_item_images_household_created", table_name="item_images")
    op.drop_index("ix_item_images_item_status", table_name="item_images")
    op.drop_table("item_images")

    op.drop_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        type_="check",
    )
    op.create_check_constraint(
        "valid_task",
        "ai_task_settings",
        "task in ('assistant', 'imports', 'documents', 'search', 'vision', "
        "'labels', 'transcription')",
    )

    op.drop_column("jobs", "result")
    op.drop_constraint(
        "ck_households_item_image_generation_cap",
        "households",
        type_="check",
    )
    op.drop_column("households", "item_image_daily_generation_cap")
    op.drop_column("households", "item_image_auto_generate")
    op.drop_column("households", "item_image_auto_reference")
