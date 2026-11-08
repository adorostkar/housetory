import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url


def test_server_baseline_upgrades_to_current_head_without_rewriting_values_or_keys():
    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_release_migration_{uuid.uuid4().hex[:8]}"
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

    def upgrade(revision: str) -> None:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", revision],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )

    try:
        upgrade("a1c3e5f7b9d2")
        with psycopg.connect(**connection_args) as connection:
            household_id = connection.execute(
                "INSERT INTO households (name) VALUES ('Release migration') RETURNING id"
            ).fetchone()[0]
            provider_id = connection.execute(
                "INSERT INTO ai_providers "
                "(household_id, provider, display_name, base_url, default_model, "
                "encrypted_api_key, api_key_version, enabled, cloud_consent) "
                "VALUES (%s, 'openai', 'Release provider', 'https://api.openai.com/v1', "
                "'gpt-4o', 'fernet:v1:fixture-ciphertext-never-decrypted', 4, true, true) "
                "RETURNING id",
                (household_id,),
            ).fetchone()[0]
            for task in ("assistant", "documents", "imports", "search"):
                connection.execute(
                    "INSERT INTO ai_task_settings "
                    "(household_id, task, provider_id, model, enabled) "
                    "VALUES (%s, %s, %s, 'gpt-4o', true)",
                    (household_id, task, provider_id),
                )
            connection.execute(
                "INSERT INTO ai_task_settings "
                "(household_id, task, provider_id, model, enabled) "
                "VALUES (%s, 'vision', %s, 'vision-model', true)",
                (household_id, provider_id),
            )
            connection.execute(
                "INSERT INTO ai_task_settings "
                "(household_id, task, provider_id, model, enabled) "
                "VALUES (%s, 'labels', %s, 'retired-label-model', false)",
                (household_id, provider_id),
            )
            item_id = connection.execute(
                "INSERT INTO items "
                "(household_id, name, quantity, condition, current_value_cents, "
                "current_value_currency) "
                "VALUES (%s, 'Baseline item', 2, 'good', 8000, 'USD') "
                "RETURNING id",
                (household_id,),
            ).fetchone()[0]
            connection.commit()

        upgrade("head")
        upgrade("head")
        with psycopg.connect(**connection_args) as connection:
            provider = connection.execute(
                "SELECT provider, display_name, default_model, encrypted_api_key, "
                "api_key_version, enabled, cloud_consent FROM ai_providers WHERE id=%s",
                (provider_id,),
            ).fetchone()
            assert provider == (
                "openai",
                "Release provider",
                "gpt-4o",
                "fernet:v1:fixture-ciphertext-never-decrypted",
                4,
                True,
                True,
            )
            tasks = {
                row[0]: row[1:]
                for row in connection.execute(
                    "SELECT task, provider_id, model, enabled, inherits_text_default "
                    "FROM ai_task_settings WHERE household_id=%s",
                    (household_id,),
                ).fetchall()
            }
            for task in ("assistant", "documents", "imports", "search"):
                assert tasks[task] == (provider_id, "gpt-4o", True, True)
            assert tasks["vision"] == (provider_id, "vision-model", True, False)
            assert tasks["labels"] == (provider_id, "retired-label-model", False, False)
            item = connection.execute(
                "SELECT name, quantity, current_value_cents, current_value_currency, "
                "current_value_basis, current_value_estimated_at, "
                "current_value_estimate_metadata FROM items WHERE id=%s",
                (item_id,),
            ).fetchone()
            assert item == (
                "Baseline item",
                2,
                8000,
                "USD",
                "legacy_record_total",
                None,
                None,
            )
            default = connection.execute(
                "SELECT provider_id, model FROM ai_text_defaults WHERE household_id=%s",
                (household_id,),
            ).fetchone()
            assert default == (provider_id, "gpt-4o")
            assert connection.execute(
                "SELECT to_regclass('public.item_valuation_previews')"
            ).fetchone()[0] == "item_valuation_previews"
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
