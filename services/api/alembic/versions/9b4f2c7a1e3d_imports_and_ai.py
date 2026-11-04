"""imports and ai recognition

Revision ID: 9b4f2c7a1e3d
Revises: 7c9a2e4f1b6d
Create Date: 2026-11-04 12:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9b4f2c7a1e3d"
down_revision: str | None = "7c9a2e4f1b6d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "import_batches",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_type", sa.String(length=20), server_default="file", nullable=False),
        sa.Column("status", sa.String(length=20), server_default="queued", nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=True),
        sa.Column("content_type", sa.String(length=100), nullable=True),
        sa.Column("storage_key", sa.String(length=500), nullable=True),
        sa.Column("byte_size", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("total_entries", sa.Integer(), server_default="0", nullable=False),
        sa.Column("imported_entries", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_entries", sa.Integer(), server_default="0", nullable=False),
        sa.Column("failed_entries", sa.Integer(), server_default="0", nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
            "source_type in ('text', 'file', 'vault', 'image')",
            name="ck_import_batches_valid_source_type",
        ),
        sa.CheckConstraint(
            "status in ('queued', 'processing', 'review', 'applying', 'completed', 'failed')",
            name="ck_import_batches_valid_status",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_import_batches_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_import_batches")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_import_batches_storage_key")),
    )
    op.create_index(
        "ix_import_batches_household_created",
        "import_batches",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_import_batches_status", "import_batches", ["status"], unique=False)

    op.create_table(
        "import_source_files",
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("relative_path", sa.String(length=1000), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("is_referenced", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "kind in ('note', 'attachment')",
            name="ck_import_source_files_valid_kind",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["import_batches.id"],
            name=op.f("fk_import_source_files_batch_id_import_batches"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_import_source_files")),
        sa.UniqueConstraint(
            "batch_id", "relative_path", name="uq_import_files_batch_path"
        ),
        sa.UniqueConstraint("storage_key", name=op.f("uq_import_source_files_storage_key")),
    )
    op.create_index(
        "ix_import_source_files_batch",
        "import_source_files",
        ["batch_id"],
        unique=False,
    )

    op.create_table(
        "import_entries",
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("source_file_id", sa.UUID(), nullable=True),
        sa.Column("source_path", sa.String(length=1000), nullable=True),
        sa.Column("source_excerpt", sa.Text(), nullable=True),
        sa.Column("note_title", sa.String(length=200), nullable=True),
        sa.Column(
            "proposed",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "field_sources",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("confidence", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="proposed", nullable=False),
        sa.Column(
            "duplicate_candidates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("duplicate_resolution", sa.String(length=20), nullable=True),
        sa.Column("matched_item_id", sa.UUID(), nullable=True),
        sa.Column("imported_item_id", sa.UUID(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
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
            "status in ('proposed', 'approved', 'rejected', 'imported', 'skipped', "
            "'merged', 'failed')",
            name="ck_import_entries_valid_status",
        ),
        sa.CheckConstraint(
            "duplicate_resolution is null or duplicate_resolution in ('new', 'skip', 'merge')",
            name="ck_import_entries_valid_duplicate_resolution",
        ),
        sa.CheckConstraint(
            "confidence is null or confidence between 0 and 100",
            name="ck_import_entries_confidence_range",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["import_batches.id"],
            name=op.f("fk_import_entries_batch_id_import_batches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_file_id"],
            ["import_source_files.id"],
            name=op.f("fk_import_entries_source_file_id_import_source_files"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["matched_item_id"],
            ["items.id"],
            name=op.f("fk_import_entries_matched_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["imported_item_id"],
            ["items.id"],
            name=op.f("fk_import_entries_imported_item_id_items"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_import_entries")),
        sa.UniqueConstraint(
            "imported_item_id", name=op.f("uq_import_entries_imported_item_id")
        ),
    )
    op.create_index(
        "ix_import_entries_batch_position",
        "import_entries",
        ["batch_id", "position"],
        unique=False,
    )
    op.create_index("ix_import_entries_status", "import_entries", ["status"], unique=False)
    op.create_index(
        "ix_import_entries_imported_item",
        "import_entries",
        ["imported_item_id"],
        unique=False,
    )

    op.create_table(
        "ai_recognitions",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("original_storage_key", sa.String(length=500), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("original_content_type", sa.String(length=100), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("original_byte_size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="queued", nullable=False),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "field_sources",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("confidence", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("model_provider", sa.String(length=40), nullable=True),
        sa.Column("model_name", sa.String(length=120), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
            "status in ('queued', 'processing', 'succeeded', 'failed')",
            name="ck_ai_recognitions_valid_status",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_ai_recognitions_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_recognitions")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_ai_recognitions_storage_key")),
        sa.UniqueConstraint(
            "original_storage_key", name=op.f("uq_ai_recognitions_original_storage_key")
        ),
    )
    op.create_index(
        "ix_ai_recognitions_household_created",
        "ai_recognitions",
        ["household_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ai_recognitions_household_created", table_name="ai_recognitions"
    )
    op.drop_table("ai_recognitions")
    op.drop_index("ix_import_entries_imported_item", table_name="import_entries")
    op.drop_index("ix_import_entries_status", table_name="import_entries")
    op.drop_index("ix_import_entries_batch_position", table_name="import_entries")
    op.drop_table("import_entries")
    op.drop_index("ix_import_source_files_batch", table_name="import_source_files")
    op.drop_table("import_source_files")
    op.drop_index("ix_import_batches_status", table_name="import_batches")
    op.drop_index("ix_import_batches_household_created", table_name="import_batches")
    op.drop_table("import_batches")
