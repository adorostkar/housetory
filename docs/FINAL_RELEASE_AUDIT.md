# Final whole-app release audit

Audit date: 2026-11-08  
Candidate branch: `codex/restore-assisted-undo`  
Feature HEAD before audit fixes: `9080112` (`Add on-demand resale and replacement item valuation`)  
Server release status: **not performed**. This audit does not merge, push, or modify the server.

The goal is release readiness, not new scope. Retired illustration/headline/warranty-AI
features remain retired, and the frozen post-audit queue remains: necessary fixes only,
then server release.

## Executive result

| Area | Result | Evidence |
| --- | --- | --- |
| Backend tests | PASS | `uv run pytest -q` against PostgreSQL: **480 passed** |
| Backend lint | PASS | `uv run ruff check housetory_api tests` |
| Frontend tests | PASS | `npx vitest run`: **242 passed** |
| TypeScript / production build | PASS | `npx tsc -b --pretty false`, `npm run build` |
| Full disposable browser suite | PASS | Fresh project `housetory-final-audit`, fresh volumes, port 8094: **97 passed, 1 documented skip** in 7.7 min |
| Focused audit regressions | PASS | 14/14 targeted E2E after fixes |
| Actual `Inventory.md` parser/import | PASS | 7 backend tests; actual user file comparison; E2E phase6 import of sanitized fixture |
| Responsive matrix | PASS | `/tmp/housetory-final-responsive-audit.json`: 33/33 page/width checks, no page errors, no horizontal overflow; mobile inputs ≥16px |
| Release-baseline migrations | PASS | disposable DB from server baseline `a1c3e5f7b9d2` to head `c2d3e4f5a6b7`; values and encrypted-key ciphertext preserved |
| Main 8080 data preservation after local deploy | PENDING FINAL DEPLOY | recorded before/after fingerprints below |
| Server live commit / privileged status | UNVERIFIED | read-only SSH available, but `/opt/housetory` is root-only and sudo requires a password; no server modification attempted |

## Verification commands

```bash
# backend (PostgreSQL test database)
cd services/api
uv run ruff check housetory_api tests
HOUSETORY_TEST_DATABASE_URL='postgresql+psycopg://housetory:housetory@127.0.0.1:55432/housetory_test' \
  uv run pytest

# frontend
cd apps/web
npx tsc -b --pretty false
npx vitest run
npm run build

# fresh disposable browser stack (project housetory-final-audit, port 8094)
npx playwright test
```

The fresh stack was created with fresh named volumes and did not touch the existing
`housetory` (8080) or `housetory-e2e` (8090) projects. It ran with
`AI_PROVIDER=disabled`, blank Brave/SMTP/cloud credentials and a fixture-only Brave
base URL, so core workflows did not depend on external services.

## Findings and fixes

### 1. Retired maintenance failures stayed in core attention

Two historical `maintenance.prune_item_images` jobs failed on 2026-11-06 because the
old worker tried to delete upload files from a read-only mount. The handler is now a
safe retired no-op that preserves media, but the failed rows still made System status
report a core “Worker jobs” issue.

Fix: retired no-op job tasks are excluded from live job counts and recent-failure
alerts. Historical rows are retained, not purged. A retry still succeeds through the
retired handler if an operator chooses it. Real failed jobs remain core issues.

Evidence: `tests/test_system_status.py` now creates a historical failed
`maintenance.prune_item_images` row and asserts a healthy summary plus no core issue.

### 2. First-provider model selection did not finish default text setup

When a first provider was created without a default model and the model was selected
later in the provider dialog, the provider save could leave the Default text model
empty. Backend seeding now supports the no-task-row first-provider completion case,
and the UI explicitly sets the first provider/model as the saved default when no
default exists. Later provider edits still do not overwrite an existing saved default.

Evidence: `tests/test_ai_providers.py::test_first_provider_model_finishes_setup_by_seeding_the_default`,
`ai-settings-page.test.tsx` first-provider default test, and full phase6 E2E after fix.

### 3. Browser-suite isolation and accessible-role regressions

The full-suite audit exposed test-only issues: a borrower field is now a combobox, and
an earlier spec left a configured provider behind for later “no-provider” search tests.
These were corrected in tests without changing product behavior. No functional search
or loan regression was found.

## Requirement matrix

Legend: **PASS** means executed in this audit; **LIMIT** means an honest unverified
boundary; **NOT RUN** means intentionally skipped to avoid paid or destructive action.

| Requirement | Result | Concrete evidence |
| --- | --- | --- |
| Core CRUD without AI/provider/internet | PASS | full backend + fresh-stack E2E; stack started with `AI_PROVIDER=disabled`, empty Brave/SMTP/search credentials for core specs |
| Rooms, nested containers, owned-storage items | PASS | `test_item_storage.py`, `test_containers.py`, `item-storage.spec.ts`, phase6/place-management E2E |
| Borrowed records, partial returns, lending and history undo | PASS | `test_lending.py`, `test_borrowed_items.py`, `lending.spec.ts`, `borrowed-items.spec.ts`, `restore-assisted-undo.spec.ts` |
| Tombstones and recoverable place restore | PASS | `test_restore_assisted_undo` coverage + `restore-assisted-undo.spec.ts` |
| Roles, permissions, cross-household and properties | PASS | full backend IDOR/role suites, `zz-properties.spec.ts`, `zzz-households.spec.ts`, viewer borrowed/status tests |
| Search and scoped follow-ups, current loan truth | PASS | unified-search backend/UI tests, `unified-search.spec.ts`, `single-home-polish.spec.ts` |
| Actual `Inventory.md` hierarchy/quantity | PASS | `test_actual_inventory.py` (7 passed; compares live readable user file to fixture when present) and phase6 actual-hierarchy E2E; no external send, no real-household apply |
| Local OCR, documents, receipts, scans, manuals/citations | PASS | backend OCR/scan/manual suites and document-scanning/manuals/document-extraction E2E on disposable storage |
| Online exact make/model manual discovery | PASS with fixture skip | manuals E2E runs with configured Brave fixture; otherwise explicitly skips when Brave provider is not configured |
| QR labels excluding item contents | PASS | label/QR backend tests and phase5/responsive E2E |
| Purchases, allocations, warranty, per-unit value math | PASS | `test_financial.py`, `test_evidence_exports.py`, current-values/item-valuation specs |
| Evidence PDF/CSV/ZIP real artifact + permissions | PASS | backend PyPDF assertions and `inventory-evidence.spec.ts` actual download; authenticated no-store checks |
| Voice / vision routes and provider failures | PASS with mock providers | voice/recognition/provider-capability backend suites; phase6/openrouter-media/voice E2E; no paid calls |
| Review queue, off-by-default schedule, consent/staleness | PASS | inventory-review backend/E2E, schedule panel tests, full suite |
| Persistent default text, overrides and bulk Test all | PASS | `test_ai_providers.py`, `simplification3.spec.ts`, mocked `test-all-ai-tasks.spec.ts` |
| SMTP flexible provider without hardcoded Resend | PASS with manual live boundary | email service token/capture tests; no external mail sent; server Resend env remains untouched |
| Multi-home, roles, invitations, recovery tokens | PASS with no external mail | households/accounts backend suites and `zzz-households.spec.ts`; tokens exercised locally |
| No account/key plaintext or log leakage | PASS | credential-encryption/log/IDOR tests; audit commands did not read server env values or key logs |
| Unified search scope/cache/current truth | PASS | unified-search/direct/AI/fallback backend + E2E; no automatic writes |
| 320/390/768/landscape 844/1440 responsive layout | PASS | responsive-mobile E2E and `/tmp/housetory-final-responsive-audit.json` (33 checks); full suite includes 320/390/844 landscape/768/1024/1440 |
| Mobile input sizing and keyboard shrink behavior | PASS with device limitation | responsive-mobile spec checks mobile input size and simulated 390×500 keyboard shrink; real iPhone keyboard/PWA cannot be emulated |
| Accessibility basics | PASS | accessible names/roles, keyboard flows, focus return, loading/error/empty states across tests |
| Migration from server baseline to head | PASS | `test_release_migration.py`: baseline `a1c3e5f7b9d2` → head `c2d3e4f5a6b7`; rerunning head is no-op; provider ciphertext/version and item values unchanged; legacy values become `legacy_record_total`; new metadata/table nullable/empty |
| Main data/settings preservation after local deploy | PASS | 52 items / 1 photo / 3 images / 2 providers / 8 tasks / 1 loan preserved; 0 applied values, 2 preview rows; provider ciphertext presence, Brave/SMTP/default-text settings and Alembic head unchanged; 8090 fixtures unchanged |
| Real paid AI/Brave/SMTP/insurance-provider calls | NOT RUN | mocks/fixtures only; no paid calls or real external messages |
| Real iPhone/iPad PWA keyboard and standalone behavior | LIMIT | not emulatable in this environment; requires manual iPhone check |
| Live server commit, privileged helper status, Docker/Compose and env names | UNVERIFIED | read-only SSH shows Ubuntu 24.04.5, nginx active, 18089 and public HTTPS health 200; `/opt/housetory` is mode 700 root, Docker socket denied, sudo needs a password; no values read |
| Local 8080 deployment | PASS | commit `0166708` built and deployed to existing `housetory` project; health 200; DB/storage ok; data/settings preserved; System status healthy; no volume reset |
| Server deployment | NOT PERFORMED | branch is unmerged; no push/merge/deploy performed |

## Responsive audit evidence

`/tmp/housetory-final-responsive-audit.json` records 33 page/width checks across
Items, Rooms, Loans, Documents, Containers, Review, Settings, AI settings, System
status, Purchases and Warranties at 320, 768 and 1440 widths.

- 0 page errors;
- 0 horizontal overflows;
- 0 small inputs at mobile widths;
- desktop small controls are expected and were not treated as defects.

The checked-in `responsive-mobile.spec.ts` additionally covers 320×568, 390×844,
844×390 landscape, 768×1024, 1024×768 and 1440×1000, dense AI rows, dialogs,
menus, keyboard-open simulation and More navigation.

## Local 8080 deployment evidence

The audit fixes were committed as `0166708` (`fix: close final release audit gaps`),
then deployed to the existing local `housetory` Compose project on port 8080 with
`RELEASE_COMMIT=0166708036f4`, `RELEASE_CHANNEL=local`. The report-only follow-up
commit was then deployed with identical application code so the running release
commit matches branch HEAD. No volumes were removed or recreated. A pre-deploy backup
was written to `backups/housetory-20261108T060015Z` (database, uploads, imports,
exports; mode 600 files, SHA-256 checksums).

Before deployment, the running release was `908011219375` with Alembic head
`c2d3e4f5a6b7`. Preserved fingerprints:

| Fingerprint | Before | After |
| --- | --- | --- |
| Items | 52 | 52 |
| Item photos | 1 | 1 |
| Item images | 3 | 3 |
| AI providers | 2 | 2 |
| AI task settings | 8 | 8 |
| Loans | 1 | 1 |
| Applied current values | 0 | 0 |
| Valuation preview rows | 2 | 2 |
| Alembic revision | `c2d3e4f5a6b7` | `c2d3e4f5a6b7` |

Provider credentials remained present with `api_key_version=1`; the OpenAI and
OpenRouter providers were unchanged. The saved default text model remained
`deepseek/deepseek-v4.1-flash` and all eight task rows kept their model/enabled/
inheritance values. Online search remained manual+reference enabled with an encrypted
Brave credential (`api_key_version=1`). SMTP reported `email_configured=true` and the
AI credential key remained configured; no secret values were printed.

System status before the fix was `attention` with one core issue (“Worker jobs: 2
failed job(s)”). After deployment it is `healthy` with
`attention_count=0`, `core_issue_count=0`, `configured_feature_issue_count=0` and no
issues. Live job counts exclude the retired task (`succeeded=43`, no recent failures),
while the two historical `maintenance.prune_item_images` failed rows remain in
PostgreSQL for audit/retry.

The existing 8090 acceptance fixtures were not modified. Their before/after
fingerprints were identical: 216 items, 6 item photos, 1 item image, 1 provider,
5 task settings, 24 loans, and the accepted host/child item IDs plus shelf container
ID `b109fc38-2c4f-4798-8af3-bf13acd73517` remained present.

Health checks after deploy:

```text
GET http://localhost:8080/api/v1/health/ready -> 200, database=ok, storage=ok
GET http://localhost:8080/                    -> 200
container RELEASE_COMMIT                      -> matches committed audit HEAD
```

## Server read-only facts (2026-11-08)

Verified without modifying the server:

- host `ashkanserver`, Ubuntu 24.04.5 LTS, 15 GiB RAM (about 10 GiB available), 800 GiB free on `/`;
- nginx active; ports 80/443 and loopback `127.0.0.1:18089` listening;
- public `https://inventory.dorostkar.net/api/v1/health/ready` → HTTP 200;
- local `http://127.0.0.1:18089/api/v1/health/ready` → HTTP 200;
- Housetory nginx config proxies `inventory.dorostkar.net` to `127.0.0.1:18089`, redirects HTTP to HTTPS, sets HSTS/CSP/referrer/opener/resource/permissions headers;
- certificate/key files exist at `/etc/ssl/cert.pem` and `/etc/ssl/key.pem` with expected root-readable permissions;
- API/worker processes are running in containers; Docker socket is not readable by the SSH user.

Unverified or supplied from the prior accepted helper run (not re-read in this audit):

- server commit was previously pinned at `6068b3d`; the server baseline migration for that commit is `a1c3e5f7b9d2`;
- `/opt/housetory/.env` names/values and Docker Compose project details could not be read as the non-privileged SSH user;
- live server DB revision could not be read without privileged access.

## Release/staging plan (not executed)

1. Codex independent verification of this audit and the new commit.
2. Merge `codex/restore-assisted-undo` into `main`, push the stable Git commit, and
   deploy that pinned GitHub commit. Do not deploy a local archive or copy `.env`.
3. On the server, through the existing sudo-gated helper/operator policy, take a fresh
   database/uploads/imports/exports backup and record the current pinned release
   `6068b3d`.
4. Fetch the stable GitHub commit into `/opt/housetory`; verify source readability for
   the Docker build context and confirm the existing `.env` names are unchanged. Do
   not print, copy, reset or rotate existing SMTP/Brave/AI credentials.
5. Build with the existing `housetory-server` Compose project and run pinned migrations
   `a1c3e5f7b9d2 → c2d3e4f5a6b7`; no destructive volume reset.
6. Verify release commit, API/worker/storage/DB health, migration head, item/loan/
   provider/task counts, encrypted credentials still present, online-search settings
   and SMTP configuration presence (names/booleans only), and public HTTPS smoke tests.
7. Roll back by restoring the pre-deploy backup and returning to `6068b3d` if any
   check fails. Do not repair by deleting data or volumes.
8. Run the manual iPhone/PWA keyboard/camera/microphone check and live provider/email
   checks only after deployment approval.

## Artifacts

- `docs/FINAL_RELEASE_AUDIT.md` (this report)
- `/tmp/housetory-final-responsive-audit.json`
- `/tmp/housetory-valuation-live-preview.png`
- `/tmp/housetory-valuation-web-live.png`
- disposable-stack Playwright screenshots/downloads were temporary; the checked-in
  walkthrough screenshots were restored and only intentional audit evidence remains
- fresh-stack Playwright output and test-results are ignored build artifacts

## Exact skips / limits

- One Playwright case skips by design: `apps/web/e2e/manuals.spec.ts:139`
  (`discovers through the concrete Brave adapter…`) skips when
  `/api/v1/items/{id}/manuals` reports that the online-search provider is not
  `brave`. The audit stack deliberately ran without a Brave credential, so the
  concrete-adapter path was covered by backend fixtures and the UI path by the
  configured-fixture test history, not by a live Brave call. This is an explicit
  fixture guard, not a silent pass.
- No live paid AI, live Brave search, real SMTP delivery, external SMS/Telegram,
  real iPhone hardware camera/microphone or insurer integration was used.
- The server privileged state above remains unverified until operator-assisted release.
- No server release, merge or push was performed.
