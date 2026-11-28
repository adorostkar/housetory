"""Who in a household may keep a read-only copy of the inventory on a device."""

import sqlalchemy as sa

from alembic import op

revision = "e8a0c2d4f6b1"
down_revision = "d7f9b1c3e5a8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "households",
        sa.Column(
            "offline_copy_policy",
            sa.String(length=16),
            nullable=False,
            server_default="members",
        ),
    )
    op.create_check_constraint(
        "offline_copy_policy",
        "households",
        "offline_copy_policy in ('nobody', 'members', 'everyone')",
    )


def downgrade():
    op.drop_constraint("offline_copy_policy", "households", type_="check")
    op.drop_column("households", "offline_copy_policy")
