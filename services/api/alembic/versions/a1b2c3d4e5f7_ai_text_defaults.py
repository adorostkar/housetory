"""persistent default text model and explicit task inheritance

Revision ID: a1b2c3d4e5f7
Revises: b6d8f0a2c4e6
Create Date: 2026-11-08 03:30:00.000000
"""

from collections import Counter
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a1b2c3d4e5f7"
down_revision: str | None = "b6d8f0a2c4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TEXT_TASKS = ("assistant", "documents", "imports", "search")


def upgrade() -> None:
    op.create_table(
        "ai_text_defaults",
        sa.Column("household_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("model", sa.String(length=160), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_ai_text_defaults_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["ai_providers.id"],
            name=op.f("fk_ai_text_defaults_provider_id_ai_providers"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("household_id", name=op.f("pk_ai_text_defaults")),
    )
    op.add_column(
        "ai_task_settings",
        sa.Column(
            "inherits_text_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    bind = op.get_bind()
    households = [
        row[0]
        for row in bind.execute(sa.text("SELECT id FROM households ORDER BY id")).all()
    ]
    for household_id in households:
        rows = bind.execute(
            sa.text(
                "SELECT task, provider_id, model FROM ai_task_settings "
                "WHERE household_id = :household_id "
                "AND task IN ('assistant', 'documents', 'imports', 'search')"
            ),
            {"household_id": household_id},
        ).all()
        configured = [
            (str(row[0]), row[1], str(row[2]))
            for row in rows
            if row[1] is not None and row[2]
        ]
        chosen: tuple[object, str] | None = None
        if configured:
            counts = Counter((pair[1], pair[2]) for pair in configured)
            pair, count = counts.most_common(1)[0]
            # Bootstrap only an unambiguous common pair. A tie or a bare
            # plurality leaves all configured text tasks as explicit overrides.
            if len(counts) == 1 or count > len(configured) / 2:
                chosen = pair
        if chosen is not None:
            provider_id, model = chosen
            for task, row_provider_id, row_model in configured:
                if row_provider_id == provider_id and row_model == model:
                    bind.execute(
                        sa.text(
                            "UPDATE ai_task_settings SET inherits_text_default = true "
                            "WHERE household_id = :household_id AND task = :task"
                        ),
                        {"household_id": household_id, "task": task},
                    )
            bind.execute(
                sa.text(
                    "INSERT INTO ai_text_defaults (household_id, provider_id, model) "
                    "VALUES (:household_id, :provider_id, :model)"
                ),
                {
                    "household_id": household_id,
                    "provider_id": provider_id,
                    "model": model,
                },
            )
        else:
            bind.execute(
                sa.text(
                    "INSERT INTO ai_text_defaults (household_id, provider_id, model) "
                    "VALUES (:household_id, NULL, NULL)"
                ),
                {"household_id": household_id},
            )


def downgrade() -> None:
    op.drop_column("ai_task_settings", "inherits_text_default")
    op.drop_table("ai_text_defaults")
