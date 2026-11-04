# Housetory implementation plan

This plan tracks the foundation and product phases delivered in this repository.
Status is deliberately honest: Core Inventory is complete and verified, but the
product is not finished. Earlier platform milestones used different phase numbers;
the product-facing numbering below follows the delivery brief.

## Working agreement

- Preserve data. Migrations are append-only once deployed.
- Keep the backend and database off the public internet.
- Prefer fewer dependencies and simple, inspectable systems.
- No mock production data, no dead controls, no hardcoded secrets.
- Tests and the production build must pass before a phase is considered done.

## Phase 0 — Foundation ✅

- [x] Inspect repository; no pre-existing work to preserve.
- [x] Monorepo layout: `apps/`, `services/`, `infrastructure/`, `docs/`, `scripts/`.
- [x] `ARCHITECTURE.md`, `README.md`, `IMPLEMENTATION_PLAN.md`.
- [x] Strict TypeScript and Python tooling.

## Phase 1 — Data and API foundation ✅

- [x] PostgreSQL 16 schema with UUID keys and named constraints.
- [x] Tables: users, households, household_members, auth_sessions, rooms,
      storage_locations, categories, tags, items, purchases, warranties,
      item_photos, documents, item_documents, custom_field_definitions,
      item_custom_values, jobs.
- [x] Self-referential constraints and cycle protection for rooms, locations and
      categories.
- [x] Initial Alembic migration `0001` and migration freshness test.
- [x] FastAPI application factory, versioned `/api/v1` router, structured errors.
- [x] Health endpoints: liveness, readiness (database + storage), container alias.
- [x] Argon2id passwords, opaque hashed sessions, HttpOnly cookies, first-run
      setup, login/logout, origin protection.
- [x] Household-scoped authorization dependency; cross-household isolation tests.
- [x] Rooms, nested locations, categories, tags CRUD.
- [x] Items CRUD with room/location/category/tags, search, filters, archiving and
      pagination.
- [x] Purchase and warranty details, multi-currency reporting.
- [x] Multi-photo upload with validation, EXIF stripping, HEIC normalization and
      WebP thumbnails.
- [x] Document upload, attachment to items, authenticated download and deletion.
- [x] Overview aggregate endpoint (counts, quantities, value by currency,
      warranties expiring soon, storage use, recent items).
- [x] Household rename endpoint.

## Phase 1.5 — Security gate ✅

- [x] Audit authentication, authorization, uploads, web security, infrastructure,
      dependencies, backup and recovery.
- [x] Upgrade Pillow/pillow-heif and add an explicit image decoder allowlist.
- [x] Parse PDFs with pypdf and force document downloads as attachments.
- [x] Enforce Secure cookies for HTTPS deployments at startup.
- [x] Add login throttling, session replay/expiry/cookie tests and concurrent
      first-run setup coverage.
- [x] Exhaustive cross-household IDOR tests for every household-scoped endpoint.
- [x] Harden upload validation, filenames, metadata stripping, storage modes,
      media caching and maximum sizes.
- [x] Add CSP/HSTS/COOP/CORP hardening and no-store headers.
- [x] Harden containers (non-root nginx, read-only filesystems, capability drops)
      and rebuild images with zero fixable HIGH/CRITICAL scanner findings.
- [x] Split PostgreSQL admin and least-privilege API/worker roles.
- [x] Protect backup permissions, validate upload archives against traversal,
      guard against restoring into the wrong database and rehearse a full restore.
- [x] Record findings and remaining risks in `SECURITY_AUDIT.md`.

## Phase 2 — Core Inventory Experience ✅

- [x] Hierarchy-aware room counts including all descendant rooms.
- [x] Hierarchical storage-place counts including descendant locations.
- [x] Descendant-aware item filtering by room and place.
- [x] URL-driven room/place selection with deep-linkable filters.
- [x] Full nested room and place hierarchy in desktop and mobile views.
- [x] Search across room names, storage-place names, categories, tags and item
      fields, including ancestor rooms/places.
- [x] Full room → place path on item detail with links into filtered browsing.
- [x] Item-form hierarchical room picker and selected place path.
- [x] Cover-photo selection with server-side ordering and primary image update.
- [x] Full-screen photo viewer with keyboard, control and thumbnail navigation.
- [x] iPhone camera-capture action alongside multi-photo library uploads.
- [x] Fixed modal centering animation defect found during the walkthrough.
- [x] Fresh relationship reads after an item move so PATCH responses show the new
      room/place immediately.
- [x] Backend and frontend tests for hierarchy, search, cover photos and lightbox.
- [x] Desktop and iPhone browser walkthrough with zero console/network errors.
- [x] Walkthrough documentation and screenshots in `docs/PHASE_2_WALKTHROUGH.md`.

## Supporting platform — Background processing ✅

- [x] PostgreSQL queue with `FOR UPDATE SKIP LOCKED`, retries/backoff, stale job
      recovery, heartbeat health check.
- [x] Worker container, scheduled session cleanup and finished-job pruning.
- [x] Queue mechanics tests.

## Supporting platform — Web application shell ✅

- [x] Vite + React + TypeScript strict + Tailwind + shadcn/ui patterns.
- [x] Session bootstrap, setup and login screens with field-level errors.
- [x] Responsive app shell: desktop sidebar, mobile tab bar, command shortcut.
- [x] Overview dashboard with real aggregates and first-run empty states.
- [x] Room browsing, room detail, nested storage place management.
- [x] Item collection with debounced search, filters, sorting, load more.
- [x] Item create/edit, photographs, documents, purchase/warranty details.
- [x] Global search page.
- [x] Settings: household rename, account details, appearance, storage use,
      sign out, iPhone install guidance.
- [x] Light/dark/system themes, reduced-motion support.
- [x] PWA manifest, Apple metadata, generated icons, privacy-safe app-shell
      service worker.
- [x] Vitest unit/component tests and strict typecheck.

## Deployment — Container environment ✅

- [x] Compose services: PostgreSQL, one-shot migrate, API, worker, nginx web.
- [x] No host ports for database/API; web bound to loopback only.
- [x] Health checks for every long-running service.
- [x] Persistent named volumes for database and uploads.
- [x] `.env.example`, environment documentation, no committed secrets.
- [x] Non-root, read-only API/worker containers with tmpfs.
- [x] nginx reverse proxy, SPA fallback, upload size limit, security headers.
- [x] Local verification through Docker Compose.
- [x] Headless-browser walkthrough of setup, rooms, places, items, uploads,
      search, themes and mobile layouts.
- [x] Backup and restore scripts with checksums; restore drill completed.

## Operations — Access and recovery ✅ (documented, environment-dependent)

- [x] Tailscale Serve instructions with HTTPS, no public DNS, no Funnel.
- [x] iPhone PWA installation workflow.
- [ ] User's actual Tailscale certificate and hostname provisioning (requires
      their tailnet; cannot be done from this repository).
- [ ] Automated off-site backup scheduling (scripts are ready for cron/systemd).

## Phase 3 — Desktop (next, not started)

- [ ] Scaffold Tauri 2 in `apps/desktop` using the production web build.
- [ ] macOS window chrome, menu bar, keyboard commands.
- [ ] Point the wrapper at the self-hosted server; never bundle credentials.
- [ ] Code signing/notarization and update strategy.
- [ ] Desktop-specific tests.

## Phase 4 — Product depth (next)

### Custom fields
- [ ] CRUD endpoints and validation for custom field definitions and values.
- [ ] Item form section and display on item detail.
- [ ] Search custom fields.

### Taxonomy management
- [ ] Category/tag edit and delete UI (API already supports it).
- [ ] Category descriptions and colours consistently surfaced.
- [ ] Safe reassignment flows before deletion.

### Multi-user and sharing
- [ ] Invitations, membership roles and multi-household switching.
- [ ] Owner/member enforcement in every UI path.
- [ ] Account profile, password change, session revocation and optional 2FA.

### Media and documents
- [ ] Photo reordering and captions.
- [ ] Document rename and document library view.
- [ ] Move thumbnail/re-encoding to the job queue with progress reporting.
- [ ] Optional AVIF/TIFF support.
- [ ] Virus scanning hook for documents.

### Search and reporting
- [ ] PostgreSQL `pg_trgm`/full-text indexes and ranked results.
- [ ] Optional filters for warranty status and archived/active mixed views.
- [ ] Export inventory to CSV/PDF.
- [ ] Natural-language search with optional Ollama, disabled by default.

### Reliability
- [ ] Playwright end-to-end suite against Compose.
- [ ] Backup restore drill automation.
- [ ] Structured JSON logging and log rotation policy review.
- [ ] PostgreSQL-backed (multi-process) login throttling and audit history.
- [ ] Malware scanning hook for uploaded documents.
- [ ] Backup encryption and off-site replication automation.
- [ ] Graceful job prioritisation and worker concurrency limits.
- [ ] Migration downgrade rehearsal on staging data.
- [ ] Automated dependency/image scanning in CI.

### Offline and mobile
- [ ] Offline read cache for recently viewed items (private, opt-in).
- [ ] Outbox for offline edits, if desired.
- [x] Camera capture shortcuts and HEIC upload UX.
- [ ] Push reminders for expiring warranties (requires user-chosen notification
      transport).

## Known foundation gaps

- The API and UI for custom fields are not implemented; the database schema is.
- Category and tag deletion/editing are API-only.
- Multi-user membership management is modelled but not exposed.
- The worker currently handles maintenance only.
- Password change/reset is not implemented.
- Login throttling is in-process only; setup can be claimed before first setup.
- Search is `ILIKE` based; adequate for personal scale but not optimised.
- No antivirus scanning for documents; PDFs download as attachments.
- Backups are unencrypted unless the operator encrypts them.
- No automated browser E2E suite is checked in; Phase 2 used a manual Playwright
  walkthrough with zero console/network failures.
- Photo drag-reordering and captions are not implemented; users can choose a cover.
- Tauri desktop is not started. Core Inventory is now stable enough to begin it.
- Offline mode is an app shell, not offline inventory data.

## Definition of done for Phase 2

1. Nested rooms and storage places are browseable and countable end-to-end. ✅
2. Search and filters understand the hierarchy. ✅
3. Photos can be uploaded, viewed full-screen and assigned a cover. ✅
4. Item create, edit, location assignment and retrieval work on desktop/iPhone. ✅
5. Backend and frontend suites pass on the Compose-built application. ✅
6. Walkthrough evidence and limitations are documented. ✅

## Recommended Phase 3

Do not start until explicitly approved. The strongest next candidates are the
Tauri macOS shell, advanced organisation (custom fields and taxonomy management),
and deeper media/document workflows. See the walkthrough for the trade-offs.
