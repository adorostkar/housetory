# Housetory

> **Everything has a place.**

Housetory is a private, self-hosted inventory for your home. Rooms hold nested
storage places, items hold photographs, receipts, warranties and purchase
details, and everything can be found again from one calm interface.

Designed for a CPU-only Linux server, reached securely through Tailscale, and
installed on an iPhone as a PWA.

![Status: foundation complete](https://img.shields.io/badge/status-foundation_complete-56614f)

## What is working

- First-run owner setup, Argon2id passwords and session authentication.
- A responsive React application with light/dark modes, designed for desktop and
  iPhone.
- Rooms with optional nesting; shelves, cabinets, drawers and boxes with
  unlimited nesting.
- Items with search, filters, quantities, condition, categories and tags.
- Multiple item photographs with validation, thumbnail generation, EXIF
  stripping and HEIC conversion.
- Receipts and manuals attached to items, stored on a persistent local volume.
- Purchase prices grouped by currency, warranty dates and an overview dashboard.
- PostgreSQL-backed background worker for maintenance jobs.
- Docker Compose deployment with health checks, migrations, backups and
  Tailscale HTTPS guidance.
- Automated backend and frontend tests.

### Foundation verification

The foundation in this repository has been exercised against the real Compose
stack, not just unit mocks:

- 37 pytest tests pass against PostgreSQL, including a fresh Alembic migration.
- 11 Vitest tests pass; strict TypeScript typecheck and production build pass.
- `docker compose up --build` brings all services healthy; the worker processed
  real queued maintenance jobs.
- A headless Chrome walkthrough covered first-run setup, room/location creation,
  item creation, multi-photo and document upload, search, dark mode, settings
  and mobile layouts with no console errors or failed requests.
- Backup, checksum verification and destructive restore were rehearsed locally.
  The restore drill exposed and fixed stale nginx upstream resolution after API
  recreation.

The foundation is intentionally not the whole product. Custom fields, category/
tag management UI, multi-user sharing, password changes, the Tauri macOS shell
and browser E2E tests are not implemented yet. See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), which separates shipped work
from remaining work.

## Quick start with Docker Compose

Requirements: Docker Engine 24+ with Compose v2. For remote access, a Linux
server joined to your Tailscale tailnet.

```bash
git clone <your-repository-url> housetory
cd housetory

cp .env.example .env
# Generate a URL-safe database password and put it in POSTGRES_PASSWORD:
openssl rand -hex 24
$EDITOR .env

docker compose up --build -d
```

Then visit <http://localhost:8080>. On first launch Housetory asks you to create
the single owner account and name your household. No demo data is inserted.

Check the deployment:

```bash
docker compose ps
docker compose logs -f api worker
curl -fsS http://localhost:8080/api/v1/health/ready
```

The `migrate` service applies Alembic migrations before the API and worker start.
The web port is published only on `127.0.0.1`; PostgreSQL and the API have no host
ports.

## Secure remote access from iPhone

Housetory is designed to be exposed through **Tailscale Serve**, never the public
internet. Tailscale terminates HTTPS with a trusted certificate on your tailnet,
so the iPhone can install Housetory as a standalone home-screen app.

1. Install Tailscale on the server and sign in: `tailscale up`.
2. Find the machine's MagicDNS name: `tailscale status`.
3. Set in `.env`:
   ```dotenv
   APP_BASE_URL=https://your-machine.your-tailnet.ts.net
   COOKIE_SECURE=true
   ```
4. Recreate the application: `docker compose up -d`.
5. Publish it on your tailnet:
   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:8080
   tailscale serve status
   ```
6. On the iPhone, install Tailscale, sign in to the same tailnet, open the HTTPS
   address in Safari, tap Share → **Add to Home Screen**.

Do **not** use `tailscale funnel`; it would expose the app publicly. Do not add
router port forwards for this stack. Full details and troubleshooting are in
[`docs/TAILSCALE.md`](docs/TAILSCALE.md).

## Configuration

Copy `.env.example` to `.env`. Compose reads this file for variable substitution.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` | `housetory` | Database role |
| `POSTGRES_DB` | `housetory` | Database name |
| `POSTGRES_PASSWORD` | — | **Required.** URL-safe password (use hex) |
| `APP_BASE_URL` | `http://localhost:8080` | Public origin used for cookie/origin checks |
| `COOKIE_SECURE` | `false` | Must be `true` behind Tailscale HTTPS |
| `WEB_PORT` | `8080` | Loopback-only host port for nginx |
| `SESSION_TTL_DAYS` | `30` | Login lifetime |
| `MAX_UPLOAD_MB` | `25` | Per-file upload cap |
| `EXTRA_ORIGINS` | empty | Comma-separated extra allowed origins (normally empty) |

Inside the containers the API uses `DATABASE_URL`, `DATA_DIR=/data`,
`UPLOADS_DIR=/data/uploads` and `ENVIRONMENT=production`. Secrets are never
committed.

Changing `APP_BASE_URL` requires recreating the API container and signing in
again if the cookie domain policy changes.

## Data, backups and restore

Persistent named volumes:

- `housetory_pgdata` — PostgreSQL
- `housetory_uploads` — item photographs and documents

Create a verified backup (PostgreSQL custom dump + uploads tar + SHA-256 sums):

```bash
./scripts/backup.sh
```

Backups land in `./backups/housetory-<UTC timestamp>/`. Copy them off the server
and schedule the script with cron or a systemd timer.

Restore **replaces** the current database and uploads:

```bash
./scripts/restore.sh ./backups/housetory-20261104T120000Z
```

The restore script verifies checksums, stops the API and worker, recreates the
database, restores files, runs migrations and restarts the stack. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the consistency trade-off.

Never delete a Docker volume unless you intend to lose data. To reset a
development environment only:

```bash
docker compose down -v   # destructive: deletes database and uploads
```

## Local development

The easiest development loop is PostgreSQL in Docker plus API, worker and web
running on the host.

```bash
cp .env.example .env
# For local development, a simple password such as "housetory-dev" is fine.

docker compose -f compose.yaml -f compose.dev.yaml up -d db
```

Create a shell environment for the API (the compose override exposes PostgreSQL
on `127.0.0.1:5432`):

```bash
cd services/api
uv sync --extra dev

export DATABASE_URL="postgresql+psycopg://housetory:<password-from-.env>@127.0.0.1:5432/housetory"
export ENVIRONMENT=development
export APP_BASE_URL=http://localhost:8080
export COOKIE_SECURE=false

uv run alembic upgrade head
uv run uvicorn housetory_api.main:app --reload --port 8000
```

In a second terminal, run the worker from the repository root:

```bash
PYTHONPATH=services/api:services/worker \
  services/api/.venv/bin/python -m housetory_worker
```

In a third terminal, run the web app:

```bash
cd apps/web
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to
`http://127.0.0.1:8000`, so cookies remain same-origin. API documentation is
available at <http://127.0.0.1:8000/api/docs> in development only.

### Tests

Backend tests use a **real PostgreSQL** database, create `housetory_test`, run the
actual Alembic migration, and truncate between tests.

```bash
cd services/api
uv run pytest
uv run ruff check housetory_api tests
```

Default test connection:
`postgresql+psycopg://housetory:housetory@127.0.0.1:5432/housetory_test`.
Override it with `HOUSETORY_TEST_DATABASE_URL`. The role needs `CREATEDB`.

If you are using the Compose development database above, point the tests at its
credentials and create an isolated test database name:

```bash
export HOUSETORY_TEST_DATABASE_URL="postgresql+psycopg://housetory:<password-from-.env>@127.0.0.1:5432/housetory_test"
cd services/api && uv run pytest
```

If you do not already have PostgreSQL locally:

```bash
docker run -d --rm --name housetory-test-db \
  -e POSTGRES_USER=housetory \
  -e POSTGRES_PASSWORD=housetory \
  -p 127.0.0.1:5432:5432 postgres:16-alpine
```

Frontend:

```bash
cd apps/web
npm run typecheck
npm run test
npm run build
```

### Useful Compose commands

```bash
docker compose ps
docker compose logs -f api worker web
docker compose exec db psql -U housetory -d housetory
docker compose run --rm migrate      # apply pending migrations
docker compose up -d --build          # update after pulling
docker compose down                   # stop, keep data
```

`./scripts/compose.sh` is a convenience wrapper for `docker compose`.

## API

- Base path: `/api/v1`
- Health: `/api/v1/health/live`, `/api/v1/health/ready`
- Authentication: opaque sessions in `HttpOnly`, `SameSite=Lax` cookies.
- All inventory is scoped to the signed-in household; cross-household requests
  return 404.
- Structured errors: `{"detail": {"code", "message", "fields"}}`.
- Uploaded files are only served through authenticated endpoints.

The endpoint inventory and data model are documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Project layout

```
apps/web/               React application
apps/desktop/           Tauri 2 placeholder (deferred)
services/api/           FastAPI, SQLAlchemy, Alembic, pytest
services/worker/        PostgreSQL job worker
infrastructure/docker/  Dockerfiles and nginx
docs/                   Tailscale and operations
scripts/                backup, restore, compose helpers
compose.yaml            Production topology
compose.dev.yaml        Loopback Postgres exposure for development only
```

## Security notes

- Only nginx binds a host port, and only to loopback.
- PostgreSQL and FastAPI are reachable only inside the Compose network.
- API and worker run read-only, non-root, without new privileges.
- nginx sends CSP, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions
  headers.
- Passwords use Argon2id; session tokens are stored hashed.
- Upload MIME types are validated by content, not by HTTP headers.
- Images are re-encoded, which strips location metadata.
- Keep the host patched, leave Tailscale Funnel off, and back up off-server.

## Design direction

The interface avoids admin-template conventions: warm stone backgrounds, an
editorial serif display face, restrained sage/brass accents, spacious layouts,
hairline borders, real photography, and motion that stays out of the way. Light
and dark modes are designed independently, and the mobile experience uses a
native-style tab bar with safe-area support.

## License

No license has been chosen yet. Treat this repository as private until a license
is added.
