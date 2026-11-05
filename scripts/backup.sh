#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_ROOT="${BACKUP_DIR:-$ROOT/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_ROOT/housetory-$timestamp"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
if [ -e "$target" ]; then
  echo "Backup target already exists: $target" >&2
  exit 1
fi
mkdir "$target"
chmod 700 "$target"

if ! docker compose ps --status running --services | grep -qx "api"; then
  echo "The api service must be running to take a consistent backup." >&2
  echo "Start it with: docker compose up -d" >&2
  exit 1
fi
if ! docker compose ps --status running --services | grep -qx "db"; then
  echo "The db service must be running to take a backup." >&2
  exit 1
fi

database_name="$(docker compose exec -T db sh -c 'printf %s "$POSTGRES_DB"')"
compose_project="$(docker compose ps -a --format '{{.Project}}' | head -n 1 || true)"
if [ -z "$database_name" ] || [ -z "$compose_project" ]; then
  echo "Could not determine the database or Compose project name." >&2
  exit 1
fi

echo "Backing up PostgreSQL..."
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$target/database.dump"

echo "Backing up uploaded files..."
docker compose exec -T api sh -c 'tar -C /data/uploads -czf - .' > "$target/uploads.tar.gz"

echo "Backing up import sources and vault files..."
docker compose exec -T api sh -c 'tar -C /data/imports -czf - .' > "$target/imports.tar.gz"

echo "Backing up private evidence export artifacts..."
docker compose exec -T api sh -c 'if [ -d /data/exports ]; then tar -C /data/exports -czf - .; else tar -czf - --files-from /dev/null; fi' > "$target/exports.tar.gz"

chmod 600 "$target/database.dump" "$target/uploads.tar.gz" "$target/imports.tar.gz" "$target/exports.tar.gz"

size_db="$(wc -c < "$target/database.dump" | tr -d ' ')"
size_uploads="$(wc -c < "$target/uploads.tar.gz" | tr -d ' ')"
size_imports="$(wc -c < "$target/imports.tar.gz" | tr -d ' ')"
size_exports="$(wc -c < "$target/exports.tar.gz" | tr -d ' ')"

cat > "$target/manifest.txt" <<EOF
Housetory backup
created_at=$timestamp
database=postgresql
database_name=$database_name
compose_project=$compose_project
backup_host=$(hostname 2>/dev/null || printf 'unknown')
database_bytes=$size_db
uploads_bytes=$size_uploads
imports_bytes=$size_imports
exports_bytes=$size_exports
EOF
chmod 600 "$target/manifest.txt"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$target" && sha256sum database.dump uploads.tar.gz imports.tar.gz exports.tar.gz > SHA256SUMS)
else
  (cd "$target" && shasum -a 256 database.dump uploads.tar.gz imports.tar.gz exports.tar.gz > SHA256SUMS)
fi
chmod 600 "$target/SHA256SUMS"

echo "Backup written to $target"
echo "Permissions are restricted to the current user. Backups are not encrypted;"
echo "encrypt them before copying off-server and store them somewhere protected."
