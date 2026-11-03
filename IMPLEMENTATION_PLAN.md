# Housetory implementation plan

This plan tracks the foundation delivered in this repository and the work that
remains. Status is deliberately honest: the foundation is usable end-to-end, but
it is not the complete product.

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

## Phase 2 — Background processing ✅

- [x] PostgreSQL queue with `FOR UPDATE SKIP LOCKED`, retries/backoff, stale job
      recovery, heartbeat health check.
- [x] Worker container, scheduled session cleanup and finished-job pruning.
- [x] Queue mechanics tests.

## Phase 3 — Web application ✅

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

## Phase 4 — Container environment ✅

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

## Phase 5 — Access and operations ✅ (documented, environment-dependent)

- [x] Tailscale Serve instructions with HTTPS, no public DNS, no Funnel.
- [x] iPhone PWA installation workflow.
- [ ] User's actual Tailscale certificate and hostname provisioning (requires
      their tailnet; cannot be done from this repository).
- [ ] Automated off-site backup scheduling (scripts are ready for cron/systemd).

## Phase 6 — Desktop (next, not started)

- [ ] Scaffold Tauri 2 in `apps/desktop` using the production web build.
- [ ] macOS window chrome, menu bar, keyboard commands.
- [ ] Point the wrapper at the self-hosted server; never bundle credentials.
- [ ] Code signing/notarization and update strategy.
- [ ] Desktop-specific tests.

## Phase 7 — Product depth (next)

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
- [ ] Login throttling and audit history.
- [ ] Graceful job prioritisation and worker concurrency limits.
- [ ] Migration downgrade rehearsal on staging data.

### Offline and mobile
- [ ] Offline read cache for recently viewed items (private, opt-in).
- [ ] Outbox for offline edits, if desired.
- [ ] Camera capture shortcuts and HEIC upload UX.
- [ ] Push reminders for expiring warranties (requires user-chosen notification
      transport).

## Known foundation gaps

- The API and UI for custom fields are not implemented; the database schema is.
- Category and tag deletion/editing are API-only.
- Multi-user membership management is modelled but not exposed.
- The worker currently handles maintenance only.
- Password change/reset is not implemented.
- Search is `ILIKE` based; adequate for personal scale but not optimised.
- No automated browser E2E suite is checked in.
- Tauri desktop is intentionally deferred until the web application is stable.
- Offline mode is an app shell, not offline inventory data.

## Definition of done for the next milestone

1. Custom fields usable end-to-end.
2. Category/tag management UI with safe reassignment.
3. Password change and active-session revocation.
4. Playwright smoke suite green against `docker compose up --build`.
5. Tauri shell loading the production web app.
