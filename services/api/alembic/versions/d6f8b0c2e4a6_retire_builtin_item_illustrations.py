"""retire built-in item illustrations

Revision ID: d6f8b0c2e4a6
Revises: b2d4f6a8c0e1
Create Date: 2026-11-06 06:00:00.000000

Built-in line-art is no longer rendered. Existing rows are retained for
compatibility but are moved out of the active display slot. No files or item
records are deleted.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d6f8b0c2e4a6"
down_revision: str | None = "b2d4f6a8c0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE item_images "
            "SET status = 'superseded', updated_at = now() "
            "WHERE source_type = 'builtin' AND status IN ('pending', 'active')"
        )
    )


def downgrade() -> None:
    # Intentionally do not resurrect built-in artwork. Rows remain superseded.
    pass
