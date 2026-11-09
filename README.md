# Housetory

> **Everything has a place.**

Housetory is a private, self-hosted record of everything you own. Rooms hold
nested storage places; items carry photographs, receipts, manuals, warranties,
purchase history and current-value estimates. Local OCR reads receipts, a
searchable document library keeps the paperwork, and ownership reports stay
honest across multiple currencies.

Designed for a CPU-only Linux server, reachable over a private tailnet, a trusted
LAN address or a public HTTPS hostname, and installable on an iPhone as a PWA.
Tailscale is optional.

![Status: AI intelligence, mobile camera, imports and voice notes complete](https://img.shields.io/badge/status-AI_%2B_camera_%2B_voice_complete-56614f)

## What is working

- First-run owner setup, Argon2id passwords and session authentication.
- A responsive React application with light/dark modes, designed for desktop and
  iPhone. Mobile text controls stay at a Safari-safe 16px minimum, Settings has
  no 320px overflow, and a five-tab bar plus More menu replaces the crowded
  eight-tab navigation. See [`docs/RESPONSIVE_MOBILE.md`](docs/RESPONSIVE_MOBILE.md).
- Rooms with optional nesting; shelves, cabinets, drawers and boxes with
  unlimited nesting.
- Movable containers (boxes, plastic bins, crates, suitcases and bags) with
  permanent human-readable identifiers such as `BOX-001`, optional names,
  live contents and private authenticated QR codes.
- Atomic cross-room moves that preserve the container UUID, identifier, QR
  identity, contents, nested places, document links and import provenance.
- One shared household with independent accounts, owner/member/viewer membership
  roles, owner-managed invitations, account-level password recovery and
  provider-neutral SMTP delivery (Resend is an example provider, not a default).
- Explicit conversion of existing storage places into containers; fixed shelves,
  cabinets and drawers can also receive optional identifiers such as
  `SHELF-001`.
- Owned items can provide storage: a toolbox, TV stand, car or other physical
  object keeps its purchase, warranty, value, photos, documents, tags and history
  while its item page contains the other items stored inside. A car can therefore
  have nested Boot and Glovebox places without becoming a fake room or property.
  Existing containers can
  deliberately create or link one owned item, preserving the container/QR identity.
  Items that provide storage stay at quantity 1; separate physical units are
  separate items rather than invented instances. See
  [`docs/ITEM_STORAGE.md`](docs/ITEM_STORAGE.md).
- Live container contents counts and category grouping derived from current
  items; no saved summary snapshot, regeneration step, AI headline or stale claim.
- A4 adhesive label printing with verified Avery L7160/L7163/L7165/L7651
  presets, compact/standard/detailed layouts, custom geometry, partial-sheet
  starting positions, calibration offsets, PDF preview and vector QR codes.
  Standard labels print only the permanent identifier, optional display name and
  a QR link to the live authenticated contents; item names, counts, summaries and
  current rooms are never printed.
- Reverse search by `BOX-001` or item name, with container identifiers shown in
  item cards, search results and assistant answers.
- Hierarchy-aware browsing: room and place filters include descendants, counts
  aggregate nested items, and room selections are deep-linkable.
- Items with search across room, place, category, tag and item fields; quantities,
  condition, categories and tags.
- Multiple item, room and container photographs with validation, thumbnail
  generation, EXIF stripping, HEIC conversion, cover selection, explicit
  reordering and a full-screen viewer. Room/container photo areas use a compact
  bounded empty state, then a responsive cover and compact thumbnails.
- Direct **Take Photo** and **Choose Photo** actions for items, movable
  containers, rooms and storage locations, with preview, retake, cancel and
  upload progress.
- A dedicated document library for receipts, invoices, warranty certificates,
  manuals, specifications and other files, associated with one or many items.
- PDF, JPEG, PNG, WebP, HEIC and text uploads; original uploads are preserved,
  safe downloads are normalized, and older documents remain readable.
- **Inventory evidence package**: select items, rooms, containers or the current
  home, preview scope and included evidence, then generate a presentable PDF
  report, optional formula-safe UTF-8 CSV and optional private ZIP of originals/
  derivatives with a SHA-256 manifest. Recorded facts, currencies, shared purchase
  totals, per-item allocations, on-loan quantities and missing/unknown values stay
  explicit; borrower names and private notes are excluded. Packages run in the
  durable worker, can be cancelled/retried, expire automatically and use
  authenticated no-store downloads. No AI or external fetch is required. See
  [`docs/INVENTORY_EVIDENCE.md`](docs/INVENTORY_EVIDENCE.md).
- **Multiple properties in one household**: organise inventory as
  property → room → fixed place/container → item, with a compact “All properties”
  selector on rooms, items and containers. Existing data is backfilled into an
  initial `Home` property per household without changing any IDs, permanent box
  identifiers, photos, documents, loans or QR links. Property filters are
  server-enforced and remembered; same-named rooms in different properties stay
  distinct. Top-level room subtrees, containers and bulk item moves can cross
  properties with an explicit scope preview, preserved identities and loan-safe
  last-checked staleness. Populated properties cannot be archived or deleted.
  See [`docs/PROPERTIES.md`](docs/PROPERTIES.md).
- **Scoped place management and safe emptying**: room, storage-place and container
  item lists reuse the Items bulk selection/action workflow with direct/nested
  scope, search, sort and mobile-friendly selection. Item detail preserves a safe
  same-app origin through edit/save/back, including after an item moves. Containers
  expose consistent delete actions; empty storage places become recoverable
  tombstones, while nonempty rooms/containers offer **Move contents and delete**
  with previews, or **Move all contents** without deleting. Room deletion remains
  explicit and irreversible; active contents still block it, while historical
  tombstones are detached after a truthful warning and become restore-unavailable.
  Transfers preserve nested places, quantities, documents, loans, photos and
  active borrowed placements, reparent child rooms, reject cycles/cross-household
  destinations, and roll back completely on stale counts or verification failure.
  See [`docs/PLACE_MANAGEMENT.md`](docs/PLACE_MANAGEMENT.md).
- **Multiple households and All my places**: one account can join independent
  households with a different owner/member/viewer role in each. Create or switch
  households from a compact selector; editing stays in one explicit workspace,
  while keyword search and the assistant default to **All my places** across only
  the account's current memberships. Search and answer labels include household,
  property, room and place; duplicate names across households stay distinct and
  ambiguous. Multi-household mutations require a current household context, so a
  stale tab cannot write to a newly selected household. Revoked access falls back
  immediately. All-my-places search and assistant answers interpret each
  household only with that household's own configured provider and consent; an
  unconfigured household stays deterministic and never inherits another
  household's provider. See [`docs/HOUSEHOLDS.md`](docs/HOUSEHOLDS.md) and
  [`docs/UNIFIED_SEARCH.md`](docs/UNIFIED_SEARCH.md).
- **Item images and references**: actual photos always take priority, followed by
  labelled public reference images and existing legacy AI illustrations, then a
  compact category-icon fallback. New AI illustration generation was retired;
  existing AI media remains viewable, replaceable and removable. Built-in line-art shapes and their chooser
  have been removed; legacy built-in rows are retained but retired from display.
  Optional Brave Image Search automatically selects a compatible public-web
  reference without a candidate-approval dialog, using conservative query-only
  brand/type/size/technology inference when the structured brand is blank,
  whole-token exact-model matching and verified manufacturer registrable domains.
  It records source/provenance, keeps unknown reuse permission honest, and labels
  representative images as “exact model not confirmed.” Public-web lookup needs
  only the household enable toggle and Brave key; an optional advanced domain
  restriction can narrow downloads. Optional
  OpenAI Images task generation is manual
  preview/accept/reject by default, with a separate default-off new-item setting,
  hard daily count caps and an explicit batch action. Non-photographic imagery is
  excluded from evidence packages, photo recognition and physical stocktake
  evidence; no generated/reference detail changes item facts. See
  [`docs/ITEM_IMAGES.md`](docs/ITEM_IMAGES.md).
- **Inventory review and optional schedule**: one persistent `/review` destination
  for scoped, rule-first inventory suggestions across the household, property, room,
  container or selected items. Offline checks propose evidence-backed categories,
  conservative naming consistency, advisory possible duplicates with comparison-only
  handling, missing purchase details and description/location wording conflicts.
  Suggestions persist, deduplicate unchanged findings, support applied category/name
  changes with stale checks and real undo, and keep duplicates/missing details
  advisory. Optional owner-triggered AI review reuses the existing consented
  Assistant task with a bounded one-request data disclosure. Combined
  **Organisation** suggestions cover existing/new categories and up to three
  practical tags per item, with atomic apply and exact category/tag undo. Latest
  review shows provider, model, items sent and completed/skipped/failed AI. An optional
  owner-managed weekly/monthly schedule is off by default, runs through durable
  worker jobs with hard item/daily caps, and never auto-applies changes. Scheduled
  AI requires its own consent tied to the current Assistant route; provider/model
  changes safely skip AI until reconfirmed. See
  [`docs/INVENTORY_REVIEW.md`](docs/INVENTORY_REVIEW.md).
- **Stocktake / last verified here**: start a bounded check from a room or
  container, including descendants. The expected snapshot keeps owned, at-home
  and on-loan quantities separate; loaned units are never marked missing.
  Compact checklist statuses (present, missing, moved, quantity differs,
  couldn't check, unexpected) are observations, not edits. Old/current/new
  corrections are reviewed and applied atomically with stale/conflict detection,
  request-id replay and loan-safe quantity reductions. Partial completion records
  exact coverage and unresolved discrepancies; completed checks update compact
  item and scope “Last checked” state, with later changes labelled stale rather
  than misleadingly verified. Evidence exports include exact last-checked facts
  only when a real completed observation exists. See
  [`docs/STOCKTAKE.md`](docs/STOCKTAKE.md).
- **Item manuals and grounded product help**: one combined Documents & manuals
  surface on the item page handles uploaded manuals, ordinary documents, scanned
  pages and deliberate library links. It reuses existing Manual-library documents
  across compatible items and offers Ask about this item, Add manual, Link
  existing and Find manual without a second duplicate document/manual list.
  Answers use the attached manuals' actual text, cite real pages when page-level
  OCR exists and explicit sections/excerpts otherwise, and fall back to extractive
  evidence without AI. Online search and download require a deliberate,
  server-enforced manufacturer + complete model confirmation, reviewed candidates
  and a configured search provider. The owner adds one encrypted Brave Search API
  key and enables manual discovery in **Settings → Online search**; an
  operator-only environment fallback and the advanced manual gateway remain
  available. Similar products are never auto-accepted. See
  [`docs/ITEM_MANUALS.md`](docs/ITEM_MANUALS.md) and
  [`docs/ITEM_FORM_AND_FILES.md`](docs/ITEM_FORM_AND_FILES.md).
- CPU-only local OCR through Tesseract and Poppler in the worker: merchant,
  purchase date, total, currency, invoice number, product names and serial
  numbers are proposed for explicit review before inventory changes.
- Shared purchase records: one purchase can cover several items without
  duplicating the amount, receipt or merchant.
- Warranties with provider, start date, duration, calculated expiration,
  certificate document, coverage notes, status and configurable reminders.
- Ownership overview with historical purchase transaction value, category and
  room breakdowns, and items missing purchase information. Current-value cards
  and rankings are intentionally not maintained in the ordinary UI.
- **Insurance replacement lists**: select inventory, request bounded background
  AI replacement estimates or enter values manually, edit/exclude rows in one
  review table, and generate dated PDF/CSV snapshots. Existing consented AI and
  optional Brave comparisons preserve real source links and uncertainty. Values
  are export-only; no item `current_value_*` field or purchase record is changed.
  Existing values remain visible read-only as Earlier estimates and legacy APIs
  remain compatible. See [`docs/ITEM_VALUATION.md`](docs/ITEM_VALUATION.md).
- A household **Default currency** for new purchase and current-value entries,
  applied consistently by item forms, imports and API fallbacks. Existing records
  and document-extracted currencies stay explicit. Multi-currency reporting never
  adds currencies together; there is no implicit exchange rate.
- CSV exports for documents, purchases, warranties and inventory.
- AI-assisted bulk inventory import from pasted text, TXT, Markdown, CSV, XLSX,
  DOCX, PDF, OCR images and complete Obsidian ZIP vaults through the ordinary
  **Upload file** action.
- Import review with per-field provenance, source context, inline missing-room and
  missing-place creation, duplicate candidates, merge/skip/reject decisions,
  partial approval, retry safety and import history.
- First-class Obsidian parsing: YAML frontmatter, properties, wikilinks and
  aliases, embeds, nested tags, Markdown tables, checklists, nested folders,
  attachment resolution, broken-link reporting and vault structure.
- One unified search and read-only grounded assistant flow: direct inventory
  lookup first, configured consented AI only when interpretation is needed, and
  honest direct-only results when no provider is available. See
  [`docs/UNIFIED_SEARCH.md`](docs/UNIFIED_SEARCH.md).
- One smart **Add items** input (dialog on desktop, bottom sheet on mobile):
  text, a photo with an optional note, a voice note or a single product link
  all converge on the same import review/apply workflow, with a link to the
  manual form.
  Recognition adaptation is idempotent, product pages use bounded SSRF-safe
  retrieval, and no transcript writes inventory before review. See
  [`docs/ASSISTED_ADD_ITEMS.md`](docs/ASSISTED_ADD_ITEMS.md).
- The item form leads with name, quantity and place. Optional identity,
  description, category, tags, purchase, current value and warranty stay in
  collapsed summaries; editing a visible field never clears hidden recorded
  values or shared-purchase relationships. Contextual Add items preserves the
  source place and a useful return origin. Rooms/sub-rooms can be created without
  losing the draft. **Duplicate item** copies identity and organisation with
  quantity 1, not unit-specific financial or photographic evidence. **Mark as no
  longer owned** preserves the record with an outcome/date/note and restore;
  deletion remains separate. See
  [`docs/ITEM_FORM_AND_FILES.md`](docs/ITEM_FORM_AND_FILES.md).
- One prominent global search box in the desktop top bar and near the top of
  every mobile inventory page, with grouped local suggestions while typing and
  the same submit-time result flow everywhere. On Items, this same input updates
  the list's `q` filter, so there is no duplicate Items search or Advanced search
  mode. There is no competing sidebar search box or separate keyword/Ask mode on
  the results page.
- Multi-object **AI Scan Items** from one photograph: editable suggestions,
  quantities, duplicate review, room-only or room-plus-container destinations,
  per-suggestion overrides and approved bulk creation. Fixed fixtures are flagged
  for review and are not preselected. Nothing is written automatically.
- **Lending with partial returns and safe undo**: lend quantity-bearing items to a
  borrower display name without moving them out of their room/container. Owned,
  at-home and on-loan quantities stay distinct; several open loans and partial
  returns are supported. An owned storage item explicitly offers parent-only or
  contents-included lending; included contents become separate child loans with
  the same borrower and dates, while parent-only lending never implies children
  left home. New loan can be started from the Loans page with an
  inventory search and current available stock; every outstanding row has direct
  Record return, separate View details and item navigation. The item title area
  prominently states the borrower and quantity truth, labels the stored
  room/container as the usual home while units are out, and offers Record return
  directly (choosing the relevant loan when several are open). Borrower inputs
  suggest existing household names from prior loan records, while any directly
  typed name is saved only with that loan; there is no person directory or Add
  person step. The Loans page has a person filter that composes with direction,
  Outstanding/Returned/All and past-due filters and remains in the URL. No borrower
  accounts, contact fields, automatic reminders or emails. See
  [`docs/LENDING_HISTORY_UNDO.md`](docs/LENDING_HISTORY_UNDO.md),
  [`docs/ITEM_LOAN_STATUS.md`](docs/ITEM_LOAN_STATUS.md),
  [`docs/SIMPLE_LOAN_NAMES.md`](docs/SIMPLE_LOAN_NAMES.md) and
  [`docs/LOANS_USABILITY.md`](docs/LOANS_USABILITY.md).
- **Borrowed from others, kept separate from owned stock**: record possessions
  temporarily held from an external owner with item/brand/model, quantity, owner
  display name, borrowed/due dates, keeping property/room/container, optional
  private notes and one private actual photo. One mixed Loans list uses protected
  **Lent out** / **Borrowed** direction badges and All / Lent out / Borrowed
  filters, with distinct Record return and Return to owner actions. Owner display
  names use the same household-scoped suggestions; the simple person filter shows
  what a person currently has from you and what you have borrowed from them,
  including returned history. Status, direction, past-due and text filters stay
  in the URL, and both detail back links and browser Back restore the composed
  view. Partial
  returns, corrections, cancellation, request-id/payload binding, concurrency
  guards and append-only history are supported. Borrowed quantities never enter
  owned counts, values, evidence, search-as-owned results or stocktake. Search and
  the deterministic assistant label them with owner/place/due-date wording, and
  answer “What do I need to return?” and “Who owns X?” without AI. No owner
  accounts, emails or reminders. See [`docs/BORROWED_ITEMS.md`](docs/BORROWED_ITEMS.md).
- **Household movement and lending history**: item/container moves, inherited
  container moves, loans, returns, corrections and cancellation are recorded with
  actor and preserved name snapshots. Supported moves and lending actions offer a
  state-checked compensating undo; legacy items are not given fabricated history.
  If an item's original storage place was recoverably deleted, item history can
  preview and atomically restore that container identity and return one eligible
  item without recreating other contents or missing hierarchy. See
  [`docs/LENDING_HISTORY_UNDO.md`](docs/LENDING_HISTORY_UNDO.md).
- **Bulk organisation and compact list view**: select only the loaded item records
  and move, add/remove tags or explicitly set/clear a category in bounded atomic
  batches. The previews show destination, selected records/units and active-loan
  impact; changing search, filters, sort or archived state clears selection with
  feedback. A remembered compact list view shows quantity, room/container path and
  on-loan/at-home status. Batch moves record per-item and batch history; individual
  moves can be undone, while tag/category batches cannot. See
  [`docs/BULK_ORGANISATION.md`](docs/BULK_ORGANISATION.md).
- **Document scanning and cleanup**: capture or choose up to 20 image pages,
  review original/cleaned previews, crop/straighten with four-corner perspective,
  rotate, adjust contrast/grayscale/document mode, reorder and save one readable
  multi-page PDF. Exact source pages stay private; the cleaned PDF is the default
  download and OCR input, while original pages remain downloadable. PDFs from
  scanner apps still upload unchanged. See
  [`docs/DOCUMENT_SCANNING.md`](docs/DOCUMENT_SCANNING.md).
- **Intelligent document extraction and matching**: review OCR-derived merchant
  and date fields, product lines with quantities/unit prices/line totals, separate
  tax/discount/shipping evidence and uncertain values. Likely existing items are
  ranked by household-scoped serial/model/name/brand evidence, with manual search,
  create/link/update/skip choices, optional consented AI field/line refinement and
  match re-ranking, and an itemised change preview. Reviewed product-line amounts
  persist as per-item purchase allocations under the shared purchase total; linking
  a receipt does not increase stock unless explicitly requested, and manuals are not
  treated as proof of purchase. See
  [`docs/INTELLIGENT_EXTRACTION.md`](docs/INTELLIGENT_EXTRACTION.md).
- **Unified search and grounded assistant**: one prominent global input labelled
  “Search or ask about your inventory…”, shared by the desktop top bar, mobile
  pages, results page and secondary Assistant. Typing shows cheap direct
  item/container/place matches; Enter submits one flow that resolves direct
  inventory first and automatically uses the configured consented assistant only
  when interpretation or fallback matching is needed. Persian/Arabic question
  marks, letter variants and ZWNJ are normalised without stripping scripts;
  plain multilingual questions need no punctuation. Answers are in the user's
  language, preserve original names/models/IDs and are grounded only in current
  authorised records. Short follow-ups retain bounded resolved items, candidates
  and loan references, and all-my-places answers use each household's own
  provider. Wider scopes send only validated per-household context and bounded
  per-partition dialogue memory, never raw mixed-household conversation prose.
  Answers render through a safe prose subset whose direction follows the
  question, with original Latin names/models/paths isolated for mixed RTL text.
  Direct lookup, AI-assisted answers and AI-unavailable fallbacks are visibly
  distinct. See
  [`docs/UNIFIED_SEARCH.md`](docs/UNIFIED_SEARCH.md).
- **Voice-note inventory entry** through **Add items**: record with explicit
  microphone permission or upload WebM/Ogg/WAV/MP3/M4A audio, edit the transcript,
  then review structured item groups. Repeated mentions such as “ethernet cable,
  ethernet cable, another ethernet cable” become one suggestion with quantity 3.
  Explicit counts, corrections, recap summaries, variants, rooms/containers,
  duplicate decisions and grouped-suggestion splitting are supported. Audio is
  deleted after transcription; nothing is written before explicit confirmation.
  See [`docs/VOICE_NOTES.md`](docs/VOICE_NOTES.md).
- Search examples, Enter submission and debounced typing keep one URL/query source
  of truth, preserve scope parameters and avoid stale async results. The offline
  core path is documented in [`docs/OFFLINE_ACCEPTANCE.md`](docs/OFFLINE_ACCEPTANCE.md).
- A conservative hierarchy importer that understands rooms, boxes, nested
  containers, legacy identifiers such as `STO-01` and their contents. Index
  pages and empty templates are skipped, and the tree is reviewed before apply.
- Provider management for OpenAI, Anthropic Claude, Google Gemini, xAI Grok,
  OpenRouter and Ollama (loopback, LAN, Tailscale or external endpoints) through
  **Settings → AI providers**. API keys are encrypted at rest with a key held
  outside PostgreSQL.
- One saved default text model for Assistant, document interpretation, smart
  imports and natural-language search, with preserved advanced overrides. Text
  tasks explicitly inherit the saved default or keep their own provider/model;
  saving an override survives default changes even when it equals the default.
  Changing the default updates only inherited text tasks. Core navigation keeps
  Items/Rooms/Loans prominent and moves occasional Review/Purchases/Warranties/
  Assistant routes into calm sections/More. Unconfigured scheduled review stays
  behind Advanced and off by default. Vision and
  voice remain separate capability-specific choices, with capability warnings and
  explicit remote-processing consent. Local, private-network and remote endpoints are labelled separately.
  See [`docs/SIMPLIFICATION3.md`](docs/SIMPLIFICATION3.md).
  Voice transcription is opt-in and supports OpenAI/Gemini audio plus OpenRouter
  STT or audio-input models. Item illustrations and label/container AI headlines
  were retired. Each active task has a specific minimum capability (text, image
  input or audio input/STT), not a blanket tools/structured requirement. Confirmed-incompatible
  models are hidden; unknown metadata and exact IDs are offered with an unverified
  warning and an explicit, bounded live test. No discovery or status request runs a
  paid inference. See [`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md).
- Optional direct HTTPS with nginx, or Tailscale Serve as an optional private
  access layer. PWA and camera features work in secure contexts.
- Document-to-item relationship suggestions that require explicit linking.
- Optional local, private-network or consented remote AI inference. AI is disabled by default
  and ordinary Housetory functionality does not depend on it.
- PostgreSQL-backed background worker for maintenance, OCR, import and AI jobs.
- Docker Compose deployment with health checks, migrations, backups, optional
  nginx TLS and optional Tailscale guidance.
- Automated backend and frontend tests.

### Verification

The foundation in this repository has been exercised against the real Compose
stack, not just unit mocks:

- 483 pytest tests pass against PostgreSQL, including the full Alembic chain,
  authentication/abuse controls, hierarchy semantics, concurrent identifier
  allocation, container conversion, cross-room movement, rollback, cycles,
  summaries, PDF geometry, label calibration, archive security,
  import/duplicate/location review, encrypted provider credentials and rotation,
  provider adapters, task capabilities, consent enforcement, entity photos,
  multi-object recognition/apply/idempotency, voice-note grouping/corrections/
  duplicate resolution/split/idempotent confirmation, OpenAI/Gemini/OpenRouter
  transcription adapters, task-specific capability contracts, unverified exact-ID
  paths, bounded task tests and the confirmed bulk AI-task test workflow,
  household online-search credential
  lifecycle/fallback/domain validation and worker resolution, worker
  heartbeat/status scoping, borrowed-record quantities/partial returns/corrections/
  cancellation/idempotency/concurrency/history, private borrowed photos, role and
  cross-household IDOR checks, search/assistant borrowed totals and owned-vs-borrowed
  exclusion from reports/stocktake, audio validation and cleanup, lending quantities/concurrency/returns/
  retries, item and container history snapshots, safe undo and quantity/archive/
  delete guards, atomic bulk move/tag/category batches, batch replay/idempotency,
  per-item bulk-move undo, private document scan crop/perspective/rotation/
  contrast, HEIC original preservation, ordered multi-page PDF assembly, scan
  cleanup and cleaned-artifact OCR selection, deterministic multi-line receipt/
  invoice extraction, household candidate matching, mocked AI field/line refinement
  and ranking with evidence/consent validation, duplicate-content warnings,
  persistent per-item purchase allocations with shared-total/no-double-count
  reporting, reviewed atomic/idempotent extraction apply and new-stock/loan
  preservation, the unchanged actual Inventory.md upload/paste path, semantic
  AI-edit validation
  (ages, dimensions, model tokens, similar names and truncated identifiers),
  unified keyword/question search, exact loan whereabouts and quantities,
  purchase-information status/filter parity, ambiguous-item handling,
  view-scoped assistant access, title-level loan state and usual-home semantics,
  natural loan-wording factual parity, Loans-page new-loan stock checks and
  direct-return validation, manual upload/reuse, exact make/model and variant
  gates on search/download/online questions, grounded page citations and
  extractive/AI fallback, the documented Brave Search API request/auth/response
  adapter with realistic fixtures, conservative manufacturer provenance,
  direct-PDF versus source-page discovery, 401/403/429/timeout/invalid-output
  handling, idempotent duplicate-aware downloads with provenance,
  SSRF/redirect/size/type/timeout download guards, evidence scope/overlap and
  archived handling, shared/legacy/multicurrency purchase semantics, per-unit
  current-value extension by owned quantity, legacy record-total migration/
  conversion audit, missing/zero/overflow values, actual PDF/CSV/ZIP/manifest
  value columns, CSV formula
  escaping, ZIP source bytes/manifests/missing files, snapshot reconfirmation,
  idempotency, expiry/cancel/retry and authenticated package downloads,
  endpoint classification/redirect safety, hierarchy/overlap stocktake snapshots,
  present/missing/partial/on-loan behavior, reviewed moves and quantity
  corrections, stale item/loan/review conflicts, idempotent observation/apply/
  complete requests, partial coverage, last-checked staleness, viewer isolation,
  exact evidence last-checked fields, hierarchical imports and exhaustive
  cross-household access checks, property backfill/IDs, property CRUD guards,
  room/container/bulk moves across properties, property filters, import/voice
  property scoping, QR/loan preservation and last-checked staleness, household
  creation/listing/switching, same-account role differences, stale mutation
  context, revoked-membership fallback, all-places search counts/paths/loans,
  cross-household ambiguity/property isolation and per-household AI provider
  selection, item-image category-icon fallback/legacy-row retirement/reference
  ranking/actual-photo priority, query-only attribute inference, size/technology/variant conflicts, exact-model
  token boundaries, manufacturer/deceptive-host provenance, public-web
  provenance/unknown-permission honesty, optional source restriction, bounded
  candidate format/HTTP fallback, AVIF re-encoding, decoded resolution and
  original-vs-thumbnail quality fallback, clean-photo vs spec/dimension
  infographic ranking, PS5 empty-box packaging alias, bounded reference/AI
  gallery frames and license evidence, evidence exclusion, retired illustration
  endpoints/jobs without provider calls, existing AI-media display/removal,
  live container contents/category summaries after move and quantity changes,
  label identity/name/QR output without contents or AI headlines, reference
  batch cancellation and preserved photos/vision/transcription, owned-item
  storage enable/move/undo/removal guards, existing-container ownership
  create/link/unlink, one-time value/purchase evidence across host and contents,
  explicit parent-only versus contents-included loans with independent returns,
  collapsed item-form summaries preserving shared purchase, warranty, current
  value and document links, contextual Add origin, combined document/manual
  de-duplication and image-source technical disclosure, one global search box,
  Unicode/Persian/Arabic matching, direct/AI/fallback modes, bounded multilingual
  follow-ups, provider-safe per-partition dialogue memory, mixed-direction
  rendering, per-household all-places AI provider boundaries, default text-model
  inheritance/override preservation, household-scoped borrower/lender name
  suggestions and normalized person filters, on-demand resale/replacement item
  valuation preview/apply and evidence metadata, calmer desktop/mobile navigation
  and optional scheduled-review disclosure.
- 244 Vitest tests pass; strict TypeScript typecheck and production build pass.
- 99 checked-in Playwright workflows run on disposable Compose stacks, covering
  the Phase 5 container/label/QR flows, provider configuration against a mocked
  local Ollama service, camera upload, multi-object review/split/merge and
  approved creation, voice-note review/split/confirm with grouped quantities,
  lending/partial return/outstanding list/timeline undo, item/container move
  history, owned-item contents storage and explicit contents-included loan
  choices, existing-container ownership details, collapsed item-form essentials
  and optional summaries, combined documents/manuals and contextual Add origins,
  recoverable deleted-container restore and blocker states, loaded-only bulk selection with move/tag/category dialogs and
  compact-list persistence, desktop/mobile multi-page scan editing, reorder,
  save, page-original access and cancel, OCR-to-line-item review with exact
  household matching, optional AI-refined fields/lines, reviewed apply and persisted
  purchase allocations, the actual Inventory.md hierarchy,
  duplicate prevention, PWA/service-worker/deep-link routing, one global search
  box, the exact loaned Heavy drill question, mobile keyword search with no
  inference, missing-purchase filter parity, bounded search follow-up context,
  Persian AI-assisted and no-provider fallback UI, item title / usual-home loan
  state, authorized return, viewer restrictions, compact and
  populated photo galleries, the unified Add items chooser with contextual
  destinations, manual upload/attach/answer citations and a fixture Brave
  provider exercised through the real adapter for gated search/review/save at
  mobile width, item selection, evidence preview, PDF/CSV/ZIP generation and
  downloads, cancellation/error states and mobile package preview, mobile
  focus-font/overflow/navigation/More-menu/software-keyboard-viewport checks and
  schedule/add/lend/return dialog fit, and the
  stocktake start → mark → refresh/resume → review/apply → complete flow with
  partial completion, keyboard close, failed-save recovery, abandonment,
  light/dark desktop/mobile screenshots, and two-household creation, switching,
  property-filter reset, all-places search and loan answers, remembered scope and
  a cross-household result link opening in its own household, item-image
  category-icon/reference/AI/actual-photo workflows with batch cancellation, and
  a disposable OpenRouter fixture covering capability-filtered voice/image task
  configuration, mocked STT transcription, image preview/accept and provider
  error handling, release search query/example/submit regression, system status
  build identity/jobs/task states, compact unavailable-feature states, and the
  borrowed-from-others create → mixed filters → partial return → refresh → private
  photo → remaining return → viewer read-only workflow. The isolated offline stack
  additionally passed 34 core workflows plus a zero-external-browser-request audit
  with API/worker outbound TCP and HTTPS blocked; see
  [`docs/OFFLINE_ACCEPTANCE.md`](docs/OFFLINE_ACCEPTANCE.md).
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
  label previews, voice-note review and mobile layouts with no console errors or
  failed requests.
- Backup permissions, checksum verification, archive extraction safety, target
  checks and a full destructive restore were rehearsed locally, including
  authenticating and retrieving photos/documents after restore.
- Production dependency audits report no known Python or npm vulnerabilities.
  Final application images scan with zero fixable HIGH/CRITICAL vulnerabilities.

The voice-note provider/format/retention configuration and walkthrough are in
[`docs/VOICE_NOTES.md`](docs/VOICE_NOTES.md), lending quantities, history and
undo rules are in [`docs/LENDING_HISTORY_UNDO.md`](docs/LENDING_HISTORY_UNDO.md),
bulk selection boundaries, batch semantics and compact-list behavior are in
[`docs/BULK_ORGANISATION.md`](docs/BULK_ORGANISATION.md), and document scan
limits, original/derivative storage, cleanup and OCR artifact behavior are in
[`docs/DOCUMENT_SCANNING.md`](docs/DOCUMENT_SCANNING.md), and item-image
sources, provenance, consent and batch limits are in
[`docs/ITEM_IMAGES.md`](docs/ITEM_IMAGES.md), on-demand resale/replacement
valuation, manual fallback and evidence metadata are in
[`docs/ITEM_VALUATION.md`](docs/ITEM_VALUATION.md), and reviewed line-item
extraction, matching, AI fallback and apply semantics are in
[`docs/INTELLIGENT_EXTRACTION.md`](docs/INTELLIGENT_EXTRACTION.md), and manual
attachment, grounded citations, identity gates, reviewed online search/download,
configuration and safety limits are in
[`docs/ITEM_MANUALS.md`](docs/ITEM_MANUALS.md), and the inventory evidence PDF,
CSV, ZIP, manifest, totals/privacy semantics, limits and walkthrough are in
[`docs/INVENTORY_EVIDENCE.md`](docs/INVENTORY_EVIDENCE.md). The Phase 2 desktop/iPhone
walkthrough, screenshots and remaining limitations are in
[`docs/PHASE_2_WALKTHROUGH.md`](docs/PHASE_2_WALKTHROUGH.md). The Phase 3
documents, OCR, purchase, warranty and ownership walkthrough is in
[`docs/PHASE_3_WALKTHROUGH.md`](docs/PHASE_3_WALKTHROUGH.md). The Phase 4 AI,
import and Obsidian walkthrough is in
[`docs/PHASE_4_WALKTHROUGH.md`](docs/PHASE_4_WALKTHROUGH.md), the Phase 5
container, QR and label walkthrough is in
[`docs/PHASE_5_WALKTHROUGH.md`](docs/PHASE_5_WALKTHROUGH.md), and the Phase 6
provider, camera, AI scan, hierarchy and HTTPS walkthrough is in
[`docs/PHASE_6_WALKTHROUGH.md`](docs/PHASE_6_WALKTHROUGH.md).

The pre-deployment security review, findings and remaining risks are in
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). Passing tests do not constitute a
guarantee of production security.

The product is intentionally not finished. Custom fields, category/tag
management UI, multi-user sharing, password changes and exchange-rate conversion
are not implemented yet. The Tauri macOS shell is deferred to Phase 7. A
checked-in Playwright suite covers the critical Phase 5 and Phase 6 workflows.
AI extraction is review-only and heuristics remain approximate; no model is
bundled or downloaded automatically. Voice transcription requires an operator-
configured OpenAI-compatible or Gemini provider; paid-provider and physical-
microphone smoke tests still require the operator's credentials and hardware.
Borrower reminders and borrower accounts are intentionally not implemented.
Image-page scanning accepts up to 20 pages; existing PDFs are attached unchanged
and are not recombined in the scan editor. Per-item product allocations persist
under one shared purchase total; tax, discount and shipping amounts remain separate
and unallocated by design, and there is no barcode field. Legacy purchases without
allocation rows do not receive fabricated historical splits. Purchase information
can be explicitly Unknown or Not applicable; missing-information counts exclude
items marked Not applicable and use the same rule across overview, search,
assistant and filters. Search and assistant use validated read-only tools rather
than generated SQL. Live paid-provider extraction, search and assistant quality
was not tested. See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), which separates shipped work
from remaining work and states the OCR, AI and multi-currency limitations
honestly.

## Quick start with Docker Compose

Requirements: Docker Engine 24+ with Compose v2. Remote access can use a trusted
LAN address, optional Tailscale Serve, or direct HTTPS with a domain certificate.
The worker image installs Tesseract, its English language data and Poppler at
build time; no host OCR packages or GPU are needed.

```bash
git clone <your-repository-url> housetory
cd housetory

cp .env.example .env
# Generate two URL-safe passwords:
#   1. POSTGRES_PASSWORD        — admin role for migrations/backups/restore only
#   2. HOUSETORY_APP_PASSWORD   — least-privilege role used by API and worker
openssl rand -hex 24
openssl rand -hex 24
# Generate the credential-encryption key once and keep it with your secrets:
python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
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

## Remote access and HTTPS

Choose one exposure model. Housetory never publishes PostgreSQL, the API or the
worker; only nginx has a host port. Do not add router port forwards unless you
intend to expose the app.

### 1. Local network only

The default `WEB_BIND=127.0.0.1` is reachable only from the server itself. To
reach it from another device on a trusted LAN, set:

```dotenv
WEB_BIND=0.0.0.0
APP_BASE_URL=http://192.168.1.20:8080
EXTRA_ORIGINS=http://192.168.1.20:8080
```

LAN HTTP is not a secure context on iPhones, so camera capture and PWA service
workers require HTTPS (localhost is the exception).

### 2. Private Tailscale access (optional)

Tailscale Serve terminates HTTPS with a trusted certificate inside your tailnet.
It is not required, and Housetory does not depend on it.

```bash
tailscale up
tailscale status
# Set APP_BASE_URL=https://your-machine.your-tailnet.ts.net and COOKIE_SECURE=true
docker compose up -d
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Open the HTTPS address in Safari on the iPhone and choose Share → **Add to Home
Screen**. Do not use `tailscale funnel` unless you intentionally want a public
deployment. See [`docs/TAILSCALE.md`](docs/TAILSCALE.md).

### 3. Public HTTPS with nginx and a trusted certificate

Keep nginx as the only public web server. Point a DNS name at the host, obtain a
certificate (for example with Let's Encrypt), and run:

```dotenv
APP_BASE_URL=https://inventory.example.com
QR_BASE_URL=https://inventory.example.com
COOKIE_SECURE=true
WEB_BIND=0.0.0.0
WEB_PORT=80
WEB_TLS_PORT=443
TLS_CERT_PATH=/etc/letsencrypt/live/inventory.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/inventory.example.com/privkey.pem
```

```bash
docker compose -f compose.yaml -f compose.tls.yaml up -d --build
```

Port 80 redirects to HTTPS, except for the `/healthz` probe. The redirect
assumes the standard 443 port; when using a nonstandard `WEB_TLS_PORT`, open the
HTTPS URL directly and adjust or omit the redirect if needed. The certificate and
private key must be readable by the unprivileged nginx UID (101), for example
`root:101` mode `640`. Do not mount the whole Let's Encrypt directory. Verify:

```bash
curl -fsS https://inventory.example.com/api/v1/health/ready
curl -sSI https://inventory.example.com/ | grep -i strict-transport-security
```

For a local self-signed certificate rehearsal, add
`-subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost'` and use
`curl -k`. Browsers will reject an untrusted certificate because secure-context
features such as service workers and camera access require a trusted HTTPS
origin. **Complete first-run setup immediately** after exposing the app; before
the first owner exists, any client that can reach it can claim it.

### iPhone PWA installation

1. Open the trusted HTTPS address in Safari.
2. Select Share → **Add to Home Screen**.
3. Launch the installed Housetory icon.
4. Allow camera access when prompted by **Take Photo**.

The app shell is cached; inventory and API responses are deliberately never
cached by the service worker.

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
| `COOKIE_SECURE` | `false` | Must be `true` for any HTTPS origin |
| `WEB_BIND` | `127.0.0.1` | Host interface for nginx; use `0.0.0.0` only when intended |
| `WEB_PORT` | `8080` | HTTP host port (redirect port with TLS) |
| `WEB_TLS_PORT` | `443` | HTTPS host port when using `compose.tls.yaml` |
| `TLS_CERT_PATH` | empty | PEM certificate chain mounted read-only by `compose.tls.yaml` |
| `TLS_KEY_PATH` | empty | Matching PEM private key mounted read-only |
| `SESSION_TTL_DAYS` | `30` | Login lifetime |
| `SMTP_HOST` | empty | Provider-neutral SMTP host; empty disables outgoing mail |
| `SMTP_PORT` | `587` | SMTP port (587 STARTTLS, 465 implicit TLS) |
| `SMTP_TLS_MODE` | `starttls` | `starttls`, `ssl` or local-only `none` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | empty | SMTP credentials, server-side only |
| `SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS` | `Housetory` / empty | From identity for invitations/reset mail |
| `SMTP_TIMEOUT_SECONDS` | `10` | SMTP connect/send timeout |
| `INVITATION_TTL_HOURS` | `168` | Invitation lifetime |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | Password reset lifetime |
| `MAX_UPLOAD_MB` | `25` | Per-file upload cap |
| `LOGIN_MAX_FAILURES` | `10` | Failed sign-ins per email/IP before throttling |
| `LOGIN_WINDOW_SECONDS` | `900` | Sliding throttle window |
| `EXTRA_ORIGINS` | empty | Comma-separated extra allowed origins (normally empty) |
| `OCR_LANGUAGE` | `eng` | Tesseract language code installed in the worker image |
| `OCR_MAX_PDF_PAGES` | `5` | Maximum scanned PDF pages rendered for OCR |
| `AI_CREDENTIAL_KEY` | empty | Fernet key encrypting API keys saved in the UI; keep outside PostgreSQL |
| `AI_CREDENTIAL_KEY_PREVIOUS` | empty | Old key used only during credential rotation |
| `AI_PROVIDER` | `disabled` | Optional environment bootstrap: `disabled`, `ollama`, or `openai_compatible` |
| `AI_MODEL` | empty | Bootstrap Ollama model name |
| `AI_BASE_URL` | `http://host.docker.internal:11434` | Bootstrap Ollama endpoint |
| `AI_TIMEOUT_SECONDS` | `90` | Inference request timeout |
| `AI_MAX_CONCURRENCY` | `1` | In-process inference concurrency limit |
| `AI_CLOUD_ENABLED` | `false` | Environment bootstrap cloud enablement |
| `AI_CLOUD_CONSENT` | `false` | Environment bootstrap consent; database providers use per-provider consent |
| `AI_CLOUD_BASE_URL` | empty | Bootstrap OpenAI-compatible base URL, including `/v1` |
| `AI_CLOUD_MODEL` | empty | Bootstrap cloud model name |
| `AI_CLOUD_API_KEY` | empty | Bootstrap cloud bearer token; prefer Settings → AI providers |
| `AI_MAX_CONTEXT_CHARS` | `12000` | Per-chunk import context cap |
| `AI_IMPORT_MAX_CHUNKS` | `8` | Maximum AI chunks per import |
| `MANUAL_SEARCH_PROVIDER` | `auto` | Operator fallback when no household online-search row exists: `auto`, `brave`, `gateway` or `none` |
| `BRAVE_SEARCH_API_KEY` | empty | Operator-only installation fallback; configure the Brave key in Settings → Online search instead |
| `BRAVE_SEARCH_BASE_URL` | `https://api.search.brave.com` | Official Brave endpoint or compatible operator test/proxy base |
| `BRAVE_SEARCH_COUNTRY` | empty | Optional Brave country code |
| `BRAVE_SEARCH_LANG` | empty | Optional Brave search language |
| `ITEM_IMAGE_SEARCH_PROVIDER` | `auto` | Operator fallback when no household online-search row exists: `auto`, `brave` or `none` |
| `ITEM_IMAGE_PERMITTED_SOURCE_DOMAINS` | empty | Optional operator-only legacy source restriction when no household row exists. Empty means public-web lookup, not disabled |
| `ITEM_IMAGE_PERMITTED_LICENSES` | `cc0,cc-by,cc-by-sa,public-domain` | Provider license identifiers accepted as explicit download evidence |
| `ITEM_IMAGE_MANUFACTURER_DOMAINS` | empty | Optional `brand=domain|domain` manufacturer provenance additions/overrides |
| `ITEM_IMAGE_KNOWN_BRANDS` | empty | Optional extra brand names for query-only matching |
| `EVIDENCE_EXPORT_MAX_ITEMS` | `300` | Maximum items in one evidence package |
| `EVIDENCE_EXPORT_MAX_DOCUMENTS` | `300` | Maximum candidate evidence documents |
| `EVIDENCE_EXPORT_MAX_PHOTOS` | `500` | Maximum selected photos |
| `EVIDENCE_EXPORT_MAX_BUNDLE_MB` | `100` | Maximum uncompressed evidence ZIP bytes |
| `EVIDENCE_EXPORT_MAX_PDF_PHOTOS` | `60` | Maximum photos embedded in the PDF |
| `EVIDENCE_EXPORT_RETENTION_HOURS` | `168` | Private package artifact lifetime |
| `EVIDENCE_EXPORT_TIMEOUT_SECONDS` | `180` | Maximum background generation time |
| `EXPORTS_DIR` | `/data/exports` in Compose | Separate writable private artifact volume |
| `STOCKTAKE_MAX_ITEMS` | `500` | Maximum expected items in one stocktake |
| `STOCKTAKE_MAX_APPLY_BATCH` | `200` | Maximum reviewed corrections in one atomic apply |
| `STOCKTAKE_MAX_ACTIVE_SESSIONS` | `25` | Maximum unfinished stocktakes per household |
| `STOCKTAKE_MAX_NOTES_CHARS` | `2000` | Maximum observation note length |
| `STOCKTAKE_MAX_OBSERVATIONS_PER_SESSION` | `2000` | Maximum observations in one session |
| `MANUAL_SEARCH_URL` | empty | Advanced JSON gateway URL when explicitly selected |
| `MANUAL_SEARCH_API_KEY` | empty | Optional bearer token for the advanced gateway |
| `MANUAL_SEARCH_PROVIDER_LABEL` | `Configured manual search` | Gateway label shown in the manual UI |
| `MANUAL_SEARCH_TIMEOUT_SECONDS` | `20` | Online search/landing/download timeout |

Manual answers use the existing **assistant** AI task when configured and
consented; they remain extractive without it. Online discovery uses the official
**Brave Search API** adapter with an owner-managed encrypted key, or an advanced
operator gateway, and never pretends a chat model has live browsing. Configure
one Brave key plus separate manual and reference-image enable controls in
**Settings → Online search**; changes apply on the next API or worker request
without a restart. The environment variables below are an installation fallback
only when a household has no saved online-search row. An explicit disable or key
removal in Settings remains authoritative and does not reactivate the fallback.
The Brave setup, real API contract, source/PDF evidence rules, candidate review,
download safety and page-citation limits are documented in
[`docs/ITEM_MANUALS.md`](docs/ITEM_MANUALS.md).
| `IMPORT_MAX_FILES` | `2000` | Maximum files accepted from one vault ZIP |
| `IMPORT_MAX_TOTAL_MB` | `50` | Maximum decompressed vault size |
| `IMPORT_MAX_FILE_MB` | `10` | Maximum single extracted vault file |

`AI_CREDENTIAL_KEY` is required before API keys can be saved in **Settings → AI
providers**. Generate one Fernet key and keep it with your password-manager or
secret backup; a database backup cannot decrypt saved credentials without it.
The key is never stored in PostgreSQL and is never returned to the browser.
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

### AI providers

Ordinary provider setup happens in the application, not `.env`. Sign in as the
household owner and open **Settings → AI providers**.

1. Add a provider: OpenAI, Anthropic Claude, Google Gemini, xAI Grok,
   OpenRouter or Ollama (local, private-network or external).
2. Enter the API key (cloud) or local endpoint (Ollama), then save the provider.
   Housetory discovers catalog metadata from the provider's official model-list
   endpoint. Choose the default from a searchable picker; **Refresh models** is
   available after endpoint or credential changes. Manual exact-ID entry remains
   available for private/custom models. General Settings shows only a compact
   provider/model/mode/consent summary and a catalog count; browse and select the
   full catalog on the AI providers page. The provider dialog stays within the
  viewport with long catalog IDs, URLs and consent text; its model list scrolls
  independently. Escape closes an open model list first and the dialog second.
3. Enable remote-processing consent separately for each cloud or non-local
   endpoint. Saving an API key does **not** authorize sending household data.
   Ollama on loopback/`host.docker.internal`/a Compose service name is local; LAN,
   Tailscale and external Ollama endpoints are private-network/remote and require
   consent. TLS certificate verification is never disabled and redirects are not
   followed.
4. Choose the saved **Default text model** for assistant, smart imports, document
   interpretation and natural-language search. Optional advanced overrides keep
   their own provider/model and survive default changes. Assign separate
   capability-specific choices for image recognition and voice transcription.
   Each task uses the searchable discovered catalog and switches
   catalogs when its provider changes. Known non-chat models are excluded, vision
   tasks require image input, and voice transcription requires STT/audio input.
   Retired illustration and label-headline tasks are not offered. Unknown
   capability metadata is marked
   for verification, and manual IDs are validated on save. Existing task
   assignments are preserved if discovery fails.
   General Settings verifies whether a saved task model appears in the provider
   catalog. A catalog listing is not an inference, billing or quality check, and
   Housetory does not send a test prompt to validate a model.
5. Replace a key, disable a provider or remove it without editing files.

The database stores only Fernet-encrypted credentials. All calls originate from
the API or worker; the browser never receives a saved key. Decryption failures
fail closed and are reported as provider errors. Rotation:

```dotenv
AI_CREDENTIAL_KEY_PREVIOUS=<old key>
AI_CREDENTIAL_KEY=<new key>
```

Restart the API and worker, use **Rotate credentials**, verify provider tests,
then remove the previous key. Provider models are selected explicitly rather than
assumed. There is no automatic model download and no GPU requirement.

Environment-based `AI_PROVIDER`/`AI_CLOUD_*` configuration remains available for
bootstrap or administrator-managed deployments, but a database provider takes
precedence. If no database provider exists, deterministic imports, search,
recognition fallback and assistant answers continue to work. Ollama setup:
`ollama serve`, `ollama pull <chosen model>`, then configure the endpoint in the
UI (`http://host.docker.internal:11434` from Compose).

Model discovery only requests provider catalog metadata. It does not send
inventory, documents, photos or prompts and does not require household-data
consent. Catalogs are cached briefly server-side per household/provider and
invalidated when credentials or endpoints change. Actual inference still requires
the established consent rules.

Official provider APIs use API keys, bearer tokens or local endpoints. Housetory
does not reuse consumer-account cookies, subscription tokens or unofficial OAuth.

## Accounts, household membership and email

Housetory now supports one shared household with independent accounts. The
household owner creates the first account during setup, then invites other
people. Accounts are not tied to a household; authorization comes from a
household membership with one of three roles:

- **Owner** — inventory plus household settings, member administration, AI and
  credential configuration.
- **Member** — ordinary inventory, photos, documents, imports, scans and
  reports; no member/security administration.
- **Viewer** — read-only browsing, search, assistant and exports. Mutations are
  rejected server-side and most mutation controls are hidden.

Viewers can read attached manuals, ask attached-manual questions and download
documents, but cannot upload/attach manuals, save product identities, search
online or download online candidates. The full matrix is in
[`docs/PERMISSIONS.md`](docs/PERMISSIONS.md). The UI
continues to show one shared household; there is no household creation or
switching flow yet. Cross-household isolation remains enforced on every
household-scoped route.

Owners invite people under **Settings → Members & invitations**. Invitations are
single-use, expiring links bound to the invited email and assigned role. New
accounts choose their own password; existing accounts must sign in with the
invited email first. Password recovery is account-level and returns the same
response whether or not an account exists. Both token types are hashed at rest,
and resetting a password revokes existing sessions.

Email is provider-neutral SMTP. Set `SMTP_HOST`, `SMTP_PORT`,
`SMTP_TLS_MODE`, credentials and `SMTP_FROM_ADDRESS` in `.env`; Resend is only one
example provider in `.env.example`, not an application default. The configured
`APP_BASE_URL` is used for absolute links. When email is unconfigured, login and
inventory continue to work, owners see an explicit invitation warning, and
password recovery keeps its non-enumerating response. Development/test mail is
captured locally instead of sent in development (`data/mail-capture/`) and kept
in memory in tests. Automated tests never deliver real email.

A Resend example, using the operator's separately supplied restricted key and
their own sending domain, is:

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_TLS_MODE=starttls
SMTP_USERNAME=resend
SMTP_PASSWORD=<restricted-key-supplied-separately>
SMTP_FROM_NAME=Housetory
SMTP_FROM_ADDRESS=noreply@mail.dorostkar.net
```

This is documentation, not a default. The sending domain was added in the Resend
dashboard at the time of writing, but DNS/domain verification was still pending
and has not been verified by Housetory. Do not claim delivery succeeds until the
provider shows the domain verified and a test message is delivered.

Account settings are under **Settings → Account settings**. Household settings
and member administration remain separate under Settings and **Members &
invitations**. Main Settings shows only a compact owner health summary; detailed
release identity, readiness, worker jobs and AI task diagnostics live on the
dedicated **Settings → System status** page. Optional services that are not
configured are reported separately and do not count as core outages.

## Camera, AI Scan Items and hierarchical imports

### Camera and photo management

Item, room and container screens expose **Take Photo** and **Choose Photo**.
Camera capture uses the rear camera hint where supported, presents a local
preview, and supports retake, cancel, upload progress, validation errors and
retry. The photo is uploaded directly; it does not need to be saved to the
iPhone photo library first. Existing secure image processing normalizes
orientation, strips metadata and converts HEIC/HEIF to a browser-safe format.
Room and storage-location photos reuse the same authenticated storage pipeline.
Their empty state is a compact card with one Take photo / Choose photo group; it
does not reserve a cover-sized blank canvas. Existing photos use a bounded cover
and a compact thumbnail/add row.

### AI Scan Items

Open **AI scan** from the navigation, an item list, a room or a container. The
default destination can be a room by itself or a room plus an optional
container/storage location; each suggestion can override both before approval.
After upload, an explicitly configured vision task returns separate editable
suggestions. Review name, quantity, category, brand/model, confidence, review
flags, possible duplicates and destination; then approve only the selected
suggestions. Apply is explicit, idempotent and reports partial failures. The
source photograph is retained as provenance and is not automatically used as
every item's cover.

The vision task is separate from the assistant/default model. If no vision task is
assigned, Housetory does not silently call the assistant model: it reports the
actionable configuration error and may fall back to OCR-readable text. AI or OCR
fallback, unavailable, empty and failed states are labelled explicitly. Fixed
architecture such as windows, walls, doors and installed radiators is flagged for
review and excluded from approval by default; ambiguous observations are marked
for review rather than promoted to confident possessions. The QR/manifest and
vision path are described further in the walkthrough.

### Hierarchical imports

**Add items → Import a list or file** opens the import workflow. It accepts TXT,
Markdown, CSV, XLSX, DOCX, PDF, images and Obsidian ZIP exports. There is no
separate Obsidian tab. When the source contains a recognizable room/container
structure, Housetory builds a review tree instead of flat items. Starting from a
room or container carries a review default; flat entries without their own
location inherit it, while source hierarchy and explicit destinations always win. Expand branches, edit names, quantities, entity types, parents and
legacy identifiers, review duplicates and source text, then approve individual
entries, branches or the whole tree. Rooms and containers are created before their
contents. Index pages, instructions and empty example containers are skipped;
a “Box list (template)” section that contains real populated records is still
imported. Parenthesized quantities, model numbers, dimensions and ages are
preserved, while nested notes remain context for their parent item. Legacy
identifiers such as `STO-01`, `APT-KIDS-01` and `CAR-TOOLS-01` are preserved as
aliases, while Phase 5 permanent identifiers remain authoritative. The checked-in
acceptance fixture is a byte-for-byte copy of the real `Inventory.md`; tests
verify both Upload file and Paste notes without AI.

## Data, backups and restore

Persistent named volumes:

- `housetory_pgdata` — PostgreSQL, including document/import metadata and OCR output
- `housetory_uploads` — item photographs, normalized document downloads and
  preserved original uploads under `households/*/documents/originals/`
- `housetory_imports` — private original import sources, extracted Obsidian notes
  and attachments

Create a verified backup (PostgreSQL custom dump + uploads/imports/exports tars + SHA-256 sums):

```bash
./scripts/backup.sh
```

Backups land in `./backups/housetory-<UTC timestamp>/` with directory mode `700`
and file mode `600`. The database and upload files contain private household
data and password hashes. **Backups are not encrypted by the script**; encrypt
them before copying off-server (for example with `age` or GPG) and keep them in
protected storage. Copy them off the server and schedule the script with cron or
a systemd timer.

Back up `AI_CREDENTIAL_KEY` separately from the database. Saved provider API keys
cannot be decrypted after a restore without the same key (or the previous key
during rotation). The backup script intentionally does not copy deployment
secrets into the backup directory.

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
E2E_EMAIL=phase6@example.com \
E2E_PASSWORD=phase-six-password-2026 \
npx playwright test
```

The Phase 6 provider test starts a local mock Ollama HTTP service in the
Playwright process and configures the disposable API to call it through
`host.docker.internal`. Override `E2E_AI_BASE_URL` if the API is not in Docker
(for example `http://127.0.0.1:<port>`).

The manuals Brave workflow starts a fixture Brave-compatible HTTP service on
port `4789`. Start the disposable API with
`BRAVE_SEARCH_PROVIDER=brave`,
`BRAVE_SEARCH_API_KEY=e2e-fixture-key` and
`BRAVE_SEARCH_BASE_URL=http://host.docker.internal:4789` so the real adapter
is exercised; otherwise that workflow skips with a clear message. Its download
step uses a browser fixture for the private PDF fetch because the disposable mock
service is intentionally not a public SSRF destination. The hierarchy test expects a fresh
disposable household because it applies fixed fixture identifiers; recreate the
disposable volumes between full runs. The global setup signs in, or performs
first-run setup when the stack is empty. Set `E2E_CHANNEL` if Chrome is not
installed under the default `chrome` channel.

To exercise direct HTTPS with a local self-signed certificate:

```bash
E2E_BASE_URL=https://localhost \
E2E_IGNORE_HTTPS=true \
E2E_EMAIL=phase6-tls@example.com \
E2E_PASSWORD=phase-six-tls-password-2026 \
npx playwright test
```

`E2E_IGNORE_HTTPS=true` also adds Chrome's certificate-error bypass so service
workers can register with the local test certificate. Use a trusted certificate
for real iPhone testing.

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
  explicit review/apply and related-item suggestions. Item manuals add
  `GET/POST /items/{id}/manuals`, confirmed `manual-profile`, attach-existing,
  grounded `manual-questions`, and reviewed `manual-search` candidate/download
  endpoints; optional online questions use the same confirmed identity gate.
- Evidence exports add `POST /evidence-exports/preview`,
  `POST /evidence-exports`, household-scoped status/cancel/retry/list routes and
  authenticated PDF/CSV/ZIP downloads. They use the existing durable worker and
  a separate private exports volume.
- Stocktake adds household-scoped session start/list/detail, observation,
  refresh, review/apply, complete/abandon and compact scope-summary routes. The
  checklist, review and finish UI lives at `/stocktake/{sessionId}` and is
  reachable from room/container detail without new primary navigation.
- Properties add household-scoped CRUD/list routes, property filters on rooms/
  items/containers, a top-level room subtree move preview/apply route and
  property management in Settings. Property IDs are never treated as a
  permission boundary; household membership still controls every request.
- Purchases, warranties, ownership reports and CSV exports have dedicated
  household-scoped endpoints.
- Imports expose upload, history, source/file downloads, retry and explicit
  approve/merge/skip/reject application.
- Search exposes the deterministic quick-search endpoint for items, containers
  and fixed locations, plus the existing dedicated search page and explicit
  natural-language flow.
- AI endpoints expose provider status, grounded assistant, smart search, photo
  recognition and read-only document relationship suggestions.
- Containers expose create/bulk/convert, live detail with live contents counts,
  identifier lookup, cross-room move, QR SVG, label templates, label PDF
  generation and calibration PDFs. Owned containers move with their owning item
  rather than independently. Saved-summary regeneration, AI headlines and
  stale-summary management are retired.

The endpoint inventory and data model are documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Project layout

```
apps/web/               React application
services/api/           FastAPI, SQLAlchemy, Alembic, pytest
services/worker/        PostgreSQL job worker
infrastructure/docker/  Dockerfiles and nginx HTTP/TLS configs
docs/                   walkthroughs, Tailscale and operations
scripts/                backup, restore, compose helpers
compose.yaml            Production topology
compose.tls.yaml        Optional direct-HTTPS nginx override
compose.dev.yaml        Loopback Postgres exposure for development only
```

## Security notes

- Container QR destinations are authenticated, household-scoped and opaque
  UUID-based. No public or anonymous QR sharing exists.
- Container identifiers are allocated by a database counter with atomic
  `INSERT … ON CONFLICT` updates; they are never reused or reassigned.
- Only nginx binds a host port. The default is loopback; `WEB_BIND=0.0.0.0` or
  `compose.tls.yaml` must be chosen explicitly. PostgreSQL, FastAPI and the worker
  remain on the internal Compose network.
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
  private imports volume for extracted vault files. AI is disabled by default.
  Database provider credentials are encrypted with `AI_CREDENTIAL_KEY`, never
  returned to the browser and never logged. Cloud calls require per-provider
  consent separate from API-key configuration; decryption failures fail closed.
  Official provider APIs are used; no consumer subscription tokens or unofficial
  OAuth are used. AI output is strict validated JSON and has no SQL/write tools.
- Direct TLS terminates in nginx with TLS 1.2/1.3, HSTS and the same security
  headers as HTTP. `APP_BASE_URL` must match the public HTTPS origin and
  `COOKIE_SECURE=true` is mandatory. Certificate private keys must be readable by
  the unprivileged nginx user and must not be committed or placed in the database.
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
