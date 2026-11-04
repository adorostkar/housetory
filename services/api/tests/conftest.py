import io
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from sqlalchemy.engine import make_url

API_DIR = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get(
    "HOUSETORY_TEST_DATABASE_URL",
    "postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test",
)
UPLOAD_ROOT = Path(tempfile.mkdtemp(prefix="housetory-test-uploads-"))
IMPORTS_ROOT = Path(tempfile.mkdtemp(prefix="housetory-test-imports-"))

os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["ENVIRONMENT"] = "test"
os.environ["APP_BASE_URL"] = "http://testserver"
os.environ["COOKIE_SECURE"] = "false"
os.environ["UPLOADS_DIR"] = str(UPLOAD_ROOT)
os.environ["IMPORTS_DIR"] = str(IMPORTS_ROOT)
# Deterministic Fernet key for credential tests. Production operators generate
# their own key outside the database.
os.environ["AI_CREDENTIAL_KEY"] = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

from sqlalchemy import text  # noqa: E402

from housetory_api.api.abuse import login_limiter  # noqa: E402
from housetory_api.db import engine  # noqa: E402
from housetory_api.main import app  # noqa: E402
from housetory_api.services.email import reset_captured_email  # noqa: E402


def _admin_connection() -> psycopg.Connection:
    url = make_url(TEST_DATABASE_URL)
    return psycopg.connect(
        host=url.host,
        port=url.port or 5432,
        user=url.username,
        password=url.password,
        dbname="postgres",
        autocommit=True,
    )


@pytest.fixture(scope="session", autouse=True)
def database() -> Iterator[None]:
    url = make_url(TEST_DATABASE_URL)
    database_name = url.database
    assert database_name is not None
    with _admin_connection() as connection:
        connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
        connection.execute(f'CREATE DATABASE "{database_name}"')

    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_DIR,
        check=True,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
    )
    yield
    engine.dispose()
    with _admin_connection() as connection:
        connection.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
    shutil.rmtree(UPLOAD_ROOT, ignore_errors=True)
    shutil.rmtree(IMPORTS_ROOT, ignore_errors=True)


@pytest.fixture(autouse=True)
def clean_state(database: None) -> Iterator[None]:
    with engine.begin() as connection:
        tables = connection.scalars(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
            )
        ).all()
        if tables:
            quoted = ", ".join(f'"{table}"' for table in tables)
            connection.execute(text(f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE"))
    shutil.rmtree(UPLOAD_ROOT, ignore_errors=True)
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(IMPORTS_ROOT, ignore_errors=True)
    IMPORTS_ROOT.mkdir(parents=True, exist_ok=True)
    login_limiter.reset_all()
    reset_captured_email()
    yield


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def anon_client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def upload_root() -> Path:
    return UPLOAD_ROOT


@pytest.fixture
def imports_root() -> Path:
    return IMPORTS_ROOT


@pytest.fixture
def pdf_bytes() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def owner_client(client: TestClient) -> TestClient:
    response = client.post(
        "/api/v1/auth/setup",
        json={
            "name": "Ada Lovelace",
            "email": "ada@example.com",
            "password": "analytical-engine-1843",
            "household_name": "Ada's Home",
        },
    )
    assert response.status_code == 201, response.text
    return client
