"""bulk organisation batch history

Revision ID: d4f6b8c0e2a1
Revises: c9e1f3a5b7d2
Create Date: 2026-11-05 15:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d4f6b8c0e2a1"
down_revision: str | None = "c9e1f3a5b7d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        "entity_type in ('item', 'container', 'loan', 'batch')",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_activity_events_valid_entity_type"),
        "activity_events",
        "entity_type in ('item', 'container', 'loan')",
    )
