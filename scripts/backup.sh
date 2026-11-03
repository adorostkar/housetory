#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_ROOT="${BACKUP_DIR:-$ROOT/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_ROOT/housetory-$timestamp"

mkdir -p "$target"

if ! docker compose ps --status running --services | grep -qx "api"; then
  echo "The api service must be running to take a consistent backup." >&2
  echo "Start it with: docker compose up -d" >&2
  exit 1
fi

echo "Backing up PostgreSQL..."
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$target/database.dump"

echo "Backing up uploaded files..."
docker compose exec -T api sh -c 'tar -C /data/uploads -czf - .' > "$target/uploads.tar.gz"

size_db="$(wc -c < "$target/database.dump" | tr -d ' ')"
size_uploads="$(wc -c < "$target/uploads.tar.gz" | tr -d ' ')"

cat > "$target/manifest.txt" <<EOF
Housetory backup
created_at=$timestamp
database=postgresql
database_bytes=$size_db
uploads_bytes=$size_uploads
EOF

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$target" && sha256sum database.dump uploads.tar.gz > SHA256SUMS)
else
  (cd "$target" && shasum -a 256 database.dump uploads.tar.gz > SHA256SUMS)
fi

echo "Backup written to $target"
echo "Copy this directory somewhere off the server."
