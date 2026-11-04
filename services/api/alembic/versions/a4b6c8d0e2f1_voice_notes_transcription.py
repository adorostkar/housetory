"""voice notes and transcription task

Revision ID: a4b6c8d0e2f1
Revises: f3c1a9b7d245
Create Date: 2026-11-05 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a4b6c8d0e2f1"
down_revision: str | None = "f3c1a9b7d245"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        "task in ('assistant', 'imports', 'documents', 'search', 'vision', "
        "'labels', 'transcription')",
    )

    op.create_table(
        "voice_notes",
        sa.Column("household_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="queued", nullable=False),
        sa.Column("audio_storage_key", sa.String(length=500), nullable=True),
        sa.Column("audio_original_filename", sa.String(length=255), nullable=True),
        sa.Column("audio_content_type", sa.String(length=100), nullable=True),
        sa.Column("audio_byte_size", sa.BigInteger(), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("default_room_id", sa.UUID(), nullable=True),
        sa.Column("default_location_id", sa.UUID(), nullable=True),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("transcript_provider", sa.String(length=40), nullable=True),
        sa.Column("transcript_model", sa.String(length=160), nullable=True),
        sa.Column("transcript_mode", sa.String(length=20), nullable=True),
        sa.Column("transcript_error", sa.Text(), nullable=True),
        sa.Column("interpretation_provider", sa.String(length=40), nullable=True),
        sa.Column("interpretation_model", sa.String(length=160), nullable=True),
        sa.Column("interpretation_mode", sa.String(length=20), nullable=True),
        sa.Column("interpretation_error", sa.Text(), nullable=True),
        sa.Column(
            "suggestions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "applied_items",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("audio_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
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
        sa.CheckConstraint(
            "status in ('queued', 'transcribing', 'transcribed', 'interpreting', "
            "'review', 'applying', 'confirmed', 'failed', 'cancelled')",
            name=op.f("ck_voice_notes_valid_status"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_voice_notes_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["default_location_id"],
            ["storage_locations.id"],
            name=op.f("fk_voice_notes_default_location_id_storage_locations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["default_room_id"],
            ["rooms.id"],
            name=op.f("fk_voice_notes_default_room_id_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_voice_notes_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_voice_notes")),
    )
    op.create_index(
        "ix_voice_notes_household_created",
        "voice_notes",
        ["household_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_voice_notes_status", "voice_notes", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_voice_notes_status", table_name="voice_notes")
    op.drop_index("ix_voice_notes_household_created", table_name="voice_notes")
    op.drop_table("voice_notes")
    op.drop_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_ai_task_settings_valid_task"),
        "ai_task_settings",
        "task in ('assistant', 'imports', 'documents', 'search', 'vision', 'labels')",
    )
