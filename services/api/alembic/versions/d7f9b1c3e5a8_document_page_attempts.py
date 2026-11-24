"""How often reading a page was tried, why the last try failed, and which words OCR
was unsure about."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "d7f9b1c3e5a8"
down_revision = "c5e7a9b1d3f6"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "document_page_texts",
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="1"),
    )
    op.add_column("document_page_texts", sa.Column("error", sa.Text()))
    op.add_column("document_page_texts", sa.Column("unsure_words", postgresql.JSONB()))


def downgrade():
    op.drop_column("document_page_texts", "unsure_words")
    op.drop_column("document_page_texts", "error")
    op.drop_column("document_page_texts", "attempts")
