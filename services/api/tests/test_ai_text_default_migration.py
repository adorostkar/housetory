import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url


def test_ai_text_default_migration_preserves_assignments_and_bootstraps_once():
    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_ai_default_{uuid.uuid4().hex[:8]}"
    connection_args = {
        "host": admin_url.host,
        "port": admin_url.port or 5432,
        "user": admin_url.username,
        "password": admin_url.password,
        "dbname": database_name,
    }
    admin_args = {**connection_args, "dbname": "postgres"}
    with psycopg.connect(**admin_args, autocommit=True) as connection:
        connection.execute(f'CREATE DATABASE "{database_name}"')
    database_url = (
        f"postgresql+psycopg://{admin_url.username}:{admin_url.password}"
        f"@{admin_url.host}:{admin_url.port or 5432}/{database_name}"
    )
    api_dir = Path(__file__).resolve().parents[1]
    try:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "b6d8f0a2c4e6"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )
        with psycopg.connect(**connection_args) as connection:
            connection.autocommit = False
            households: dict[str, uuid.UUID] = {}
            providers: dict[str, tuple[uuid.UUID, uuid.UUID]] = {}
            task_rows: list[tuple[uuid.UUID, str, uuid.UUID, str, bool]] = []

            def add_household(label: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
                household_id = connection.execute(
                    "INSERT INTO households (name) VALUES (%s) RETURNING id",
                    (f"AI default {label}",),
                ).fetchone()[0]
                first = connection.execute(
                    "INSERT INTO ai_providers "
                    "(household_id, provider, display_name, base_url, default_model) "
                    "VALUES (%s, 'ollama', %s, 'http://127.0.0.1:11434', %s) "
                    "RETURNING id",
                    (household_id, f"{label} first", f"{label}-a"),
                ).fetchone()[0]
                second = connection.execute(
                    "INSERT INTO ai_providers "
                    "(household_id, provider, display_name, base_url, default_model) "
                    "VALUES (%s, 'openai', %s, 'https://api.openai.com/v1', %s) "
                    "RETURNING id",
                    (household_id, f"{label} second", f"{label}-b"),
                ).fetchone()[0]
                households[label] = household_id
                providers[label] = (first, second)
                return household_id, first, second

            def add_task(
                household_id: uuid.UUID,
                task: str,
                provider_id: uuid.UUID,
                model: str,
                enabled: bool = True,
            ) -> None:
                connection.execute(
                    "INSERT INTO ai_task_settings "
                    "(household_id, task, provider_id, model, enabled) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (household_id, task, provider_id, model, enabled),
                )
                task_rows.append((household_id, task, provider_id, model, enabled))

            # All text tasks share one pair.
            household_a, a_provider, _a_second = add_household("a")
            for task in ("assistant", "documents", "imports", "search"):
                add_task(household_a, task, a_provider, "a-model")
            add_task(household_a, "vision", a_provider, "vision-model")

            # Unambiguous majority B with assistant A: B becomes default and A
            # stays an explicit override.
            household_b, b_first, b_second = add_household("b")
            add_task(household_b, "assistant", b_first, "b-a", enabled=False)
            for task in ("documents", "imports", "search"):
                add_task(household_b, task, b_second, "b-b")

            # 2/2 tie: no invented default; all configured rows stay explicit.
            household_c, c_first, c_second = add_household("c")
            add_task(household_c, "assistant", c_first, "c-a")
            add_task(household_c, "documents", c_first, "c-a")
            add_task(household_c, "imports", c_second, "c-b")
            add_task(household_c, "search", c_second, "c-b")
            connection.commit()

        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )

        with psycopg.connect(**connection_args) as connection:
            defaults = {
                row[0]: (row[1], row[2])
                for row in connection.execute(
                    "SELECT household_id, provider_id, model FROM ai_text_defaults"
                ).fetchall()
            }
            assert defaults[households["a"]] == (providers["a"][0], "a-model")
            assert defaults[households["b"]] == (providers["b"][1], "b-b")
            assert defaults[households["c"]] == (None, None)

            stored = {
                (row[0], row[1]): (row[2], row[3], row[4], row[5])
                for row in connection.execute(
                    "SELECT household_id, task, provider_id, model, enabled, "
                    "inherits_text_default FROM ai_task_settings"
                ).fetchall()
            }
            for household_id, task, provider_id, model, enabled in task_rows:
                assert stored[(household_id, task)][:3] == (
                    provider_id,
                    model,
                    enabled,
                )
            assert stored[(household_a, "assistant")][3] is True
            assert stored[(household_a, "search")][3] is True
            assert stored[(household_a, "vision")][3] is False
            assert stored[(household_b, "assistant")][3] is False
            assert stored[(household_b, "documents")][3] is True
            assert stored[(household_b, "assistant")][2] is False
            assert stored[(household_c, "assistant")][3] is False
            assert stored[(household_c, "search")][3] is False
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
