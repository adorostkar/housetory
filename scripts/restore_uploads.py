#!/usr/bin/env python3
"""Safely validate or extract a Housetory uploads backup archive.

Reads a gzipped tar stream on stdin. Rejects absolute paths, parent traversal,
links, devices, FIFOs, and duplicate paths before touching the uploads volume.
"""

import argparse
import os
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

DEFAULT_ROOT = Path(os.environ.get("UPLOADS_ROOT", "/data/uploads"))


def _safe_member(member: tarfile.TarInfo) -> None:
    if member.name in {".", "./"}:
        if not member.isdir():
            raise SystemExit("unsafe archive: root entry is not a directory")
        return
    name = PurePosixPath(member.name)
    if name.is_absolute():
        raise SystemExit(f"unsafe archive: absolute path {member.name!r}")
    if any(part in {"", ".."} for part in name.parts):
        raise SystemExit(f"unsafe archive: traversal path {member.name!r}")
    if not (member.isfile() or member.isdir()):
        raise SystemExit(f"unsafe archive: unsupported entry type for {member.name!r}")
    if member.size < 0:
        raise SystemExit(f"unsafe archive: invalid size for {member.name!r}")


def _check() -> None:
    count = 0
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
        seen: set[str] = set()
        for member in archive:
            _safe_member(member)
            if member.name not in {".", "./"}:
                normalized = str(PurePosixPath(member.name))
                if normalized in seen:
                    raise SystemExit(f"unsafe archive: duplicate path {member.name!r}")
                seen.add(normalized)
            count += 1
    print(f"validated {count} archive entries")


def _extract(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    # The uploads root is a Docker volume mount point; remove its contents
    # rather than the mount point itself.
    for child in root.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)

    seen: set[str] = set()
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
        for member in archive:
            _safe_member(member)
            if member.name in {".", "./"}:
                continue
            normalized = str(PurePosixPath(member.name))
            if normalized in seen:
                raise SystemExit(f"unsafe archive: duplicate path {member.name!r}")
            seen.add(normalized)
            target = (root / member.name).resolve()
            if root not in target.parents:
                raise SystemExit(f"unsafe archive: target escapes uploads root {member.name!r}")
            archive.extract(member, root, filter="data", set_attrs=True)

    for path in root.rglob("*"):
        try:
            if path.is_file():
                os.chmod(path, 0o600)
            elif path.is_dir():
                os.chmod(path, 0o700)
        except OSError:
            pass
    print("uploads restored")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--extract", action="store_true")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    if args.check == args.extract:
        parser.error("choose exactly one of --check or --extract")
    if args.check:
        _check()
    else:
        _extract(args.root.resolve())


if __name__ == "__main__":
    main()
