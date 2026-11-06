# Internet-independent core acceptance

This record describes what was actually exercised without outbound Internet. It is
not a claim that the browser can edit inventory offline: the browser still needs
to reach the self-hosted server over a trusted LAN/local network.

## Isolated topology

`compose.offline.yaml` creates disposable volumes and an internal Docker network:

- `db`, `migrate`, `api` and `worker` join only `core_internal` (`internal: true`);
- `web` joins `core_internal` for the `/api` proxy and the default network only so
  the browser can reach the published port;
- no AI provider, Brave key, permitted image source, SMTP host or cloud credential
  was configured for the stack.

Commands:

```bash
WEB_BIND=127.0.0.1 WEB_PORT=8091 APP_BASE_URL=http://localhost:8091 \
RELEASE_COMMIT=offline-core-test RELEASE_CHANNEL=offline-test \
SERVER_IDENTITY=offline-stack AI_PROVIDER=disabled AI_CLOUD_ENABLED=false \
AI_CLOUD_CONSENT=false AI_CLOUD_API_KEY= AI_CREDENTIAL_KEY= \
MANUAL_SEARCH_PROVIDER=none BRAVE_SEARCH_API_KEY= ITEM_IMAGE_SEARCH_PROVIDER=none \
SMTP_HOST= SMTP_USERNAME= SMTP_PASSWORD= SMTP_FROM_ADDRESS= \
docker compose -p housetory-offline -f compose.yaml -f compose.offline.yaml up -d --build
```

## Actual outbound-block evidence

Inside both `api` and `worker` containers:

```text
TCP 1.1.1.1:443 blocked: OSError
HTTPS example.com blocked: URLError
```

## Core workflows exercised

Against the isolated stack, 34 checked-in Playwright workflows passed:

- account setup/login and viewer role behavior;
- item, room, property and household CRUD/context;
- keyword and deterministic structured search, quick search, missing-purchase
  filters and the search query/submit regression;
- owned loans, partial returns, history and move undo;
- borrowed-from-others creation, mixed direction filters, partial returns to owners,
  private borrowed photos, search labels and viewer read-only behavior;
- direct document scan/edit/reorder/save and local worker OCR;
- QR/label creation, preview, calibration and authenticated container view;
- room/container hierarchy and bulk operations;
- stocktake start/resume/review/apply/complete;
- evidence preview, PDF/CSV/ZIP generation and authenticated download through the
  local worker;
- system status and compact unavailable-feature states.

Browser resource audit: the app shell, items, rooms, search, loans, documents and
Settings loaded with **zero external browser requests**. Only same-origin,
`data:` and `blob:` resources were used.

Restart check: after restarting API, worker and web, readiness returned `ok`,
login succeeded and the existing LAN session remained valid.

## Optional-service behavior

With no AI/search/mail configuration:

- the item page shows one compact `Configure item images` action and no disabled
  artwork/generation controls;
- the voice page shows one `Configure voice transcription` action instead of a
  disabled recorder;
- status marks optional external services not configured and does not probe or
  claim they work;
- no paid/live provider call is made by discovery or status.

## Tested boundaries and limitations

- The browser itself still had Internet access during the resource audit; the
  audit proves the app requested only local resources. The API/database/worker
  Internet block is proven separately.
- This is **not** offline browser editing, service-worker inventory sync or a
  replacement for the server. The browser must reach the server over LAN.
- A public domain may fail to resolve during an Internet outage. Use a stable
  trusted-LAN HTTPS address and matching QR base URL; certificate validation is
  never disabled.
- Local OCR/PDF/labels/stocktake depend on bundled worker/runtime resources, not
  first-use downloads. Model quality and real speech/cloud provider quality are
  not claimed.
- Cloud AI, manual/image discovery and email are optional and honestly unavailable
  without configuration/Internet. Real provider live tests remain operator-run,
  explicit and outside this automated acceptance.
- Borrowed records are private household logs, not owner accounts. They are
  excluded from owned counts, values, evidence and stocktake. The offline stack
  verified creation, mixed filters, partial returns, private photo access and viewer
  restrictions with no AI/search/SMTP configuration and blocked API/worker egress.
- The live household/Settings/task choices were not used to validate these
  destructive workflows; the acceptance stack is disposable and separate.

## Reproduce the focused checks

```bash
cd apps/web
E2E_BASE_URL=http://localhost:8091 E2E_EMAIL=offline-core@example.com \
E2E_PASSWORD=offline-core-password-2026 \
E2E_DB_CONTAINER=housetory-offline-db-1 E2E_RELEASE_COMMIT=offline-core-test \
npx playwright test e2e/accounts.spec.ts e2e/add-items.spec.ts \
  e2e/borrowed-items.spec.ts e2e/bulk-organisation.spec.ts \
  e2e/document-scanning.spec.ts e2e/inventory-evidence.spec.ts \
  e2e/item-status.spec.ts e2e/lending.spec.ts e2e/phase5.spec.ts \
  e2e/quick-search.spec.ts e2e/release-stabilisation.spec.ts \
  e2e/single-home-polish.spec.ts e2e/stocktake.spec.ts \
  e2e/zz-properties.spec.ts e2e/zzz-households.spec.ts \
  e2e/offline-resource-audit.spec.ts
```
