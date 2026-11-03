import os
import subprocess
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]


def test_migrations_are_current():
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "check"],
        cwd=API_DIR,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "No new upgrade operations detected" in result.stdout + result.stderr


def test_single_initial_revision():
    versions = list((API_DIR / "alembic" / "versions").glob("*.py"))
    assert len(versions) == 1
    assert "down_revision: str | None = None" in versions[0].read_text()
