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
| Containers | `GET/POST /containers`, `POST /containers/bulk`, `POST /containers/convert`, `GET /containers/lookup/{identifier}`, `GET/PATCH /containers/{id}`, `POST /containers/{id}/move`, `POST /containers/{id}/identifier`, summary regenerate/edit/AI, `GET /containers/{id}/qr.svg`, `GET /containers/qr-config` |
| Labels | `GET /labels/templates`, `POST /labels/pdf`, `GET/POST /labels/calibration.pdf` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/{id}` |
| Tags | `GET/POST /tags`, `PATCH/DELETE /tags/{id}` |
| Items | `GET/POST /items`, `GET/PATCH/DELETE /items/{id}`; list supports `q`, room/place/category/tag filters, `include_descendants` and sorting |
| Photos | `GET/POST /items/{id}/photos`, `POST /items/{id}/photos/{photo_id}/primary`, `DELETE /photos/{id}`, `GET /photos/{id}/file`, `GET /photos/{id}/thumbnail` |
| Documents | `GET/POST /documents`, `GET/PATCH/DELETE /documents/{id}`, `GET /documents/{id}/file`, `GET /documents/{id}/original`, `POST /documents/{id}/ocr`, `POST /documents/{id}/ocr/apply`, legacy `POST /items/{id}/documents` |
| Purchases | `GET/POST /purchases`, `GET/PATCH/DELETE /purchases/{id}`; one purchase may reference several items |
| Warranties | `GET /warranties` with status/item filters and counts; warranty writes use the item endpoints |
| Ownership | `GET /overview`, `GET /financial-overview` |
| Exports | `GET /exports/documents.csv`, `/exports/purchases.csv`, `/exports/warranties.csv`, `/exports/inventory.csv` |
| Imports | `GET/POST /imports`, `GET/DELETE /imports/{id}`, `GET /imports/{id}/source`, `GET /imports/{id}/files/{file_id}/download`, `POST /imports/{id}/retry`, `POST /imports/{id}/apply` |
| Documents/AI | `GET /documents/{id}/related-items` |
| AI | `GET /ai/status`, `POST /assistant/query`, `POST /search/natural`, `GET/POST /ai/recognitions`, recognition image/original/retry/delete |

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
  │                                │      │  (containers, identifiers, summaries)
  │                                │      │
  │                                │      └──< location_identifier_counters
  │                                ├──< categories ──< categories (optional nesting)
  │                                ├──< tags ──< item_tags >── items
  │                                ├──< purchases ──< items
  │                                └──< documents ──< item_documents >── items
  │                                                                      │
  │                                                       ┌──────────────┼─────────────┐
  │                                                       ▼              ▼             ▼
  │                                                  warranties     item_photos   current values
  │
  └──< auth_sessions

items ──< item_custom_values >── custom_field_definitions
purchases ──> documents (receipt)      warranties ──> documents (certificate)
documents (OCR metadata, original + normalized storage)
import_batches ──< import_entries ──> items (imported/matched)
import_batches ──< import_source_files (notes/attachments)
ai_recognitions (private photo, status, suggestions)
jobs (PostgreSQL-backed queue)
```

Key decisions:

- **Rooms** may optionally nest through `parent_id`; cycles are prevented in
  the service layer and self-parenting is blocked by a check constraint.
- **Storage locations** belong to exactly one room and may nest arbitrarily.
  Parent and child must share a room. Deleting a location that still has
  contents is rejected by the API.
- **Movable containers** reuse the storage-location row and UUID. They add
  `is_container`, `container_type`, a permanent household-unique `identifier`,
  optional summary/headline snapshots and label timestamps. A container can be
  unnamed; its display name falls back to the identifier. Fixed shelves,
  cabinets and drawers remain non-container locations, optionally with their own
  identifiers. Converting a place to a container is explicit and preserves its
  UUID, children, items, documents and import provenance.
- **Identifier allocation** uses `location_identifier_counters` keyed by
  household and prefix. A single atomic `INSERT … ON CONFLICT DO UPDATE …
  RETURNING` reserves a range, including bulk creation. Counters are never
  decremented, so deleted identifiers are not reused; identifiers never change
  when a container moves or is renamed.
- **Container movement** is a single transaction protected by a per-household
  `pg_advisory_xact_lock` and deterministic `FOR UPDATE` row locks. It validates
  destination room/parent, self-parenting and descendant cycles, then updates the
  moved subtree's `room_id`, the moved root's `parent_id`, and all linked items'
  `room_id`. Counts, search, breadcrumbs, financial breakdowns, exports and the
  QR payload derive from the updated rows and therefore remain consistent.
- **Contents summaries** are deterministic snapshots built only from actual item
  names, quantities and categories. A SHA-256 contents hash detects stale
  summaries/labels. Optional AI produces only a short headline; item lines remain
  deterministic. Manual edits are explicit snapshots.
- **Labels** are generated server-side as vector PDFs. Verified A4 presets store
  millimetre geometry (L7160/L7163/L7165/L7651); custom geometry is validated
  against the paper. QR modules and DejaVu fonts are vector-embedded. The user
  controls layout, copies, partial-sheet start position and calibration offsets.
- **Items** optionally reference a room and a storage location. A location
  implicitly determines its room. Deleting a room/location does not delete
  items; foreign keys are `SET NULL`.
- **Categories** are household-scoped and optionally nested. **Tags** are flat
  and many-to-many with items.
- **Purchases** are household-owned shared records. Items reference
  `purchases.id`; one purchase can cover many items without duplicating the date,
  amount, merchant, order number, notes or receipt document. Prices are stored
  as integer minor units plus an ISO-4217 currency. Multiple currencies are never
  silently summed.
- **Warranties** remain one-to-one with an item. They store provider, start date,
  optional duration in calendar months, resolved end date, optional per-warranty
  reminder override, coverage notes and an optional certificate document.
  Households carry the default reminder window.
- **Current values** are optional item estimates stored separately from purchase
  values, with their own currency.
- **Photos** are item-owned files with dimensions, byte size, sort order and a
  derived WebP thumbnail. Up to 20 per item.
- **Documents** are household-owned files with type, merchant, document date,
  notes, extracted text, JSONB extraction metadata, OCR status/error/confidence/
  processed time, and original/normalized storage keys. They can be linked to
  multiple items through `item_documents` and can be referenced by purchases and
  warranties.
- **Custom fields** are modelled as typed definitions
  (`text|number|date|boolean|select`) and per-item JSONB values. API and UI for
  custom fields are deferred; the schema is present in migration `0001`.
- **Import batches** are household-owned sources with status, counts, warnings,
  vault tree, ignored notes and broken links. **Import entries** carry proposed
  JSON fields, per-field provenance, duplicate candidates, explicit resolution and
  the resulting item. **Import source files** preserve extracted notes and
  attachments. Application is explicit and idempotent; no inventory is created by
  extraction.
- **AI recognition records** store a private normalized/original photo, status,
  validated suggestions, model metadata and errors. Applying a suggestion uses the
  existing item APIs only after user confirmation.
- **Jobs** carry task name, JSON payload, status, priority, run time, attempts,
  max attempts and worker lock fields.

Delete behavior was chosen to avoid silent inventory loss. The API rejects
deleting non-empty rooms and locations. Deleting an item cascades its photos,
warranty and custom values, detaches it from a shared purchase, and deletes the
purchase only when no item remains attached. Documents are removed only when the
item is their sole attachment; shared documents remain available. Deleting a
purchase detaches its items without deleting them. A deleted receipt or warranty
document clears the reference through `SET NULL`.

Phase 4 added migration `9b4f2c7a1e3d` for imports/recognition. Phase 5 adds the
append-only migration `4d8e1a6c2b90` for container fields, identifier uniqueness,
summary/label snapshots and the identifier-counter table. It extends the storage
kind check constraint and adds container/identifier checks and indexes without
rewriting existing migrations or records.

The Phase 3 migration is append-only (`7c9a2e4f1b6d`). It backfills household
ownership of existing purchases, moves one-to-one item purchase references to
`items.purchase_id`, points existing document originals at their safe copies, and
adds document/OCR, warranty duration/document/reminder and item current-value
columns.

## 6. File storage

- Upload/media root is `UPLOADS_DIR` (default `/data/uploads` in Docker).
- Import sources and extracted vault files use a separate `IMPORTS_DIR`
  (`/data/imports`). The API can write both; the worker mounts uploads read-only
  and the imports volume writable so OCR remains unable to alter document/photo
  storage.
- Generated object keys, never user filenames, determine paths:
  `items/<item_uuid>/photos/<photo_uuid>.<ext>`,
  `households/<household_uuid>/documents/<document_uuid>.<ext>` and preserved
  originals under `households/<household_uuid>/documents/originals/`.
- All access goes through authenticated API file routes. The uploads directory
  is not served by nginx as static files, so UUIDs alone are not access.
- Uploads are size-capped (`MAX_UPLOAD_MB`, default 25 MB); nginx caps the whole
  request at 30 MB.
- Photos are validated by decoding with Pillow through an explicit
  `JPEG/PNG/WebP/HEIF` decoder allowlist, not by trusting MIME headers or
  extensions. HEIC is normalized to JPEG for browser compatibility. Images are
  re-encoded (stripping EXIF/GPS and other metadata), oriented correctly, and a
  1600px max WebP thumbnail is generated synchronously.
- Documents are limited to PDF, JPEG, PNG, WebP, HEIC/HEIF and UTF-8 text. PDFs
  are parsed with pypdf and must contain at least one page; encrypted/malformed
  PDFs are rejected. Image documents are re-encoded to their actual format,
  normalizing MIME/extension mismatches and stripping metadata. Executables, SVG
  and HTML are rejected.
- Each new document stores the exact uploaded bytes as a preserved original plus
  a normalized safe download. Default downloads use the normalized file;
  `/documents/{id}/original` returns the preserved bytes with their original
  content type. Legacy documents point both keys at their already-sanitized copy.
- All document responses are forced to `Content-Disposition: attachment` so
  active PDF content is not rendered in the application origin. Photo and
  document responses are `private, no-store`, `nosniff` and CORP same-origin.
- The worker mounts uploads read-only. Storage resolution has a read-only path
  that never attempts to create or chmod directories; only API write paths set
  up `0700` storage.
- Files and directories are stored with `0600` and `0700` permissions under the
  uploads volume; the volume root is also `0700`.
- Deleted files are removed best-effort after the database commit. Deleting an
  item removes its photographs and any documents only that item used.
- Container/label PDFs are generated in memory and streamed with
  `Content-Disposition: attachment`, `private, no-store` and `nosniff`; no
  generated label is persisted as a public file. Label text is drawn with
  ReportLab text primitives (no HTML/XML interpolation), QR payloads come from
  `QR_BASE_URL`/`APP_BASE_URL` plus a random UUID, and output is clipped to each
  label rectangle.
- Backups capture the database, uploads volume and private imports volume. Backup
  directories are `0700` and files `0600`; restores verify checksums and refuse
  database or Compose-project mismatches. Uploads and imports archives are
  validated for traversal, links, devices and duplicate entries and extracted
  with Python's safe tar filter. Because recreating the database discards its
  CONNECT, table, sequence and default-privilege grants, restore reapplies the
  least-privilege app role before the API and worker start. Older backups without
  `imports.tar.gz` remain restorable.

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
- Current handlers: prune expired sessions, prune old finished jobs,
  `documents.ocr`, `imports.process` and `ai.recognize`. A maintenance job is enqueued every six hours. OCR jobs are
  enqueued in the same transaction as an upload, claimable by the worker, and
  retried with backoff. The handler marks the document processing, extracts text
  with embedded PDF text or Tesseract/Poppler, stores proposals in JSONB, and
  records failure/error without touching inventory records. Confirmation is a
  separate authenticated endpoint that changes purchases/items explicitly.
- The worker image installs Alpine Tesseract with English language data and
  Poppler utilities. No GPU, external OCR API or network service is required.
  OCR language and scanned-PDF page count are configurable. Import jobs safely
  read text/Markdown/PDF/DOCX/XLSX/CSV/image sources and Obsidian ZIPs, store
  private extracted files, match locations/duplicates and produce review entries.
  Recognition jobs use a configured vision model or the OCR fallback. The queue is
  deliberately general so future export/media jobs can reuse it.

## 8. Frontend

- React 19, TypeScript strict, Vite, Tailwind CSS 3.4 and shadcn/ui patterns
  (Radix primitives + CVA + local UI components).
- TanStack Query owns server state; there is no global state store.
- React Router 7 with route-level lazy loading and a protected shell.
- Routes: overview, rooms, room detail, items, item create/edit/detail,
  documents, document detail/OCR review, purchases, warranties, imports, import
  review/apply, containers, container detail, labels, assistant, recognition,
  keyword/smart search, settings, setup, login, 404.
- The UI is an installable PWA: web manifest, Apple meta tags, generated icons,
  standalone display and an app-shell service worker that never caches API
  data.
- Item photography supports multiple uploads, cover selection, an accessible
  full-screen viewer with keyboard/thumbnail navigation, and an iPhone camera
  capture action.
- Document library, OCR review, purchase management with multi-item selection,
  warranty dashboards, ownership/financial overview, import review, assistant and
  recognition use the same typed API client and React Query invalidation model.
  OCR/import/recognition status polls while queued or processing and stops after a
  terminal state.
- Import review preserves per-field provenance, source excerpts and vault context;
  missing locations can be created inline but only by explicit user action.
  Assistant answers render grounded references and cannot mutate data.
- Smart search translates deterministic intent into safe filters and retains the
  ordinary keyword mode as a fallback.
- Container list/detail, bulk creation, explicit fixed-place conversion,
  cross-room move, deterministic/AI/manual summaries, QR dialog and label
  builder/preview/calibration use the same typed client and query invalidation
  model. The label preview is a generated PDF blob in a CSP-permitted iframe.
- Item cards resolve the nearest container from `location_path`; item detail
  links to container pages; room place menus link to container pages and show
  identifiers.
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
- PostgreSQL (`db`), uploads (`api`) and private imports (`api`/`worker`) own
  persistent data. The worker mounts uploads read-only and imports writable. The
  worker image adds Tesseract, English language data and Poppler for CPU-only OCR.
  The PostgreSQL image is rebuilt with a current Go-built `gosu`; API and worker
  images use Alpine Python to keep the runtime high/critical package count at
  zero in the audit performed. Backups use `pg_dump` plus tars of uploads and
  imports because snapshots cannot be atomic across them; restore stops the API
  and worker first.
- The database admin role is used only for migrations, backup and restore. API
  and worker connect with a separate non-superuser role that has DML privileges
  only and cannot create databases, roles or schema objects. A fresh volume
  creates the role through the init script; existing volumes use
  `scripts/harden-db-role.sh` once.

## 10. Testing

- Backend: 141 pytest tests against a real PostgreSQL database. The test session
  creates a dedicated database, runs the full Alembic chain, and truncates tables
  between tests. Coverage includes health, auth/session lifecycle, concurrent
  first-run setup, cookie attributes, token hashing, rate limiting, origin/
  Referer protection, exhaustive cross-household isolation, rooms/locations/
  taxonomy, nested-room/place counts, descendant-aware filters, ancestor-aware
  search, cover-photo ordering, item-move responses, multi-currency overview,
  document metadata/search/types/originals, HEIC normalization, OCR parsing,
  job completion and failure/retry, confirmed OCR application, shared purchase
  associations, warranty duration/status/reminders, currency separation, CSV
  exports, archive traversal/symlink/bomb limits, import extraction for text,
  Markdown, Obsidian, CSV/XLSX/DOCX, duplicate/location review, partial approval,
  retry safety, source traceability, AI provider contracts, cloud consent,
  grounded tools, smart search, recognition fallback, document suggestions,
  prompt-injection resistance, upload content validation, malformed PDF/images,
  EXIF stripping, traversal filenames, upload size and permissions, archive
  extraction safety, concurrent identifier allocation, non-reuse, conversion,
  cross-room movement, rollback/cycle prevention, concurrent moves, summary
  accuracy/staleness, deterministic fallback, label presets/geometry/start slots/
  offsets/calibration, QR authorization and migration freshness.
- Frontend: 25 Vitest tests + Testing Library, including hierarchy utilities,
  location paths, nested room cards, the photo lightbox, document cards,
  warranty labels/status text and calendar-month expiration, plus container
  creation/bulk/movement dialogs and nested-container resolution. TypeScript is
  checked in strict mode; the production build is part of verification.
- Browser: 4 checked-in Playwright workflows cover unnamed/bulk creation,
  cross-room movement, label preview/PDF/calibration downloads, QR and mobile
  container/label views on a disposable stack.
- Docker Compose: health checks for PostgreSQL, API readiness, worker heartbeat
  and nginx; exercised locally, plus non-root/capability/port inspection.
- Dependency scanning: `pip-audit` (production), `npm audit`, Trivy image scans.
- Not implemented: automated accessibility audit, load testing and visual
  regression testing. Playwright is checked in and executable; it is not run in
  CI without a disposable stack and Chrome.

## 11. Deliberate limitations

- No multi-user sharing UI yet, though the membership model supports it.
- No custom-field API/UI yet.
- No Tauri desktop build yet; Core Inventory is now stable enough to begin it.
- No automatic backup scheduler; scripts are provided for external scheduling.
  Backups are not encrypted by the scripts.
- The login rate limiter is process-local and resets on restart; it is not a
  substitute for Tailscale ACLs. Setup is not rate-limited and can be claimed
  before the first owner exists.
- Container summaries/AI headlines can be stale until regenerated; labels show
  a freshness warning, while the QR always opens live data. Actual physical printer
  alignment depends on the printer and must be checked with the calibration
  sheet at 100% scale.
- No antivirus/malware scanning of documents; PDFs are parsed and downloaded as
  attachments but may still contain malicious content when opened in a PDF
  reader. OCR parses untrusted documents locally in the worker; keep the worker
  image rebuilt and patched.
- AI extraction/recognition is heuristic and provider-dependent. Deterministic
  fallback works without a model, but real model quality, latency and hardware
  requirements were not measured because no model is bundled or installed by the
  repository. All AI changes require explicit review.
- Obsidian support covers practical Markdown/frontmatter, links, tags, tables,
  checklists, folders and attachments, but not executable plugins, Dataview
  queries, canvas files or full YAML semantics.
- Import jobs can consume CPU proportional to vault size and configured AI chunk
  count; limits bound files, decompressed bytes and AI chunks but there is no
  operator-facing queue UI.
- OCR extraction is heuristic and English-first, limited to configured PDF page
  counts and installed language packs. It proposes values only; review is
  mandatory.
- No exchange-rate provider or conversion configuration. Multi-currency values
  are reported separately, and category/room shared-purchase allocation is
  equal across active linked items rather than manually assignable.
- Original files are preserved for new uploads; documents created before Phase 3
  only have their already-sanitized copy because the original bytes were removed
  by the earlier security hardening.
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
