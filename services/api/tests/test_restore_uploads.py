import io
import os
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "restore_uploads.py"


def tar_stream(entries) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for entry in entries:
            name = entry["name"]
            if entry.get("type") == "dir":
                info = tarfile.TarInfo(name)
                info.type = tarfile.DIRTYPE
                info.mode = 0o700
                archive.addfile(info)
                continue
            if entry.get("type") == "symlink":
                info = tarfile.TarInfo(name)
                info.type = tarfile.SYMTYPE
                info.linkname = entry.get("target", "/etc/passwd")
                archive.addfile(info)
                continue
            data = entry.get("data", b"")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def run(arguments: list[str], archive: bytes) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        input=archive,
        capture_output=True,
        check=False,
    )


def test_valid_archive_validates():
    archive = tar_stream(
        [
            {"name": "./", "type": "dir"},
            {"name": "./items/a/photo.jpg", "data": b"photo"},
            {"name": "./households/b/documents/receipt.pdf", "data": b"pdf"},
            {
                "name": "./households/b/documents/originals/receipt.pdf",
                "data": b"original-pdf",
            },
        ]
    )
    result = run(["--check"], archive)
    assert result.returncode == 0, result.stderr.decode()
    assert "validated 4 archive entries" in result.stdout.decode()


def test_parent_traversal_is_rejected(tmp_path):
    archive = tar_stream([{"name": "../escape.txt", "data": b"escape"}])
    result = run(["--extract", "--root", str(tmp_path / "uploads")], archive)
    assert result.returncode != 0
    assert "unsafe archive" in result.stderr.decode()
    assert not (tmp_path / "escape.txt").exists()


def test_absolute_path_is_rejected(tmp_path):
    archive = tar_stream([{"name": "/tmp/housetory-escape.txt", "data": b"escape"}])
    result = run(["--check"], archive)
    assert result.returncode != 0
    assert "unsafe archive" in result.stderr.decode()


def test_symlink_is_rejected(tmp_path):
    archive = tar_stream([{"name": "photos/link", "type": "symlink", "target": "/etc/passwd"}])
    result = run(["--extract", "--root", str(tmp_path / "uploads")], archive)
    assert result.returncode != 0
    assert "unsupported entry type" in result.stderr.decode()


def test_duplicate_path_is_rejected():
    archive = tar_stream(
        [
            {"name": "items/a/photo.jpg", "data": b"one"},
            {"name": "items/a/photo.jpg", "data": b"two"},
        ]
    )
    result = run(["--check"], archive)
    assert result.returncode != 0
    assert "duplicate path" in result.stderr.decode()


def test_valid_archive_extracts_private_files(tmp_path):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "old").write_bytes(b"stale")
    archive = tar_stream(
        [
            {"name": "./", "type": "dir"},
            {"name": "./items/a/photo.jpg", "data": b"photo-data"},
            {"name": "./households/b/documents/receipt.pdf", "data": b"pdf-data"},
            {
                "name": "./households/b/documents/originals/receipt.pdf",
                "data": b"original-pdf-data",
            },
        ]
    )
    result = run(["--extract", "--root", str(uploads)], archive)
    assert result.returncode == 0, result.stderr.decode()
    assert not (uploads / "old").exists()
    photo = uploads / "items/a/photo.jpg"
    assert photo.read_bytes() == b"photo-data"
    original = uploads / "households/b/documents/originals/receipt.pdf"
    assert original.read_bytes() == b"original-pdf-data"
    assert stat.S_IMODE(os.stat(photo).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(uploads).st_mode) == 0o700


def test_restore_reapplies_least_privilege_role_grants():
    restore_script = SCRIPT.parent / "restore.sh"
    text = restore_script.read_text()
    assert "create-app-role.sql" in text
    assert "Restoring application role privileges" in text
