import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url


def test_item_valuation_migration_preserves_existing_values_and_metadata_stays_unknown():
    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_valuation_migration_{uuid.uuid4().hex[:8]}"
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
            [sys.executable, "-m", "alembic", "upgrade", "a1b2c3d4e5f7"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )
        with psycopg.connect(**connection_args) as connection:
            household_id = connection.execute(
                "INSERT INTO households (name) VALUES ('Valuation migration') RETURNING id"
            ).fetchone()[0]
            per_unit_id = connection.execute(
                "INSERT INTO items "
                "(household_id, name, quantity, condition, current_value_cents, "
                "current_value_currency, current_value_basis, current_value_estimated_at) "
                "VALUES (%s, 'Per-unit camera', 2, 'good', 4000, 'USD', 'per_unit', now()) "
                "RETURNING id",
                (household_id,),
            ).fetchone()[0]
            legacy_id = connection.execute(
                "INSERT INTO items "
                "(household_id, name, quantity, condition, current_value_cents, "
                "current_value_currency, current_value_basis) "
                "VALUES (%s, 'Legacy camera', 2, 'good', 8000, 'EUR', "
                "'legacy_record_total') RETURNING id",
                (household_id,),
            ).fetchone()[0]
            connection.commit()

        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )

        with psycopg.connect(**connection_args) as connection:
            stored = {
                row[0]: row[1:]
                for row in connection.execute(
                    "SELECT id, current_value_cents, current_value_currency, "
                    "current_value_basis, current_value_estimate_metadata "
                    "FROM items"
                ).fetchall()
            }
            assert stored[per_unit_id] == (4000, "USD", "per_unit", None)
            assert stored[legacy_id] == (8000, "EUR", "legacy_record_total", None)
            preview_table = connection.execute(
                "SELECT to_regclass('public.item_valuation_previews')"
            ).fetchone()[0]
            assert preview_table == "item_valuation_previews"
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
