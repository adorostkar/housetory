# Housetory Architecture

> Everything has a place.

Housetory is a self-hosted inventory of a home: rooms, nested storage places,
items, photographs, documents, purchase details and warranties. It is designed
as a private, single-account application that runs on a CPU-only Linux server
and is reached through Tailscale.

This document describes the architecture implemented in this repository. It is
not a wish list; where something is intentionally deferred, it is marked.

---

## 1. System shape

```
iPhone / Mac browser
        │  HTTPS (Tailscale certificate)
        ▼
Tailscale Serve  ──────────────►  127.0.0.1:8080
                                      │
                                      ▼
                              ┌────────────────┐
                              │  web (nginx)   │
                              │  React SPA     │
                              │  /api/* proxy  │
                              └───────┬────────┘
                                      │ private Docker network
                                      ▼
                              ┌────────────────┐
                              │  api (FastAPI) │
                              └───┬────────┬───┘
                                  │        │
                    ┌─────────────▼──┐  ┌──▼─────────────────┐
                    │ PostgreSQL 16  │  │ uploads volume     │
                    │ data + jobs    │  │ photos + documents │
                    └───────┬────────┘  └────────────────────┘
                            │
                    ┌───────▼────────┐
                    │ worker         │
                    │ job queue      │
                    └────────────────┘
```

- Only `web` publishes a port, and only on `127.0.0.1`. PostgreSQL and FastAPI
  have no host ports.
- Tailscale Serve terminates HTTPS and forwards to the nginx container. There
  is no public DNS, no public certificate management and no extra reverse
  proxy.
- Compose services: `db`, `migrate` (one-shot), `api`, `worker`, `web`.
- Persistent named volumes: `housetory_pgdata`, `housetory_uploads`.

## 2. Repository layout

```
housetory/
  apps/
    web/                 React + Vite + TypeScript + Tailwind + shadcn/ui
    desktop/             Tauri 2 shell (intentionally deferred, see apps/desktop)
  services/
    api/                 FastAPI, SQLAlchemy 2, Alembic, pytest
    worker/              PostgreSQL-backed background worker
  infrastructure/
    docker/              Dockerfiles and nginx configuration
  docs/                  Tailscale and operational notes
  scripts/               backup.sh, restore.sh, compose.sh
  compose.yaml
  compose.dev.yaml       Loopback Postgres port for local development only
  ARCHITECTURE.md
  IMPLEMENTATION_PLAN.md
  README.md
```

## 3. Backend

### Runtime

- Python 3.12, FastAPI, Pydantic 2.
- SQLAlchemy 2 **synchronous** ORM with psycopg 3. This is a single-user,
  CPU-only application; synchronous sessions are simpler to reason about and
  avoid async session pitfalls. FastAPI runs sync route handlers in its
  threadpool.
- PostgreSQL 16 with UUID primary keys (`gen_random_uuid()` server defaults).
- Alembic owns schema changes. Tables are never auto-created at runtime.
- Uvicorn with proxy headers enabled behind nginx.

### Request lifecycle

```
request → origin check → route → auth dependency → household-scoped service
        → SQLAlchemy session → commit → JSON / FileResponse
```

- Every route that touches inventory depends on `require_auth`.
- `AuthContext` contains the user, their household, their role and the session.
- All inventory queries include `household_id`; authorization is not an
  after-the-fact filter. Cross-household object access therefore returns 404.
- The household membership layer exists now even though setup creates only one
  owner. This keeps authorization clean if sharing is added later.

### Error contract

Errors use a stable machine-readable envelope:

```json
{
  "detail": {
    "code": "room_name_taken",
    "message": "A room with this name already exists here.",
    "fields": { "name": "..." }
  }
}
```

Validation errors use `code: "validation_error"` with per-field messages. This
lets the frontend display errors without parsing prose.

### API surface

All application endpoints are versioned under `/api/v1`.

| Area | Endpoints |
| --- | --- |
| Health | `GET /health/live`, `GET /health/ready`, `GET /healthz` (container liveness alias) |
| Auth | `GET /auth/session`, `POST /auth/setup`, `POST /auth/login`, `POST /auth/logout` |
| Household | `GET /household`, `PATCH /household` |
| Rooms | `GET/POST /rooms`, `GET/PATCH/DELETE /rooms/{id}` |
| Storage | `GET/POST /storage-locations`, `GET/PATCH/DELETE /storage-locations/{id}` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/{id}` |
| Tags | `GET/POST /tags`, `PATCH/DELETE /tags/{id}` |
| Items | `GET/POST /items`, `GET/PATCH/DELETE /items/{id}`; list supports `q`, room/place/category/tag filters, `include_descendants` and sorting |
| Photos | `GET/POST /items/{id}/photos`, `POST /items/{id}/photos/{photo_id}/primary`, `DELETE /photos/{id}`, `GET /photos/{id}/file`, `GET /photos/{id}/thumbnail` |
| Documents | `GET /documents`, `POST /items/{id}/documents`, `GET /documents/{id}/file`, `DELETE /documents/{id}` |
| Overview | `GET /overview` |

OpenAPI documentation is available in development at `/api/docs`. It is
disabled when `ENVIRONMENT=production`.

Health semantics:

- `live`: process is up; no dependencies.
- `ready`: database reachable and uploads directory writable; returns 503 with
  component status when degraded. Docker health checks use `ready`.
- `healthz`: tiny unauthenticated liveness response used by Compose.

## 4. Authentication and authorization

- First-run `POST /auth/setup` creates exactly one user, one household and one
  owner membership. A PostgreSQL advisory transaction lock serializes concurrent
  setup requests; subsequent attempts return `409 setup_complete`.
- Passwords are hashed with Argon2id (`argon2-cffi`). Verification uses a dummy
  hash for unknown accounts to reduce timing differences. Login rehashes when
  the Argon2 parameters change.
- Sessions are opaque 40-byte random tokens. Only a SHA-256 hash of the token is
  stored in `auth_sessions`; the raw value lives solely in an HttpOnly cookie.
- Cookie defaults: `HttpOnly`, `SameSite=Lax`, `Path=/`, configurable `Secure`.
  Settings validation refuses to start when `APP_BASE_URL` is HTTPS and
  `COOKIE_SECURE` is false. Production also rejects remote plain-HTTP origins
  and `DEBUG=true`.
- Unsafe browser requests must match `APP_BASE_URL` (or configured extra
  origins) using `Origin`, falling back to `Referer` when `Origin` is absent.
  Combined with SameSite cookies, this blocks cross-site state changes without a
  CSRF-token round trip. Non-browser API clients with neither header are allowed.
- Session expiry defaults to 30 days; expired sessions are pruned by the worker
  and opportunistically on login. Logout deletes the session row, so cookie
  replay fails. Sessions for deactivated users are rejected.
- Login failures are throttled with a sliding window per email and proxy
  address (default 10 failures per 15 minutes). The limiter is in-process and
  resets on restart; it must become PostgreSQL-backed before multiple API
  replicas. Behind Tailscale Serve, the proxy address is shared, which makes the
  limit effectively global as well as per-account. Setup itself is not throttled.
- Authorization is role-ready (`owner` / `member`). Household rename requires
  owner; multi-user invitations are not implemented.
- **First-run claim:** before an owner exists, any client that can reach the
  setup endpoint can claim the instance. Tailscale ACLs must restrict access and
  setup should be completed immediately after deployment.

Not in the foundation: password reset/change UI, 2FA, SSO, idle timeout and
multi-device session management. Tailscale keeps the service off the public
internet, which is the primary access control boundary.

## 5. Data model

All IDs are UUIDs. All timestamps are timezone-aware. Constraint names follow a
deterministic naming convention so migrations remain diff-friendly.

```
users ──< household_members >── households
  │                                │
  │                                ├──< rooms ──< rooms (optional nesting)
  │                                │      │
  │                                ├──< storage_locations ──< storage_locations (nesting)
  │                                │      │
  │                                ├──< categories ──< categories (optional nesting)
  │                                ├──< tags ──< item_tags >── items
  │                                └──< documents ──< item_documents >── items
  │                                                                      │
  │                                                       ┌──────────────┼─────────────┐
  │                                                       ▼              ▼             ▼
  │                                                  purchases      warranties   item_photos
  │
  └──< auth_sessions

items ──< item_custom_values >── custom_field_definitions
jobs (PostgreSQL-backed queue)
```

Key decisions:

- **Rooms** may optionally nest through `parent_id`; cycles are prevented in
  the service layer and self-parenting is blocked by a check constraint.
- **Storage locations** belong to exactly one room and may nest arbitrarily.
  Parent and child must share a room. Deleting a location that still has
  contents is rejected by the API.
- **Items** optionally reference a room and a storage location. A location
  implicitly determines its room. Deleting a room/location does not delete
  items; foreign keys are `SET NULL`.
- **Categories** are household-scoped and optionally nested. **Tags** are flat
  and many-to-many with items.
- **Purchases** and **warranties** are one-to-one extensions of items. Prices
  are stored as integer minor units plus an ISO-4217 currency. Multiple
  currencies are never silently summed.
- **Photos** are item-owned files with dimensions, byte size, sort order and a
  derived WebP thumbnail. Up to 20 per item.
- **Documents** are household-owned files and can be linked to multiple items
  through `item_documents`. This supports e.g. one appliance manual attached to
  several items.
- **Custom fields** are modelled as typed definitions
  (`text|number|date|boolean|select`) and per-item JSONB values. API and UI for
  custom fields are deferred; the schema is present in migration `0001`.
- **Jobs** carry task name, JSON payload, status, priority, run time, attempts,
  max attempts and worker lock fields.

Delete behavior was chosen to avoid silent inventory loss. The API rejects
deleting non-empty rooms and locations. Deleting an item cascades its photos,
purchase, warranty and custom values. Documents are removed only when the item
is their sole attachment; documents shared with other items remain available.

## 6. File storage

- Root is `UPLOADS_DIR` (default `/data/uploads` in Docker).
- Generated object keys, never user filenames, determine paths:
  `items/<item_uuid>/photos/<photo_uuid>.<ext>` and
  `households/<household_uuid>/documents/<document_uuid>.<ext>`.
- All access goes through authenticated API file routes. The uploads directory
  is not served by nginx as static files, so UUIDs alone are not access.
- Uploads are size-capped (`MAX_UPLOAD_MB`, default 25 MB); nginx caps the whole
  request at 30 MB.
- Photos are validated by decoding with Pillow through an explicit
  `JPEG/PNG/WebP/HEIF` decoder allowlist, not by trusting MIME headers or
  extensions. HEIC is normalized to JPEG for browser compatibility. Images are
  re-encoded (stripping EXIF/GPS and other metadata), oriented correctly, and a
  1600px max WebP thumbnail is generated synchronously.
- Documents are limited to PDF, JPEG, PNG, WebP and UTF-8 text. PDFs are parsed
  with pypdf and must contain at least one page; encrypted/malformed PDFs are
  rejected. Image documents are re-encoded to their actual format, normalizing
  MIME/extension mismatches and stripping metadata. Executables, SVG and HTML
  are rejected.
- All document responses are forced to `Content-Disposition: attachment` so
  active PDF content is not rendered in the application origin. Photo and
  document responses are `private, no-store`, `nosniff` and CORP same-origin.
- Files and directories are stored with `0600` and `0700` permissions under the
  uploads volume; the volume root is also `0700`.
- Deleted files are removed best-effort after the database commit. Deleting an
  item removes its photographs and any documents only that item used.
- Backups capture both the database and the uploads volume. Backup directories
  are `0700` and files `0600`; restores verify checksums and refuse database or
  Compose-project mismatches. Uploads archives are validated for traversal,
  links, devices and duplicate entries and extracted with Python's safe tar
  filter.

## 7. Background jobs

The queue lives in PostgreSQL, intentionally avoiding Redis for a single-user
deployment.

- `enqueue()` inserts a `jobs` row.
- Workers claim one row at a time with
  `SELECT ... FOR UPDATE SKIP LOCKED`, mark it `running`, and bump `attempts`.
- Successful handlers set `succeeded` and `finished_at`.
- Failures retry with capped exponential backoff until `max_attempts`; then the
  job becomes `failed` with `last_error`.
- Stale `running` jobs (worker crash) are requeued on startup and periodically.
- The worker writes a heartbeat file; its Docker health check fails if the
  heartbeat is stale.
- Current handlers: prune expired sessions and prune old finished jobs. A
  maintenance job is enqueued every six hours. The queue is deliberately
  general so future thumbnail/re-encoding/export jobs can reuse it.

## 8. Frontend

- React 19, TypeScript strict, Vite, Tailwind CSS 3.4 and shadcn/ui patterns
  (Radix primitives + CVA + local UI components).
- TanStack Query owns server state; there is no global state store.
- React Router 7 with route-level lazy loading and a protected shell.
- Routes: overview, rooms, room detail, items, item create/edit/detail, search,
  settings, setup, login, 404.
- The UI is an installable PWA: web manifest, Apple meta tags, generated icons,
  standalone display and an app-shell service worker that never caches API
  data.
- Item photography supports multiple uploads, cover selection, an accessible
  full-screen viewer with keyboard/thumbnail navigation, and an iPhone camera
  capture action.
- Design system: warm ivory/stone light mode, deep charcoal dark mode, system
  SF typography with New York-style display serif, restrained sage/brass accents,
  subtle borders and soft shadows. Reduced-motion preferences are respected.
- No placeholder production data or non-functional controls. Empty states are
  real first-run states.

Frontend API access is same-origin through `/api/v1`; Vite proxies to the API in
development and nginx proxies in production. No CORS allowlist is needed.

## 9. Deployment

- Compose runs a one-shot `migrate` service (`alembic upgrade head`) before the
  API and worker start, gated by health/completion conditions.
- API, worker, web and migrate containers run non-root. They drop all Linux
  capabilities, use `no-new-privileges`, and have read-only root filesystems with
  minimal tmpfs mounts. The nginx image is the unprivileged variant.
- nginx adds CSP, HSTS, COOP/CORP, clickjacking, MIME-sniffing, referrer and
  permissions headers. API JSON and authenticated media are `no-store`.
- The application port binds only to loopback. Tailscale Serve is the only
  intended entry point. Tailscale Funnel is explicitly not used.
- Only PostgreSQL (`db`) and uploads (`api`) own persistent data. The PostgreSQL
  image is rebuilt with a current Go-built `gosu`; API and worker images use
  Alpine Python to keep the runtime high/critical package count at zero in the
  audit performed. Backups use `pg_dump` plus a tar of the uploads because
  snapshots cannot be atomic across both; restore stops the API and worker first.
- The database admin role is used only for migrations, backup and restore. API
  and worker connect with a separate non-superuser role that has DML privileges
  only and cannot create databases, roles or schema objects. A fresh volume
  creates the role through the init script; existing volumes use
  `scripts/harden-db-role.sh` once.

## 10. Testing

- Backend: 72 pytest tests against a real PostgreSQL database. The test session
  creates a dedicated database, runs the real Alembic migration, and truncates
  tables between tests. Coverage includes health, auth/session lifecycle,
  concurrent first-run setup, cookie attributes, token hashing, rate limiting,
  origin/Referer protection, exhaustive cross-household isolation, rooms/
  locations/taxonomy, nested-room/place counts, descendant-aware filters,
  ancestor-aware search, cover-photo ordering, item-move responses, multi-currency
  overview, upload content validation, malformed PDF/images, EXIF stripping,
  traversal filenames, upload size and permissions, archive extraction safety,
  queue mechanics and migration freshness.
- Frontend: 16 Vitest tests + Testing Library, including hierarchy utilities,
  location paths, nested room cards and the photo lightbox. TypeScript is checked
  in strict mode; the production build is part of verification.
- Docker Compose: health checks for PostgreSQL, API readiness, worker heartbeat
  and nginx; exercised locally, plus non-root/capability/port inspection.
- Dependency scanning: `pip-audit` (production), `npm audit`, Trivy image scans.
- Not implemented: checked-in browser end-to-end tests (Playwright), load testing,
  accessibility automation, visual regression tests.

## 11. Deliberate limitations

- No multi-user sharing UI yet, though the membership model supports it.
- No custom-field API/UI yet.
- No Tauri desktop build yet; Core Inventory is now stable enough to begin it.
- No automatic backup scheduler; scripts are provided for external scheduling.
  Backups are not encrypted by the scripts.
- The login rate limiter is process-local and resets on restart; it is not a
  substitute for Tailscale ACLs. Setup is not rate-limited and can be claimed
  before the first owner exists.
- No antivirus/malware scanning of documents; PDFs are parsed and downloaded as
  attachments but may still contain malicious content when opened in a PDF
  reader.
- Secrets (database password) are supplied to containers as environment
  variables and are visible to the Docker host/root. Protect host access.
- PostgreSQL connections inside the private Compose bridge are not TLS-encrypted.
- Search uses household-scoped `ILIKE` matching, including ancestor room/place
  names; PostgreSQL full-text/trigram search is a future optimization.
- Photos cannot be drag-reordered and have no captions; a cover can be chosen.
- Mixed currencies are reported per currency, not converted.
- Offline mode caches only the app shell; inventory data requires the server.
- Uploads are stored on a single local volume, not replicated object storage, by
  design for a single-server self-hosted deployment.
- Base images use mutable tags; rebuild and rescan regularly for newly disclosed
  OS/library vulnerabilities.
