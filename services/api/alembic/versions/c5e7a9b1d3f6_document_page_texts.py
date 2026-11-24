"""Page-level text and the navigation map of documents, kept apart from the document row."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "c5e7a9b1d3f6"
down_revision = "b4d6f8a0c2e5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "document_page_texts",
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "documents.id",
                ondelete="CASCADE",
                name="fk_document_page_texts_document_id_documents",
            ),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("source_generation", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("vision_text", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("document_id", "page_number", name="pk_document_page_texts"),
        sa.CheckConstraint("page_number >= 1", name="ck_document_page_texts_page_number_positive"),
        sa.CheckConstraint(
            "source in ('pdf_text', 'ocr', 'text', 'unreadable')",
            name="ck_document_page_texts_valid_source",
        ),
    )
    op.create_table(
        "document_readings",
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "documents.id",
                ondelete="CASCADE",
                name="fk_document_readings_document_id_documents",
            ),
            nullable=False,
        ),
        sa.Column("source_generation", sa.Integer(), nullable=False),
        sa.Column("page_total", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column("map", postgresql.JSONB()),
        sa.Column("map_error", sa.Text()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("document_id", name="pk_document_readings"),
    )


def downgrade():
    op.drop_table("document_readings")
    op.drop_table("document_page_texts")
