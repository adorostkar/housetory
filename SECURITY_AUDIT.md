# Housetory security audit

**Audit date:** 2026-11-04  
**Scope:** repository, API, web client, Docker Compose deployment, dependencies,
backup and restore procedure.  
**Environment:** local Compose stack, PostgreSQL 16, Chromium/Python tests.  
**Status:** all critical and high-severity findings identified in this review
were remediated and regression-tested. This is **not** a certification that the
system is production-secure; residual risks are listed below.

## Summary

| ID | Finding | Severity | Status |
| --- | --- | --- | --- |
| SEC-01 | Vulnerable Pillow/pillow-heif versions and unrestricted image decoder dispatch | **Critical** | Fixed |
| SEC-02 | Fixable HIGH/CRITICAL CVEs in worker, web and PostgreSQL base images | **High** | Fixed |
| SEC-03 | HTTPS deployments could run with non-Secure session cookies | **High** | Fixed |
| SEC-04 | Backup files were world-readable; restore accepted wrong databases and unsafe archives | **High** | Fixed |
| SEC-05 | PDF validation accepted header-only files and rendered documents inline in the app origin | **High** | Fixed |
| SEC-06 | nginx ran as root with a writable filesystem and full capabilities | Medium | Fixed |
| SEC-07 | Login had no brute-force/abuse throttling | Medium | Fixed (with residual limits) |
| SEC-08 | Authenticated photos/documents were browser-cacheable after logout | Medium | Fixed |
| SEC-09 | Document images retained metadata; upload file/directory permissions were permissive | Medium | Fixed |
| SEC-10 | Missing HSTS/COOP/CORP/CSP restrictions, cacheable API JSON, and configuration errors that could log secrets | Medium/Low | Fixed |
| SEC-11 | `.env.example` encouraged a known placeholder database password | Medium | Fixed |
| SEC-12 | Logout cookie deletion did not mirror the Secure attribute | Low | Fixed |
| SEC-13 | Authorization/IDOR review found no cross-household access | — | Verified with new tests |
| SEC-14 | API and worker connected as the PostgreSQL superuser | **High** | Fixed |

## Detailed findings and fixes

### SEC-01 — Critical: image processing dependency and decoder exposure

**Finding.** `pip-audit` reported multiple Pillow 12.3.0 advisories (including
heap corruption and memory-amplification issues) and `pillow-heif` 0.22.0
(PYSEC-2026-2258). The upload path called Pillow's general `Image.open()` without
an explicit format allowlist, meaning unsupported-but-registered codecs could be
dispatched before the application rejected the resulting format.

**Fix.**

- Upgraded to Pillow 13.0.0 and pillow-heif 1.8.1; added pypdf for proper PDF
  parsing.
- `Image.open(..., formats=[...])` is now restricted to JPEG, PNG, WebP and HEIF.
- Added regression tests for GIF/unsupported decoders, MIME/extension spoofing,
  HEIC conversion, malformed images, decompression limits and EXIF stripping.
- Final production `pip-audit` (including dev requirements) reports no known
  vulnerabilities.

**Evidence.** `services/api/tests/test_media.py`;
`services/api/housetory_api/services/storage.py`.

### SEC-02 — High: vulnerable base images and root nginx

**Finding.** Trivy initially found fixable HIGH/CRITICAL OS packages:

- worker image: 39 (7 critical, 32 high), inherited from the older uv/Debian runtime;
- web image: 5 (1 critical, 4 high), in Alpine 3.24.2;
- PostgreSQL image: 26 (1 critical, 25 high), in the bundled stale `gosu` binary;
- API runtime image: 0.

nginx also ran as UID 0 with a writable root filesystem and default capabilities.

**Fix.**

- Rebuilt API and worker on `python:3.12-alpine`, with dependencies installed in
  an Alpine builder; both final images now scan clean.
- Upgraded the unprivileged nginx base and applied `apk upgrade` at build time;
  web now runs as UID 101, read-only root filesystem, all capabilities dropped.
- Added a PostgreSQL build that compiles `gosu` 1.20 with a current Go toolchain.
- Added capability drops, `no-new-privileges`, read-only filesystems and tmpfs
  mounts across app containers.
- Added Trivy to the release checklist (see below).

**Evidence.** Final Trivy scan (`--severity HIGH,CRITICAL`, including unfixed
advisories): **0 findings on all four final images** — API, worker, web and
database. `docker inspect` confirms non-root/read-only/capability settings.

Caveat: image tags are mutable and vulnerabilities can be disclosed after this
audit. Rebuild and rescan regularly.

### SEC-03 — High: HTTPS cookie configuration

**Finding.** Compose defaults to local HTTP for development, but a production
deployment could set an HTTPS `APP_BASE_URL` while leaving `COOKIE_SECURE=false`,
allowing the session cookie to be transmitted without the Secure attribute.

**Fix.** Settings validation now fails closed:

- `APP_BASE_URL` must be an absolute HTTP(S) URL.
- An `https://` origin requires `COOKIE_SECURE=true`.
- Production rejects remote plain-HTTP origins and `DEBUG=true`.
- `COOKIE_SECURE` defaults remain local-only; `.env.example` documents the
  Tailscale case.

**Evidence.** `services/api/tests/test_security_auth.py`; API refuses to start
with HTTPS + insecure cookies (verified with a one-off container).

### SEC-04 — High: backup confidentiality and restore safety

**Finding.**

- Backup directories/files were created with the caller's umask and could be
  world-readable on a multi-user host.
- Restore did not verify that the backup belonged to the current database or
  Compose project, so an operator could overwrite the wrong deployment.
- Restore piped a tar archive into `tar -x`; a tampered backup could contain
  absolute paths, `..` traversal, symlinks, devices or duplicate entries.
- The first restore drill also exposed a bug where the restore helper tried to
  remove the volume mount point itself, leaving services stopped.

**Fix.**

- `umask 077`; backup root `0700`; files `0600`; manifests are checksummed.
- Manifest records database name and Compose project. Restore refuses mismatches
  unless `--allow-target-mismatch` is explicitly supplied.
- Added `scripts/restore_uploads.py`, a safe validator/extractor that rejects
  absolute paths, parent traversal, links, devices, FIFOs, duplicates and
  out-of-root targets, then extracts with Python's `data` filter.
- Upload archive is validated **before** services are stopped. It clears only
  the volume contents, not the mount point.
- Full restore was rehearsed: login worked, photos and PDF documents were
  retrieved, metadata remained stripped, and a sentinel database row created
  after the backup disappeared. A mismatched-database restore and a traversal
  archive were both refused with services still running.

**Evidence.** `services/api/tests/test_restore_uploads.py`, backup/restore drill
output, manifest/`SHA256SUMS` checks.

**Residual:** backups are **not encrypted** and database/upload snapshots are
not atomic. Encrypt before off-site storage and schedule backups.

### SEC-05 — High: PDF handling and inline documents

**Finding.** PDF validation only checked the `%PDF-` prefix, so malformed or
polyglot files could be accepted. PDFs and images were served `inline` from the
application origin, allowing a malicious PDF to be handled by the browser PDF
viewer in that origin.

**Fix.**

- PDFs are parsed with pypdf and must contain at least one page; malformed and
  encrypted PDFs are rejected.
- All document downloads are forced to `Content-Disposition: attachment`.
- Document images are decoded with the same allowlist, re-encoded to their real
  format and stripped of metadata.
- Response headers are `private, no-store`, `nosniff`, and CORP same-origin.

**Evidence.** `test_document_upload_download_and_delete`,
`test_malformed_pdf_is_rejected`,
`test_document_images_are_normalized_and_exif_stripped`.

**Residual:** no antivirus/malware scanner. A valid malicious PDF can still be
downloaded and opened in a user's PDF reader. Add a scanning hook before handling
documents from untrusted sources.

### SEC-06 — Medium: container privilege posture

**Finding.** nginx ran as root with a writable root filesystem and default
capabilities. API/worker/migrate lacked explicit capability drops.

**Fix.** Unprivileged nginx image; API, worker, web and migrate run as non-root
and drop `ALL` capabilities. API/worker/web/migrate use read-only root
filesystems, `no-new-privileges`, restricted tmpfs, and no host network or Docker
socket. PostgreSQL runs as the `postgres` OS user after initialization and has
`no-new-privileges`.

**Evidence.** `docker inspect`: web `uid=101`, API/worker UID `housetory`, all
`ReadonlyRootfs=true`, `CapDrop=["ALL"]` for app containers.

### SEC-07 — Medium: credential abuse protection

**Finding.** No rate limit or lockout existed for `/auth/login`.

**Fix.** Added an in-process sliding-window limiter keyed by a hash of email and
proxy address. Defaults: 10 failures per 15 minutes; returns `429 too_many_attempts`
with `Retry-After`. Successful login clears both keys. Memory is bounded to 5,000
keys.

**Limitations.** It resets on process restart, is not shared across API replicas,
and behind Tailscale Serve the proxy-address key is effectively global. This
means an attacker who can reach the tailnet could temporarily lock out sign-in
(availability DoS). Setup is not rate-limited. Tailscale ACLs remain the primary
boundary. A PostgreSQL-backed limiter is required before horizontal scaling.

**Evidence.** `test_login_is_rate_limited`; deployed stack returned ten `401`s
followed by `429` and `Retry-After: 900`.

### SEC-08 — Medium: authenticated media caching

**Finding.** Photo and document responses used long-lived immutable private
caching. After logout, a browser could potentially serve a previously cached
private response without revalidation.

**Fix.** Photos, thumbnails, documents and API JSON use `private, no-store` (or
API `no-store`). The service worker explicitly never caches `/api/`.

**Evidence.** Header assertions in `test_media.py` and `test_auth.py`; live
response inspections.

### SEC-09 — Medium: file permissions and metadata

**Finding.** Upload files were created with default modes (typically `0644`) and
directories under the volume could be `0755`; document images preserved EXIF and
trusted the declared type for their served MIME.

**Fix.** Upload root and directories are `0700`; files are `0600`; document
images are re-encoded and served with their actual validated MIME type. EXIF
stripping is tested for photos and document images. Filenames are sanitized for
display and never used as filesystem paths.

**Evidence.** `test_uploaded_files_are_private`, traversal filename tests, EXIF
tests, container permission inspection.

**Residual:** backups preserve private file modes, but the host/root and Docker
daemon can always read the data.

### SEC-10 — Medium/Low: headers, caching, CORS and error leakage

**Finding.** HSTS/COOP/CORP and some CSP directives were missing; API JSON had no
explicit cache policy; Pydantic configuration errors embedded the full settings
mapping (including `DATABASE_URL`) in startup tracebacks.

**Fix.** Added HSTS (no preload), COOP/CORP, CSP `form-action`, `frame-src`,
`worker-src`, `manifest-src`, and `no-store` for API responses. Configuration
startup errors are converted to a sanitized `RuntimeError` that contains only
validation messages, never the settings mapping. The unhandled-error handler
returns a generic 500 without internal details.

**Evidence.** Live header checks; `test_internal_errors_do_not_leak_details`;
`test_invalid_configuration_does_not_leak_environment`; nginx config.

### SEC-11 — Medium: example secret

**Finding.** `.env.example` contained a known database password placeholder that
could be deployed unchanged.

**Fix.** The example now leaves `POSTGRES_PASSWORD` empty and requires the
operator to generate one; Compose fails closed when it is unset. `.env` remains
ignored and mode `0600`.

### SEC-12 — Low: logout cookie attributes

**Finding.** Logout deleted the cookie without repeating the Secure attribute.

**Fix.** Secure/SameSite/HttpOnly details are mirrored with the runtime settings.

### SEC-14 — High: database superuser used by the application

**Finding.** Compose used the PostgreSQL image's `POSTGRES_USER` for both the API
and migrations. The official image creates that role as a superuser, so a SQL
injection or application compromise would have had cluster-level privileges,
including access outside the application database and potentially
`COPY ... FROM PROGRAM` filesystem execution.

**Fix.**

- Fresh volumes create a separate non-superuser `housetory_app` role with
  `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`.
- The app role receives only `CONNECT`, schema `USAGE`, and
  `SELECT/INSERT/UPDATE/DELETE` plus sequence usage. No DDL, TRUNCATE, role or
  database management.
- Default privileges are configured so tables created by future admin-run
  migrations automatically grant DML to the app role.
- API and worker use the app URL; the one-shot migration, backup and restore use
  the admin role.
- Existing volumes can be upgraded with `scripts/harden-db-role.sh` followed by
  an API/worker recreation.

**Evidence.** `docker compose exec api` reports
`current_user = housetory_app, usesuper = false`; creating a table as that role
is denied; API reads/writes and health checks still work. The admin role remains
only for migrations/backup/restore and should remain protected.

## Authorization verification

New tests in `services/api/tests/test_cross_household.py` exercise every
household-scoped endpoint with a second household's session:

- rooms, storage locations, categories, tags, items, overview and household
  endpoints;
- all direct object paths for rooms/locations/items/categories/tags;
- photos (list/upload/file/thumbnail/delete);
- documents (list/upload/file/delete);
- filter IDs (`room_id`, `location_id`, `category_id`, `tag_id`);
- attaching foreign IDs during create/update and nested-parent operations;
- unauthenticated access to sensitive routes and file downloads.

All foreign-object requests returned 401/404/422 without data; owner records
remained intact. Household rename requires owner role.

## Dependency and static analysis results

| Check | Result |
| --- | --- |
| `pip-audit` production requirements | No known vulnerabilities |
| `pip-audit` including dev requirements | No known vulnerabilities (pytest upgraded to 9.2.0) |
| `npm audit` (prod and all) | 0 vulnerabilities |
| Trivy HIGH/CRITICAL, final API/worker/web/db images | 0 findings each (Phase 5 rebuild) |
| Bandit Python static analysis | 0 High/Medium; 4 Low subprocess-path notes in the OCR wrapper |
| Secret scan | No credentials in tracked files; `.env` ignored |
| Compose port inspection | DB/API/worker unpublished; web loopback only |

Trivy scan date: 2026-11-04 (re-run after the Phase 5 container/label images).
Image vulnerabilities are time-sensitive.

## Verification performed

- 67 backend pytest tests at audit sign-off; Phase 2 raised this to 72, Phase 3
  to 104, Phase 4 to 128 and Phase 5 to 141, including new security regressions.
- 11 frontend Vitest tests at audit sign-off; now 25 after Phases 2–5; strict
  TypeScript check and production build pass. Four checked-in Playwright
  workflows run against a disposable stack.
- Headless Chromium walkthrough: setup, room/location, item create/edit,
  multipart photo upload, document upload, search, dark mode, settings and mobile
  layouts; zero console errors and zero failed responses.
- Live stack checks: all four long-running services healthy; API readiness
  verified through nginx; PWA manifest served as `application/manifest+json`.
- 31 MB upload rejected by nginx with 413; app-level 1 MB limit tested separately.
- Anonymous access to photo/document URLs returned 401; raw `/uploads`, `/data`,
  `/backups` paths returned 404.
- Backup/restore drill performed with authentication and file retrieval after
  restore.
- `docker inspect` confirmed users, read-only filesystems, capability drops,
  security options and port bindings.

## Remaining risks and recommendations

1. **First-run claim.** Before the first owner exists, anyone who can reach the
   setup endpoint can claim the instance. Restrict the Tailscale ACL and complete
   setup immediately. A deployment token would eliminate this window.
2. **In-process login limiter.** It resets on restart and is not multi-process.
   Move to a PostgreSQL-backed limiter before scaling API replicas. The shared
   proxy IP may cause temporary lockouts (availability risk).
3. **Unencrypted backups.** Files are `0600`/`0700` but not encrypted. Encrypt
   off-site copies and protect the host. Database/upload snapshots are not atomic.
4. **No malware scanning.** Valid PDFs/images may contain malicious content;
   documents download as attachments but users can open them externally. OCR
   also parses untrusted documents with Tesseract/Poppler in the worker, so
   parser vulnerabilities are a residual risk; rebuild and rescan the worker
   image regularly.
5. **Secrets in environment.** Docker host/root can inspect the database URL.
   Consider Docker/Compose secrets and a rootless or tightly controlled host.
6. **No internal DB TLS.** PostgreSQL traffic stays on the private Compose
   bridge; enable TLS or host isolation if that boundary changes.
7. **No MFA / password reset / idle timeout.** The 30-day session lifetime relies
   on the Tailscale boundary and device security. Add MFA and idle expiry for
   higher-risk deployments.
8. **Mutable base image tags.** Rebuild and rescan regularly; pin by digest and
   sign images for a stricter supply chain.
9. **Build-stage dependencies** (Node/uv builder images) are not in the final
   runtime and were not the focus of the image scans; build hosts remain part of
   the supply chain.
10. **No automated CI scan or browser E2E.** The checks above were run manually;
    add CI enforcement before relying on them continuously.
11. **Tailscale configuration is external.** This audit did not validate a live
    tailnet ACL, certificate issuance or device posture. Verify
    `tailscale serve status` and restrict the tailnet ACL.
12. **Docker host security** (daemon hardening, host patches, full-disk
    encryption) is outside the application repository.

## Reproduce the checks

```bash
# Backend tests
cd services/api
uv sync --extra dev
uv run pytest
uv run ruff check housetory_api tests
uvx bandit -q -r housetory_api

# Python dependency audit
uv export --no-dev --format requirements-txt --no-hashes > /tmp/housetory-req.txt
uvx pip-audit --requirement /tmp/housetory-req.txt

# Frontend
cd apps/web
npm audit
npm run typecheck && npm run test && npm run build

# Images
trivy image --scanners vuln --severity HIGH,CRITICAL housetory-api:local
trivy image --scanners vuln --severity HIGH,CRITICAL housetory-worker:latest
trivy image --scanners vuln --severity HIGH,CRITICAL housetory-web:latest
trivy image --scanners vuln --severity HIGH,CRITICAL housetory-db:local
```

## Phase 2 follow-up

Phase 2 added descendant-aware filters/counts, ancestor-aware search, a cover
photo endpoint and a full-screen photo viewer. Security implications were
reviewed and covered:

- Cross-household tests extended to the cover-photo endpoint and ancestor-aware
  search; foreign room/place/category names do not leak results.
- Uploaded-photo authorization and no-store headers are unchanged.
- No new runtime dependencies were added; `@testing-library/user-event` is
  development-only.
- Backend tests increased to 72 and frontend tests to 16; the Phase 2 walkthrough
  reported zero console errors and failed network requests.
- No new critical/high security findings were introduced.

## Phase 3 follow-up

Phase 3 added document metadata/original storage, OCR, shared purchases,
warranties, financial reporting and CSV exports. Security implications reviewed:

- All document, purchase, warranty, ownership and export access is household
  scoped. Tests extend cross-household checks to document detail/original/
  mutation/OCR/apply, purchases, warranties, financial overview and every CSV
  export.
- New uploads preserve exact original bytes in a private `0600` file under a
  `0700` directory. The original download is authenticated, `private, no-store`,
  `nosniff`, CORP same-origin and an attachment. The default download remains the
  normalized/sanitized copy. Legacy documents point both keys at their existing
  sanitized file.
- HEIC/HEIF document uploads are decoded through the same Pillow allowlist,
  normalized to JPEG for the default download, and the original is served with
  its actual source content type.
- OCR runs only in the worker, which mounts uploads read-only. Read-only storage
  resolution no longer attempts mkdir/chmod. The worker has a read-only root,
  tmpfs `/tmp`, no added capabilities, `no-new-privileges`, no network access to
  external OCR services, and only receives a document UUID in the job payload.
- Tesseract and Poppler process content-validated documents. Scanned PDF pages
  are bounded by `OCR_MAX_PDF_PAGES` and subprocess timeouts. OCR results are
  proposals; a separate authenticated confirmation endpoint is required before
  any item or purchase changes.
- Shared purchase and warranty-document references validate household ownership.
  Receipt/warranty document deletion uses `SET NULL` and does not delete the
  related item or purchase.
- No new Python or npm runtime dependencies were added for OCR; Tesseract,
  English language data and Poppler are Alpine OS packages in the worker image.
  The rebuilt API, worker, web and database images scan with zero HIGH/CRITICAL
  findings. `npm audit` and production `pip-audit` report no known
  vulnerabilities.
- A destructive backup/restore drill was repeated with Phase 3 data. It exposed
  and fixed a recovery defect: recreating the database removed the
  least-privilege app role's grants. Restore now reapplies the role grants before
  the API and worker start, with a regression test. Restored originals, OCR
  metadata, documents and shared purchases were verified through authenticated
  endpoints; the role remained non-superuser and could not create databases.
- Backend tests increased to 104 and frontend tests to 20. The Phase 3 walkthrough
  reported zero console errors and failed network requests and exercised real
  Tesseract OCR in Compose.

Residual Phase 3 risks:

- OCR engine/parser vulnerabilities and malicious document content remain a
  patching and image-refresh responsibility; no antivirus hook exists.
- Preserved originals may contain sensitive EXIF/location metadata. They are
  private and require authentication, but backups and downloads should be
  handled as sensitive household data.
- OCR heuristics can propose wrong amounts/dates/serials. The review gate
  prevents silent inventory changes but does not guarantee extraction accuracy.
- No exchange-rate conversion is configured; reports cannot combine currencies.

## Post-Phase 3 local-origin fix

Local registration exposed an origin-policy usability defect: opening the
instance at `http://127.0.0.1:8080` while `APP_BASE_URL` was
`http://localhost:8080` was rejected as a cross-site mutation. The origin check
now treats `localhost`, `127.0.0.1` and `[::1]` as equivalent **only when the
configured app URL is itself loopback**, and only with the same scheme and port.
Remote LAN/tailnet origins still require an explicit `EXTRA_ORIGINS` entry and
remain rejected otherwise. A regression test covers all three loopback spellings
and an unrelated LAN origin. Backend tests are now 104.

## Phase 4 follow-up

Phase 4 added AI-assisted import, Obsidian vault handling, grounded assistant
tools, smart search, photo recognition and document relationship suggestions.
Security implications reviewed:

- Every import, source file, entry application, recognition, assistant answer and
  natural-search result is household-scoped. Cross-household tests cover import
  detail/source/apply/retry/delete, recognition image/original/retry/delete,
  assistant queries, smart search and document relation suggestions.
- Vault ZIP handling rejects absolute paths, traversal, symlinks, encrypted
  entries, unsafe/unsupported files, excessive file counts and decompressed-size
  excess before reading content. Notes are never executed; `.obsidian` and plugin
  files are skipped. Original sources and extracted notes/attachments stay in a
  private `0700/0600` import volume.
- The worker keeps `/data/uploads` read-only. A separate `housetory_imports`
  volume is writable for extracted vault files, avoiding a broader write capability
  over documents and photos. Imports are included in backup/restore; destructive
  restore was rehearsed with vault note retrieval.
- OCR/import/vision jobs use the existing durable queue with retries, stale-job
  recovery and idempotent apply. Applying an import uses the shared item creation
  service and savepoints per entry; retries do not duplicate imported items.
- Uploaded documents, Markdown, filenames, OCR text and inventory descriptions are
  framed as untrusted data in prompts. Model output must pass strict Pydantic
  schemas with extra fields forbidden. The model has no SQL, shell, write or
  arbitrary tool access; the server executes only allowlisted read-only tools with
  auth-derived household scope.
- Cloud inference is disabled unless both `AI_CLOUD_ENABLED` and
  `AI_CLOUD_CONSENT` are true. Tests assert that no HTTP request is made when
  consent is missing. Local Ollama is preferred and does not send data externally.
- AI is disabled by default. Deterministic import, keyword search, smart search and
  assistant answers continue when the provider is unavailable or returns invalid
  output. No models are downloaded automatically.
- Backend tests increased to 141 and frontend tests to 25. The Phase 5 walkthrough
  exercised container creation/movement, QR, summaries, label PDFs and Phase 4
  imports on desktop and mobile with zero console/network errors.
- Final API/worker/web/database images scan with zero HIGH/CRITICAL findings.
  `npm audit` and production `pip-audit` report no known vulnerabilities.

Residual Phase 4 risks:

- No real local model was installed on the review machine, so model quality,
  latency and hallucination behavior remain unmeasured. Provider contract tests use
  controlled/mocked outputs; deterministic fallback is the verified path.
- Prompt injection remains a defense-in-depth problem. Strict schemas and
  read-only tools limit impact, but model-written prose can still be misleading;
  references and source context must be reviewed.
- Malicious PDFs, archives, images or Office files can consume CPU or exploit
  parser/OCR/model-runtime vulnerabilities. Limits reduce but do not eliminate
  this. Keep images patched and rebuild regularly.
- Obsidian support is not a full YAML/Markdown runtime: plugins, Dataview, canvas
  files and arbitrary HTML/JavaScript are not executed. Broken links and ignored
  notes are reported for review.
- Import source files and extracted vault attachments are sensitive household
  data. Backups remain unencrypted unless the operator encrypts them.
- AI/cloud configuration is environment-driven; changing it requires recreating
  services. Cloud provider retention/training policies are outside this repo.

## Phase 5 follow-up

Phase 5 added movable containers, permanent identifiers, cross-room movement,
QR identity, deterministic/AI summaries and printable PDF labels. Security and
integrity implications reviewed:

- Every container, identifier lookup, conversion, move, summary, QR image and
  label PDF route is authenticated and household-scoped. Cross-household tests
  cover container detail, QR, movement and label generation; anonymous requests
  return 401.
- QR payloads contain only `QR_BASE_URL`/`APP_BASE_URL` plus the location UUID.
  They contain no inventory data, no sequential identifier is used as
  authentication, and the destination is an ordinary protected route. There is no
  anonymous/public QR access.
- Identifier allocation uses a database counter with atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`; tests exercise 20 concurrent
  allocations. Identifiers are unique per household, immutable and never reused
  after an empty container is deleted. Bulk creation reserves one range in a
  transaction.
- Movement takes a per-household transaction advisory lock and deterministic row
  locks, validates destination room/parent, rejects self-parenting and descendant
  cycles, and updates the container subtree and linked item room membership in one
  transaction. Tests cover rollback after a simulated item-update failure,
  concurrent moves, cycle rejection and cross-household denial.
- Existing-place conversion is explicit and preserves the UUID, items, children,
  documents and import provenance. Fixed places are never converted implicitly.
- Summaries are derived from real item records. The deterministic fallback is
  authoritative for printed item lines. Optional AI returns a strict headline
  schema only, uses the existing cloud-consent boundary, rejects digits and falls
  back on invalid/unavailable output.
- Label PDFs are generated locally with ReportLab/segno. Text is drawn with text
  primitives rather than interpolated HTML/XML; QR payloads come from validated
  base URLs plus a random UUID; content is clipped to each label rectangle; jobs
  are capped at 1000 labels. PDFs are streamed `private, no-store` with `nosniff`.
  The generated blob-preview iframe is allowed by CSP via `frame-src 'self'
  blob:`; all other framing remains blocked by `frame-ancestors 'none'`.
- DOCX/XLSX XML parsing was moved to `defusedxml` after Bandit identified
  untrusted ElementTree parsing. Operator-configured AI/QR URLs are validated as
  absolute http(s) URLs; urllib use is annotated with a narrow `nosec` rationale.
- The Phase 5 schema is append-only (`4d8e1a6c2b90`). A destructive backup/restore
  with the new tables/counters was rehearsed; containers, identifiers, items and
  labels remained usable and the app role returned as a non-superuser.
- Final API/worker/web/database images scan with zero HIGH/CRITICAL findings.
  `npm audit`, production `pip-audit` and Bandit report no High/Medium findings.
  Bandit retains four Low findings around the pre-existing Tesseract/Poppler
  subprocess wrapper; the commands and arguments are application-controlled, not
  model- or user-generated.
- Backend tests increased to 141, frontend to 25, and four checked-in Playwright
  workflows pass on a disposable Compose stack.

Residual Phase 5 risks:

- Physical printer alignment and a real iPhone camera scan were not performed.
  PDF geometry and a rendered QR were verified, but local printer scaling/drift
  remains operator-dependent; use the calibration sheet at 100% scale.
- Printed text is a snapshot and can become stale. The UI flags it and the QR
  always opens live data, but a person reading only the label may see old text.
- Summaries and AI headlines are heuristic/user-editable. AI cannot add printed
  item lines, but it can still phrase a headline poorly.
- Container moves are serialized per household; large hierarchies or very large
  item sets increase lock duration. Limits and transactional rollback prevent
  corruption but not temporary contention.
- Label PDFs are generated synchronously in the API process; the 1000-label cap
  bounds CPU/memory but very large print runs still consume request time.
- Custom label geometry is user-supplied; server validation prevents paper
  overflow, but incorrect physical measurements still produce misaligned output.
- QR availability depends on the configured external base URL and network access.
  A localhost base is intentionally warned about, not silently rewritten.

## Conclusion

The exploitable critical/high issues found in the image pipeline, cookie
configuration, backup/restore workflow, PDF handling and container posture have
been fixed and covered by regression tests or verified operational checks. The
remaining risks are primarily deployment-boundary, availability, operational
(encryption/backups) and future-vulnerability risks. Treat this report as a
point-in-time assessment and re-run the scans after dependency, base-image or
deployment changes.
