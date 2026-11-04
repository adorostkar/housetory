# Housetory

> **Everything has a place.**

Housetory is a private, self-hosted record of everything you own. Rooms hold
nested storage places; items carry photographs, receipts, manuals, warranties,
purchase history and current-value estimates. Local OCR reads receipts, a
searchable document library keeps the paperwork, and ownership reports stay
honest across multiple currencies.

Designed for a CPU-only Linux server, reached securely through Tailscale, and
installed on an iPhone as a PWA.

![Status: physical storage and smart labels complete](https://img.shields.io/badge/status-physical_storage_%2B_smart_labels_complete-56614f)

## What is working

- First-run owner setup, Argon2id passwords and session authentication.
- A responsive React application with light/dark modes, designed for desktop and
  iPhone.
- Rooms with optional nesting; shelves, cabinets, drawers and boxes with
  unlimited nesting.
- Movable containers (boxes, plastic bins, crates, suitcases and bags) with
  permanent human-readable identifiers such as `BOX-001`, optional names,
  live contents and private authenticated QR codes.
- Atomic cross-room moves that preserve the container UUID, identifier, QR
  identity, contents, nested places, document links and import provenance.
- Explicit conversion of existing storage places into containers; fixed shelves,
  cabinets and drawers can also receive optional identifiers such as
  `SHELF-001`.
- Deterministic contents summaries with quantities and category grouping, plus an
  optional AI headline that never replaces the actual item lines.
- A4 adhesive label printing with verified Avery L7160/L7163/L7165/L7651
  presets, compact/standard/detailed layouts, custom geometry, partial-sheet
  starting positions, calibration offsets, PDF preview and vector QR codes.
- Reverse search by `BOX-001` or item name, with container identifiers shown in
  item cards, search results and assistant answers.
- Hierarchy-aware browsing: room and place filters include descendants, counts
  aggregate nested items, and room selections are deep-linkable.
- Items with search across room, place, category, tag and item fields; quantities,
  condition, categories and tags.
- Multiple item photographs with validation, thumbnail generation, EXIF
  stripping, HEIC conversion, cover selection and a full-screen viewer.
- One-tap camera capture on iPhone alongside library uploads.
- A dedicated document library for receipts, invoices, warranty certificates,
  manuals, specifications and other files, associated with one or many items.
- PDF, JPEG, PNG, WebP, HEIC and text uploads; original uploads are preserved,
  safe downloads are normalized, and older documents remain readable.
- CPU-only local OCR through Tesseract and Poppler in the worker: merchant,
  purchase date, total, currency, invoice number, product names and serial
  numbers are proposed for explicit review before inventory changes.
- Shared purchase records: one purchase can cover several items without
  duplicating the amount, receipt or merchant.
- Warranties with provider, start date, duration, calculated expiration,
  certificate document, coverage notes, status and configurable reminders.
- Ownership overview with purchase value, estimated current value, category and
  room breakdowns, most valuable items and items missing purchase information.
- Multi-currency reporting that never adds currencies together; there is no
  implicit exchange rate.
- CSV exports for documents, purchases, warranties and inventory.
- AI-assisted bulk inventory import from pasted text, TXT, Markdown, CSV, XLSX,
  DOCX, PDF, OCR images and complete Obsidian ZIP vaults.
- Import review with per-field provenance, source context, inline missing-room and
  missing-place creation, duplicate candidates, merge/skip/reject decisions,
  partial approval, retry safety and import history.
- First-class Obsidian parsing: YAML frontmatter, properties, wikilinks and
  aliases, embeds, nested tags, Markdown tables, checklists, nested folders,
  attachment resolution, broken-link reporting and vault structure.
- A read-only grounded assistant using real household tools, with deterministic
  answers when no model is available, plus natural-language smart search.
- AI item recognition from photographs, with a deterministic OCR fallback and
  explicit create/update review.
- Document-to-item relationship suggestions that require explicit linking.
- Optional local Ollama or consented OpenAI-compatible inference. AI is disabled by
  default and ordinary Housetory functionality does not depend on it.
- PostgreSQL-backed background worker for maintenance, OCR, import and AI jobs.
- Docker Compose deployment with health checks, migrations, backups and
  Tailscale HTTPS guidance.
- Automated backend and frontend tests.

### Verification

The foundation in this repository has been exercised against the real Compose
stack, not just unit mocks:

- 141 pytest tests pass against PostgreSQL, including the full Alembic chain,
  authentication/abuse controls, hierarchy semantics, concurrent identifier
  allocation, container conversion, cross-room movement, rollback, cycles,
  summaries, PDF geometry, label calibration, archive security,
  import/duplicate/location review, AI-provider contracts, grounded tools, smart
  search, recognition, prompt-injection resistance and exhaustive
  cross-household access checks.
- 25 Vitest tests pass; strict TypeScript typecheck and production build pass.
- 4 checked-in Playwright workflows pass on a disposable Compose stack, covering
  unnamed/bulk container creation, cross-room movement, label preview/download,
  QR and mobile container views.
- `docker compose up --build` brings all services healthy; the worker processed
  real queued maintenance, OCR, import and recognition jobs.
- Real Tesseract OCR in the Compose worker extracted a photographed receipt
  (merchant, date, total, currency, invoice and serial), and the confirmed review
  created the purchase and attached the receipt.
- Headless Chrome walkthroughs covered first-run setup, nested rooms/places,
  item creation and editing, multi-photo and document uploads, cover selection,
  the photo viewer, hierarchy-aware filtering/search, document OCR review,
  shared purchases, warranty dashboards, ownership reports, a real Obsidian ZIP
  import with inline room creation, grounded assistant answers, smart search,
  OCR-fallback recognition, Phase 5 container creation/movement, QR labels, PDF
  label previews and mobile layouts with no console errors or failed requests.
- Backup permissions, checksum verification, archive extraction safety, target
  checks and a full destructive restore were rehearsed locally, including
  authenticating and retrieving photos/documents after restore.
- Production dependency audits report no known Python or npm vulnerabilities.
  Final application images scan with zero fixable HIGH/CRITICAL vulnerabilities.

The Phase 2 desktop/iPhone walkthrough, screenshots and remaining limitations are
in [`docs/PHASE_2_WALKTHROUGH.md`](docs/PHASE_2_WALKTHROUGH.md). The Phase 3
documents, OCR, purchase, warranty and ownership walkthrough is in
[`docs/PHASE_3_WALKTHROUGH.md`](docs/PHASE_3_WALKTHROUGH.md). The Phase 4 AI,
import and Obsidian walkthrough is in
[`docs/PHASE_4_WALKTHROUGH.md`](docs/PHASE_4_WALKTHROUGH.md), and the Phase 5
container, QR and label walkthrough is in
[`docs/PHASE_5_WALKTHROUGH.md`](docs/PHASE_5_WALKTHROUGH.md).

The pre-deployment security review, findings and remaining risks are in
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). Passing tests do not constitute a
guarantee of production security.

The product is intentionally not finished. Custom fields, category/tag
management UI, multi-user sharing, password changes and exchange-rate conversion
are not implemented yet. The Tauri macOS shell remains Phase 6. A checked-in
Playwright suite now covers the critical Phase 5 workflows.
AI extraction is review-only and heuristics remain approximate; no model is
bundled or downloaded automatically. See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), which separates shipped work
from remaining work and states the OCR, AI and multi-currency limitations
honestly.

## Quick start with Docker Compose

Requirements: Docker Engine 24+ with Compose v2. For remote access, a Linux
server joined to your Tailscale tailnet. The worker image installs Tesseract,
its English language data and Poppler at build time; no host OCR packages or GPU
are needed.

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
When `APP_BASE_URL` is a loopback URL, `localhost`, `127.0.0.1` and `[::1]` are
accepted interchangeably for local setup. If you reach the instance through a
LAN hostname or another origin, add that exact origin to `EXTRA_ORIGINS`.

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
| `QR_BASE_URL` | empty | Address encoded in printed QR labels; defaults to `APP_BASE_URL` |
| `COOKIE_SECURE` | `false` | Must be `true` behind Tailscale HTTPS |
| `WEB_PORT` | `8080` | Loopback-only host port for nginx |
| `SESSION_TTL_DAYS` | `30` | Login lifetime |
| `MAX_UPLOAD_MB` | `25` | Per-file upload cap |
| `LOGIN_MAX_FAILURES` | `10` | Failed sign-ins per email/IP before throttling |
| `LOGIN_WINDOW_SECONDS` | `900` | Sliding throttle window |
| `EXTRA_ORIGINS` | empty | Comma-separated extra allowed origins (normally empty) |
| `OCR_LANGUAGE` | `eng` | Tesseract language code installed in the worker image |
| `OCR_MAX_PDF_PAGES` | `5` | Maximum scanned PDF pages rendered for OCR |
| `AI_PROVIDER` | `disabled` | `disabled`, `ollama`, or `openai_compatible` |
| `AI_MODEL` | empty | Local Ollama model name |
| `AI_BASE_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `AI_TIMEOUT_SECONDS` | `90` | Inference request timeout |
| `AI_MAX_CONCURRENCY` | `1` | In-process inference concurrency limit |
| `AI_CLOUD_ENABLED` | `false` | Enable an OpenAI-compatible endpoint |
| `AI_CLOUD_CONSENT` | `false` | Must also be true before household data leaves the server |
| `AI_CLOUD_BASE_URL` | empty | OpenAI-compatible base URL, including `/v1` |
| `AI_CLOUD_MODEL` | empty | Cloud model name |
| `AI_CLOUD_API_KEY` | empty | Optional cloud bearer token |
| `AI_MAX_CONTEXT_CHARS` | `12000` | Per-chunk import context cap |
| `AI_IMPORT_MAX_CHUNKS` | `8` | Maximum AI chunks per import |
| `IMPORT_MAX_FILES` | `2000` | Maximum files accepted from one vault ZIP |
| `IMPORT_MAX_TOTAL_MB` | `50` | Maximum decompressed vault size |
| `IMPORT_MAX_FILE_MB` | `10` | Maximum single extracted vault file |

`APP_BASE_URL` with an `https://` scheme requires `COOKIE_SECURE=true`; the API
refuses to start with an insecure cookie configuration. Production also rejects
remote plain-HTTP origins and `DEBUG=true`.

Set `QR_BASE_URL` to the address a phone can actually reach, typically your
Tailscale hostname or LAN address. When it is empty the app uses
`APP_BASE_URL`. The UI warns before printing if the QR base points at
`localhost` or another address a phone cannot reach. QR codes are generated
locally and encode only `/containers/<uuid>`; they require sign-in and household
authorization.

The API and worker connect with `HOUSETORY_APP_USER`, a non-superuser role with
DML privileges only. Alembic migrations use the admin role. Existing databases
created before this split need the one-time role migration:

```bash
./scripts/harden-db-role.sh
docker compose up -d --force-recreate api worker
```

Inside the containers the API uses `DATABASE_URL`, `DATA_DIR=/data`,
`UPLOADS_DIR=/data/uploads`, `IMPORTS_DIR=/data/imports` and
`ENVIRONMENT=production`. Secrets are never committed.

### Optional local AI with Ollama

Housetory does not ship or download a model. To use local AI on a machine that
already has Ollama:

```bash
ollama serve
ollama pull <a CPU-friendly model you have chosen>
```

Set in `.env`:

```dotenv
AI_PROVIDER=ollama
AI_MODEL=<that model>
AI_BASE_URL=http://host.docker.internal:11434
```

Then rebuild/recreate the API and worker. The Settings screen shows provider
status, the selected model and whether it is available. If the model is missing
or unreachable, ordinary import, search, smart search and the assistant continue
with deterministic grounded tools. Cloud inference remains disabled unless both
`AI_CLOUD_ENABLED=true` and `AI_CLOUD_CONSENT=true` are explicitly configured.

Changing `APP_BASE_URL` requires recreating the API container and signing in
again if the cookie domain policy changes.

## Data, backups and restore

Persistent named volumes:

- `housetory_pgdata` — PostgreSQL, including document/import metadata and OCR output
- `housetory_uploads` — item photographs, normalized document downloads and
  preserved original uploads under `households/*/documents/originals/`
- `housetory_imports` — private original import sources, extracted Obsidian notes
  and attachments

Create a verified backup (PostgreSQL custom dump + uploads/imports tars + SHA-256 sums):

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
- validates the uploads and imports archives and rejects absolute paths, `..`
  traversal, links, devices and duplicate entries before stopping services;
- requires typed confirmation unless `--yes` is supplied;
- stops the API and worker, recreates the database, restores uploads and private
  import sources, reapplies the least-privilege application role grants, runs
  migrations and restarts the stack.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the non-atomic snapshot trade-off.

The uploads archive includes normalized files and preserved originals; the
imports archive includes vault notes and attachments. Never delete a Docker
volume unless you intend to lose data. To reset a development
environment only:

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

In a second terminal, run the worker from the repository root. Real OCR needs
the `tesseract` and `pdftoppm` binaries on the host; import parsing, DOCX/XLSX and
AI fallback use the standard library or configured provider. Without OCR binaries
the worker still starts and records a clear OCR failure instead of crashing:

```bash
# macOS: brew install tesseract poppler
# Debian/Ubuntu: sudo apt install tesseract-ocr poppler-utils
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

Checked-in Playwright workflows use system Chrome and a **disposable** stack.
They create data and must not be pointed at a live household:

```bash
cd apps/web
npm install
E2E_BASE_URL=http://localhost:8090 \
E2E_EMAIL=phase5@example.com \
E2E_PASSWORD=phase-five-password-2026 \
npx playwright test
```

The global setup signs in, or performs first-run setup when the stack is empty.
Set `E2E_CHANNEL` if Chrome is not installed under the default `chrome` channel.

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
- All inventory, documents, purchases and warranties are scoped to the signed-in
  household; cross-household requests return 404 or a validation error.
- Structured errors: `{"detail": {"code", "message", "fields"}}`.
- Uploaded files and preserved originals are only served through authenticated,
  no-store endpoints.
- Documents support metadata/search/filtering, original downloads, OCR retry,
  explicit review/apply and related-item suggestions.
- Purchases, warranties, ownership reports and CSV exports have dedicated
  household-scoped endpoints.
- Imports expose upload, history, source/file downloads, retry and explicit
  approve/merge/skip/reject application.
- AI endpoints expose provider status, grounded assistant, smart search, photo
  recognition and read-only document relationship suggestions.
- Containers expose create/bulk/convert, live detail, identifier lookup,
  cross-room move, deterministic/AI summary, QR SVG, label templates, label PDF
  generation and calibration PDFs.

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

- Container QR destinations are authenticated, household-scoped and opaque
  UUID-based. No public or anonymous QR sharing exists.
- Container identifiers are allocated by a database counter with atomic
  `INSERT … ON CONFLICT` updates; they are never reused or reassigned.
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
  tags, items, photos, documents, purchases, warranties, exports, imports,
  recognition records and AI answers (covered by tests).
- Uploads are validated by content with an image-decoder allowlist and a PDF
  parser, size-capped, and stored with `0600` permissions under `0700`
  directories. Safe downloads are re-encoded to strip metadata; exact original
  uploads are preserved and remain authenticated/no-store. PDFs and documents
  download as attachments rather than rendering in the application origin.
- OCR runs locally in the worker over validated files. Tesseract/Poppler parse
  untrusted input in a CPU-only container with no network dependency; the
  residual parser/malware risk is documented in the security audit.
- Vault ZIPs reject traversal, symlinks, unsafe/encrypted entries, file-count and
  decompressed-size excess. Imported notes are never executed. AI sees delimited
  untrusted data, returns strict validated JSON, and has no write/SQL/shell tools.
- The worker mounts document/photo uploads read-only and has a separate writable
  private imports volume for extracted vault files. AI is disabled by default;
  cloud calls require explicit enablement and consent.
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
