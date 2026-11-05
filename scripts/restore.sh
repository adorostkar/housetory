#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup-directory> [--yes] [--allow-target-mismatch]" >&2
  exit 1
fi

source_dir="$(cd "$1" && pwd)"
shift || true
assume_yes=false
allow_target_mismatch=false
for argument in "$@"; do
  case "$argument" in
    --yes|-y) assume_yes=true ;;
    --allow-target-mismatch) allow_target_mismatch=true ;;
    *)
      echo "Unknown option: $argument" >&2
      exit 1
      ;;
  esac
done

for file in database.dump uploads.tar.gz SHA256SUMS manifest.txt; do
  if [ ! -f "$source_dir/$file" ]; then
    echo "Missing $file in $source_dir" >&2
    exit 1
  fi
done

# Imports and private evidence exports were added after the original backup
# format. Older backups remain restorable; newer backups include both volumes.
has_imports=false
if [ -f "$source_dir/imports.tar.gz" ]; then
  has_imports=true
fi
has_exports=false
if [ -f "$source_dir/exports.tar.gz" ]; then
  has_exports=true
fi

echo "Verifying backup checksums..."
(cd "$source_dir" && \
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)

manifest_value() {
  sed -n "s/^$1=//p" "$source_dir/manifest.txt" | head -n 1
}

backup_database="$(manifest_value database_name)"
backup_project="$(manifest_value compose_project)"
if [ -z "$backup_database" ] || [ -z "$backup_project" ]; then
  echo "Backup manifest is incomplete; refusing to restore." >&2
  exit 1
fi

if ! docker compose ps --status running --services | grep -qx "db"; then
  echo "The db service must be running before restoring. Start it with: docker compose up -d db" >&2
  exit 1
fi

current_database="$(docker compose exec -T db sh -c 'printf %s "$POSTGRES_DB"')"
current_project="$(docker compose ps -a --format '{{.Project}}' | head -n 1 || true)"

if [ "$backup_database" != "$current_database" ] || [ "$backup_project" != "$current_project" ]; then
  echo "Restore target does not match the backup:" >&2
  echo "  backup database: $backup_database (project $backup_project)" >&2
  echo "  current database: $current_database (project $current_project)" >&2
  if [ "$allow_target_mismatch" != true ]; then
    echo "Refusing to overwrite the wrong database. Pass --allow-target-mismatch only if this is intentional." >&2
    exit 1
  fi
  echo "Proceeding because --allow-target-mismatch was explicitly supplied." >&2
fi

echo "Validating uploads archive..."
docker compose run --rm --no-deps -T \
  -v "$ROOT/scripts:/scripts:ro" \
  --entrypoint python api /scripts/restore_uploads.py --check \
  < "$source_dir/uploads.tar.gz"

if [ "$has_imports" = true ]; then
  echo "Validating imports archive..."
  docker compose run --rm --no-deps -T \
    -v "$ROOT/scripts:/scripts:ro" \
    --entrypoint python api /scripts/restore_uploads.py --check \
    < "$source_dir/imports.tar.gz"
fi

if [ "$has_exports" = true ]; then
  echo "Validating evidence export archive..."
  docker compose run --rm --no-deps -T \
    -v "$ROOT/scripts:/scripts:ro" \
    --entrypoint python api /scripts/restore_uploads.py --check \
    < "$source_dir/exports.tar.gz"
fi

if [ "$assume_yes" != true ]; then
  echo
  echo "This will REPLACE the current database and uploaded files with:"
  echo "  $source_dir"
  echo "  database: $current_database (project $current_project)"
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

# Recreating the database also removes its CONNECT/table/sequence grants and
# default privileges. Reapply the least-privilege application role before the
# API and worker start.
echo "Restoring application role privileges..."
docker compose exec -T db sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --set=app_user="$HOUSETORY_APP_USER" \
    --set=app_password="$HOUSETORY_APP_PASSWORD" \
    --set=db_name="$POSTGRES_DB"' \
  < scripts/create-app-role.sql

echo "Restoring uploaded files..."
docker compose run --rm --no-deps -T \
  -v "$ROOT/scripts:/scripts:ro" \
  --entrypoint python api /scripts/restore_uploads.py --extract \
  < "$source_dir/uploads.tar.gz"

if [ "$has_imports" = true ]; then
  echo "Restoring import sources..."
  docker compose run --rm --no-deps -T \
    -v "$ROOT/scripts:/scripts:ro" \
    --entrypoint python api /scripts/restore_uploads.py --extract --root /data/imports \
    < "$source_dir/imports.tar.gz"
fi

if [ "$has_exports" = true ]; then
  echo "Restoring private evidence export artifacts..."
  docker compose run --rm --no-deps -T \
    -v "$ROOT/scripts:/scripts:ro" \
    --entrypoint python api /scripts/restore_uploads.py --extract --root /data/exports \
    < "$source_dir/exports.tar.gz"
fi

echo "Applying any newer migrations..."
docker compose run --rm migrate

echo "Starting services..."
docker compose up -d
echo "Restore complete."
