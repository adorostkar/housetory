#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup-directory> [--yes]" >&2
  exit 1
fi

source_dir="$(cd "$1" && pwd)"
shift || true
assume_yes=false
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  assume_yes=true
fi

for file in database.dump uploads.tar.gz SHA256SUMS; do
  if [ ! -f "$source_dir/$file" ]; then
    echo "Missing $file in $source_dir" >&2
    exit 1
  fi
done

echo "Verifying backup checksums..."
(cd "$source_dir" && \
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)

if [ "$assume_yes" != true ]; then
  echo
  echo "This will REPLACE the current database and uploaded files with:"
  echo "  $source_dir"
  read -r -p "Type 'restore' to continue: " confirmation
  if [ "$confirmation" != "restore" ]; then
    echo "Restore cancelled."
    exit 1
  fi
fi

echo "Stopping application services..."
docker compose stop api worker

echo "Recreating the database..."
docker compose exec -T db sh -c \
  'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

echo "Restoring PostgreSQL..."
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
  < "$source_dir/database.dump"

echo "Restoring uploaded files..."
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'find /data/uploads -mindepth 1 -delete && tar -xzf - -C /data/uploads' \
  < "$source_dir/uploads.tar.gz"

echo "Applying any newer migrations..."
docker compose run --rm migrate

echo "Starting services..."
docker compose up -d
echo "Restore complete."
