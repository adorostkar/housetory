"""Document cleanup drafts and generation-fenced derived work.

Revision ID: a6c8e0f2b4d6
Revises: f5a7c9e1b3d5
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "a6c8e0f2b4d6"
down_revision = "f5a7c9e1b3d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("source_generation", sa.Integer(), nullable=False, server_default="1"),
    )
    # Keep a deleted target's identity so an abandoned draft cannot become a new scan.
    op.add_column(
        "document_scans",
        sa.Column("target_document_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column("document_scans", sa.Column("base_generation", sa.Integer(), nullable=True))
    op.create_index(
        "ix_document_scans_target_document_id", "document_scans", ["target_document_id"]
    )
    op.add_column(
        "document_scan_pages",
        sa.Column(
            "detection_status", sa.String(24), nullable=False, server_default="manual_required"
        ),
    )
    op.add_column(
        "document_scan_pages",
        sa.Column("source_page_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("document_scan_pages", "source_page_id")
    op.drop_column("document_scan_pages", "detection_status")
    op.drop_index("ix_document_scans_target_document_id", table_name="document_scans")
    op.drop_column("document_scans", "base_generation")
    op.drop_column("document_scans", "target_document_id")
    op.drop_column("documents", "source_generation")
