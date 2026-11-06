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

## Phase 3 — Documents, Receipts & Ownership ✅

- [x] Append-only migration for document metadata/OCR/originals, shared purchases,
      warranty duration/reminders/documents, household reminder window and item
      current values.
- [x] Dedicated Documents library with search, type/merchant/date filters,
      multiple-item association, metadata editing, authenticated downloads,
      original-file downloads and confirmed deletion.
- [x] Preserve exact original uploads alongside normalized safe downloads;
      include both in backups and restore validation.
- [x] CPU-only local OCR using Tesseract + Poppler in the worker, with embedded
      PDF text read first and no API blocking.
- [x] Durable `documents.ocr` jobs with queued/processing/succeeded/failed states,
      persisted errors, confidence and retry.
- [x] Review screen prefilled from OCR; inventory changes only after explicit
      confirmation.
- [x] Shared purchase records with date, price, currency, merchant, order number,
      receipt document and notes; one purchase can cover multiple items.
- [x] Purchase management page and item purchase editing without duplicated
      purchase records.
- [x] Warranty provider, start, duration, calculated expiry, certificate,
      coverage notes, per-warranty reminder override and computed status.
- [x] Configurable household warranty reminder window in Settings.
- [x] Warranty dashboard sections for expiring soon, active and expired, plus a
      dedicated warranty list.
- [x] Ownership overview: purchase value, estimated current value, category/room
      breakdowns, most valuable items and missing-purchase items.
- [x] Strict multi-currency separation with no implicit conversion.
- [x] CSV exports for documents, purchases, warranties and inventory.
- [x] Backend tests for uploads, originals, OCR parsing/retries/application,
      permissions, cross-household isolation, shared purchases, warranties,
      currencies, exports and backup/restore paths.
- [x] Desktop and iPhone walkthrough with real Compose OCR and zero console/
      network errors, documented in `docs/PHASE_3_WALKTHROUGH.md`.

## Phase 4 — AI Intelligence, Smart Import & Inventory Automation ✅

- [x] Append-only migration for import batches, import source files, import
      entries and AI recognition records.
- [x] Bulk import from pasted text, TXT, Markdown, CSV, XLSX, DOCX, PDF, OCR
      images and Obsidian ZIP vaults.
- [x] Obsidian parsing for frontmatter/properties, wikilinks and aliases, embeds,
      nested tags, Markdown tables, checklists, nested folders, attachments,
      broken links and vault structure.
- [x] Deterministic extraction with explicit/inferred/missing field provenance.
- [x] Location/category matching, missing-location suggestions with inline
      user-approved creation, and duplicate candidates.
- [x] Review workflow with per-entry editing, selection, skip/reject/merge,
      partial approval, retries and import history.
- [x] Idempotent apply using the shared item creation service and source
      traceability on item detail.
- [x] Private import-source volume, original/vault preservation, safe ZIP limits
      and backup/restore support.
- [x] Optional Ollama/OpenAI-compatible provider abstraction with strict schemas,
      timeouts, concurrency limits, cloud consent gates and no automatic model
      download.
- [x] Read-only grounded assistant tools with deterministic fallback, household
      scoping, references and no SQL/write access.
- [x] Natural-language smart search with safe filters and keyword fallback.
- [x] AI/OCR-fallback item recognition with explicit create/update review.
- [x] Document-to-item relationship suggestions with explicit linking.
- [x] Prompt-injection, malformed provider output, unavailable model, timeout,
      archive traversal/symlink/limit, cross-household and retry-safety tests.
- [x] Real Obsidian import, assistant, smart search, document suggestions,
      recognition and mobile walkthroughs; screenshots in
      `docs/PHASE_4_WALKTHROUGH.md`.

## Phase 5 — Physical Storage, Smart Containers & QR Labels ✅

- [x] Extend storage locations with movable container semantics rather than a
      competing hierarchy: container type, optional name, permanent identifier,
      notes and summary/label snapshots.
- [x] Append-only migration for container fields, identifier uniqueness and
      database-backed per-household/prefix counters.
- [x] Atomic identifier allocation for single and bulk creation; identifiers are
      immutable and never reused after deletion.
- [x] Atomic cross-room movement of containers and descendants, including item
      room membership, breadcrumbs, counts, search, financial breakdowns, exports,
      imports and assistant/QR identity.
- [x] Cycle prevention, self-parent prevention, destination validation, advisory
      locking, row locking and rollback tests.
- [x] Explicit conversion of existing storage places into containers preserving
      UUIDs, items, children, documents and import provenance.
- [x] Container creation/bulk creation, optional naming, fixed-place identifiers,
      empty-container filtering, identifier lookup, detail and contents browsing.
- [x] Authenticated opaque QR destinations, local SVG generation, configurable
      `QR_BASE_URL`, localhost warnings and manual identifier lookup.
- [x] Deterministic short/detailed summaries with quantity/category grouping,
      staleness hashes, manual editing and optional grounded AI headline fallback.
- [x] Vector PDF label generation with embedded fonts, compact/standard/detailed
      layouts, verified L7160/L7163/L7165/L7651 presets, large/custom geometry,
      copies, partial-sheet start positions, calibration offsets and calibration
      sheets.
- [x] Reverse search and assistant container queries through existing household
      tools; imported items can match container identifiers.
- [x] Backend/frontend/E2E tests, real Compose walkthrough, backup/restore and
      security scans; screenshots and example PDFs in
      `docs/PHASE_5_WALKTHROUGH.md`.

## Supporting platform — Background processing ✅

- [x] PostgreSQL queue with `FOR UPDATE SKIP LOCKED`, retries/backoff, stale job
      recovery, heartbeat health check.
- [x] Worker container, scheduled session cleanup and finished-job pruning.
- [x] Document OCR handler, local Tesseract/Poppler runtime and retry behavior.
- [x] Bulk import and AI recognition job handlers.
- [x] Queue mechanics, import retry and OCR failure/retry tests.

## Supporting platform — Web application shell ✅

- [x] Vite + React + TypeScript strict + Tailwind + shadcn/ui patterns.
- [x] Session bootstrap, setup and login screens with field-level errors.
- [x] Responsive app shell: desktop sidebar, mobile tab bar, command shortcut.
- [x] Overview dashboard with real aggregates and first-run empty states.
- [x] Room browsing, room detail, nested storage place management.
- [x] Item collection with debounced search, filters, sorting, load more.
- [x] Item create/edit, photographs, documents, purchase/warranty details.
- [x] Global search page and deterministic quick search for items, containers and
      locations in the desktop sidebar and mobile overview.
- [x] Unified Add items chooser for manual entry, photo scanning and file/note
      import, with contextual room/container destinations and preserved existing
      workflow deep links.
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

## Phase 6 — AI Intelligence, Mobile Camera & Smart Import ✅

- [x] Owner-only AI provider settings for OpenAI, Anthropic Claude, Gemini,
      xAI Grok, OpenRouter and Ollama with local, private-network or remote
      endpoint classification.
- [x] Fernet-encrypted API credentials with environment-held key, rotation,
      fail-closed decryption and no secret serialization/logging.
- [x] Separate task models for assistant, imports, documents, search, vision and
      label headlines, capability warnings and connection/model discovery.
- [x] Discovered-model pickers for provider defaults and every task, with search,
      readable names, model-kind filtering, cached/refresh behavior, capability
      provenance and manual exact-ID fallback.
- [x] Explicit per-provider remote-processing consent, local/private/remote
      endpoint scope, redirect refusal and task-aware AI status/privacy notes.
- [x] Direct camera and library photo actions for items, rooms and storage
      locations, with preview, retake, cancel, progress and secure processing.
- [x] Cover selection, explicit photo ordering, deletion and full-screen viewing.
- [x] Multi-object AI Scan Items with editable suggestions, quantities,
      duplicate review, destinations, source provenance and approved bulk apply.
- [x] Explicit merge/split controls for recognition suggestions, with stable
      entry keys and idempotent split retry.
- [x] Idempotent recognition application with existing-item updates, partial
      failure reporting and household isolation.
- [x] Conservative hierarchical import parser and tree review: rooms, containers,
      nested locations, items, quantities, legacy identifiers, source references,
      branch approval, parent/entity editing and duplicate prevention.
- [x] The unchanged actual `Inventory.md` is a checked-in acceptance fixture;
      upload and paste both work without AI, including parenthesized quantities,
      nested context notes, a populated “Box list (template)” and excluded empty
      examples.
- [x] AI hierarchy/document/search edits are validated against semantic source
      evidence; ages/dimensions/model tokens cannot become counts, close-spelling
      fabrications are rejected, and identifiers use full token boundaries.
      Unsupported names, quantities, identifiers and entity changes retain the
      deterministic fact and produce reviewable warnings.
- [x] Index, instruction and empty-template content excluded from inventory.
- [x] Obsidian ZIP export support through the ordinary Upload file action; the
      dedicated vault tab was removed.
- [x] Optional direct nginx HTTPS with `compose.tls.yaml`, HTTP redirect, HSTS,
      secure cookies, PWA/service-worker and camera secure-context guidance.
- [x] Tailscale remains optional; LAN and public trusted-certificate modes are
      documented.
- [x] Backend, frontend and Playwright tests for providers, credentials,
      capabilities, consent, endpoint scope, camera, recognition split/merge,
      hierarchy, duplicates, actual Inventory.md and HTTPS/PWA routing.
- [ ] Real cloud-provider credentials/model benchmark and real iPhone camera/PWA
      verification require the user's environment and hardware.

## Phase 7 — Tauri Desktop & Further Polish (next, not started)

- [ ] Scaffold Tauri 2 in `apps/desktop` using the production web build.
- [ ] macOS window chrome, menu bar, keyboard commands.
- [ ] Point the wrapper at the self-hosted server; never bundle credentials.
- [ ] Code signing/notarization and update strategy.
- [ ] Desktop-specific tests.

## Phase 7 — Product depth (later)

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
- [x] Explicit photo reordering (move earlier/later) and cover selection.
- [ ] Photo captions and drag-and-drop ordering.
- [x] Document rename/edit and document library view.
- [x] Original upload preservation and authenticated original downloads.
- [x] OCR-assisted document relationship suggestions with explicit approval.
- [ ] Move thumbnail/re-encoding to the job queue with progress reporting.
- [ ] Optional AVIF/TIFF support.
- [ ] Virus scanning hook for documents.
- [ ] PDF/text inline viewer and richer document previews.
- [ ] OCR line-item parsing and bulk multi-item application.

### Search and reporting
- [ ] PostgreSQL `pg_trgm`/full-text indexes and ranked results.
- [x] Warranty status views and filters.
- [x] Export inventory, documents, purchases and warranties to CSV.
- [x] Natural-language search with safe structured filters and keyword fallback.
- [ ] Add PDF report export and optional exchange-rate configuration.

### Reliability
- [x] Checked-in Playwright end-to-end suite against disposable Compose stacks.
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
- The worker handles maintenance, document OCR, imports and AI recognition;
  photo thumbnailing and label PDF generation remain synchronous.
- Password change/reset is not implemented.
- Login throttling is in-process only; setup can be claimed before first setup.
- Search is `ILIKE` based; adequate for personal scale but not optimised.
- No antivirus scanning for documents; PDFs download as attachments. OCR and
  imports parse untrusted files locally and must be kept patched.
- Backups are unencrypted unless the operator encrypts them.
- A checked-in Playwright suite covers Phase 5 and Phase 6 critical workflows;
  broader accessibility and visual-regression automation is not implemented.
- Photograph ordering uses explicit earlier/later controls; drag-and-drop and
  captions are not implemented.
- OCR is heuristic and English-first. It proposes values only and does not parse
  full line-item purchases; review is mandatory.
- No exchange rates are configured. Currencies are never combined, and shared
  purchases are allocated equally for category/room breakdowns.
- Legacy documents created before Phase 3 retain only their already-sanitized
  copy; exact originals are preserved for new uploads.
- No AI model is bundled or downloaded automatically. Real model quality/latency
  is unmeasured on the review machine; deterministic import/search/assistant
  fallbacks and mocked provider contracts are tested.
- Obsidian support does not execute plugins, Dataview queries or canvas files,
  and implements a practical YAML frontmatter subset rather than full YAML.
- Tauri desktop is not started; it is Phase 7. Physical printer alignment and
  real iPhone camera/PWA behavior depend on the environment and must be verified
  physically. Real AI model quality was not benchmarked; Phase 6 vision tests use
  a mocked Ollama endpoint.
- Offline mode is an app shell, not offline inventory data.

## Definition of done for Phase 2

1. Nested rooms and storage places are browseable and countable end-to-end. ✅
2. Search and filters understand the hierarchy. ✅
3. Photos can be uploaded, viewed full-screen and assigned a cover. ✅
4. Item create, edit, location assignment and retrieval work on desktop/iPhone. ✅
5. Backend and frontend suites pass on the Compose-built application. ✅
6. Walkthrough evidence and limitations are documented. ✅

## Definition of done for Phase 3

1. Documents upload, associate with multiple items, search, filter, download,
   preserve originals and delete with confirmation. ✅
2. OCR runs through the background worker on CPU-only Linux and proposes fields
   for an explicit review. ✅
3. Shared purchases link multiple items without duplicated purchase rows. ✅
4. Warranties include duration/document/reminders and active/expiring/expired
   views. ✅
5. Ownership value distinguishes purchase and current value and never adds
   currencies without conversion. ✅
6. Exports, backup/restore, cross-household isolation and all earlier tests pass. ✅
7. Desktop/iPhone walkthrough and honest limitations documented. ✅

## Definition of done for Phase 4

1. Bulk import works end-to-end with review, duplicate and location handling. ✅
2. Obsidian vaults preserve structure, notes, attachments and relationships. ✅
3. The assistant is grounded, read-only, household-scoped and functional without
   AI availability. ✅
4. Natural-language search uses safe structured filters. ✅
5. Recognition and document suggestions require explicit approval. ✅
6. Import jobs are retry-safe, traceable and included in backup/restore. ✅
7. Security, cross-household, prompt-injection and archive tests pass. ✅
8. Desktop/iPhone walkthrough and honest AI limitations documented. ✅

## Definition of done for Phase 5

1. Unnamed boxes receive permanent, concurrent-safe identifiers. ✅
2. Existing storage places can be converted explicitly without data loss. ✅
3. Containers move across rooms atomically and keep UUID, identifier, QR,
   contents, descendants, documents and import provenance. ✅
4. QR codes are local, opaque and open authenticated live pages. ✅
5. Summaries contain only actual inventory and have deterministic fallback. ✅
6. Individual, selected, room and fixed-place labels print on verified A4
   templates with partial-sheet and calibration support. ✅
7. Reverse search, assistant tools and imports recognize containers. ✅
8. Full tests, security scans, backup/restore and desktop/iPhone walkthroughs
   pass. ✅

## Definition of done for Phase 6

1. Supported AI providers can be configured and tested through the UI without
   editing `.env`. ✅
2. Credentials are encrypted at rest and never returned or logged. ✅
3. Task-specific models and capabilities are enforced. ✅
4. Direct mobile camera capture with preview, retake, cancel and progress. ✅
5. Multi-object recognition produces editable suggestions without automatic
   writes. ✅
6. Approved suggestions become correctly located inventory records. ✅
7. The hierarchy fixture creates rooms, containers and contents without
   duplicates. ✅
8. Index and template content are excluded, and legacy identifiers are preserved
   as aliases. ✅
9. Obsidian ZIP exports work through Upload file. ✅
10. Processing mode is shown and deterministic fallback is never described as AI. ✅
11. nginx remains the web server and Tailscale is optional. ✅
12. HTTP, direct HTTPS, PWA assets, service worker and deep links verified. ✅
13. Phase 4 and Phase 5 regressions pass. ✅
14. Backend/frontend/Playwright tests and security scans pass. ✅

## Staged milestone — accounts, invitations and recovery

This milestone adds multi-user access without changing the existing shared
household model or renumbering earlier phases.

### Stage A — membership and authorization foundation

- [x] Keep accounts (`users`) separate from household membership
      (`household_members`); roles are scoped per household.
- [x] Add the `viewer` role and make sessions select a household id while
      revalidating membership on every request.
- [x] Document and enforce owner/member/viewer permissions across inventory,
      photos, documents, imports, scans, AI, labels, exports and account routes.
- [x] Restrict household settings, AI/credential configuration and member
      administration to owners.
- [x] Serialize member role/removal changes with a household row lock and prevent
      zero-owner households under concurrent requests.
- [x] Revoke a removed member's household sessions immediately and re-read roles
      so demotions take effect without waiting for session expiry.
- [x] Preserve cross-household isolation tests and add viewer/member boundary
      tests.
- [x] Separate account settings from household/member administration in the UI.
- [x] Keep one shared household visible; no household creation/switching flow.

### Stage B — provider-neutral email infrastructure

- [x] Add a transport interface with standard SMTP STARTTLS/implicit TLS,
      timeout, username/password and from identity support.
- [x] Keep SMTP secrets server-side; no email credentials are returned to the UI
      or logged.
- [x] Use validated `APP_BASE_URL` for invitation/reset links, never the Host
      header.
- [x] Add a captured development/test transport and explicit unconfigured and
      delivery-failure states.
- [x] Document environment configuration with Resend only as an example; no
      provider or domain is hardcoded.
- [x] Keep inventory/login working when email is unconfigured.

### Stage C — invitations and password recovery

- [x] Owners can invite an email with a household role, list pending invites,
      resend, revoke and manage members.
- [x] Invitations are hashed, expiring, single-use and bound to household, email
      and role; duplicate/replay/wrong-account paths are rejected.
- [x] New accounts choose their own password; existing accounts must authenticate
      with the invited email before accepting.
- [x] Password recovery is account-level, uses uniform responses, expiring hashed
      single-use tokens and revokes sessions when consumed.
- [x] Add meaningful rate limits to invite, acceptance and recovery endpoints.
- [x] Keep first-run/setup protections and avoid open registration or
      unauthenticated household/member discovery.
- [x] Provide useful invalid/expired/revoked link states and email-unconfigured
      guidance.

### Stage D — verification and local delivery

- [x] Backend tests for role boundaries, cross-household isolation, last-owner
      safety, invitation replay/expiry/wrong account, recovery non-enumeration
      and session revocation, SMTP capture/configuration/failure.
- [x] Frontend/component tests for the new account, invitation, recovery and
      read-only states.
- [x] Browser tests for account/member separation, recovery messaging, invitation
      forms and existing inventory flows.
- [x] Run all repository checks and deploy locally after backup/rollback
      recording; the remote server is explicitly out of scope.

## Staged milestone — voice-note inventory entry

This milestone extends the existing **Add items** entry point without changing
manual entry, imports, photo recognition, quantities or authorization semantics.

### Stage A — transcription and voice-note foundation

- [x] Dedicated `voice_notes` record with household scoping, statuses, transcript,
      interpretation metadata, suggestions, warnings, applied links and timestamps.
- [x] Add the explicit `transcription` AI task and a migration that extends the
      existing task check constraint without altering existing task assignments.
- [x] Private audio storage under the imports volume, signature validation for
      WebM/Ogg/WAV/MP3/M4A, size/duration limits and active-note concurrency limits.
- [x] Actual OpenAI `/audio/transcriptions` and Gemini inline-audio adapters with
      capability checks, no silent provider fallback and no fake transcription.
- [x] Delete source audio after successful transcription or cancellation; retain
      failed audio only for explicit retry.
- [x] Worker handlers for transcription and interpretation jobs with cancellation
      checks and no transcript/audio content in logs.

### Stage B — deterministic grouping and review contract

- [x] Structured, schema-validated AI mentions with exact transcript evidence,
      optional explicit quantities, variants, locations, corrections and summaries.
- [x] Server-side grouping by normalized name, meaningful attributes and resolved
      room/container; repeated mentions become one quantity-bearing suggestion.
- [x] Explicit counts, correction replacement, summary suppression, variant
      separation and same-item/different-location separation with tests.
- [x] Natural spoken location matching (`box two` / `Box 2` / identifiers),
      ambiguity flags, room-only destinations and transcript location evidence.
- [x] Duplicate candidates and explicit create-new/add-quantity/skip resolution;
      no silent quantity increment or duplicate insert.
- [x] Unsupported move statements are flagged for manual action and never turned
      into new inventory.
- [x] Editable names, quantities, rooms, containers and explicit new-room/new-box
      choices that respect existing uniqueness and hierarchy rules.
- [x] Split grouped suggestions with stable child IDs and idempotent retry.
- [x] Atomic per-suggestion apply, partial-failure reporting and retry safety.

### Stage C — recorder and review UI

- [x] **Record a voice note** choice in the unified Add items dialog with preserved
      room/container context.
- [x] Browser microphone capture with permission/secure-context errors, supported
      format selection, timer, stop, cancel, retake and upload alternative.
- [x] Editable transcript step before interpretation and clear interpretation
      configuration/unavailable states.
- [x] Review cards showing combined mention counts, explicit-count provenance,
      transcript evidence, location evidence, warnings and duplicate candidates.
- [x] Mobile-friendly destination controls with explicit create-room/create-box
      choices, split control and confirm-selected action.
- [x] Separate Voice transcription and Smart imports task configuration in
      Settings, with audio capability support in model discovery/pickers and
      consent wording that names recordings and transcripts.
- [x] Honest setup, cancellation, failure, partial-result and confirmed states.

### Stage D — verification and local delivery

- [x] Backend tests for repeated mentions, explicit counts, corrections, summaries,
      variants, multiple locations, ambiguity, moves, duplicate resolution,
      add-quantity, split/idempotent confirmation, invalid AI output, audio
      validation, cancellation/cleanup, viewer permissions and cross-household IDOR.
- [x] Mocked adapter tests for OpenAI multipart transcription and Gemini inline
      audio; unsupported providers fail clearly.
- [x] Frontend component tests for grouped quantity display, splitting, confirm
      payloads and the unconfigured setup state; Add items coverage includes voice.
- [x] Backend suite, frontend tests, strict TypeScript typecheck and production
      build pass.
- [x] Document providers, formats, limits, retention, privacy, grouping rules,
      walkthrough and limitations in `docs/VOICE_NOTES.md`.
- [x] Local deployment after backup; remote server remains untouched.
- [ ] Real paid-provider transcription and physical microphone smoke tests require
      the operator's credentials and hardware.

## Staged milestone — lending, movement history and safe undo

This milestone extends the existing item/container and role model. It does not
create borrower accounts, move loaned items out of their home location, send email
or start later roadmap milestones.

### Stage A — lending foundation and quantity rules

- [x] Append-only migration `c9e1f3a5b7d2` for loans, partial returns and
      household-scoped activity events. No existing row is rewritten.
- [x] Borrower display name, lent date, optional due date, private notes, quantity,
      returned quantity and explicit outstanding/partial/returned/cancelled states.
- [x] Owned quantity remains on the item; on-loan is the sum of open outstanding
      quantities; at-home/available is owned minus on-loan. Existing aggregates
      still use owned quantities.
- [x] Multiple concurrent loans and partial returns with item/loan row locking,
      unique request ids and server-side stock validation.
- [x] Loan correction, cancellation before returns, date validation and neutral
      local-date overdue interpretation.
- [x] Quantity reduction below on-loan stock and archive/delete with open loans are
      blocked; moving items/containers while loaned is allowed and recorded.
- [x] Loans, item summaries, overview and assistant expose accurate owned/on-loan
      context without treating loaned units as disposed or duplicated.

### Stage B — movement and lending history

- [x] Item moves record actor, time, stable item/room/location IDs and preserved
      room/location/path name snapshots before and after.
- [x] Container moves record one inherited-content event with affected item, unit
      and nested-container counts; they do not fabricate per-item move events.
- [x] Loans, returns, corrections and cancellations create household-scoped events
      with borrower/quantity/date snapshots and no private notes in history.
- [x] Item timeline, container movement history and loan detail history endpoints
      and UI, with empty legacy state and no fabricated creation dates.

### Stage C — safe compensating undo

- [x] Undo only for item/container moves, untouched loan creation and the latest
      active return.
- [x] Verify current actor permission, household, origin/destination existence,
      current quantities and intervening item/container/loan changes.
- [x] Undo creates a new event and never deletes history; unique `undoes_event_id`
      plus event locking prevents double undo.
- [x] Clear blocked-undo reasons in UI and docs; correction/cancel/quantity/archive
      actions are deliberately not silently reversible.

### Stage D — review UI and local delivery

- [x] Compact Lend/Return/Correct dialogs on item and loan pages.
- [x] Outstanding loans page with borrower, item links, quantity, dates, status,
      optional past-due filter and no borrower contacts or emails.
- [x] Item details show owned/at-home/on-loan quantities, open loans, Lend action
      and history; container details show movement history; overview shows a small
      loan banner only when relevant.
- [x] Small Loans navigation addition while preserving typography, palette, cards,
      spacing and the existing shell.
- [x] Backend tests for authorization/IDOR, quantities, concurrency, retries,
      partial returns, dates, quantity/archive/delete restrictions, history
      snapshots, container inheritance, safe/blocked/replayed/concurrent undo.
- [x] Frontend tests and disposable-stack browser workflows for lending, partial
      return, outstanding list, timeline and undo.
- [x] Document exact quantity definitions, permissions, constraints, supported and
      unsupported undo, retry semantics and limits in
      `docs/LENDING_HISTORY_UNDO.md`.
- [x] Local deployment after backup; remote server remains untouched.

## Staged milestone — bulk organisation and compact list view

This milestone extends the existing Items page, item movement, taxonomy, lending,
history and role model. It does not add batch undo, quantity splitting, tag
replacement, a household-wide activity page, email or later roadmap work.

### Stage A — loaded selection and view continuity

- [x] Native per-item checkboxes on cards and compact rows, placed outside item
      links so selection never navigates.
- [x] Explicit **Select all loaded** scope, accurate selected record/unit/on-loan
      counts and honest `Showing X of Y; only loaded items can be selected`
      wording when more records match.
- [x] Selection clears on search, room/place/category/tag/archived/sort changes
      with visible feedback; card/list toggling preserves it, and navigation or
      refresh drops component state.
- [x] Archived checkboxes disabled; viewers see no selection controls or bulk bar.
- [x] Remembered compact list view alongside cards, showing name, quantity,
      room/container path and on-loan/at-home status without borrower notes.
- [x] Existing typography, palette, spacing, rounded controls, cards and shell
      preserved; desktop and mobile screenshots reviewed.

### Stage B — bounded atomic API contract

- [x] `POST /items/bulk/move`, `/items/bulk/tags` and `/items/bulk/category` with
      household-scoped validation and the existing viewer write guard.
- [x] 1–100 unique item IDs and 1–20 tag IDs; duplicate item IDs and oversized
      requests rejected, duplicate tag IDs deduplicated.
- [x] Required client request ID plus canonical payload fingerprint; identical
      replay returns the stored result, while different action/payload reuse is
      rejected with `409 request_id_reused`.
- [x] Validation before writes in one transaction; no partial success or
      retry-only failures. No-op and archived batches return clear 409 errors.
- [x] Household hierarchy advisory lock first, then item rows in sorted UUID
      order, matching container moves and serializing with item edits/lending.
- [x] Cross-household item/destination/tag/category references return 404 without
      per-item disclosure.

### Stage C — move, tag and category behavior

- [x] Bulk move changes each selected record's home room and optional place only;
      quantities, loans, tags, categories and other relationships are unchanged.
- [x] Destination room/place consistency validated; no rooms or containers created;
      partial-quantity moves and cloning explicitly out of scope.
- [x] Active-loan warning and result counts make clear that moving the home place
      does not return or physically move loaned units.
- [x] Tag workflow supports add/remove, preserves other tags, rejects empty input
      and no-ops, and deliberately omits replace-all.
- [x] Category workflow requires explicit `set` or `clear`; empty input never
      clears, and clear is separately reviewed.
- [x] Mixed same-destination batches report moved and unchanged counts while
      remaining atomic.

### Stage D — history, undo and review

- [x] Per-item `item.moved` events with actor, from/to snapshots and
      `details.batch`; one batch event records counts, destination and replay
      result.
- [x] Tag/category changes record one batch event each and are not labelled
      undoable; no per-item fabrications or batch undo.
- [x] Individual bulk moves reuse the existing safe per-item undo; intervening
      changes are rechecked and sibling items are not silently reverted.
- [x] Move/tag/category dialogs preview records, units, destination/tags/category
      and active-loan impact before confirmation.
- [x] Append-only migration `d4f6b8c0e2a1` permits `entity_type="batch"`; no
      earlier migration or row is rewritten.

### Stage E — verification and local delivery

- [x] PostgreSQL tests for atomicity, mixed/no-op/archived/missing batches,
      household isolation and viewer rejection, active loans and preserved
      quantities, tag/category semantics, bounds, replay mismatch, concurrency,
      per-item undo and non-undoable batch events.
- [x] Frontend tests for loaded-only selection, select-all-loaded, view
      persistence, filter clearing and all three reviewed workflows.
- [x] Disposable-stack browser workflow for checkbox keyboard use,
      loaded-versus-total wording, move/tag/category, loan warning, compact-list
      persistence and mobile layout.
- [x] Document selection boundaries, batch limits, atomic/replay semantics,
      active-loan interaction, history/undo scope and limitations in
      `docs/BULK_ORGANISATION.md`.
- [x] Local deployment after backup; remote server remains untouched.

## Staged milestone — receipt and document scanning

This milestone extends the existing Documents library, upload storage, OCR worker
and role model. It adds image-page capture and cleanup with a bounded multi-page
PDF commit. It does not add new AI extraction, line-item ranking, automatic item or
purchase creation, PDF recombination, or later roadmap milestones.

### Stage A — capture and private page drafts

- [x] **Scan pages** entry points on the Documents library and item document
      section; the existing single-file **Add document** path remains unchanged.
- [x] Camera capture input plus multi-file image chooser for JPEG, PNG, WebP, HEIC
      and HEIF; browser camera permission and unsupported-browser states are
      handled by the native file input.
- [x] Draft scan sessions and page records distinct from committed documents;
      thumbnails, add/remove, reorder, cancel, reset and explicit save.
- [x] Retain item context with a reviewed `ItemMultiSelect`; scanning never creates
      inventory items, purchases or automatic links.
- [x] Bounded page count, source pixels, upload size, draft total size and active
      draft count; stale drafts are pruned after 24 hours.

### Stage B — cleanup editor

- [x] Manual four-corner crop/perspective/straighten control with pointer dragging
      and keyboard arrow adjustment; no unreliable automatic edge detection.
- [x] 90° left/right rotation, Color/Grayscale/Document modes, conservative
      contrast slider, per-page reset and original/cleaned comparison.
- [x] Original page bytes preserved exactly; cleaned JPEGs are regenerated from the
      original and never overwrite it.
- [x] Receipt-length images preserve aspect ratio in the editor/PDF; no fixed-page
      squashing or invented text.
- [x] Existing Pillow/HEIC/reportlab dependencies reused; no new image editor
      dependency.

### Stage C — multi-page PDF and OCR

- [x] Ordered A4 portrait/landscape PDF assembly with consistent page orientation,
      bounded image dimensions and sensible compression.
- [x] Exact page originals retained under the one document; cleaned PDF is the
      default download, assembled source PDF is the Original, and page originals are
      available individually.
- [x] Direct scanner-app PDFs still attach as-is; editing/recombining existing PDFs
      is explicitly unsupported rather than silently flattened.
- [x] OCR runs on the cleaned PDF for scans and original uploads otherwise;
      `ocr_artifact` records the choice. Existing review/metadata behavior is
      unchanged and no new extraction is added.
- [x] Existing background OCR job status/retry is reused; empty/unreadable text is
      marked failed with adjustment/retry guidance rather than silent success.
- [x] Commit request id is required; same request returns the same document and
      different reuse is rejected. Cancel/delete/prune remove every retained page
      and derivative.

### Stage D — security and storage

- [x] Household-scoped scan sessions/pages, authenticated private media, viewer
      write rejection and cross-household 404 behavior.
- [x] Signature-based image validation, allowlisted decoders, decompression and
      dimension limits, sanitized names and generated storage keys.
- [x] No network fetch of embedded references, no cloud/LLM dependency, private
      no-store file headers and no public static storage.
- [x] Item/document deletion removes scan originals, derivatives, assembled PDFs
      and cleaned PDFs; no orphaned page files.
- [x] Append-only migration `e5a7c9d1f3b2` for scan sessions and source pages; no
      existing row is rewritten.

### Stage E — verification, documentation and local delivery

- [x] PostgreSQL tests for crop/perspective/rotation/contrast, original bytes, HEIC,
      ordered PDF pages, idempotent commit, request reuse, cancel/prune cleanup,
      viewer/isolation rules, item attachment, no automatic writes and OCR artifact
      selection.
- [x] Frontend tests for upload, previews, keyboard corners, rotation, reorder,
      removal, cancel, save metadata and stable retry request ids.
- [x] Disposable-stack browser workflows for desktop/mobile scan editing, save,
      page-original access and cancel.
- [x] Document supported formats/limits, original/derivative storage, cleanup,
      OCR behavior and limitations in `docs/DOCUMENT_SCANNING.md`.
- [x] Local deployment after backup; remote server remains untouched.

## Staged milestone — intelligent extraction and inventory matching

This milestone extends the existing Documents/OCR/scanning flow, purchase and
warranty models, AI task settings and role rules. It adds reviewed line-item
extraction, household-scoped matching and an itemised apply. It does not add a new
provider, change existing task assignments, store per-item purchase allocations,
start unified search/stocktake/property work or make automatic inventory changes.

### Stage A — deterministic extraction proposal

- [x] Versioned extraction metadata for merchant/date/currency/total/order,
      brand/model/serial, warranty evidence and source-line citations.
- [x] Product lines with quantity, optional unit price and line total in integer
      cents; separate tax/discount/shipping/payment/change lines.
- [x] Conservative discrepancy/ambiguity warnings for quantity arithmetic,
      subtotal/total mismatch, missing totals, multiple dates and multiple currencies.
- [x] Manuals/warranty/specification documents are marked as not purchase evidence;
      they may contribute item/warranty evidence without purchase creation.
- [x] No invented missing values, automatic product grouping or tax/discount
      allocation.

### Stage B — household-scoped matching and optional AI

- [x] Exact serial/model/name/brand/description matching over non-archived
      household inventory only; deterministic reasons and current location/purchase
      context, without invented percentages.
- [x] Manual item search and explicit create/link/update/skip choices; new items
      require a room and optional container.
- [x] Optional refinements reuse the existing consented `documents` AI task with
      minimal candidate/line context. Unknown candidate IDs are discarded and exact
      identifier candidates stay pinned; unavailable/denied AI falls back clearly.
- [x] Prompt-injection text is treated as untrusted data and cannot select records
      outside the supplied candidate set.

### Stage C — review and reviewed apply

- [x] Editable document fields, line descriptions/quantities/amounts, source
      evidence, uncertainty and current-value conflict visibility.
- [x] Explicit purchase decision (none/create/existing), one shared purchase total,
      optional receipt and document attachment links.
- [x] Existing-stock changes only with explicit new-stock choice; loans/on-loan
      quantities are preserved and create-new quantity is reviewed.
- [x] Warranty/provider/date evidence applied only when explicitly chosen; manual
      documents never create purchases.
- [x] Atomic apply with required request id, extraction-version stale check,
      already-applied guard, conflict validation and useful failure messages.
- [x] Stable proposal line IDs and `document_extraction_applies` replay records;
      retries cannot double-create items, stock, purchases, links or warranties.

### Stage D — duplicates, security and resource bounds

- [x] SHA-256 content hash for exact duplicate warnings; no automatic merge/delete
      and explicit re-apply acknowledgement for previously applied extraction.
- [x] Explicit household scope for documents, OCR artifacts, candidates, apply
      references, rooms/locations/categories/purchases/warranties and attachments.
- [x] Viewer rejection for extraction writes/AI requests while preserving read-only
      review access; cross-household records return 404.
- [x] Bounded lines, match inputs, candidates, household item scans and apply
      decisions; no network fetch of embedded content and no raw private payloads in
      logs.
- [x] Append-only migration `f6b8d0e2a4c3` for content hashes and apply records; no
      earlier row is rewritten.

### Stage E — verification, documentation and local delivery

- [x] PostgreSQL coverage for multi-line amounts/quantities, charge separation,
      date/currency ambiguity, exact/approximate/no matches, AI forbidden IDs,
      consent/fallback, prompt injection, conflicts, duplicate content, manual gate,
      stale/replayed/already-applied behavior, household/viewer rules, atomic
      rollback, stock preservation with active loans, purchase/warranty/link
      creation and no automatic items.
- [x] Frontend component tests for fields, line cards, match choices, new-item
      destination/warranty, manual/type choices, AI action and apply payloads.
- [x] Disposable-stack browser workflow for upload/OCR, review, exact matching,
      create-new-item selection, apply, purchase creation and quantity preservation.
- [x] Documented extraction/matching limits, provider/fallback configuration,
      money/quantity rules, review/idempotency/duplicate semantics and privacy in
      `docs/INTELLIGENT_EXTRACTION.md`.
- [x] Local deployment after backup; remote server remains untouched.

## Extraction milestone gap fixes

This follow-up completes the two gaps identified after local verification. It does
not start single-home polish or add another AI provider/task framework.

### Stage A — actual AI field and line refinement

- [x] Explicit `POST /documents/{id}/extraction/refine` action using the existing
      consented `documents` task; fields, product/charge lines, quantities,
      unit/line totals, abbreviations, models/serials and warranty evidence can be
      proposed.
- [x] Structured output schema, evidence excerpts, monetary/date/quantity support
      validation and bounded line/field limits. Missing evidence, malformed output,
      invented numbers, unsupported provider state and unconsented cloud use fail
      clearly without changing the deterministic proposal.
- [x] Refinements are stored separately and version-bound to the deterministic base;
      repeated output maps to the same version and only the latest five are retained.
- [x] UI shows provider/model/consent state, a distinct AI proposal with evidence,
      explicit accept/reject, warning that accepting replaces the current draft, and
      an AI-refined marker after acceptance. Apply remains a separate confirmation.
- [x] Match ranking remains a separate AI action constrained to supplied candidate
      IDs; exact identifiers stay pinned and unknown IDs are discarded.

### Stage B — persistent per-item purchase allocations

- [x] Append-only migration `a7c9e1f3b5d4` for `purchase_allocations`, with
      household/purchase/item/document/source-line provenance and least-privilege
      defaults.
- [x] Reviewed product-line decisions persist quantity, optional unit price, line
      total, allocated cents, currency, source document/version/line and evidence.
      Multiple lines may map to one item and multiple items may share a purchase;
      retries upsert rather than duplicate.
- [x] Shared purchase total remains the single reported spend; allocations are not
      another purchase total. Product amounts, unallocated charges/discounts and
      legacy no-split purchases are distinguished without equal-splitting history.
- [x] Currency, allocation-over-total-plus-discount, stale version, conflicting
      payload/request replay and ownership validation are enforced atomically.
- [x] Purchase API/UI, item purchase display, financial overview and inventory/
      purchases exports expose reviewed allocations and unallocated balances without
      changing current-value or multi-currency rules.
- [x] Documentation distinguishes what AI refines from deterministic/user data and
      what allocations persist versus unallocated charges.

### Stage C — verification and local delivery

- [x] PostgreSQL tests for AI field/line refinement evidence/schema/provider
      fallback, actual mocked-call wiring, user edit/accept flows, persistent
      allocations, multi-line/one-item mapping, shared-total reporting, export
      columns, currency/amount guards, replay payload mismatch, rollback and loan
      preservation.
- [x] Frontend/component tests for AI refinement accept/reject, edited values,
      versioned apply and allocation display.
- [x] Disposable-stack browser workflows for mocked AI refinement, accept/edit/apply,
      persisted allocations and refresh/already-applied state.
- [x] Local deployment after backup; remote server remains untouched. Verified
      backup `backups/housetory-20261105T091625Z` (checksums valid), migration
      `a7c9e1f3b5d4` applied, healthy api/db/worker/web services, served new
      refinement/allocation assets, and unchanged local counts (51 items, 1 user,
      1 member, 1 AI provider, 6 task settings, 5 import batches, 328 entries,
      1 loan, 0 purchases/documents). Host PostgreSQL port exposure was removed.

## Single-home polish milestone

This milestone completes the unified everyday search/assistant experience and the
approved low-risk single-home refinements. It does not start the later evidence
package, stocktake, properties or multi-household milestones, and it does not use
the user's live Heavy drill loan as a fixture.

### Stage A — unified search entry and grounded questions

- [x] Sidebar/mobile input labelled “Search or ask about your inventory…” with
      immediate ordinary matches while typing. No AI call per keystroke.
- [x] Enter submits the full query; question-like text opens `/search` in grounded
      answer mode, while ordinary terms use keyword results. Removed the redundant
      Search nav entry but retained `/search` and all deep links.
- [x] Explicit Ask Housetory quick-panel action hands longer conversations to the
      dedicated Assistant page with the query preserved.
- [x] Deterministic structured intents for whereabouts, counts, open loans, missing
      purchase/date/price/serial/location/warranty information, room/container
      contents, documents, purchase history, warranties and inventory summary.
- [x] Fixed read-only household-scoped tools; no generated SQL, arbitrary tools or
      mutations. AI may refine intent/wording only on explicit submission, with
      consent, context bounds and honest unavailable/malformed fallback.

### Stage B — exact loan whereabouts

- [x] “where is my heavy drill?” resolves the item and reports owned/on-loan/at-home
      quantities first, then borrower, outstanding quantity, optional recorded due
      date and the usual home room/container path.
- [x] Fully loaned items are never asserted to be in their usual storage place;
      partial loans distinguish at-home and loaned units. Returned items report no
      open loan. Ambiguous names list matches instead of guessing; no match is
      explicit.
- [x] Same grounded answer and references work through search, the quick panel loan
      context and the dedicated Assistant, including a “when is it due?” follow-up.
- [x] Isolated regression tests and disposable-stack browser workflows cover partial,
      full, returned, no-due-date, ambiguous, no-match, viewer and household-scoped
      cases without mutating the real loan.

### Stage C — purchase information states

- [x] Append-only migration `e2f4a6c8b0d2` adds nullable
      `items.purchase_info_status` (`unknown` or `not_applicable`) with a check
      constraint; legacy and ordinary items remain null/automatic.
- [x] Effective Recorded/Unrecorded/Unknown/Not applicable status is derived without
      magic dates or zero prices. Existing purchase details survive status changes.
- [x] Overview counts, Items filters and assistant/search missing-information
      questions share one rule: unrecorded and explicitly Unknown are missing;
      Not applicable is excluded. Date/price-only missing filters are explicit.
- [x] Item form/detail and inventory export expose the status and missing fields.

### Stage D — visual and everyday refinements

- [x] Overview leads with finding/organising items, recently added records and rooms;
      empty value/warranty panels collapse to compact summaries and outstanding loans
      remain a small useful notice. No borrower notes are exposed.
- [x] Human name plus permanent identifier and full room/location path in cards,
      filters and details; stored names/IDs unchanged.
- [x] Empty category/tag filters hidden or disabled with management paths retained;
      removable active-filter chips, reset and selection-clearing feedback added.
- [x] Compact empty item-photo state with one Take photo/Choose photo control pair;
      populated galleries keep their existing controls. Empty Documents library no
      longer shows an export CTA.
- [x] Assistant leads with the question and grounded content; provider model IDs and
      detailed consent copy moved into compact expandable details while active mode
      and remote-transmission status stay visible.

### Stage E — verification

- [x] 267 PostgreSQL tests, 109 Vitest tests and 26 disposable-stack Playwright
      workflows pass; Ruff, strict TypeScript typecheck, production build and
      migration checks pass.
- [x] Browser coverage includes the exact loaned Heavy drill query, PS5 keyword
      search without inference, missing-purchase filter parity, mobile search,
      assistant follow-up and unconfigured-AI fallback.
- [x] Before/after desktop and mobile screenshots captured under
      `docs/walkthrough/single-home-polish/`.

### Stage F — backup and local deployment

- [x] Backed up the real local database/uploads/imports to
      `backups/housetory-20261105T100830Z` (checksums valid) before deployment.
- [x] Applied append-only migration `e2f4a6c8b0d2` through the standard local
      Compose deployment and removed the test-only PostgreSQL host port.
- [x] Verified healthy api/db/worker/web services, served the new search/assistant/
      purchase-status assets, and preserved real-data counts (51 items, 1 user,
      1 member, 1 AI provider, 6 task settings, 5 import batches, 328 entries,
      1 loan, 0 purchases/documents/allocations; uploads 2 files/1,177,655 bytes;
      imports 5 files/75,620 bytes). Remote deployment remains untouched.

## Item-detail loan-status and compact-photo follow-up

This queued follow-up makes open-loan truth prominent at the item title and
finishes the compact empty-gallery cleanup. It reuses the existing lending and
return validation; no schema or quantity rules changed, and the user's real Heavy
drill/Mohsen loan was not used as a fixture.

### Stage A — title status and usual home

- [x] Header-status panel beneath the item title: fully loaned single borrower
      (“On loan to …”), partial quantity summaries, multi-borrower/loan rows,
      owned/at-home/on-loan counts, recorded or absent due date, and text-backed
      “Past due”. Private borrower notes are not shown.
- [x] Record return reuses `ReturnLoanDialog`: direct action for one open loan;
      one explicit per-loan return action when several are open. Partial returns,
      server validation, idempotency, history and undo remain unchanged.
- [x] Viewer users see the same loan state without return, lend or edit actions.
      Returned/cancelled/no-open-loan items show no title banner and keep the
      detailed lending card/history.
- [x] While loaned, Details labels the stored place “Usual home location” and
      explains that it applies to at-home units/recorded home, never to the
      physical whereabouts of loaned units.

### Stage B — compact empty photo

- [x] Empty gallery reduced to a 150 px panel with one clear Take photo/Choose
      photo pair; the extra compact toolbar no longer renders while empty.
- [x] Populated galleries retain useful image space, cover/order/remove controls,
      thumbnails, lightbox and upload controls.
- [x] Light/dark desktop/mobile and fully/partially/multiple-loan screenshots
      captured under `docs/walkthrough/item-status-followup/`.

### Stage C — verification

- [x] 267 PostgreSQL tests, 114 Vitest tests and 30 disposable-stack Playwright
      workflows pass; Ruff, strict TypeScript typecheck, production build and
      migration checks pass.
- [x] New component/E2E coverage: title status, partial/multiple quantities,
      borrower selection for returns, authorized return update, viewer restriction,
      returned/no-due-date state, usual-home wording, note privacy and
      empty/populated photo controls.
- [x] Backed up local data to `backups/housetory-20261105T103325Z` (checksums
      valid), deployed locally with the standard Compose workflow, and verified
      healthy api/db/worker/web services, served item-detail assets, migration
      `e2f4a6c8b0d2`, and preserved real-data counts (51 items, 1 user, 1 member,
      1 AI provider, 6 task settings, 5 import batches, 328 entries, 1 loan,
      0 purchases/documents/returns; uploads 2 files/1,177,655 bytes; imports
      5 files/75,620 bytes). The test-only PostgreSQL port is not published.
      Remote deployment remains untouched.

## Loans usability and natural-wording follow-up

This queued follow-up adds point-of-use lending actions on the Loans page and
rewrites deterministic loan answers in natural language. It reuses existing
server validation and history; no schema or stock rule changed, and the user's
real loans were not used as fixtures.

### Stage A — Loans page actions

- [x] New loan action with inventory search, brand/model/home context, available
      quantities, disabled fully loaned items, loading/no-match/error states and
      archived-item exclusion.
- [x] Reuses the existing Lend dialog and server rechecks stock/archive state;
      over-lending and stale-stock errors are shown in the dialog. Successful
      creation refreshes the Outstanding list and restores focus.
- [x] Outstanding rows use plain borrower text, item-detail links, recorded home
      and dates, independent View details and direct Record return actions.
      Return reuses the existing dialog with partial returns, explicit
      confirmation, idempotency, history and undo. Closed/cancelled rows and
      viewers cannot return stock.

### Stage B — natural search/assistant wording

- [x] Location answers lead with a direct borrower/quantity statement and natural
      recorded home path, using stored brand/name/model without rewriting records.
- [x] Partial, multiple-borrower, no-return-date, returned, missing-home,
      ambiguous and no-match cases are quantity-aware and honest; no fabricated
      borrower, date or location.
- [x] Removed the “Grounded answer” badge, internal intent headings and generic
      return-guarantee disclaimer. Search helper is “Search for an item or ask a
      question.” Useful item/loan/source links remain; provider/consent details
      stay secondary.
- [x] No paid model is required to paraphrase basic facts; all retrieval,
      permissions and read-only boundaries are unchanged.

### Stage C — verification and local delivery

- [x] 268 PostgreSQL tests, 117 Vitest tests and 31 disposable-stack Playwright
      workflows pass; Ruff, strict TypeScript typecheck, production build and
      migration checks pass.
- [x] Covers fully/partial/multiple loan wording, returned/no-date/no-home,
      brand/name matching, ambiguous/no-match, New loan selection, over-lending,
      stale stock, direct partial return, separate item/details navigation and
      viewer restrictions.
- [x] Backed up local data to `backups/housetory-20261105T110600Z` (checksums
      valid), deployed locally with the standard Compose workflow, and verified
      healthy api/db/worker/web services, served Loans/search/assistant assets,
      migration `e2f4a6c8b0d2`, and preserved real-data counts (51 items, 1 user,
      1 member, 1 AI provider, 6 task settings, 5 import batches, 328 entries,
      1 loan, 0 purchases/documents/returns; uploads 2 files/1,177,655 bytes;
      imports 5 files/75,620 bytes). The test-only PostgreSQL port is not
      published. Remote deployment remains untouched.

## Staged milestone — item manuals and grounded product help

This milestone reuses the existing Manual document type, document library,
uploads, scan/OCR pipeline and authenticated file routes. It does not add a
parallel manual library, a new top-level product section, or any properties,
stocktake or evidence-export work. Full behavior, configuration, security and
limitations are in `docs/ITEM_MANUALS.md`.

### Stage A — manual attachment and reuse

- [x] Compact `Manuals & help` card on item details with Add manual, Attach
  existing, Ask about this item and Find manual actions; existing item photos,
  lending, purchase, warranty, history and Documents behavior is preserved.
- [x] Manual upload reuses `DocumentUploadDialog` in manual mode, hides
  receipt/type fields, permits upload without make/model and links the current
  item by default. Originals, normalization, size limits, scans and OCR remain
  the existing pipeline.
- [x] New append-only `item_manual_profiles` and `manual_search_candidates`
  tables plus a `POST /documents/{id}/items` link route. One Manual can link to
  several compatible items through the existing `item_documents` join table.
- [x] Attach-existing lists only unlinked Manual-library documents, warns when a
  document is already linked elsewhere and never infers compatibility.
- [x] Duplicate file content is recorded in document metadata and warned about;
  nothing is merged or deleted automatically.
- [x] Viewers can read manuals and ask attached-manual questions but cannot
  upload, attach, confirm identity, search online or download candidates.

### Stage B — grounded manual questions

- [x] OCR now stores bounded page-level text under
  `extracted_metadata["ocr_pages"]` (40 pages, 20k chars/page, 180k total);
  older documents use explicit excerpt/section citations when page mapping is
  unavailable.
- [x] `POST /items/{id}/manual-questions` retrieves at most four bounded chunks
  (two per manual) from actual attached-manual text; no title/metadata-only or
  general-model answers.
- [x] Citations include document id/title, real page when present, explicit
  section/excerpt otherwise, an excerpt and an authenticated document URL with
  `#page=N` where known. No page number is fabricated.
- [x] The existing assistant task/provider/consent is optional. AI receives only
  the question, product context and numbered evidence; output is schema-checked
  and citation IDs are limited to supplied evidence. Invalid output, unknown
  IDs, unsupported page claims and provider errors fall back to extractive text.
- [x] Manual text is treated as untrusted data; prompts grant no tools and cannot
  choose arbitrary URLs/documents. Missing evidence, multiple manuals and
  missing page mapping are reported honestly.

### Stage C — reviewed online discovery and download

- [x] Added an explicit confirmed `item_manual_profiles` identity (manufacturer,
  complete model, optional variant, confirmer/time). Server validation rejects
  generic/empty manufacturer/model values and unconfirmed writes, while allowing
  legitimate letter-only model identifiers. Item fields are never auto-edited.
- [x] Search, download and online questions recheck the complete identity gate
  server-side on every request; upload and attached-manual questions remain
  available without it.
- [x] The built-in Brave Search API adapter uses a server-side subscription
  token, with the original generic JSON gateway retained as an advanced option
  (`MANUAL_SEARCH_URL` + optional API key/label/timeout). Unconfigured state is
  honest and never fabricates results.
- [x] Candidate results must show the exact model and, when set, the variant;
  similar-product/generic results are hidden. Candidates persist source/file URL,
  publisher, language, source type, model coverage, snippet, retrieval date and
  creator and direct-file state. Repeated searches update the same source URL.
- [x] Download requires explicit candidate review + `confirm_model: true` +
  `request_id`; retries return the same document, identical bytes reuse the
  existing private document/link and provenance includes source URL, final URL,
  publisher/language/type/coverage, retrieval time and download time.
- [x] Public-destination DNS pinning, redirect bounds/revalidation, HTTPS
  downgrade refusal, HTTP(S)-only URLs, no credentials, byte/time limits, PDF
  signature/content checks, filename sanitization, existing storage validation
  and authenticated no-store downloads protect the fetch path. No embedded PDF
  references are fetched and raw content/queries are not logged.

### Stage D — optional online questions and delivery

- [x] `POST /items/{id}/manual-questions/online` requires the same confirmed
  identity and configured search provider, is an explicit user action and sends
  only manufacturer/model/variant/question. Borrower, loan and household data
  are never included.
- [x] Online answers cite source URLs and clearly label web evidence separately
  from attached-manual evidence. Optional AI synthesis only uses supplied
  excerpts/IDs; there is no autonomous tool loop or instruction-following from
  retrieved content.
- [x] Frontend types/query hooks, compact card, manual upload mode, attach
  picker, Ask dialog with citations, Find dialog with identity confirmation,
  candidate review/download and honest no-AI/unconfigured states are integrated
  into the existing visual shell. Dialogs are bounded, keyboard accessible and
  responsive.
- [x] Backend tests cover upload without fields, reuse, household/viewer
  boundaries, generic/partial/variant gates on search and online questions,
  exact candidate filtering, persistence, idempotent/duplicate downloads,
  provenance, malformed output, extractive/AI fallback, page fabrication,
  OCR page storage and SSRF/redirect/size/type/timeout guards. Frontend tests
  cover attach/ask/citation/no-AI/gated find/review/save/viewer states.
- [x] Documentation records exact configuration, citation/search limits and the
  live-provider steps that remain unverified. No live internet search, paid AI,
  email, credential creation or real household mutation was used in tests.

### Verification and local delivery

- [x] 280 PostgreSQL tests, 123 Vitest tests and 33 disposable-stack Playwright
  workflows pass; Ruff, strict TypeScript typecheck, production build and Alembic
  drift checks pass. The new workflow uploads a synthetic text manual without
  make/model, asks a grounded question with a real page citation and attaches the
  same manual to a second item; a mocked workflow confirms identity, searches,
  reviews and downloads at mobile width.
- [x] Backed up local data to `backups/housetory-20261105T120400Z` (all
  checksums valid), applied the append-only migration locally and deployed the
  standard Compose stack. The test-only PostgreSQL port remains unpublished.
- [x] Verified healthy api/db/worker/web services, served the new web assets,
  schema head `c4e6a8b0d2f4`, and preserved real-data counts (51 items, 1 user,
  1 member, 1 AI provider, 6 task settings, 5 import batches, 328 entries,
  1 loan, 0 purchases/documents/returns; uploads 2 files/1,177,655 bytes;
  imports 5 files/75,620 bytes). The new manual tables contain no real-household
  rows.
- [x] Screenshots for empty/populated desktop and mobile item states, grounded
  citations, honest unconfigured search and reviewed candidate download are in
  `docs/walkthrough/item-manuals/` and linked from `docs/ITEM_MANUALS.md`.
- [x] No live internet search, real vendor download, paid AI answer, email,
  credential creation or real household mutation was used. `MANUAL_SEARCH_URL`
  remains unset; live gateway/provider verification steps are documented and
  explicitly unverified.

## Manuals readiness gap — concrete search provider adapter

The first manuals delivery could only use an unspecified custom JSON gateway,
which made online discovery impractical without running another service. This
follow-up adds one concrete, documented provider while preserving the existing
upload/manual-QA pipeline, identity gates, candidate review, household scoping
and SSRF-safe download path.

### Stage A — Brave Search API adapter

- [x] Added the official [Brave Search API](https://api.search.brave.com/) Web
  Search adapter. Requests use the documented
  `GET /res/v1/web/search` endpoint, `X-Subscription-Token` header,
  `q`/`count`/`extra_snippets`/`text_decorations`/`safesearch` parameters and
  optional `country`/`search_lang`.
- [x] Added `MANUAL_SEARCH_PROVIDER=auto|brave|gateway|none`,
  `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_BASE_URL`, `BRAVE_SEARCH_COUNTRY` and
  `BRAVE_SEARCH_LANG`. `auto` keeps an explicitly configured gateway as the
  advanced option and otherwise selects Brave when its key is present.
- [x] The per-item manuals status now exposes `provider`, provider label,
  configured/can-search state and an honest unconfigured reason. The Find dialog
  shows the provider and explicitly states that no provider request is made until
  the user presses Search. No automatic Brave probe is performed, so validating
  configuration presence does not spend quota.
- [x] The key remains server-side. Errors map 401/403, 429, 5xx, redirects,
  timeouts and invalid JSON to safe messages without exposing the key or query.
  The existing assistant task/provider remains independent and unchanged.

### Stage B — normalize real results and discover PDFs without guessing

- [x] Brave `web.results[]` fields (`title`, `url`, `description`,
  `extra_snippets`, `profile`, `language`) are normalized into the existing
  candidate contract. Similar-product results are hidden unless their actual
  title/snippet/URL contains the confirmed model and variant.
- [x] Manufacturer provenance is validated conservatively: `manufacturer`
  requires both a registrable host-label match and a matching Brave profile
  name; `official` requires one of those; everything else is `other`. Provider
  claims are never treated as an official flag by themselves.
- [x] Direct `.pdf` results are accepted as real PDF candidates. For at most two
  manufacturer/official landing pages per search, Housetory may safely read the
  page and inspect actual anchor links. It accepts only a real `.pdf` link whose
  text/URL shows the model/variant or clear manual wording. It never guesses a
  `.pdf` address, follows JavaScript/meta refresh/embedded references or treats
  HTML as a manual.
- [x] `direct_file` distinguishes a real direct PDF from a source page in the
  API and UI. Source-page-only results show **Open source page** and **Upload
  manual** instead of a download action. Discovered/direct PDF URLs are shown
  for review when they differ from the source page URL.
- [x] Landing-page fetches retain pinned public-IP DNS, redirect bounds,
  HTTPS-downgrade refusal, 512 KB page cap, total wall-clock deadline and
  content-type checks. Only actual linked PDFs are later downloaded after review.

### Stage C — identity examples and model validation correction

- [x] Removed the arbitrary “model must contain a digit” rule. Completion is now
  the deliberately confirmed manufacturer-specific identity: at least two
  characters, containing a letter/digit and not a generic label. Letter-only
  models such as `Sonos One` are accepted; “Heavy drill”/“cordless drill”/“tool”
  remain rejected.
- [x] Corrected manual examples from the incorrect “Makita DCD791” pairing to
  the real DeWalt DCD791/DCD791B family in docs, tests and regenerated
  screenshots. Variant evidence still requires `B` for the concatenated
  `DCD791B` form.
- [x] The advanced JSON gateway remains documented and tested, but is no longer
  the only way to use online discovery.

### Stage D — verification and local delivery

- [x] 286 PostgreSQL tests, 124 Vitest tests and 33 disposable-stack Playwright
  workflows pass; Ruff, strict TypeScript typecheck, production build and Alembic
  drift checks pass. The manuals browser workflow now uses a fixture
  Brave-compatible service through the real adapter, validates the
  `X-Subscription-Token`/query construction, discovers a source, reviews it,
  saves/links a manual through the UI and asks a cited manual question.
- [x] Backed up local data to `backups/housetory-20261105T125745Z` (checksums
  valid), rebuilt and redeployed the local Compose stack. No schema migration was
  needed; head remains `c4e6a8b0d2f4`. The test-only PostgreSQL port remains
  unpublished.
- [x] Verified healthy api/db/worker/web services, served the new web assets,
  preserved real-data counts (51 items, 1 user, 1 member, 1 AI provider,
  6 task settings, 5 import batches, 328 entries, 1 loan, 0
  purchases/documents/returns; uploads 2 files/1,177,655 bytes; imports 5
  files/75,620 bytes), and confirmed the local API reports online search
  unconfigured without a Brave key rather than pretending it is ready.
- [x] Regenerated the manual screenshots with the real DeWalt DCD791 · B example,
  Brave provider status, exact-model candidate, manufacturer source, review
  state and source-page-only handling. They remain linked from
  `docs/ITEM_MANUALS.md`.
- [x] No real Brave request, real vendor PDF download, paid AI, email,
  credential creation, server deployment or real household mutation was used.
  The exact remaining user step is to supply a Brave Search API subscription
  token in `BRAVE_SEARCH_API_KEY` (or explicitly configure the advanced
  gateway), restart the API and perform one deliberate live verification.

## Staged milestone — inventory evidence package

This milestone adds a presentable, offline-readable inventory evidence package
without adding an insurance-management area, a stocktake claim, public sharing or
a new reporting framework. It reuses item/room/container scope, photos, documents,
purchases/allocations, loans, warranties, the durable worker and the existing export
entry points. Full output, totals, privacy, limits and limitations are in
`docs/INVENTORY_EVIDENCE.md`.

### Stage A — scope, evidence preview and snapshot

- [x] Added explicit item, room, container and current-home scope resolution with
  descendant hierarchy handling, union de-duplication and archived inclusion
  control. Empty/missing/cross-household scopes are handled without leaking data.
- [x] Added a read-only preview with item/unit counts, full location paths, evidence
  counts, document list, per-category and per-document inclusion, evidence size,
  purchase/current-value summaries and shared/legacy purchase warnings.
- [x] Document inclusion is limited to selected item links, selected-item warranty
  documents and selected-item purchase receipts. Shared documents are flagged and
  can be excluded individually; manuals/other documents are off by default.
- [x] Added snapshot fingerprinting and confirmation. A changed inventory/evidence
  state returns `inventory_changed` and requires a refreshed preview; the confirmed
  snapshot is stored and used by the worker. Request IDs make creation idempotent.
- [x] Added a compact responsive dialog with home, items bulk, room and container
  entry points. No mandatory new data-entry fields or top-level insurance section.

### Stage B — PDF, CSV and originals bundle

- [x] Generated a vector PDF with embedded Unicode fonts and PDF CID fallbacks,
  wrapping/pagination, cover summary, currency-separated value summary, referenced
  purchase table, per-item facts, photo thumbnails, evidence index and privacy/
  non-appraisal notes. No active content, scripts or external URLs.
- [x] Preserved purchase price versus current estimates, selected allocation versus
  shared purchase total versus legacy unallocated amounts, and kept currencies
  separate. Shared purchase totals appear once; no full receipt total is assigned
  to every item.
- [x] Excluded borrower names, loan notes, purchase notes and document notes. Loaned
  units remain owned and are reported with at-home and recorded on-loan quantities.
- [x] Added a stable, UTF-8 BOM CSV with formula-injection protection and no invented
  prices/dates. No XLSX workbook is claimed; CSV is the supported spreadsheet.
- [x] Added an optional ZIP with PDF, CSV, README and manifest; exact original
  document roles, normalized/cleaned derivatives, scan source pages and stored photo
  derivatives are distinguished. Files map to item/document IDs with byte counts and
  SHA-256. Shared documents are written once, names are sanitized and missing files
  are reported rather than silently omitted.
- [x] Added explicit photo/receipt/warranty/manual/other/original/CSV/ZIP controls,
  preview size estimates, bounded PDF photo count and package size limits.

### Stage C — durable jobs, retention and security

- [x] Added append-only `inventory_evidence_exports` storage and migration with
  household/user/job links, scope/options/snapshot/manifest, artifact keys/SHA-256,
  status, errors and expiry. The worker task updates the package and the API serves
  authenticated no-store PDF/CSV/ZIP downloads.
- [x] Generated artifacts use a separate private `/data/exports` volume mounted
  writable in API/worker; source uploads remain read-only to the worker. Temporary
  files are cleaned on failure/cancel/expiry. Source originals are never deleted.
- [x] Added queued/running/succeeded/failed/cancelled/expired states, cancellation,
  retry/regeneration, idempotent creation, background progress and 7-day default
  retention. A maintenance worker task and access checks delete expired artifacts.
- [x] Added household-scoped preview/create/list/detail/cancel/retry/download routes.
  Viewers may preview/generate/download under established read-only export rules;
  they can manage only their own package jobs, with cross-household IDs rejected.
- [x] Bounded item/document/photo counts, uncompressed ZIP bytes, embedded PDF
  photos, a wall-clock generation deadline and existing upload limits. ZIP paths
  are sanitized; CSV formulas are neutralized; no raw private contents/download
  URLs are logged.

### Stage D — verification and local delivery

- [x] 291 PostgreSQL backend tests, 127 Vitest tests and 35 disposable-stack
  Playwright workflows pass; Ruff, strict TypeScript typecheck, production build
  and Alembic drift checks pass. The Playwright run included the Brave/manual
  fixture workflow and the new evidence package workflow.
- [x] Added synthetic sample artifacts under `docs/samples/inventory-evidence/`
  (PDF, CSV, ZIP) and rendered/screenshot walkthrough files under
  `docs/walkthrough/inventory-evidence/`. The sample PDF was rendered and visually
  checked page by page, including Unicode text, embedded photo, evidence references,
  shared/legacy purchase notes and privacy statements.
- [x] Backed up local data to `backups/housetory-20261105T145849Z` (all checksums
  valid), applied append-only migration `b8d1e3f5a7c9`, and redeployed the local
  Compose stack. The new private exports volume is separate from uploads/imports.
- [x] Verified healthy api/db/worker/web services, served the new web assets,
  preserved real-data counts (51 items, 1 user, 1 member, 1 AI provider,
  6 task settings, 5 import batches, 328 entries, 1 loan, 0 purchases/documents/
  returns; uploads 2 files/1,177,655 bytes; imports 5 files/75,620 bytes),
  confirmed the new export table contains no real-household rows, and verified the
  test-only PostgreSQL port remains unpublished.
- [x] No real household evidence package was generated, no originals were deleted,
  no remote deployment or email was sent, and no paid AI/network service was used.
  XLSX is not implemented; CSV is the documented spreadsheet format.

## Staged milestone — stocktake and last verified here

This milestone adds a bounded room/container stocktake that records field
observations separately from reviewed inventory edits. It does not add a
background monitoring system, a write-off/archive shortcut, properties,
households or a new primary navigation area. Full status definitions, coverage,
privacy, limits and last-checked semantics are in `docs/STOCKTAKE.md`.

### Stage A — snapshot, scope and observations

- [x] Added append-only stocktake session/snapshot tables with immutable expected
  item/quantity/location/version facts, room and container descendant scope,
  overlap de-duplication, archived exclusion and bounded item counts.
- [x] Expected quantities keep owned, at-home and on-loan values separate. Loaned
  units are never expected at home and cannot be marked missing.
- [x] Added request-ID idempotency for start and observations, version/loan-context
  conflict checks, deleted-item handling and explicit refresh that only adds new
  in-scope items without deleting existing snapshot/history rows.
- [x] Added checklist statuses (unchecked, present, missing, moved, quantity
  discrepancy, couldn't check) plus unexpected findings. No page load or item view
  auto-marks unchecked items present.
- [x] Observations are immutable evidence with verifier/time, counted quantity,
  existing room/place, notes, loan context, ownership and a payload hash. They do
  not mutate inventory.

### Stage B — reviewed edits, history and completion

- [x] Added a review endpoint returning old/current/new quantity/location values,
  loan reduction warnings and conflicts for item/loan/destination changes.
- [x] Added atomic reviewed apply with a review fingerprint, sorted item locks,
  stale-review rejection, bounded correction batches, loan-safe quantity
  reductions, existing-place validation and no missing-item deletion/archive/
  write-off.
- [x] Reused item move history/safe undo for moves and added a non-undoable
  `stocktake.quantity_corrected` event for quantity corrections. Request-ID replay
  returns the original application and payload mismatch is rejected.
- [x] Added partial completion with explicit acknowledgement, exact item/unit
  coverage, unresolved missing/quantity/unknown/unexpected summaries and completed
  versus abandoned semantics. No fabricated legacy verification history.
- [x] Completed observations upsert a derived per-item last-checked state;
  later item, location, quantity or loan changes are labelled stale rather than
  remaining misleadingly “verified here”. Abandoned sessions never update state.

### Stage C — UI, permissions and evidence

- [x] Added compact room/container stocktake entry/history/resume, `/stocktake/:id`
  checklist with search/status filters, observation dialogs, unexpected finding
  flow, review/apply and partial finish/abandon dialogs.
- [x] Added last-checked display on item cards/details and room/container scope
  strips, with session links and changed-since labels. Mobile and keyboard states
  use existing cards, rounded controls, palette and shell; viewers are read-only.
- [x] Evidence PDF/CSV/manifest include exact last-checked facts and stale labels
  only when a real completed observation exists; the package keeps its recorded-
  not-verified and non-appraisal wording rather than broadly redesigning reports.
- [x] Added frontend/backend/E2E coverage and screenshots under
  `docs/walkthrough/stocktake/`.

### Stage D — final verification and local delivery

- [x] 300 PostgreSQL backend tests, 129 Vitest tests and 37 disposable-stack
  Playwright workflows pass; Ruff, strict TypeScript typecheck, production build
  and Alembic drift checks pass. The Playwright run includes the full stocktake
  start → mark → refresh/resume → review/apply → complete flow, partial
  completion, keyboard/failed-save/abandonment states and mobile screenshots.
- [x] Captured light/dark desktop and mobile screenshots plus a room last-checked
  strip under `docs/walkthrough/stocktake/`; no sample data was written to the
  real household.
- [x] Backed up local data to `backups/housetory-20261105T194957Z` (checksums
  valid), applied append-only migration `e9f3a5b7c1d2`, and redeployed the local
  Compose stack. The new tables remain empty for the real household and the app
  role has DML privileges on them.
- [x] Verified healthy api/db/worker/web services, served the new assets, and
  preserved real-data counts (51 items, 1 user, 1 member, 1 AI provider,
  6 task settings, 5 import batches, 328 entries, 1 loan, 0 purchases/documents/
  returns; uploads 2 files/1,177,655 bytes; imports 5 files/75,620 bytes). The
  existing evidence-export table remains empty and the test-only PostgreSQL port
  remains unpublished.
- [x] No remote deployment, paid AI, email, credential creation, real-household
  stocktake observation, upload deletion or arbitrary Docker cleanup was performed.
  Properties and multiple households were not started.

## Staged milestone — multiple properties within one household

This milestone adds a property layer between the household and its existing room
tree without changing household permissions, existing IDs/attachments/QR links,
or any purchase/loan ownership. Full rules are in `docs/PROPERTIES.md`.

### Stage A — schema, migration and consistency

- [x] Added `properties` with household scope, name, optional description,
  ordering and empty-only archive, plus `rooms.property_id` and property indexes.
  Room-name uniqueness is property/parent-scoped; parent/property consistency is
  enforced by application validation and a composite database constraint.
- [x] Added an append-only migration that creates one `Home` property per
  existing household, backfills every room without changing room/item/container
  UUIDs, permanent identifiers, loan quantities, photos/documents, imports,
  stocktake history or QR payloads. Historical activity snapshots are left as
  historical facts.
- [x] Backfill leaves item and last-checked `updated_at` values untouched; later
  real moves update item timestamps so last-checked state becomes stale.
- [x] New households receive an initial `Home` property. Room creation defaults
  only when there is one active property; nested rooms inherit their parent.
  Unlocated items remain explicitly unlocated.
- [x] Added household-scoped property CRUD/list, empty-only archive/delete guards
  and hierarchy locks. Viewers remain read-only; property IDs never bypass
  household membership checks.

### Stage B — hierarchy moves, filters and scope propagation

- [x] Added explicit top-level room-subtree preview and atomic move with request
  ID/review fingerprint, deterministic locks, affected room/place/item/unit and
  on-loan counts, ID/QR preservation, history event and stale last-checked
  behavior. Nested-only room moves are clearly rejected; populated properties
  cannot be archived/deleted.
- [x] Existing container moves and bulk item moves work across properties with
  source/destination property history, preserved identity and loan quantities.
- [x] Added remembered “All properties” filters to rooms, items and containers,
  server-side property filters, room grouping, active filter chips and selection
  clearing on property changes. Search/assistant/evidence remain all-property by
  default with property-labelled paths.
- [x] Added property paths to item cards/details, containers, search, assistant,
  evidence PDF/CSV/manifest, stocktake snapshots and label/QR destination context.
  Old QR/deep links remain stable.
- [x] Property context is stored for imports and voice notes; matching is scoped
  to the property, same-name rooms across properties are ambiguous rather than
  silently chosen, and hierarchy-created rooms use the selected property.
  Document/photo flows validate the same room/container/property relationship.

### Stage C — UI, tests and local delivery

- [x] Added compact property management under Settings, property selectors on
  rooms/items/containers and a room-subtree move dialog with explicit preview.
  Existing fonts, palette, cards, rounded controls and shell were retained.
- [x] Added PostgreSQL tests for multi-household backfill/IDs, unlocated records,
  CRUD/archive/delete guards, duplicate room names, parent constraints, room/
  container/bulk moves, loans/QR/last checked, filters/search/assistant/evidence/
  stocktake paths, import/voice property ambiguity, viewer and cross-household
  isolation.
- [x] Added Vitest property-management and room-property-move coverage, and
  disposable Playwright workflows for two-property filtering/remembering,
  add-item/container context, same-name rooms, cross-property move with preserved
  IDs/QR/loans and populated-property guards.
- [x] 307 PostgreSQL backend tests, 132 Vitest tests and 39 disposable-stack
  Playwright workflows pass; Ruff, strict TypeScript typecheck, production build
  and Alembic drift checks pass. Added light/dark desktop and mobile property
  screenshots plus the move/management walkthrough.
- [x] Backed up all local persistent volumes (database, uploads, imports and the
  separate evidence exports volume) to `backups/housetory-20261105T223653Z`
  with valid checksums, then applied append-only migration `f1a3c5e7b9d2` and
  redeployed the local Compose stack.
- [x] Verified one `Home` property for the existing household, every room assigned
  to it, and unchanged room/storage-location ID hashes, item ID/`updated_at`
  hashes, item/user/member/loan counts, uploads/imports files and bytes. The new
  properties table remains household-scoped and the app role has DML rights;
  property routes return 401 unauthenticated and the test-only DB port remains
  unpublished.
- [x] No remote deployment, email, paid AI, credentials, real-household property
  creation beyond the required additive backfill, volume cleanup or arbitrary
  Docker rollback was performed. Multiple-household switching was not started.

## Staged milestone — multiple households and All my places

This milestone keeps the household as the membership/security boundary while
letting one account join several households independently. The editable workspace
stays one household/property; search and assistant add a separate read scope over
current memberships. Full rules are in `docs/HOUSEHOLDS.md`.

### Stage A — account/household lifecycle

- [x] Added household list/create/select routes. Creation makes the account an
  owner, creates an initial property, selects the new household and is bounded by
  a per-account household cap/rate limit. Any authenticated account can create
  its first household from the no-household page; first-run setup is still sealed
  after the instance has users.
- [x] Session state now returns only the caller's current memberships and effective
  role. Selecting a household is membership-validated; an unauthorized id returns
  not-found without revealing another account's household name.
- [x] Same account may have different roles per household. Viewers remain read-only
  in that household but can be owners elsewhere; no global role or automatic
  cross-household access exists.
- [x] Added compact desktop/mobile household switching and a compact mobile account
  menu list. Account settings, household settings, members and properties remain
  distinct. Existing household/data/IDs/QR/provider settings are preserved.
- [x] Last-owner, concurrency and member-removal session revocation protections are
  retained. Invitations remain bound to household/email/role with wrong-account
  rejection. Household deletion/leave/transfer is intentionally unsupported.

### Stage B — explicit workspace context and isolation

- [x] Unsafe requests from multi-household accounts require a current
  `X-Household-Id`. A stale tab receives `409 household_context_changed` instead of
  writing to a newly selected household. The frontend sends the rendered
  workspace id and clears all non-session query caches/hash scope on switch.
- [x] Switching resets the remembered property filter, invalid remembered search
  scope, in-page selections and stale query results. Jobs/proposals remain owned by
  their creating household and are revalidated before apply/download.
- [x] Revoked selected membership returns a specific auth error; session state falls
  back to another current membership or the no-household state. Old caches are
  removed promptly. All existing routes/jobs/media/files were audited as
  household-owned.

### Stage C — All my places search, assistant and consent isolation

- [x] Added `/search/scopes` (current memberships + active properties), all-places
  quick search and paginated all-places item search. Default scope is All my places;
  deliberate household/property scopes are remembered and server-validated.
  Caller-supplied ids never grant another household. Results include household,
  property, room and place labels; duplicate names are distinct and ambiguous.
- [x] Assistant defaults to All my places. All-places and property-wide answers use
  deterministic retrieval only, querying each household separately and explaining
  the scope. AI interpretation is used only for one household without a property
  filter, with that household's own provider/task/cloud consent. All-scope tests
  assert AI planning is never invoked.
- [x] Loan whereabouts keep borrower/quantity facts and household-qualified home
  paths; cross-household duplicates ask which item was meant. Ordinary keyword and
  structured search works without AI. No cross-household writes or transfers exist.
- [x] Result/citation deep links carry validated household context and switch only
  after membership confirmation; old QR/deep links remain stable. Bounded household
  fanout, search windows, indexes/joins and in-process request limits avoid unbounded
  fanout and per-row N+1 queries.

### Stage D — UI, tests and local delivery

- [x] Added the compact household selector/creation dialog, no-household creation
  flow, All-my-places scope selectors, household-qualified item/assistant/search
  paths and clear read-scope vs editable-workspace wording without changing the
  visual system.
- [x] Added PostgreSQL tests for lifecycle, roles per household, stale context,
  revocation fallback, invitations, IDOR, all-places counts/paths/loans, duplicate
  names, property isolation and per-household AI provider selection. Vitest covers
  selector/cache-reset behavior. Disposable Playwright covers two-household creation,
  switching, property reset, all-places search/loan answers, remembered scope and
  cross-household deep links.
- [x] 317 PostgreSQL backend tests, 138 Vitest tests and 40 disposable-stack
  Playwright workflows pass. Ruff, strict TypeScript typecheck, production build
  and Alembic drift checks pass. Light/dark desktop/mobile screenshots are under
  `docs/walkthrough/households/`.
- [x] Backed up all local persistent volumes (database, uploads, imports and the
  separate evidence exports volume) to `backups/housetory-20261106T011330Z` with
  valid checksums, rebuilt the local Compose stack and verified health/assets.
  No new schema migration was needed: the existing membership/session tables
  already carry the multi-household model. Alembic head remains
  `f1a3c5e7b9d2`.
- [x] Verified the real local data is unchanged: 1 household, 1 property, 8
  rooms, 10 storage locations, 51 items, 1 user, 1 membership, 1 loan, 0 evidence
  exports; unchanged room/item ID and item `updated_at` hashes; uploads 2 files/
  1,177,655 bytes, imports 5 files/75,620 bytes, exports 0 files. No real
  household was created, no membership/settings were changed, the DB port stays
  unpublished and the test-only database was removed.
- [x] No remote deployment, email sending, paid AI/provider call, credential
  change, arbitrary Docker volume cleanup or cross-household transfer was
  performed. Real external AI provider quality remains untested. Item images were
  not started.

## Staged milestone — item images, references and illustrations

This is the final planned roadmap milestone. Actual photographs remain the only
physical evidence; reference/AI/built-in images are labelled display aids. Full
rules are in `docs/ITEM_IMAGES.md`.

### Stage A — source model, built-ins and display priority

- [x] Added a separate `item_images` source model with household/item/provider
  ownership, source type, status, private storage metadata, source URL/page/
  publisher, retrieval time, exact-model confirmation, fingerprint, prompt/error
  and one-active-image-per-item partial unique index. Actual `item_photos` are
  untouched and always take priority.
- [x] Added a small offline built-in line-art library (drill, TV, Ethernet cable,
  suitcase, box, chair, sofa, camera, laptop, kettle, bicycle, book, generic) with
  conservative local matching and category-icon fallback. Users can choose/change/
  remove/reset or use a generic illustration without overwriting actual photos.
- [x] Item cards/details show explicit Reference image / AI illustration / Generic
  illustration labels and provenance; source, retrieval date and “exact model not
  confirmed” are available in details. Non-actual imagery is excluded from
  evidence, recognition and stocktake physical evidence. Item facts/stock/loans
  are never changed.

### Stage B — automatic reference-image search

- [x] Extended the real Brave integration to the documented Image Search endpoint
  (`/res/v1/images/search`) with bounded response/query limits, official auth
  fields and fixture-tested parsing. No invented endpoints or custom gateway is
  required.
- [x] Implemented deterministic candidate ranking with brand/type conflict
  rejection, stock/watermark-host rejection, manufacturer-host preference,
  exact-model evidence detection and representative fallback. Image-only model
  relaxation applies; manuals/model-specific instructions retain the full model
  gate.
- [x] Explicit Find image and the default-off new-item setting automatically
  select and display a suitable lawful candidate without a candidate-approval
  dialog. No candidate falls back to the built-in/category illustration. Source
  page/retrieval/provenance is stored; reuse/licensing is not assumed or verified.
- [x] Added safe image download: public DNS/pinned address, redirect/byte/time
  bounds, image type/signature/dimension decode validation and private normalized
  derivatives. The same lookup is deduplicated and reused within a household only.

### Stage C — AI illustrations and automation

- [x] Added the Item illustrations AI task using the documented OpenAI Images API
  (`/images/generations`, inline `b64_json` only), not chat-completion output.
  Reuses encrypted providers/task/consent settings; the prompt contains only
  minimized product text. URL-only/malformed responses fail honestly.
- [x] Manual generation is preview → accept/reject/regenerate with an AI/not-a-
  photo label. Automatic new-item generation is a separate default-off setting,
  requires sufficient saved product text/no photo, and runs only after save.
  Explicit batch action is the only old-item path.
- [x] Added hard daily generation count caps, one-attempt jobs, replay/dedupe,
  progress/cancel, draft TTL/stale checks, actual-photo/archived/item-change
  rejection and file cleanup. No monetary cap or provider-billing estimate is
  claimed.

### Stage D — permissions, jobs, UI, tests and local delivery

- [x] Added owner-only household settings (auto reference, auto generation, hard
  daily cap, default off), member image actions and viewer read-only labels.
  Household-scoped provider/artifacts/jobs/file routes and stale-tab context rules
  are reused. Non-photographic files are private and never logged with contents.
- [x] Added backend coverage for built-ins/priority/override, Brave parsing/ranking/
  conflicts/stock-host rejection, provenance, representative vs exact labels,
  reuse/dedupe, evidence exclusion, AI preview/accept/reject, caps, batch
  preview/replay/cancel, permissions/IDOR and OpenAI image adapter success/error
  contracts with fixtures. Vitest covers card/control source priority and preview
  acceptance. Disposable Playwright covers built-in → mocked automatic reference →
  actual-photo priority, manual AI preview/accept, no-provider states, settings and
  batch cancellation with screenshots.
- [x] 326 PostgreSQL backend tests, 143 Vitest tests and 44 disposable-stack
  Playwright workflows pass. Ruff, strict TypeScript typecheck, production build
  and Alembic drift checks pass. Item-image screenshots are under
  `docs/walkthrough/item-images/`.
- [x] Backed up all local persistent volumes (database, uploads, imports and the
  separate evidence exports volume) to `backups/housetory-20261106T031456Z` with
  valid checksums, applied append-only migration `a8c0e2f4b6d8`, and rebuilt the
  local Compose stack.
- [x] Verified existing data/settings: 1 household, 1 property, 8 rooms, 10
  storage locations, 51 items, 1 user, 1 membership, 1 loan, 0 evidence exports,
  0 actual item photos and 0 item-image rows; unchanged room/item ID and item
  `updated_at` hashes; uploads 2 files/1,177,655 bytes, imports 5 files/75,620
  bytes, exports 0 files. Existing AI providers/tasks (assistant, documents,
  imports, labels, search, vision) are unchanged; the new item-image settings
  default to off/off/10 and no item-image jobs were queued for existing records.
- [x] Local api/db/worker/web are healthy, current assets return 200, new image
  routes return 401 unauthenticated, Alembic reports no drift and the DB port
  remains unpublished. SMTP/AI credentials and all existing item/photo/document
  IDs/files were preserved. No real item images, external Brave/OpenAI calls,
  remote deployment, email, credential changes or arbitrary Docker cleanup were
  performed. Real external provider image quality/availability remains for live
  validation.

## Agreed product roadmap — updated 2026-11-05

This sequence supersedes the previous desktop-app recommendation. These are
planned milestones, not completed capabilities or authorization to start them.
Voice notes are complete and locally verified. Milestones 2, 3, 4, 5, 6, 7, 8, 9,
10, 11 and 12 are implemented and locally verified; the planned roadmap is
complete and awaits final user review.

1. **Voice notes:** complete and verify recording/upload, transcription, repeated
   mention quantities, location matching and review-before-confirmation.
2. **Lending, movement history and undo (implemented locally):** prioritise the
   user's everyday lending workflow. Record borrower name (no borrower account required), lent date,
   optional due date and a clear lent/returned state. Preserve the normal home
   location; lending is not a move into a fictitious room. Support partial lending
   and returns for quantity-bearing items without losing or double-counting stock.
   Show outstanding loans and overdue status, allow corrections, and keep contact
   details private. Automated email reminders require separate configuration and
   explicit recipient/notification choices; do not send unsolicited borrower mail.
   Add who/when/from/to history for item and container moves, including lending
   events where relevant. Offer safe undo with permission and intervening-change
   checks. Inspect/reuse existing movement functionality rather than duplicating it.
3. **Bulk organisation (implemented locally):** select multiple items to move,
   tag or categorise; offer a compact list view alongside existing cards. Preview
   affected items and destination, handle quantity/location ambiguity and partial
   failures clearly, preserve permissions and record changes in history. Reuse
   safe undo primitives.
4. **Receipt and document scanning (implemented locally):** inspect existing
   Documents/OCR capabilities first; add capture, crop, perspective correction,
   rotation, contrast cleanup and multi-page PDFs while preserving originals.
   Accept files from dedicated scanning apps. Basic cleanup must not require an
   LLM.
5. **Intelligent extraction and matching (implemented locally):** propose receipt
   fields and line items, purchases, warranties and attachments. Use an available,
   consented LLM to interpret abbreviations and rank relevant inventory candidates
   with evidence; retain OCR/basic matching without it. Exact identifiers carry
   strong weight. Handle duplicate documents, no matching item and per-line
   purchase values. Review before creating, attaching or overwriting records.
   Before this work, check that matching, jobs and AI context use explicit
   household scope.
6. **Single-home polish, including unified search and assistant:** make manual,
   photo, voice and document flows consistent, with duplicate/quantity handling.
   Use one everyday input labelled “Search or ask about your inventory…”.
   - Short queries such as “PS5” show matching items and boxes immediately,
     without requiring an LLM. Show ordinary matches while typing; Enter submits
     the full search/question rather than triggering paid AI on each keystroke.
   - Questions such as “Which items have no purchase information?” produce a
     structured, validated database query and linked/filterable item results,
     explaining the missing-information criterion. The database supplies actual
     results and counts; an LLM may interpret intent, never invent inventory.
   - Open-ended questions produce an assistant answer grounded in accessible
     records, with item links. Ambiguous intent offers matches and an explicit
     “Ask assistant” action. Keep longer conversations on the assistant page,
     allowing a question to continue there without losing its context.
   - Preserve useful ordinary search without AI, show honest unavailable/error
     states, enforce permissions and cloud consent, and treat queries as
     untrusted data. Changes require a specific destination and confirmation.
   - Make overview useful with sparse data: lead with finding/organising items,
     recent items and rooms; collapse empty financial/warranty panels. Surface
     outstanding loans when relevant, without adding another wall of empty cards.
   - Purchase information supports explicit “Unknown” and “Not applicable” states;
     avoid treating every item as an outstanding purchase-information task.
     Define how these states affect counts and missing-information searches.
   - Standardise container/storage terminology and present display name, permanent
     identifier and full room path consistently across cards, filters and details.
     Do not rename user records or identifiers merely to improve presentation.
   - Hide irrelevant empty filters and show active filter chips. Reduce empty item-photo placeholders and redundant upload
     controls. Remove empty-library export calls to action while retaining normal
     export capability once useful. Lead assistant with the question and retain
     accurate provider/privacy information in compact expandable details.
   **Item-detail loan-status follow-up (implemented locally):** the item title now
   carries a prominent text-backed loan panel with borrower summaries, accurate
   owned/at-home/on-loan quantities, optional due date, overdue text and direct
   per-loan Record return actions for permitted users. Viewers remain read-only.
   While loaned, the stored place is labelled “Usual home location” with an
   explanation that it covers at-home stock only. The empty gallery is compact with
   one photo-control pair; populated galleries retain their full behaviour. See
   `docs/ITEM_LOAN_STATUS.md`. The next lending-usability follow-up below remains
   queued and has not been started.

   **Loans-page actions and natural wording follow-up (implemented locally):**
   the Loans page now has a New loan picker over active household inventory with
   current available stock, disabled fully loaned items and clear
   loading/no-match/error states. The existing Lend dialog enforces server stock,
   archive, permission and idempotency rules; stale stock errors stay in the
   dialog. Outstanding rows show plain borrower text, an item link, recorded home
   and dates, separate View details and direct Record return actions; the return
   dialog defaults to outstanding quantity and supports partial return. Closed
   rows and viewers have no return action. See `docs/LOANS_USABILITY.md`.
   Simple grounded loan answers now use direct natural language (“Mohsen has your
   DeWalt drill. No return date is set.”), quantity-aware partial/multiple
   breakdowns, recorded dates and home paths, with missing/ambiguous/no-match
   states stated honestly. Internal “Grounded answer”/“whereabouts of …” labels and
   the generic return guarantee disclaimer were removed; search helper text is
   “Search for an item or ask a question.” Provider/consent details remain
   secondary. No paid model is used to paraphrase basic facts. The manuals
   milestone below remains queued and was not started.

7. **Item manuals and grounded product help (implemented locally):** build on
   existing Manual document type and item attachments rather than a parallel library. Deliver in stages:
   - Make Add manual/upload and existing-manual attachment easy to discover from
     item details. Permit manual upload even without make/model. Allow one manual
     to serve several compatible items, retaining authenticated access and source
     provenance. Preserve originals and current document safety/size limits.
   - Add Ask about this item, using permitted attached manuals first. Retrieve
     relevant passages and cite document/page (or clearly identified section when
     page mapping is unavailable); do not fabricate page numbers. Distinguish
     manual facts from general explanation and admit missing evidence. Require
     a configured/consented suitable model; ordinary document access works without
     AI. Treat manual text as untrusted data, never tool or system instructions.
   - Offer explicit Find manual using online search only when BOTH manufacturer
     and complete model identifier are recorded. Generic item names or inferred
     guesses are insufficient. Enforce this gate server-side for automated online
     search AND download, and explain missing fields in the UI. Confirm regional,
     hardware or revision variants where compatibility remains ambiguous. An LLM
     may identify/rank candidates, but exact compatibility needs source evidence.
   - Prefer official manufacturer sources, show model coverage, language and
     source link, and require review before downloading/saving a proposed manual.
     Keep source URL/retrieval date and duplicate detection; no silent background
     downloading, bulk crawler or manual-site account/paywall bypass. Verify
     response type, size, file safety and compatibility; protect download workers
     from SSRF, redirects to private networks and unbounded retrieval. Respect
     current household roles and document access/retention behavior.
   - Optionally research item-specific questions online only with complete make
     and model, explicit user action and configured search/tool capability. A chat
     model is not assumed to have live browsing. Prefer manufacturer information,
     cite sources and clearly distinguish web evidence from the attached manual.
     Send only required product identifiers/question, not borrower or household
     data. Honor provider consent and configured limits; no autonomous tool loops
     driven by untrusted retrieved content. If model/revision is uncertain, ask;
     do not supply model-specific operating instructions from a similar product.
   Preserve visual style and integrate compactly into item details/Assistant, not
   a new top-level product section. Verify missing-make/model gates, mismatched
   variants, unknown sources, citations, download safety, consent, permissions and
   duplicate/manual reuse on isolated fixtures. No real online/paid calls in tests.
8. **Inventory evidence package (implemented locally):** export selected items,
   boxes, rooms or the current home as a presentable itemised PDF, with an optional spreadsheet and
   bundle of original supporting attachments. Include recorded quantities,
   location paths, photos, serial/model identifiers, purchase details, receipts
   and recorded values where available. Clearly distinguish purchase price from
   current estimates, preserve currencies without unsupported conversion, and
   mark unknown/missing information rather than inventing facts or valuations.
   Include export date and scope; distinguish recorded inventory from physically
   verified contents. Offer the user a preview and attachment selection before
   download. Keep access household-scoped, protect private documents, and allow
   saving outside the home server. No automatic sending to insurers. Position as
   “Export inventory with evidence”, useful for insurance, theft/loss documentation
   and moving; do not claim insurer acceptance, coverage or professional appraisal.
   Reuse existing export infrastructure and avoid adding an insurance-management
   section or mandatory purchase data entry.
9. **Stocktake / last verified here (implemented locally):** allow checking a room or box against its
   recorded contents, explicitly marking present, missing, moved or quantity
   discrepancies. Record who verified what and when; distinguish a verification
   from an edit. Do not mark unchecked contents as present or overwrite quantities
   automatically. Preserve an interrupted stocktake for later completion.
10. **Multiple properties in one household (implemented locally):** property → room → storage/box → item;
   migrate existing inventory into an initial property without breaking IDs,
   attachments or QR links. Add property context/filters and clear location paths.
   Initially retain household-level permissions across all its properties.
11. **Multiple households (implemented locally):** creation, switching, household-specific invitations,
   membership roles, settings and verified isolation in jobs, AI and documents.
   Search and assistant must support “All my places” across households/properties
   the account can access, with explicit filters and labelled result locations;
   remember a deliberately selected narrower scope. Revalidate permissions before
   retrieval and exclude revoked access. Respect each household's cloud-provider
   consent rather than sending its data through another household's provider.
   Mutations identify a particular household/property and clarify ambiguity.
   Cross-household item transfers are deferred beyond the initial release.

12. **Item images — reference pictures and illustrations (implemented locally):**
   deliver after the property/household milestones, preserving the existing visual feel. Distinguish
   actual user photos, downloaded product references, representative images,
   custom AI illustrations and built-in illustrations in storage and presentation.
   - Display priority: user photo, suitable product/reference image, accepted
     custom AI illustration, built-in type illustration, category icon. User can
     change/remove/reset the choice; actual photos always take precedence.
   - Small curated built-in illustration library for common types (Ethernet cable,
     TV, drill, suitcase etc.), consistently styled, locally matched conservatively
     and usable offline without LLM calls. Vague types use broad fallback icons.
   - Find product image uses real configured search and bounded safe downloads,
     manufacturer sources preferred. Exact confirmed make/model yields an exact
     reference only when evidence supports compatibility. An LLM may rank real
     candidates, never invent URLs, source permissions or model compatibility.
   - IMPORTANT image-specific relaxation approved by user: full model is NOT
     required for representative images. “LG TV” + “OLED, 77-inch” is sufficient
     to search, automatically choose a suitable clean single-product image and
     show it without a candidate approval dialog. Match known attributes, reject
     obvious brand/type conflicts and use a generic fallback if no suitable image.
     Exact model certainty is not required for a representative browsing thumbnail.
   - Label downloaded images “Reference image”; source and whether exact model is
     confirmed are available in details. Representative images must not silently
     populate make/model/colour/specification/condition fields from depicted details.
     Provide Change image, Remove and Use generic illustration; user need not
     choose a candidate in the normal automatic flow.
   - Automatic lookup for newly saved items is a household opt-in setting, off by
     default, operating only after inventory review/save with sufficient description
     and no real photo. No per-keystroke searches. Separate batch action for old
     items with explicit scope, limits/progress/cancel and no surprise full-library
     processing. Deduplicate jobs/downloads and discard stale results after item
     changes or a real photo upload. Preserve source URL, retrieval date and image
     provenance. Respect source image-use permissions; do not assume discovery
     grants reuse rights, bypass restrictions or remove watermarks.
   - Optional Item illustrations task uses a compatible image-generation model,
     reusing existing credentials where supported. Manual generate/preview/accept
     first; optional default-off automatic generation for new saved items and later
     batch generation. Spending/job/concurrency limits, explicit provider consent,
     honest estimates only when reliable and no repeated paid retries. Text LLM
     prompt assistance optional, never required for simple descriptions.
   - Send only required product text to search/generation providers, not borrowers,
     room contents, receipts or household notes. Household-scoped permissions and
     consent; safe SSRF/DNS/redirect/file/type/size/time protections as manual
     downloads, private storage and cleanup. Generated/reference artwork must be
     visibly distinguished and excluded from insurance/evidence/condition claims
     and physical photo-based recognition/stocktake evidence. Never overwrite photos.
   - Stages: provenance/display + built-in library; real search with automatic
     representative selection; manual AI generation; automation/batch. Test known
     attributes vs conflicting candidates, fallback, labels/evidence exclusion,
     permissions, job races/cost caps and real-photo priority on isolated fixtures.
     No paid/external calls in automated tests. This relaxation applies ONLY to
     images: manuals and model-specific online instructions retain complete,
     confirmed manufacturer/model gates.

### Visual continuity and delivery boundaries

The user likes the current feel: preserve typography, dark palette, spacing
character, cards, rounded controls and overall navigation shell. This is an
incremental refinement, not a redesign. Prefer existing components and small,
reviewable changes; do not replace the dashboard/sidebar wholesale or introduce
a new design system. Review representative before/after desktop and mobile views.
Low-risk polish directly related to a milestone can ship with it; broader overview
reordering and unified search remain in the dedicated polish milestone. No drastic
visual change is implied by this roadmap.

For each milestone: OpenCode implements, verifies and deploys locally; we review
after the user reports completion. Deploy to the server only on explicit request,
using GitHub fetch/checkout of a verified commit for future deployments, with
backups and migrations that preserve server secrets/data and existing nginx.
Keep future household/property boundaries explicit during earlier milestones,
without exposing unfinished multi-home UI. No additional work is queued merely
by adding it to this roadmap.
