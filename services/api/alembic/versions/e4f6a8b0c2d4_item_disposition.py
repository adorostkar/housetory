"""item disposition metadata

Revision ID: e4f6a8b0c2d4
Revises: d3e5f7a9b1c2
Create Date: 2026-11-09 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e4f6a8b0c2d4"
down_revision: str | None = "d3e5f7a9b1c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("items", sa.Column("disposition", sa.String(length=32), nullable=True))
    op.add_column("items", sa.Column("disposed_on", sa.Date(), nullable=True))
    op.add_column("items", sa.Column("disposition_note", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_items_valid_disposition"),
        "items",
        "disposition IS NULL OR disposition IN "
        "('sold', 'given_away', 'donated', 'discarded', 'lost', 'consumed', 'other')",
    )
    op.create_check_constraint(
        op.f("ck_items_disposition_requires_archive"),
        "items",
        "is_archived OR (disposition IS NULL AND disposed_on IS NULL "
        "AND disposition_note IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_items_disposition_reason_required"),
        "items",
        "disposition IS NOT NULL OR (disposed_on IS NULL AND disposition_note IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_items_disposition_reason_required"), "items", type_="check"
    )
    op.drop_constraint(
        op.f("ck_items_disposition_requires_archive"), "items", type_="check"
    )
    op.drop_constraint(op.f("ck_items_valid_disposition"), "items", type_="check")
    op.drop_column("items", "disposition_note")
    op.drop_column("items", "disposed_on")
    op.drop_column("items", "disposition")
