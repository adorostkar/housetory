# Housetory Architecture

> Everything has a place.

Housetory is a self-hosted inventory of a home: rooms, nested storage places,
items, photographs, documents, purchase details and warranties. It is designed
as a private, single-account application that runs on a CPU-only Linux server.
It can be reached over a trusted LAN, an optional Tailscale tailnet, or a public
hostname with direct nginx TLS.

This document describes the architecture implemented in this repository. It is
not a wish list; where something is intentionally deferred, it is marked.

---

## 1. System shape

```
iPhone / Mac browser
        │  HTTPS (trusted certificate)
        ▼
Tailscale Serve (optional) ─────► 127.0.0.1:8080
   or direct nginx TLS ─────────► 0.0.0.0:443
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

- Only `web` publishes a port. The default is `127.0.0.1`; explicit opt-in is
  required for LAN/public binds. PostgreSQL and FastAPI have no host ports.
- Tailscale Serve can terminate HTTPS and forward to the loopback nginx port, or
  `compose.tls.yaml` terminates TLS directly in nginx with an operator-provided
  trusted certificate. There is no extra reverse proxy.
- Compose services: `db`, `migrate` (one-shot), `api`, `worker`, `web`.
- Persistent named volumes: `housetory_pgdata`, `housetory_uploads`.

## 2. Repository layout

```
housetory/
  apps/
    web/                 React + Vite + TypeScript + Tailwind + shadcn/ui
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
| Auth | `GET /auth/session`, `POST /auth/setup`, `POST /auth/login`, `POST /auth/logout`, password-reset request/status/confirm |
| Accounts | `GET/PATCH /account`, `POST /account/password` |
| Invitations | `GET/POST /household/invitations`, resend/revoke, public invitation read and accept |
| Members | `GET /household/members`, role update/remove |
| Household | `GET /household`, `PATCH /household` |
| Rooms | `GET/POST /rooms`, `GET/PATCH/DELETE /rooms/{id}` |
| Storage | `GET/POST /storage-locations`, `GET/PATCH/DELETE /storage-locations/{id}` |
| Containers | `GET/POST /containers`, `POST /containers/bulk`, `POST /containers/convert`, `GET /containers/lookup/{identifier}`, `GET/PATCH /containers/{id}`, `POST /containers/{id}/move`, `POST /containers/{id}/identifier`, summary regenerate/edit/AI, `GET /containers/{id}/qr.svg`, `GET /containers/qr-config` |
| Labels | `GET /labels/templates`, `POST /labels/pdf`, `GET/POST /labels/calibration.pdf` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/{id}` |
| Tags | `GET/POST /tags`, `PATCH/DELETE /tags/{id}` |
| Items | `GET/POST /items`, `GET/PATCH/DELETE /items/{id}`; list supports `q`, room/place/category/tag/purchase-information filters, `include_descendants` and sorting |
| Bulk organisation | `POST /items/bulk/move`, `POST /items/bulk/tags`, `POST /items/bulk/category`; bounded atomic batches with required request-id replay safety |
| Photos | `GET/POST /items/{id}/photos`, `POST /items/{id}/photos/{photo_id}/primary`, `DELETE /photos/{id}`, plus room/location equivalents, authenticated file/thumbnail routes and cover selection |
| Documents | `GET/POST /documents`, `GET/PATCH/DELETE /documents/{id}`, `GET /documents/{id}/file`, `GET /documents/{id}/original`, `POST /documents/{id}/ocr`, `POST /documents/{id}/ocr/apply`, legacy `POST /items/{id}/documents` |
| Document scans | `POST/GET/DELETE /documents/scans`, add/update/delete/reorder pages, authenticated original/cleaned page files, idempotent `POST /documents/scans/{id}/commit` |
| Document extraction | `GET /documents/{id}/extraction`, `POST /documents/{id}/extraction/refine`, `POST /documents/{id}/extraction/matches`, idempotent `POST /documents/{id}/extraction/apply` |
| Purchases | `GET/POST /purchases`, `GET/PATCH/DELETE /purchases/{id}`; one purchase may reference several items and reviewed per-item allocations |
| Warranties | `GET /warranties` with status/item filters and counts; warranty writes use the item endpoints |
| Ownership | `GET /overview`, `GET /financial-overview` |
| Insurance | `POST /insurance-valuations/scope-preview`, `POST/GET /insurance-valuations/batches/{request_id}`, cancel, `POST/GET /insurance-lists/{job_id}`, PDF/CSV downloads |
| Exports | `GET /exports/documents.csv`, `/exports/purchases.csv`, `/exports/warranties.csv`, `/exports/inventory.csv` |
| Search | `GET /search/quick` bounded item/container/location results with loan state and effective question terms; `POST /search/natural` is the explicit answer/filter flow. Structured intents execute fixed read-only tools; ambiguous questions fall back to ordinary matches plus an assistant handoff. |
| Imports | `GET/POST /imports` (with optional room/location review context), `GET/DELETE /imports/{id}`, source/file downloads, retry, hierarchy-aware explicit apply |
| Voice | `GET /voice/config`, `POST /voice` (private audio + optional room/location context), `GET /voice/{id}`, `POST /voice/{id}/interpret`, transcription retry, explicit confirm and cancel |
| Lending | `GET/POST /loans`, `GET/PATCH /loans/{id}`, partial returns, cancel, `GET /items/{id}/loans`, item/container history and `POST /history/{event_id}/undo` |
| Documents/AI | `GET /documents/{id}/related-items` |
| AI | `GET /ai/status?task=`, `POST /assistant/query`, `POST /search/natural`, recognition create/list/detail/retry/apply, provider settings CRUD, model discovery, connection test, task defaults and credential rotation |
| AI settings | `GET /ai/settings`, `POST/PATCH/DELETE /ai/providers`, `GET /ai/providers/{id}/models`, `POST /ai/providers/{id}/test`, `PUT /ai/tasks/{task}`, `POST /ai/credentials/rotate` (owner only) |

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
  A session stores the selected household id but never a global role. Membership
  is resolved from `household_members` on every request, so revoked access and
  role changes take effect immediately.
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
- Authorization has three household-scoped roles: owner, member and viewer.
  Owner-only routes cover household settings, AI/credentials and member
  administration. A router-level write guard rejects unsafe methods for viewers;
  assistant questions and natural-language search remain read-only POST
  exceptions. The complete matrix is in `docs/PERMISSIONS.md`.
- Member mutations lock the household row, making last-owner demotion/removal
  safe under concurrent requests. Removing a membership deletes that account's
  sessions for the selected household.
- Invitations and password-reset tokens are random, hashed at rest, expiring and
  single-use. Invitations bind household/email/role; acceptance may only create
  the invited account identity or attach the matching signed-in account. Reset
  consumption invalidates outstanding reset tokens and all account sessions.
- Email is a provider-neutral SMTP transport with STARTTLS or implicit TLS,
  server-side credentials, validated `APP_BASE_URL` links and a captured
  development/test transport. Production does not report success when SMTP is
  unconfigured or delivery fails.
- **First-run claim:** before an owner exists, any client that can reach the
  setup endpoint can claim the instance. Tailscale ACLs must restrict access and
  setup should be completed immediately after deployment.

Not in this milestone: household creation/switching, email-change verification,
2FA, SSO, idle timeout, drag-and-drop member administration or PostgreSQL-backed
rate limiting. The in-process limiter resets on restart. Deployment choice
determines the access boundary: keep the default loopback bind for a private
install, use Tailscale for a private tailnet, or expose nginx TLS publicly only
with a trusted certificate, strong credentials, prompt first-run setup and host
patching.

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
ai_recognitions (private photo, status, mode, suggestions, applied items)
household_invitations (hashed token, email, role, expiry, lifecycle)
password_reset_tokens (hashed token, expiry, use)
recognition_item_links >── items
room_photos / location_photos (entity photographs)
ai_providers (encrypted credentials, consent, provider endpoint)
ai_task_settings (provider/model per task)
document_scans >── documents (one committed document per scan)
document_scan_pages >── document_scans (exact originals + cleaned derivatives)
document_extraction_applies >── documents (request-id replay results)
purchase_allocations >── purchases/items/documents (reviewed per-line amounts)
items.purchase_info_status (nullable explicit Unknown / Not applicable override)
jobs (PostgreSQL-backed queue)
```

Key decisions:

- **Rooms** may optionally nest through `parent_id`; cycles are prevented in
  the service layer and self-parenting is blocked by a check constraint.
- **Storage locations** belong to exactly one room and may nest arbitrarily.
  Parent and child must share a room. Deleting a location that still has
  contents is rejected by the API.
- **Movable containers** reuse the storage-location row and UUID. They add
  `is_container`, `container_type`, a permanent household-unique `identifier`
  and label timestamps. A container can be unnamed; its display name falls back
  to the identifier. Fixed shelves, cabinets and drawers remain non-container
  locations, optionally with their own identifiers. Converting a place to a
  container is explicit and preserves its UUID, children, items, documents and
  import provenance.
- **Owned storage items** link one owned item to one storage location through
  `storage_locations.owner_item_id` (nullable unique). The same model works for a
  toolbox, TV stand or car; a car's Boot and Glovebox can be nested places. The item remains outside
  its own backing place and keeps its purchase, warranty, value, photos,
  documents, tags and history. Contents use the ordinary item storage-location
  relation. Moving the item moves the backing location subtree; moving the
  container independently is rejected. A storage-bearing item is deliberately
  limited to quantity 1, and removal requires an empty place before tombstoning
  the preserved identifier.
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
- **Contents summaries** are live nested/direct counts and category totals built
  only from current item records. There is no saved snapshot, staleness hash,
  manual edit or AI headline.
- **Labels** are generated server-side as vector PDFs. Verified A4 presets store
  millimetre geometry (L7160/L7163/L7165/L7651); custom geometry is validated
  against the paper. QR modules and DejaVu fonts are vector-embedded. The user
  controls layout, copies, partial-sheet start position and calibration offsets.
- **Items** optionally reference a room and a storage location. A location
  implicitly determines its room. Deleting a room/location does not delete
  items; foreign keys are `SET NULL`.
- **Bulk organisation** is an explicit loaded-record workflow in the Items page.
  Move, add/remove tags and explicit set/clear category accept 1–100 unique item
  IDs (and up to 20 tags), validate every household-scoped reference before
  writing and commit all changes or none. The per-household hierarchy advisory
  lock is taken first, then item rows are locked in sorted UUID order, matching
  container moves and serializing with item edits and lending. Each move writes a
  per-item `item.moved` event with from/to snapshots plus `details.batch`, and one
  `entity_type="batch"` event stores affected IDs, counts, destination and the
  replay result. Tag/category batches store one batch event and are not undoable.
  Required request ids are fingerprinted so identical retries return the stored
  result while different payloads are rejected.
- **Document scanning** keeps draft pages in household-scoped scan sessions
  distinct from committed documents. Each page preserves its exact uploaded bytes
  and has a separately generated cleaned JPEG. The server applies a normalized
  four-corner perspective crop, 90° rotation and conservative color/grayscale/
  contrast adjustments with Pillow; no text restoration or automatic edge
  detection is claimed. Commit locks the scan row, validates all page order and
  references, assembles an A4-oriented cleaned PDF and an assembled source PDF,
  creates one document, and enqueues the existing OCR job. A required request id
  makes retries return the same document. Cleaned derivatives and source pages are
  bounded to 20 pages, 40 MP inputs, 100 MB draft files and 3500 px output edges.
- **Intelligent extraction** keeps a deterministic, versioned proposal in
  `documents.extracted_metadata["extraction"]`: document fields, product/charge
  lines, source-line evidence, warnings and uncertainty. Receipt/invoice lines carry
  integer-cent unit and line totals; tax/discount/shipping/payment/change lines stay
  separate. Manuals and warranty documents are not purchase evidence. Candidate
  matching is household-scoped, ranks exact serial/model/name/brand evidence first
  and exposes deterministic reasons plus current location/purchase context; there is
  no fabricated percentage confidence. Unified search/assistant share one
  deterministic query layer: item whereabouts, loan state, counts, missing
  purchase/date/price/serial/location/warranty, room/container contents, documents,
  purchases, warranties and summaries are resolved by fixed household-scoped
  tools. “Where is …?” answers report owned/on-loan/at-home quantities, borrower
  names, optional recorded due dates and the usual home path; loaned units are
  never asserted to be physically in that storage place. Explicit Unknown and Not
  applicable purchase states are stored as an override on `items`, while
  recorded/unrecorded is derived from real purchase details. Missing-information
  counts and filters use the same helper, and Not applicable is excluded. The
  `search`/`assistant` tasks may only refine interpretation or wording on explicit
  submission; SQL is never generated or executed, candidate/label/context limits
  are bounded, and provider consent is required. When the existing `documents` AI task is
  configured and consented, explicit actions can either (a) refine document fields
  and product/charge lines into a stored, separately versioned `extraction_refinements`
  proposal with exact OCR evidence validation, or (b) re-rank supplied candidate IDs
  only. AI proposals must be accepted before they populate the review draft; they
  never write inventory. Unknown IDs and unsupported evidence are discarded/rejected,
  and exact identifiers stay pinned. Apply is one transaction with a required request
  id, extraction-version check, payload fingerprint and `document_extraction_applies`
  replay record. Linking purchase evidence does not increase an existing item's
  stock unless the user explicitly requests new stock; loans are preserved. Reviewed
  product-line amounts persist in `purchase_allocations` under the one shared purchase
  total, including source document/extraction/line evidence. Tax/discount/shipping
  charges are not fabricated or equal-split; legacy purchases without allocation rows
  keep no invented historical split. Exact duplicate content is warned about by
  SHA-256; it is never auto-merged or deleted.
- **Categories** are household-scoped and optionally nested. **Tags** are flat
  and many-to-many with items.
- **Purchases** are household-owned shared records. Items reference
  `purchases.id`; one purchase can cover many items without duplicating the date,
  amount, merchant, order number, notes or receipt document. Prices are stored
  as integer minor units plus an ISO-4217 currency. Multiple currencies are never
  silently summed. Reviewed extraction lines add `purchase_allocations` rows linked
  to the purchase/item/document/source line, without multiplying the shared purchase
  total in ownership totals. Households carry a default currency used only for new
  entries when no explicit/document currency exists; existing records are not
  rewritten and no exchange-rate conversion occurs.
- **Warranties** remain one-to-one with an item. They store provider, start date,
  optional duration in calendar months, resolved end date, optional per-warranty
  reminder override, coverage notes and an optional certificate document.
  Households carry the default reminder window.
- **Current values** are optional legacy item estimates stored separately from
  purchase values, with their own currency. The ordinary UI preserves them as
  read-only Earlier estimates and omits current-value keys on save; fresh
  replacement estimates are generated only for dated Insurance PDF/CSV snapshots,
  never applied back to items by that workflow.
- **Disposition** is nullable outcome metadata on archived items: sold, given
  away, donated, discarded, lost, consumed or other, with an optional date/note.
  Active items cannot carry it; restoring clears it. It excludes records through
  the same archived filters used by stocktake, lending, search and reports, and
  changes are recorded as item history rather than deleting evidence.
- **Photos** are item-owned files with dimensions, byte size, sort order and a
  derived WebP thumbnail. Up to 20 per item. Room and storage-location photos use
  the same validated storage pipeline and authenticated file routes.
- **AI providers** are household-scoped rows containing provider type, base URL,
  default model, encrypted API key, key version, enabled state and separate
  remote-processing consent. `ai_task_settings` assigns a provider/model to
  assistant, imports, documents, search, vision, transcription and label tasks.
  Transcription is opt-in and capability-checked separately from chat/vision.
  Model discovery
  fetches only the provider's catalog metadata, returns display names/kind and
  capability provenance, and is cached briefly per household/provider with
  credential/endpoint invalidation. Status responses expose only a catalog count
  and whether the saved model was listed; the full catalog is not serialized in
  the general Settings status. A catalog match is not treated as proof of
  inference access or billing eligibility. Known non-chat models are excluded
  from task selection; unknown capability metadata is explicitly marked as
  heuristic.
  Ollama endpoints are scoped as local, private-network or remote from their host;
  only local endpoints are described as staying on the server. Credentials are
  Fernet-encrypted with an environment key held outside PostgreSQL; no secret is
  serialized to clients.
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
- **Loans** store household scope, borrower display name, original and returned
  quantities, dates, private notes, status, created-by and home-location snapshots.
  `loan_returns` records immutable partial returns with active/reversed state.
  Owned quantity remains on the item; on-loan quantity is the sum of open loan
  outstanding amounts, and at-home/available is the difference. Item and loan row
  locks plus request-id uniqueness prevent overselling and retry duplication.
- **Activity events** store actor/id snapshots, action, stable entity references,
  item/container/loan links, human summary, preserved from/to place snapshots and
  optional undo links. Container moves record inherited-content counts without
  fabricating per-item move events. Undo is a new compensating event with a unique
  original-event constraint.
- **Voice-note records** store household scope, creator, status, private audio
  metadata/storage key, room/container context, transcript and provider metadata,
  validated structured suggestions with source spans, deterministic grouping and
  location/duplicate metadata, warnings, applied-item links and lifecycle
  timestamps. Audio is removed after successful transcription or cancellation;
  failed audio is retained only for retry. Confirmation is separate and
  idempotent, and reuses the existing item/location services.
- **AI recognition records** store a private normalized/original photo, status,
  validated suggestions, model metadata, actual processing mode, optional
  destination room/container, applied-item provenance and errors.
  `recognition_item_links` records idempotent application. Applying a suggestion
  uses existing item APIs only after user confirmation.
- **Hierarchical imports** use the existing import batch/entry model with
  `entity_type`, `parent_entry_id`, `legacy_identifier`, created room/location
  links and hierarchy metadata. Legacy labels such as `STO-03` become aliases;
  Phase 5 permanent identifiers remain authoritative.
- **Jobs** carry task name, JSON payload, status, priority, run time, attempts,
  max attempts and worker lock fields.

Delete behavior was chosen to avoid silent inventory loss. The API rejects
deleting non-empty rooms and locations. Deleting an item cascades its photos,
warranty and custom values, detaches it from a shared purchase, and deletes the
purchase only when no item remains attached. Documents are removed only when the
item is their sole attachment; shared documents remain available. Deleting a
purchase detaches its items without deleting them. A deleted receipt or warranty
document clears the reference through `SET NULL`.

Phase 4 added migration `9b4f2c7a1e3d` for imports/recognition. Phase 5 added the
append-only migration `4d8e1a6c2b90` for container fields, identifier uniqueness,
summary/label snapshots and the identifier-counter table. Phase 6 adds
`c1a7e5d9f320` for AI providers/task settings, room/location photos, recognition
mode/destination/apply provenance, hierarchical import fields and storage-location
legacy identifiers/aliases. The voice milestone adds append-only migration
`a4b6c8d0e2f1` for `voice_notes`, the transcription task check constraint and
voice indexes. The lending milestone adds append-only migration `c9e1f3a5b7d2`
for loans, partial returns and activity events. The bulk-organisation milestone
adds append-only migration `d4f6b8c0e2a1`, allowing `entity_type="batch"` on
activity events. The document-scanning milestone adds append-only migration
`e5a7c9d1f3b2` for temporary scan sessions and retained source pages. The
intelligent-extraction milestone adds append-only migration `f6b8d0e2a4c3` for
document content hashes and idempotent extraction-apply records. The extraction gap
fix adds append-only migration `a7c9e1f3b5d4` for persistent purchase allocations.
Single-home polish adds append-only migration `e2f4a6c8b0d2` for the nullable
explicit purchase-information status. No earlier migration or record is rewritten.

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
- Scan drafts and retained source pages use
  `households/<household_uuid>/documents/scans/<scan_uuid>/...`; assembled
  cleaned/source PDFs use the ordinary document paths. Draft originals and
  derivatives are removed when the draft is cancelled, when it is pruned after 24
  hours, or when its committed document/item is deleted. Page files carry private
  authenticated `no-store` responses and are never served from nginx.
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
  `documents.ocr`, `imports.process`, `ai.recognize`, `voice.transcribe` and
  `voice.interpret`. A maintenance job is enqueued every six hours. OCR jobs are
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
  Recognition jobs require an explicitly configured vision task; they never fall
  back silently to the assistant/default model. Voice transcription requires the
  explicit transcription task and supports only OpenAI `/audio/transcriptions` or
  Gemini inline audio; interpretation reuses `imports`. Missing configuration,
  cancellation, request failure, OCR fallback, empty and failed paths are
  recorded and labelled. Lending and undo are synchronous authenticated API
  operations using row locks, request-id idempotency and compensating events;
  bulk move/tag/category batches are likewise synchronous, bounded transactions
  with no background job and no borrower email or reminder job. Scan PDF assembly
  is a bounded synchronous request; OCR remains the existing background job and
  reads the cleaned PDF for scanned documents. Deterministic extraction is built in
  the OCR job. Optional AI ranking is an explicit authenticated request and is never
  a worker default. Abandoned scan drafts are pruned by the API at startup and
  opportunistically when a new scan starts. Fixed
  fixtures are flagged for review and are excluded from default approval. The queue is
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
- Unified search/assistant: typing performs bounded keyword matching; Enter submits
  the query. Clear structured intents use deterministic fixed-tool answers with
  item/loan/document references. Simple loan answers lead with a direct
  borrower/quantity/date sentence and a natural home-path sentence, using stored
  brand/name without fabricating models; no internal intent labels or generic
  disclaimer are shown. Question-like quick results offer an explicit assistant
  handoff. The dedicated Assistant keeps the conversation, shows provider/privacy
  details in a secondary disclosure and passes the prior turns for context.
  Filters and result counts remain server-derived and household-scoped.
- Purchase-information filters expose Missing/Unknown, Recorded, Not applicable and
  missing date/price with the same semantics as overview, search and assistant.
- Sparse overviews collapse empty value/warranty sections while recent items, rooms
  and outstanding loans lead. Active filter chips and empty category/tag filtering
  keep bulk selection safe.
- Container list/detail, bulk creation, explicit fixed-place conversion,
  cross-room move, deterministic/AI/manual summaries, QR dialog and label
  builder/preview/calibration use the same typed client and query invalidation
  model. The label preview is a generated PDF blob in a CSP-permitted iframe.
- Item cards resolve the nearest container from `location_path`; item detail
  links to container pages; room place menus link to container pages and show
  identifiers.
- Item detail puts open-loan truth directly beneath the title: borrower or
  multi-borrower summary, owned/at-home/on-loan quantities, optional recorded due
  date, overdue text and per-loan Record return actions for writers. Viewers see
  the same state without mutation controls. While units are loaned, the stored
  room/container is labelled “Usual home location” and explained as the recorded
  home for at-home stock only. The detailed lending card and history remain.
- The Loans page has a New loan picker over active household inventory with current
  available stock, disabled fully loaned items and picker/loading/no-match/error
  states. The existing Lend and Return dialogs enforce server stock/archive checks
  and idempotency. Outstanding rows show plain borrower text, item-detail link,
  recorded home/dates, independent View details and direct Record return actions;
  closed rows and viewers have no return action.
- Empty item galleries use a compact single Take photo/Choose photo pair; actual
  photography retains the full gallery, ordering, removal, lightbox and upload
  controls.
- The Documents page adds a multi-page scan dialog alongside the unchanged
  single-file upload. Draft pages have thumbnails, original/cleaned previews,
  keyboard-adjustable crop corners, rotation, color/document mode, contrast,
  reorder/remove controls and a persistent save/cancel footer. Saved scans show a
  page strip with exact original page downloads and identify the cleaned PDF as
  the default download/OCR artifact. Viewers see no write controls.
- Document detail adds a progressive extraction review: editable document fields,
  provenance/uncertainty, product/charge line cards, exact/approximate match
  reasons, manual item search, create/link/update/skip choices, explicit new-stock,
  warranty, purchase/attachment decisions and an itemised change preview. The
  optional AI action is secondary and shows provider/consent state. The long review
  uses cards and internal progressive disclosure rather than a wide table, so it
  remains usable on mobile.
- The Items page supports explicit loaded-record selection and a remembered
  card/compact-list toggle. Checkboxes sit outside item links; archived rows are
  disabled; viewers have no selection controls. Search/filter/sort changes clear
  selection with visible feedback, and the UI never claims unloaded matches are
  selected. The compact rows show quantity, full place path and on-loan/at-home
  status without exposing borrower notes.
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
  permissions headers. The optional TLS server adds TLS 1.2/1.3, HSTS and an HTTP
  redirect while keeping the same headers. API JSON and authenticated media are
  `no-store`.
- The application binds to loopback by default. Three documented modes exist:
  trusted LAN (`WEB_BIND=0.0.0.0`), optional Tailscale Serve, or direct nginx TLS
  via `compose.tls.yaml` with a trusted certificate. Tailscale is optional;
  Funnel is not used. PostgreSQL and the worker never receive host ports.
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

- Backend: 204 pytest tests against a real PostgreSQL database. The test session
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
  retry safety, source traceability, provider adapters, encrypted credentials and
  rotation, capability validation, consent enforcement, entity photos,
  multi-object recognition/apply/idempotency, hierarchical parsing/apply,
  duplicate prevention, legacy identifiers, the unchanged actual Inventory.md
  upload/paste/apply/re-import path, semantic AI-edit validation against source
  evidence (counts vs ages/dimensions/model tokens, exact content names, full
  identifier boundaries),
  endpoint scope/consent/redirect safety, AI provider contracts, grounded
  tools, smart search, recognition fallback, document suggestions,
  prompt-injection resistance, upload content validation, malformed PDF/images,
  EXIF stripping, traversal filenames, upload size and permissions, archive
  extraction safety, concurrent identifier allocation, non-reuse, conversion,
  cross-room movement, rollback/cycle prevention, concurrent moves, summary
  accuracy/staleness, deterministic fallback, label presets/geometry/start slots/
  offsets/calibration, QR authorization and migration freshness.
- Frontend: 74 Vitest tests + Testing Library, including membership/recovery
  forms, compact Intelligence
  status, searchable model discovery pickers, room-only scan destinations,
  fixture review, bounded room/container photo areas, the unified Add items
  chooser,
  contextual destinations, quick-search grouping,
  keyboard selection, Escape/outside dismissal, loading/empty/error/stale
  responses and query preservation, provider settings and remote-Ollama consent,
  camera preview/retake/cancel, multi-object review, split/merge and bulk
  approval, hierarchy branch approval/type-parent editing, processing-mode text,
  hierarchy utilities, location paths, nested room cards, photo lightbox,
  document cards, warranty labels/status text, container dialogs and
  nested-container resolution. TypeScript is checked in strict mode; the
  production build is part of verification.
- Browser: 31 checked-in Playwright workflows cover the Phase 5 container flows
  plus mocked-Ollama provider configuration, camera upload, multi-object approval,
  the actual Inventory.md hierarchy import/duplicate prevention, PWA/deep-link
  routing, quick search, exact loan whereabouts, mobile keyword search without
  inference, missing-purchase filter parity, assistant continuation, item title
  loan truth, per-loan return/viewer rules, usual-home labels, compact/populated
  photo galleries, New loan from the Loans page, stale-stock and over-lending
  errors, direct partial row returns and the unified Add items chooser with
  contextual destinations and import-history access.
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
- Container contents counts and category totals are derived live from current
  items, with no saved snapshot to become stale. Printed labels intentionally show
  only the permanent identifier, optional name and live QR, so content movement
  does not invalidate them. Actual physical printer alignment depends on the
  printer and must be checked with the calibration sheet at 100% scale.
- An owned item can provide one storage place and must remain quantity 1 while it
  does. Separate boxes/furniture units are separate items. There is no kit/BOM,
  automatic name matching, borrower directory or automatic propagation of parent
  loan corrections; parent and child loans remain independently correctable.
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
  are reported separately. Category/room purchase breakdowns use persisted reviewed
  allocations only; legacy purchases without allocation rows have no fabricated
  per-item split.
- Original files are preserved for new uploads; documents created before Phase 3
  only have their already-sanitized copy because the original bytes were removed
  by the earlier security hardening.
- Secrets (database password) are supplied to containers as environment
  variables and are visible to the Docker host/root. Protect host access.
- PostgreSQL connections inside the private Compose bridge are not TLS-encrypted.
- Search uses household-scoped `ILIKE` matching, including ancestor room/place
  names; PostgreSQL full-text/trigram search is a future optimization. Unified
  search is single-household, structured result lists are bounded, and live paid
  provider search/assistant quality was not validated.
- Photos cannot be drag-reordered and have no captions; a cover can be chosen.
- Mixed currencies are reported per currency, not converted.
- Offline mode caches only the app shell; inventory data requires the server.
- Uploads are stored on a single local volume, not replicated object storage, by
  design for a single-server self-hosted deployment.
- Base images use mutable tags; rebuild and rescan regularly for newly disclosed
  OS/library vulnerabilities.
