"""item manuals and reviewed online search candidates

Revision ID: c4e6a8b0d2f4
Revises: e2f4a6c8b0d2
Create Date: 2026-11-06 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c4e6a8b0d2f4"
down_revision: str | None = "e2f4a6c8b0d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "item_manual_profiles",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("manufacturer", sa.String(length=120), nullable=False),
        sa.Column("model_identifier", sa.String(length=120), nullable=False),
        sa.Column("variant", sa.String(length=120), nullable=True),
        sa.Column("confirmed_by_user_id", sa.UUID(), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=False),
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
            "length(manufacturer) between 2 and 120",
            name=op.f("ck_item_manual_profiles_manufacturer_length"),
        ),
        sa.CheckConstraint(
            "length(model_identifier) between 3 and 120",
            name=op.f("ck_item_manual_profiles_model_length"),
        ),
        sa.CheckConstraint(
            "variant is null or length(variant) between 1 and 120",
            name=op.f("ck_item_manual_profiles_variant_length"),
        ),
        sa.ForeignKeyConstraint(
            ["confirmed_by_user_id"],
            ["users.id"],
            name=op.f("fk_item_manual_profiles_confirmed_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_item_manual_profiles_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_item_manual_profiles_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_item_manual_profiles")),
        sa.UniqueConstraint("item_id", name="uq_item_manual_profiles_item"),
    )
    op.create_index(
        "ix_item_manual_profiles_household",
        "item_manual_profiles",
        ["household_id"],
        unique=False,
    )

    op.create_table(
        "manual_search_candidates",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("file_url", sa.Text(), nullable=False),
        sa.Column("publisher", sa.String(length=200), nullable=True),
        sa.Column("language", sa.String(length=40), nullable=True),
        sa.Column("source_type", sa.String(length=20), server_default="other", nullable=False),
        sa.Column(
            "model_coverage",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("snippet", sa.Text(), nullable=True),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("download_request_id", sa.UUID(), nullable=True),
        sa.Column("document_id", sa.UUID(), nullable=True),
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
            "length(title) between 1 and 300",
            name=op.f("ck_manual_search_candidates_title_length"),
        ),
        sa.CheckConstraint(
            "length(source_url) between 1 and 2000",
            name=op.f("ck_manual_search_candidates_source_url_length"),
        ),
        sa.CheckConstraint(
            "length(file_url) between 1 and 2000",
            name=op.f("ck_manual_search_candidates_file_url_length"),
        ),
        sa.CheckConstraint(
            "publisher is null or length(publisher) <= 200",
            name=op.f("ck_manual_search_candidates_publisher_length"),
        ),
        sa.CheckConstraint(
            "language is null or length(language) <= 40",
            name=op.f("ck_manual_search_candidates_language_length"),
        ),
        sa.CheckConstraint(
            "source_type in ('manufacturer', 'official', 'other')",
            name=op.f("ck_manual_search_candidates_valid_source_type"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_manual_search_candidates_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_manual_search_candidates_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_manual_search_candidates_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_manual_search_candidates_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_manual_search_candidates")),
        sa.UniqueConstraint(
            "household_id",
            "download_request_id",
            name="uq_manual_candidates_household_request",
        ),
    )
    op.create_index(
        "ix_manual_candidates_household_item",
        "manual_search_candidates",
        ["household_id", "item_id"],
        unique=False,
    )
    op.create_index(
        "ix_manual_candidates_document",
        "manual_search_candidates",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_manual_candidates_document", table_name="manual_search_candidates")
    op.drop_index(
        "ix_manual_candidates_household_item", table_name="manual_search_candidates"
    )
    op.drop_table("manual_search_candidates")
    op.drop_index("ix_item_manual_profiles_household", table_name="item_manual_profiles")
    op.drop_table("item_manual_profiles")
