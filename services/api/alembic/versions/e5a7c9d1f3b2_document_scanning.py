"""document scanning sessions and source pages

Revision ID: e5a7c9d1f3b2
Revises: d4f6b8c0e2a1
Create Date: 2026-11-05 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e5a7c9d1f3b2"
down_revision: str | None = "d4f6b8c0e2a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "document_scans",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="draft", nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
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
            "status in ('draft', 'committed')",
            name=op.f("ck_document_scans_valid_status"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_document_scans_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_scans_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_document_scans_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_scans")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name="uq_document_scans_household_request_id",
        ),
        sa.UniqueConstraint("document_id", name="uq_document_scans_document_id"),
    )
    op.create_index(
        "ix_document_scans_household_status",
        "document_scans",
        ["household_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_document_scans_household_updated",
        "document_scans",
        ["household_id", "updated_at"],
        unique=False,
    )

    op.create_table(
        "document_scan_pages",
        sa.Column("scan_id", sa.UUID(), nullable=False),
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("page_index", sa.Integer(), nullable=False),
        sa.Column("original_storage_key", sa.String(length=500), nullable=False),
        sa.Column("cleaned_storage_key", sa.String(length=500), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("original_content_type", sa.String(length=100), nullable=False),
        sa.Column("cleaned_content_type", sa.String(length=100), nullable=False),
        sa.Column("original_byte_size", sa.BigInteger(), nullable=False),
        sa.Column("cleaned_byte_size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column(
            "adjustments",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
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
            "page_index >= 0",
            name=op.f("ck_document_scan_pages_page_index_nonnegative"),
        ),
        sa.CheckConstraint(
            "original_byte_size > 0",
            name=op.f("ck_document_scan_pages_original_byte_size_positive"),
        ),
        sa.CheckConstraint(
            "cleaned_byte_size > 0",
            name=op.f("ck_document_scan_pages_cleaned_byte_size_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_document_scan_pages_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["scan_id"],
            ["document_scans.id"],
            name=op.f("fk_document_scan_pages_scan_id_document_scans"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_scan_pages")),
        sa.UniqueConstraint(
            "cleaned_storage_key",
            name="uq_document_scan_pages_cleaned_storage_key",
        ),
        sa.UniqueConstraint(
            "original_storage_key",
            name="uq_document_scan_pages_original_storage_key",
        ),
    )
    op.create_index(
        "ix_document_scan_pages_scan_order",
        "document_scan_pages",
        ["scan_id", "page_index"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_document_scan_pages_scan_order", table_name="document_scan_pages")
    op.drop_table("document_scan_pages")
    op.drop_index("ix_document_scans_household_updated", table_name="document_scans")
    op.drop_index("ix_document_scans_household_status", table_name="document_scans")
    op.drop_table("document_scans")
