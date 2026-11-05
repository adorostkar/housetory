"""intelligent document extraction and matching

Revision ID: f6b8d0e2a4c3
Revises: e5a7c9d1f3b2
Create Date: 2026-11-05 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f6b8d0e2a4c3"
down_revision: str | None = "e5a7c9d1f3b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("content_sha256", sa.String(length=64), nullable=True))
    op.create_index(
        "ix_documents_household_content_sha256",
        "documents",
        ["household_id", "content_sha256"],
        unique=False,
    )
    op.create_table(
        "document_extraction_applies",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_document_extraction_applies_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_extraction_applies_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_document_extraction_applies_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_extraction_applies")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name="uq_document_extraction_applies_household_request_id",
        ),
    )
    op.create_index(
        "ix_document_extraction_applies_document",
        "document_extraction_applies",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_document_extraction_applies_document",
        table_name="document_extraction_applies",
    )
    op.drop_table("document_extraction_applies")
    op.drop_index("ix_documents_household_content_sha256", table_name="documents")
    op.drop_column("documents", "content_sha256")
