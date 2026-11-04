"""documents, ownership and shared purchases

Revision ID: 7c9a2e4f1b6d
Revises: e58f0ce93a5d
Create Date: 2026-11-04 09:15:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7c9a2e4f1b6d"
down_revision: str | None = "e58f0ce93a5d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Household-level warranty reminder window.
    op.add_column(
        "households",
        sa.Column(
            "warranty_reminder_days",
            sa.Integer(),
            server_default="30",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_households_warranty_reminder_days",
        "households",
        "warranty_reminder_days between 1 and 3650",
    )

    # Document library, OCR metadata and preserved originals.
    op.add_column(
        "documents",
        sa.Column(
            "document_type",
            sa.String(length=24),
            server_default="other",
            nullable=False,
        ),
    )
    op.add_column("documents", sa.Column("document_date", sa.Date(), nullable=True))
    op.add_column("documents", sa.Column("merchant", sa.String(length=160), nullable=True))
    op.add_column("documents", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column(
        "documents",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.add_column("documents", sa.Column("extracted_text", sa.Text(), nullable=True))
    op.add_column(
        "documents",
        sa.Column(
            "extracted_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column(
        "documents",
        sa.Column(
            "ocr_status",
            sa.String(length=20),
            server_default="not_requested",
            nullable=False,
        ),
    )
    op.add_column("documents", sa.Column("ocr_error", sa.Text(), nullable=True))
    op.add_column("documents", sa.Column("ocr_confidence", sa.Integer(), nullable=True))
    op.add_column(
        "documents",
        sa.Column("ocr_processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "documents",
        sa.Column("original_storage_key", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "documents",
        sa.Column("original_content_type", sa.String(length=100), nullable=True),
    )
    op.add_column("documents", sa.Column("original_byte_size", sa.BigInteger(), nullable=True))
    # Existing files were already normalized by the security gate; point the
    # original reference at the preserved sanitized copy rather than inventing
    # bytes that no longer exist.
    op.execute(
        "UPDATE documents SET "
        "original_storage_key = storage_key, "
        "original_content_type = content_type, "
        "original_byte_size = byte_size"
    )
    op.alter_column("documents", "original_storage_key", nullable=False)
    op.alter_column("documents", "original_content_type", nullable=False)
    op.alter_column("documents", "original_byte_size", nullable=False)
    op.create_check_constraint(
        "ck_documents_valid_document_type",
        "documents",
        "document_type in ('receipt', 'invoice', 'warranty_certificate', 'manual', "
        "'specification', 'other')",
    )
    op.create_check_constraint(
        "ck_documents_valid_ocr_status",
        "documents",
        "ocr_status in ('not_requested', 'queued', 'processing', 'succeeded', 'failed')",
    )
    op.create_check_constraint(
        "ck_documents_ocr_confidence_range",
        "documents",
        "ocr_confidence IS NULL OR ocr_confidence between 0 and 100",
    )
    op.create_check_constraint(
        "ck_documents_original_byte_size_positive",
        "documents",
        "original_byte_size > 0",
    )
    op.create_unique_constraint(
        "uq_documents_original_storage_key",
        "documents",
        ["original_storage_key"],
    )
    op.create_index(
        "ix_documents_household_type",
        "documents",
        ["household_id", "document_type"],
        unique=False,
    )
    op.create_index(
        "ix_documents_household_created",
        "documents",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_documents_ocr_status",
        "documents",
        ["ocr_status"],
        unique=False,
    )

    # Item estimates and a reference to the shared purchase record.
    op.add_column("items", sa.Column("current_value_cents", sa.BigInteger(), nullable=True))
    op.add_column(
        "items",
        sa.Column(
            "current_value_currency",
            sa.String(length=3),
            server_default="USD",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_items_current_value_non_negative",
        "items",
        "current_value_cents IS NULL OR current_value_cents >= 0",
    )
    op.create_check_constraint(
        "ck_items_current_value_currency_length",
        "items",
        "char_length(current_value_currency) = 3",
    )
    op.add_column("items", sa.Column("purchase_id", sa.UUID(), nullable=True))

    # Purchases become household-owned shared records. Existing one-to-one
    # purchase rows map cleanly to the item that created them.
    op.add_column("purchases", sa.Column("household_id", sa.UUID(), nullable=True))
    op.add_column(
        "purchases",
        sa.Column("receipt_document_id", sa.UUID(), nullable=True),
    )
    op.execute(
        "UPDATE purchases SET household_id = items.household_id "
        "FROM items WHERE items.id = purchases.item_id"
    )
    op.alter_column("purchases", "household_id", nullable=False)
    op.create_foreign_key(
        "fk_purchases_household_id_households",
        "purchases",
        "households",
        ["household_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_purchases_receipt_document_id_documents",
        "purchases",
        "documents",
        ["receipt_document_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_purchases_household_date",
        "purchases",
        ["household_id", "purchase_date"],
        unique=False,
    )
    op.create_index(
        "ix_purchases_receipt_document_id",
        "purchases",
        ["receipt_document_id"],
        unique=False,
    )
    op.execute(
        "UPDATE items SET purchase_id = purchases.id "
        "FROM purchases WHERE purchases.item_id = items.id"
    )
    op.create_foreign_key(
        "fk_items_purchase_id_purchases",
        "items",
        "purchases",
        ["purchase_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_items_household_purchase",
        "items",
        ["household_id", "purchase_id"],
        unique=False,
    )
    op.drop_constraint("uq_purchases_item_id", "purchases", type_="unique")
    op.drop_constraint("fk_purchases_item_id_items", "purchases", type_="foreignkey")
    op.drop_column("purchases", "item_id")

    # Warranty duration, document and reminder override.
    op.add_column("warranties", sa.Column("duration_months", sa.Integer(), nullable=True))
    op.add_column("warranties", sa.Column("reminder_days", sa.Integer(), nullable=True))
    op.add_column("warranties", sa.Column("document_id", sa.UUID(), nullable=True))
    op.create_check_constraint(
        "ck_warranties_duration_months_range",
        "warranties",
        "duration_months IS NULL OR duration_months between 1 and 1200",
    )
    op.create_check_constraint(
        "ck_warranties_reminder_days_range",
        "warranties",
        "reminder_days IS NULL OR reminder_days between 1 and 3650",
    )
    op.create_foreign_key(
        "fk_warranties_document_id_documents",
        "warranties",
        "documents",
        ["document_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_warranties_end_date",
        "warranties",
        ["end_date"],
        unique=False,
    )
    op.create_index(
        "ix_warranties_document_id",
        "warranties",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_warranties_document_id", table_name="warranties")
    op.drop_index("ix_warranties_end_date", table_name="warranties")
    op.drop_constraint(
        "fk_warranties_document_id_documents", "warranties", type_="foreignkey"
    )
    op.drop_constraint("ck_warranties_reminder_days_range", "warranties", type_="check")
    op.drop_constraint("ck_warranties_duration_months_range", "warranties", type_="check")
    op.drop_column("warranties", "document_id")
    op.drop_column("warranties", "reminder_days")
    op.drop_column("warranties", "duration_months")

    # Collapse shared purchases back to one item each. Keep the earliest item so
    # the downgrade remains lossless for every purchase that still has an item.
    op.add_column("purchases", sa.Column("item_id", sa.UUID(), nullable=True))
    op.execute(
        "UPDATE purchases SET item_id = ranked.item_id FROM ("
        "SELECT item_id, purchase_id, ROW_NUMBER() OVER ("
        "PARTITION BY purchase_id ORDER BY created_at, id"
        ") AS position FROM items WHERE purchase_id IS NOT NULL"
        ") AS ranked WHERE ranked.purchase_id = purchases.id AND ranked.position = 1"
    )
    op.execute("DELETE FROM purchases WHERE item_id IS NULL")
    op.alter_column("purchases", "item_id", nullable=False)
    op.create_foreign_key(
        "fk_purchases_item_id_items",
        "purchases",
        "items",
        ["item_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint("uq_purchases_item_id", "purchases", ["item_id"])
    op.drop_index("ix_items_household_purchase", table_name="items")
    op.drop_constraint("fk_items_purchase_id_purchases", "items", type_="foreignkey")
    op.drop_column("items", "purchase_id")

    op.drop_index("ix_purchases_receipt_document_id", table_name="purchases")
    op.drop_index("ix_purchases_household_date", table_name="purchases")
    op.drop_constraint(
        "fk_purchases_receipt_document_id_documents", "purchases", type_="foreignkey"
    )
    op.drop_constraint("fk_purchases_household_id_households", "purchases", type_="foreignkey")
    op.drop_column("purchases", "receipt_document_id")
    op.drop_column("purchases", "household_id")

    op.drop_constraint("ck_items_current_value_currency_length", "items", type_="check")
    op.drop_constraint("ck_items_current_value_non_negative", "items", type_="check")
    op.drop_column("items", "current_value_currency")
    op.drop_column("items", "current_value_cents")

    op.drop_index("ix_documents_ocr_status", table_name="documents")
    op.drop_index("ix_documents_household_created", table_name="documents")
    op.drop_index("ix_documents_household_type", table_name="documents")
    op.drop_constraint(
        "uq_documents_original_storage_key", "documents", type_="unique"
    )
    op.drop_constraint("ck_documents_original_byte_size_positive", "documents", type_="check")
    op.drop_constraint("ck_documents_ocr_confidence_range", "documents", type_="check")
    op.drop_constraint("ck_documents_valid_ocr_status", "documents", type_="check")
    op.drop_constraint("ck_documents_valid_document_type", "documents", type_="check")
    op.drop_column("documents", "original_byte_size")
    op.drop_column("documents", "original_content_type")
    op.drop_column("documents", "original_storage_key")
    op.drop_column("documents", "ocr_processed_at")
    op.drop_column("documents", "ocr_confidence")
    op.drop_column("documents", "ocr_error")
    op.drop_column("documents", "ocr_status")
    op.drop_column("documents", "extracted_metadata")
    op.drop_column("documents", "extracted_text")
    op.drop_column("documents", "notes")
    op.drop_column("documents", "updated_at")
    op.drop_column("documents", "merchant")
    op.drop_column("documents", "document_date")
    op.drop_column("documents", "document_type")

    op.drop_constraint(
        "ck_households_warranty_reminder_days", "households", type_="check"
    )
    op.drop_column("households", "warranty_reminder_days")
