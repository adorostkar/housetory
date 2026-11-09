import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url


def test_household_default_currency_migration_defaults_existing_rows_and_downgrades():
    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_currency_migration_{uuid.uuid4().hex[:8]}"
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

    def migrate(revision: str) -> None:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", revision],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )

    try:
        migrate("c2d3e4f5a6b7")
        with psycopg.connect(**connection_args) as connection:
            household_id = connection.execute(
                "INSERT INTO households (name, warranty_reminder_days) "
                "VALUES ('Existing home', 45) RETURNING id"
            ).fetchone()[0]
            connection.commit()

        migrate("head")
        with psycopg.connect(**connection_args) as connection:
            existing = connection.execute(
                "SELECT default_currency, warranty_reminder_days FROM households WHERE id = %s",
                (household_id,),
            ).fetchone()
            assert existing == ("USD", 45)
            new_id = connection.execute(
                "INSERT INTO households (name) VALUES ('New home') RETURNING id"
            ).fetchone()[0]
            new_default = connection.execute(
                "SELECT default_currency FROM households WHERE id = %s",
                (new_id,),
            ).fetchone()[0]
            assert new_default == "USD"
            connection.commit()

        subprocess.run(
            [sys.executable, "-m", "alembic", "downgrade", "c2d3e4f5a6b7"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )
        with psycopg.connect(**connection_args) as connection:
            column_count = connection.execute(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'households' "
                "AND column_name = 'default_currency'"
            ).fetchone()[0]
            assert column_count == 0
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
