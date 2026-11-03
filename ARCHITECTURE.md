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
| Items | `GET/POST /items`, `GET/PATCH/DELETE /items/{id}` |
| Photos | `GET/POST /items/{id}/photos`, `DELETE /photos/{id}`, `GET /photos/{id}/file`, `GET /photos/{id}/thumbnail` |
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
  Production behind Tailscale must set `COOKIE_SECURE=true`.
- Unsafe browser requests with an `Origin` header must match `APP_BASE_URL` (or
  configured extra origins). Combined with SameSite cookies, this blocks
  cross-site state changes without a CSRF-token round trip.
- Session expiry defaults to 30 days; expired sessions are pruned by the worker
  and opportunistically on login.
- Authorization is role-ready (`owner` / `member`) but only owner setup exists
  in the UI. Multi-user invitations are not implemented.

Not in the foundation: login rate limiting, password reset/change UI, 2FA and
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
- Uploads are size-capped (`MAX_UPLOAD_MB`, default 25 MB).
- Photos are validated by decoding with Pillow, not by trusting MIME headers.
  JPEG, PNG, WebP and HEIC are accepted; HEIC is normalized to JPEG for browser
  compatibility. Images are re-encoded (stripping EXIF/GPS), oriented correctly,
  and a 1600px max WebP thumbnail is generated synchronously.
- Documents are limited to PDF, JPEG, PNG, WebP and UTF-8 text, with magic-byte
  checks for PDF and image decoding. Executables are rejected.
- File responses are marked `private`, `nosniff`, and cached immutably where the
  object is immutable. Document downloads use `Content-Disposition`.
- Files are deleted best-effort after the database commit. Deleting an item
  removes its photographs and any documents only that item used.
- Backups capture both the database and the uploads volume.

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
- API and worker containers run as a non-root user, read-only root filesystems,
  with `/tmp` tmpfs and `no-new-privileges`.
- nginx adds CSP, clickjacking, MIME-sniffing, referrer and permissions headers.
- The application port binds only to loopback. Tailscale Serve is the only
  intended entry point. Tailscale Funnel is explicitly not used.
- Only PostgreSQL (`db`) and uploads (`api`) own persistent data. Backups use
  `pg_dump` plus a tar of the uploads because snapshots cannot be atomic across
  both; restore stops the API and worker first.

## 10. Testing

- Backend: pytest against a real PostgreSQL database. The test session creates a
  dedicated database, runs the real Alembic migration, and truncates tables
  between tests. Coverage includes health, auth/session lifecycle, origin
  protection, household isolation, rooms/locations/taxonomy, items, multi-
  currency overview, photos/documents, validation, queue mechanics and
  migration freshness.
- Frontend: Vitest + Testing Library. Unit tests cover hierarchy building, paths,
  formatting and card rendering. TypeScript is checked in strict mode; the
  production build is part of verification.
- Docker Compose: health checks for PostgreSQL, API readiness, worker heartbeat
  and nginx; exercised locally.
- Not implemented: browser end-to-end tests (Playwright), load testing,
  accessibility automation, visual regression tests.

## 11. Deliberate limitations

- No multi-user sharing UI yet, though the membership model supports it.
- No custom-field API/UI yet.
- No Tauri desktop build yet; it is scheduled after the web app is stable.
- No automatic backup scheduler; scripts are provided for external scheduling.
- Search uses indexed household fields with `ILIKE`; PostgreSQL full-text/trigram
  search is a future optimization, not needed at personal-inventory scale.
- Mixed currencies are reported per currency, not converted.
- Offline mode caches only the app shell; inventory data requires the server.
- Uploads are stored on a single local volume, not replicated object storage, by
  design for a single-server self-hosted deployment.
