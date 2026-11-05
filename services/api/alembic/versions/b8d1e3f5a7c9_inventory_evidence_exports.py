"""inventory evidence export packages

Revision ID: b8d1e3f5a7c9
Revises: c4e6a8b0d2f4
Create Date: 2026-11-05 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8d1e3f5a7c9"
down_revision: str | None = "c4e6a8b0d2f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "inventory_evidence_exports",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="queued", nullable=False),
        sa.Column(
            "format_version",
            sa.String(length=40),
            server_default="inventory-evidence-v1",
            nullable=False,
        ),
        sa.Column(
            "scope",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("scope_label", sa.String(length=300), server_default="", nullable=False),
        sa.Column(
            "include_archived", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column(
            "options",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "snapshot_fingerprint", sa.String(length=64), server_default="", nullable=False
        ),
        sa.Column("item_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("unit_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "evidence_counts",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "manifest",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("pdf_key", sa.String(length=500), nullable=True),
        sa.Column("pdf_name", sa.String(length=255), nullable=True),
        sa.Column("pdf_bytes", sa.BigInteger(), nullable=True),
        sa.Column("pdf_sha256", sa.String(length=64), nullable=True),
        sa.Column("csv_key", sa.String(length=500), nullable=True),
        sa.Column("csv_name", sa.String(length=255), nullable=True),
        sa.Column("csv_bytes", sa.BigInteger(), nullable=True),
        sa.Column("csv_sha256", sa.String(length=64), nullable=True),
        sa.Column("bundle_key", sa.String(length=500), nullable=True),
        sa.Column("bundle_name", sa.String(length=255), nullable=True),
        sa.Column("bundle_bytes", sa.BigInteger(), nullable=True),
        sa.Column("bundle_sha256", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
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
            "status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')",
            name=op.f("ck_inventory_evidence_exports_valid_status"),
        ),
        sa.CheckConstraint(
            "item_count >= 0",
            name=op.f("ck_inventory_evidence_exports_item_count_non_negative"),
        ),
        sa.CheckConstraint(
            "unit_count >= 0",
            name=op.f("ck_inventory_evidence_exports_unit_count_non_negative"),
        ),
        sa.CheckConstraint(
            "pdf_bytes is null or pdf_bytes > 0",
            name=op.f("ck_inventory_evidence_exports_pdf_bytes_positive"),
        ),
        sa.CheckConstraint(
            "csv_bytes is null or csv_bytes > 0",
            name=op.f("ck_inventory_evidence_exports_csv_bytes_positive"),
        ),
        sa.CheckConstraint(
            "bundle_bytes is null or bundle_bytes > 0",
            name=op.f("ck_inventory_evidence_exports_bundle_bytes_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_inventory_evidence_exports_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_inventory_evidence_exports_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
            name=op.f("fk_inventory_evidence_exports_job_id_jobs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_evidence_exports")),
        sa.UniqueConstraint(
            "household_id",
            "request_id",
            name="uq_evidence_exports_household_request",
        ),
    )
    op.create_index(
        "ix_evidence_exports_household_created",
        "inventory_evidence_exports",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_evidence_exports_status_expires",
        "inventory_evidence_exports",
        ["status", "expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_evidence_exports_status_expires",
        table_name="inventory_evidence_exports",
    )
    op.drop_index(
        "ix_evidence_exports_household_created",
        table_name="inventory_evidence_exports",
    )
    op.drop_table("inventory_evidence_exports")
