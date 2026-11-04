#!/usr/bin/env bash
# One-time upgrade for databases created before the API/worker role split.
# This runs as the PostgreSQL admin role; the API/worker keep using the
# least-privilege role defined by HOUSETORY_APP_USER.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! docker compose ps --status running --services | grep -qx "db"; then
  echo "The db service must be running. Start it with: docker compose up -d db" >&2
  exit 1
fi

docker compose exec -T db sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --set=app_user="$HOUSETORY_APP_USER" \
    --set=app_password="$HOUSETORY_APP_PASSWORD" \
    --set=db_name="$POSTGRES_DB"' \
  < scripts/create-app-role.sql

echo "Application database role created/updated and granted DML privileges."
echo "Recreate the API and worker with: docker compose up -d --force-recreate api worker"
