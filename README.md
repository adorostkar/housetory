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
- Hierarchy-aware browsing: room and place filters include descendants, counts
  aggregate nested items, and room selections are deep-linkable.
- Items with search across room, place, category, tag and item fields; quantities,
  condition, categories and tags.
- Multiple item photographs with validation, thumbnail generation, EXIF
  stripping, HEIC conversion, cover selection and a full-screen viewer.
- One-tap camera capture on iPhone alongside library uploads.
- Receipts and manuals attached to items, stored on a persistent local volume.
- Purchase prices grouped by currency, warranty dates and an overview dashboard.
- PostgreSQL-backed background worker for maintenance jobs.
- Docker Compose deployment with health checks, migrations, backups and
  Tailscale HTTPS guidance.
- Automated backend and frontend tests.

### Foundation verification

The foundation in this repository has been exercised against the real Compose
stack, not just unit mocks:

- 72 pytest tests pass against PostgreSQL, including a fresh Alembic migration,
  authentication/abuse controls, hierarchy semantics and exhaustive cross-
  household access checks.
- 16 Vitest tests pass; strict TypeScript typecheck and production build pass.
- `docker compose up --build` brings all services healthy; the worker processed
  real queued maintenance jobs.
- Headless Chrome walkthroughs covered first-run setup, nested rooms/places,
  item creation and editing, multi-photo and document uploads, cover selection,
  the photo viewer, hierarchy-aware filtering/search and mobile layouts with no
  console errors or failed requests.
- Backup permissions, checksum verification, archive extraction safety, target
  checks and a full destructive restore were rehearsed locally, including
  authenticating and retrieving photos/documents after restore.
- Production dependency audits report no known Python or npm vulnerabilities.
  Final application images scan with zero fixable HIGH/CRITICAL vulnerabilities.

The Phase 2 desktop/iPhone walkthrough, screenshots and remaining limitations are
in [`docs/PHASE_2_WALKTHROUGH.md`](docs/PHASE_2_WALKTHROUGH.md).

The pre-deployment security review, findings and remaining risks are in
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). Passing tests do not constitute a
guarantee of production security.

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
# Generate two URL-safe passwords:
#   1. POSTGRES_PASSWORD        — admin role for migrations/backups/restore only
#   2. HOUSETORY_APP_PASSWORD   — least-privilege role used by API and worker
openssl rand -hex 24
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
| `POSTGRES_USER` | `housetory` | Admin database role (migrations/backup/restore) |
| `POSTGRES_DB` | `housetory` | Database name |
| `POSTGRES_PASSWORD` | — | **Required.** Admin password (use hex) |
| `HOUSETORY_APP_USER` | `housetory_app` | DML-only role used by API/worker |
| `HOUSETORY_APP_PASSWORD` | — | **Required.** Separate app-role password (use hex) |
| `APP_BASE_URL` | `http://localhost:8080` | Public origin used for cookie/origin checks |
| `COOKIE_SECURE` | `false` | Must be `true` behind Tailscale HTTPS |
| `WEB_PORT` | `8080` | Loopback-only host port for nginx |
| `SESSION_TTL_DAYS` | `30` | Login lifetime |
| `MAX_UPLOAD_MB` | `25` | Per-file upload cap |
| `LOGIN_MAX_FAILURES` | `10` | Failed sign-ins per email/IP before throttling |
| `LOGIN_WINDOW_SECONDS` | `900` | Sliding throttle window |
| `EXTRA_ORIGINS` | empty | Comma-separated extra allowed origins (normally empty) |

`APP_BASE_URL` with an `https://` scheme requires `COOKIE_SECURE=true`; the API
refuses to start with an insecure cookie configuration. Production also rejects
remote plain-HTTP origins and `DEBUG=true`.

The API and worker connect with `HOUSETORY_APP_USER`, a non-superuser role with
DML privileges only. Alembic migrations use the admin role. Existing databases
created before this split need the one-time role migration:

```bash
./scripts/harden-db-role.sh
docker compose up -d --force-recreate api worker
```

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

Backups land in `./backups/housetory-<UTC timestamp>/` with directory mode `700`
and file mode `600`. The database and upload files contain private household
data and password hashes. **Backups are not encrypted by the script**; encrypt
them before copying off-server (for example with `age` or GPG) and keep them in
protected storage. Copy them off the server and schedule the script with cron or
a systemd timer.

Restore **replaces** the current database and uploads:

```bash
./scripts/restore.sh ./backups/housetory-20261104T120000Z
```

The restore script:

- verifies SHA-256 checksums;
- checks the backup's database name and Compose project against the live target
  and refuses to overwrite a mismatched database unless
  `--allow-target-mismatch` is explicitly supplied;
- validates the uploads archive and rejects absolute paths, `..` traversal,
  links, devices and duplicate entries before stopping services;
- requires typed confirmation unless `--yes` is supplied;
- stops the API and worker, recreates the database, restores files, runs
  migrations and restarts the stack.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the non-atomic snapshot trade-off.

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

- Only nginx binds a host port, and only to loopback. PostgreSQL and FastAPI are
  reachable only inside the Compose network.
- Web, API, worker and migration containers run non-root. API, worker, web and
  migrate drop all Linux capabilities; API/worker/web use read-only root
  filesystems with minimal tmpfs mounts and `no-new-privileges`.
- nginx sends CSP, HSTS, COOP/CORP, `X-Frame-Options: DENY`, `nosniff`, referrer
  and permissions headers. API and file responses are `no-store`; uploaded files
  are only available through authenticated endpoints.
- Passwords use Argon2id; only SHA-256 hashes of session tokens are stored;
  cookies are HttpOnly, SameSite=Lax and Secure whenever `APP_BASE_URL` is HTTPS.
  The API refuses to start with an HTTPS origin and an insecure cookie setting.
- The API/worker database role is not a superuser and cannot create databases or
  roles or alter schema. Only the one-shot migration and backup/restore paths use
  the admin role.
- Login failures are throttled per email and proxy address with a documented
  in-process limiter. It resets on restart and is single-process only.
- Cross-household access is denied for rooms, storage locations, categories,
  tags, items, photos and documents (covered by tests).
- Uploads are validated by content with an image-decoder allowlist and a PDF
  parser, re-encoded to strip metadata, size-capped, and stored with `0600`
  permissions under `0700` directories. PDFs and documents download as
  attachments rather than rendering in the application origin.
- Keep the host patched, rebuild images periodically, leave Tailscale Funnel
  off, use a private tailnet ACL, and encrypt backups before taking them
  off-server.
- **Complete first-run setup immediately.** Before the first owner exists, any
  client that can reach the application can claim it. The first-run endpoint is
  then locked, but Tailscale ACLs and immediate initialization are the
  mitigations.

See [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) for the full review and remaining
risks.

## Design direction

The interface avoids admin-template conventions: warm stone backgrounds, an
editorial serif display face, restrained sage/brass accents, spacious layouts,
hairline borders, real photography, and motion that stays out of the way. Light
and dark modes are designed independently, and the mobile experience uses a
native-style tab bar with safe-area support.

## License

No license has been chosen yet. Treat this repository as private until a license
is added.
