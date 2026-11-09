import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url


def test_item_disposition_migration_preserves_nulls_enforces_checks_and_downgrades():
    test_database_url = os.environ.get(
        "HOUSETORY_TEST_DATABASE_URL",
        "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
    )
    admin_url = make_url(test_database_url)
    database_name = f"housetory_disposition_migration_{uuid.uuid4().hex[:8]}"
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

    def assert_check_violation(connection, sql, parameters, constraint_name):
        with (
            pytest.raises(psycopg.errors.CheckViolation) as caught,
            connection.transaction(),
        ):
            connection.execute(sql, parameters)
        assert caught.value.diag.constraint_name == constraint_name

    try:
        migrate("d3e5f7a9b1c2")
        with psycopg.connect(**connection_args) as connection:
            household_id = connection.execute(
                "INSERT INTO households (name) VALUES ('Disposition migration') RETURNING id"
            ).fetchone()[0]
            active_id = connection.execute(
                "INSERT INTO items (household_id, name, is_archived) "
                "VALUES (%s, 'Existing active item', false) RETURNING id",
                (household_id,),
            ).fetchone()[0]
            archived_id = connection.execute(
                "INSERT INTO items (household_id, name, is_archived) "
                "VALUES (%s, 'Existing archived item', true) RETURNING id",
                (household_id,),
            ).fetchone()[0]
            connection.commit()

        migrate("head")
        with psycopg.connect(**connection_args) as connection:
            existing = {
                row[0]: row[1:]
                for row in connection.execute(
                    "SELECT id, disposition, disposed_on, disposition_note FROM items"
                ).fetchall()
            }
            assert existing == {active_id: (None, None, None), archived_id: (None, None, None)}

            assert_check_violation(
                connection,
                "UPDATE items SET disposition = 'recycled' WHERE id = %s",
                (archived_id,),
                "ck_items_valid_disposition",
            )
            assert_check_violation(
                connection,
                "UPDATE items SET disposition = 'sold' WHERE id = %s",
                (active_id,),
                "ck_items_disposition_requires_archive",
            )
            assert_check_violation(
                connection,
                "UPDATE items SET disposed_on = '2026-11-01' WHERE id = %s",
                (archived_id,),
                "ck_items_disposition_reason_required",
            )
            assert_check_violation(
                connection,
                "UPDATE items SET disposition_note = 'Missing reason' WHERE id = %s",
                (archived_id,),
                "ck_items_disposition_reason_required",
            )
            connection.execute(
                "INSERT INTO items "
                "(household_id, name, is_archived, disposition, disposed_on, disposition_note) "
                "VALUES (%s, 'Disposed item', true, 'donated', '2026-11-01', 'Given to charity')",
                (household_id,),
            )
            connection.commit()

        subprocess.run(
            [sys.executable, "-m", "alembic", "downgrade", "d3e5f7a9b1c2"],
            cwd=api_dir,
            env={**os.environ, "DATABASE_URL": database_url},
            check=True,
            capture_output=True,
        )
        with psycopg.connect(**connection_args) as connection:
            columns = connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'items' "
                "AND column_name IN ('disposition', 'disposed_on', 'disposition_note')"
            ).fetchall()
            assert columns == []
            assert connection.execute("SELECT count(*) FROM items").fetchone()[0] == 3
    finally:
        with psycopg.connect(**admin_args, autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
