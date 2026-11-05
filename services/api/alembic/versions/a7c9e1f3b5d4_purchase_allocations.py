"""persistent purchase allocations

Revision ID: a7c9e1f3b5d4
Revises: f6b8d0e2a4c3
Create Date: 2026-11-06 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a7c9e1f3b5d4"
down_revision: str | None = "f6b8d0e2a4c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "purchase_allocations",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("purchase_id", sa.UUID(), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column("extraction_version", sa.String(length=80), nullable=True),
        sa.Column("source_line_id", sa.String(length=80), nullable=True),
        sa.Column("description", sa.String(length=300), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("unit_price_cents", sa.BigInteger(), nullable=True),
        sa.Column("line_total_cents", sa.BigInteger(), nullable=True),
        sa.Column("allocated_cents", sa.BigInteger(), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("source_evidence", sa.Text(), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
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
            "quantity > 0",
            name=op.f("ck_purchase_allocations_quantity_positive"),
        ),
        sa.CheckConstraint(
            "unit_price_cents IS NULL OR unit_price_cents >= 0",
            name=op.f("ck_purchase_allocations_unit_price_non_negative"),
        ),
        sa.CheckConstraint(
            "line_total_cents IS NULL OR line_total_cents >= 0",
            name=op.f("ck_purchase_allocations_line_total_non_negative"),
        ),
        sa.CheckConstraint(
            "allocated_cents IS NULL OR allocated_cents >= 0",
            name=op.f("ck_purchase_allocations_allocated_non_negative"),
        ),
        sa.CheckConstraint(
            "char_length(currency) = 3",
            name=op.f("ck_purchase_allocations_currency_length"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_purchase_allocations_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_purchase_allocations_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_purchase_allocations_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["items.id"],
            name=op.f("fk_purchase_allocations_item_id_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["purchase_id"],
            ["purchases.id"],
            name=op.f("fk_purchase_allocations_purchase_id_purchases"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_allocations")),
        sa.UniqueConstraint(
            "purchase_id",
            "source_line_id",
            name="uq_purchase_allocations_purchase_line",
        ),
    )
    op.create_index(
        "ix_purchase_allocations_purchase",
        "purchase_allocations",
        ["purchase_id"],
        unique=False,
    )
    op.create_index(
        "ix_purchase_allocations_item",
        "purchase_allocations",
        ["item_id"],
        unique=False,
    )
    op.create_index(
        "ix_purchase_allocations_document",
        "purchase_allocations",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_purchase_allocations_document", table_name="purchase_allocations")
    op.drop_index("ix_purchase_allocations_item", table_name="purchase_allocations")
    op.drop_index("ix_purchase_allocations_purchase", table_name="purchase_allocations")
    op.drop_table("purchase_allocations")
