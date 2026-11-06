#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Bind the status screen to the source being deployed rather than a dynamic
# runtime lookup. Operators can override these for server releases.
export RELEASE_COMMIT="${RELEASE_COMMIT:-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
export RELEASE_BUILD_TIME="${RELEASE_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export RELEASE_CHANNEL="${RELEASE_CHANNEL:-local}"
export SERVER_IDENTITY="${SERVER_IDENTITY:-$(hostname 2>/dev/null || echo local)}"

exec docker compose "$@"
