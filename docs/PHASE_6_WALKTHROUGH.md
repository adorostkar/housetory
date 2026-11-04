# Phase 6 — AI Intelligence, Mobile Camera & Smart Import

**Status:** implemented and verified end-to-end on disposable Compose stacks over
both HTTP and direct HTTPS. Real cloud credentials, a real local vision model, a
physical iPhone camera and a physical printer were not available; those items are
explicitly marked as unverified rather than implied.

The live household on port 8080 was not reset. Verification used separate
projects, volumes and ports, plus a loopback-only self-signed certificate for the
TLS rehearsal.

## 1. Implemented features

### AI provider management

- Owner-only **Settings → AI providers** page.
- Add, edit, enable, disable and remove OpenAI, Anthropic Claude, Google Gemini,
  xAI Grok, OpenRouter and local Ollama providers.
- API key or local endpoint, default model, connection test and model discovery
  against the provider's official API.
- Separate provider/model defaults for assistant, smart imports, document
  interpretation, natural-language search, image recognition and optional label
  headlines.
- Capability heuristics for text, vision, structured JSON and tool calling, with
  understandable errors when a model cannot perform the selected task.
- Provider-level cloud consent controls that are separate from saving an API key.
  Local Ollama remains local. AI can be disabled per task.
- Task-aware status endpoint and processing-mode labels in the UI.
- Environment-based AI remains a bootstrap/fallback path when no database
  provider exists, preserving Phase 4 behavior.

### Credential security

- API keys are encrypted with Fernet using `AI_CREDENTIAL_KEY` supplied through
  the deployment environment, never PostgreSQL.
- `AI_CREDENTIAL_KEY_PREVIOUS` supports rotation; **Rotate credentials**
  re-encrypts existing keys. A missing or wrong key fails closed and produces a
  provider error instead of sending an unauthenticated request.
- Saved keys are never included in API responses, frontend state or logs; the UI
  only receives `has_api_key` and a key version.
- Settings mutations are owner-only. All provider calls originate in the API or
  worker, never the browser.
- Backups do not include the encryption key; the documentation states that the
  key must be backed up separately or restored credentials cannot be decrypted.

### Camera and photo management

- **Take Photo** and **Choose Photo** actions on item, room and container screens.
- Rear-camera hint where the browser supports it, with a consistent file-input
  fallback. No need to save the photo to the iPhone library first.
- Local preview with **Retake**, **Cancel** and explicit upload. Upload progress,
  validation errors and retry are surfaced.
- Item, room and storage-location photographs reuse the validated storage
  pipeline: content validation, EXIF orientation/metadata stripping, HEIC/HEIF
  normalization, WebP thumbnails, 20-photo cap and authenticated no-store file
  routes.
- Multiple photos, cover selection, earlier/later reordering, full-size viewer and
  deletion. Container movement keeps photos attached because they are linked to
  the stable location UUID.

### AI visual inventory

- **AI Scan Items** page at `/scan`, linked from assistant, items, rooms and
  containers.
- Container context defaults every suggestion to that container; destination can
  be changed per suggestion.
- A vision model can return multiple separate suggestions with name, quantity,
  description, category, visible brand/model, confidence, tags, warnings and
  field provenance.
- Suggestions are editable; users can accept/reject, create new records, update
  an existing item, allow an intentional duplicate or choose another destination.
- Potential duplicates are shown with scores and reasons. Strong matches are
  blocked unless the user explicitly allows a new record or chooses update.
- Apply is explicit and idempotent, uses savepoints, reports partial failures,
  records `recognition_item_links` and source-photo provenance, and never uses the
  whole scan photo as every item's cover.
- Without a vision-capable model, OCR fallback suggestions are labelled as OCR and
  the UI explains the limitation. A failure offers manual entry.

### Hierarchical imports

- Removed the dedicated Obsidian tab. TXT, Markdown, CSV, XLSX, DOCX, PDF, images
  and ZIP vaults all go through **Import → Upload file**.
- Deterministic extraction runs first. A conservative hierarchy parser only
  activates when it recognizes room/container structure, so ordinary flat
  Markdown and Obsidian imports keep their Phase 4 behavior.
- Recognizes rooms, fixed locations, movable and nested containers, items,
  quantities and legacy identifiers such as `STO-01`, `STO-CABLE-01`,
  `APT-KIDS-01` and `CAR-TOOLS-01`.
- Skips index/contents pages, instructions, templates and empty example boxes.
- Optional LLM normalization can edit only supplied keys; it cannot invent keys,
  items, quantities, relationships, serials, prices or purchases.
- Tree review supports expand/collapse, inline name/quantity/type/parent/legacy-ID
  editing, source excerpts, duplicate warnings, individual selection and branch
  approval.
- Apply creates approved rooms and containers in dependency order, reuses
  matching existing records, preserves legacy labels as aliases, links items to
  their reviewed parent, reports partial failures and is idempotent.
- Legacy labels do not replace Phase 5 permanent identifiers. `STO-03` remains a
  recognized alias while the container receives a `BOX-###` identifier.

### HTTPS, nginx and PWA

- nginx remains the only public web process. PostgreSQL, API and worker remain
  internal.
- Optional `compose.tls.yaml` + `nginx.tls.conf` provide direct TLS 1.2/1.3 on
  the configurable HTTPS port (443 by default), an HTTP→HTTPS redirect on 8080
  (except `/healthz`) and the same security headers as HTTP.
- `APP_BASE_URL`, `COOKIE_SECURE=true`, Host/Origin checks, authenticated QR
  URLs, PWA assets and API routing are documented for HTTPS.
- Tailscale Serve is optional. Trusted LAN and public trusted-certificate modes
  are documented.
- PWA installation via Safari Share → Add to Home Screen; secure-context camera
  requirements are explained.

## 2. Architecture decisions

- Extended the Phase 4 AI boundary rather than replacing it. Provider-neutral
  adapters: OpenAI-compatible (OpenAI/xAI/OpenRouter/self-hosted), Anthropic
  Messages, Gemini `generateContent` and Ollama chat.
- Database-backed provider/task settings with environment fallback. Credentials
  are decrypted per request in the API/worker; configuration is never cached in
  the browser or queried directly by the client.
- Added `room_photos` and `location_photos` rather than a second image system.
  Existing item photos and storage validation remain authoritative.
- Recognition and hierarchy apply reuse existing item/container/location services
  and require explicit user approval. AI has no SQL, shell, write or tool-call
  path into inventory.
- Hierarchy parsing is deterministic-first and conservative; AI is an optional
  normalizer over validated keys, not an extractor that can add records.
- TLS is an opt-in Compose overlay. The HTTP deployment remains valid for
  localhost, private networks and Tailscale Serve.

## 3. Database migration

Append-only Alembic revision:

`c1a7e5d9f320_ai_providers_photos_hierarchy.py`

Adds:

- `ai_providers` with household/provider uniqueness, encrypted key, key version,
  enabled state and cloud consent.
- `ai_task_settings` keyed by household and task.
- `room_photos` and `location_photos`.
- `storage_locations.legacy_identifier` and `aliases`, with a lookup index.
- Import hierarchy fields: `entity_type`, `parent_entry_id`, `created_room_id`,
  `created_location_id`, `legacy_identifier`.
- Recognition destination/mode/apply fields and `recognition_item_links`.
- Required index/type alignment for the new model.

`alembic upgrade head` and `alembic check` pass on a fresh PostgreSQL database.
No earlier migration was rewritten and no live data was reset.

## 4. Supported AI providers

| Provider | Adapter | API key | Model discovery |
| --- | --- | --- | --- |
| OpenAI | OpenAI-compatible chat/completions | Yes | `GET /models` |
| Anthropic Claude | Messages API | Yes (`x-api-key`) | `GET /models` |
| Google Gemini | `generateContent` | Yes (query key) | `GET /models` |
| xAI Grok | OpenAI-compatible | Yes | `GET /models` |
| OpenRouter | OpenAI-compatible | Yes | `GET /models` |
| Ollama | Native `/api/chat` and `/api/tags` | Optional | `GET /api/tags` |

No model catalog is hardcoded as the only option; users can enter an exact
model name. Vision formats are provider-specific (OpenAI image URL, Anthropic
base64 image blocks, Gemini inline data, Ollama images array).

## 5. Credential storage and security

- Fernet token format `fernet:v1:<token>`; key must decode to 32 bytes.
- Save, replace, clear and rotate are owner-only operations.
- `AI_CREDENTIAL_KEY_PREVIOUS` is tried after the current key during rotation.
- Decryption failure returns a provider configuration error and prevents the
  call; it does not silently fall back to cloud or local processing.
- Provider keys are write-only from the client's perspective.
- Provider/model errors are bounded and do not include request headers or keys.
- Credential rotation test verifies re-encryption and key-version increment.
- Backup documentation calls out the key as a separate secret.

## 6. Model selection and capabilities

Capabilities are conservative heuristics based on provider and model name:
`text`, `vision`, `structured`, `tools`. The UI displays them and the API rejects
assigning a non-vision model to the vision task. Capability detection is not
presented as a substitute for a real provider test; connection and model
availability are checked through the provider's API.

## 7. Camera capture behavior

Verified in desktop Chromium with a file-input capture path: camera action,
preview, retake, cancel, upload progress and successful photo display. Room and
container photo managers likewise upload, select covers, reorder and delete.
iPhone Safari and installed-PWA camera behavior were not physically tested.

## 8. Multi-object recognition results

Controlled local Ollama response returned two suggestions from one image:
`Camera body` and `USB-C cables ×3`. The UI showed local processing, confidence,
editable fields, destination defaulted to the container, and duplicate review.
Approval created two records in the container with the correct quantity. A retry
did not create duplicates. The item detail confirmed the scan image was not
automatically attached as an item cover. The latest E2E run used unique names per
run to avoid collisions with prior disposable data.

This validates the adapter/schema/review/apply path, **not** real model accuracy.
No real vision model was installed or benchmarked.

## 9. Hierarchical import results

The mandatory fixture produced:

- 14 room/container nodes.
- 33 item entries.
- Storage → Storage room 2 → `STO-01`…`STO-06`.
- `STO-03` contents including keyboards ×2, toner ×3, power cables ×2, PC power
  cables ×4, three-way adapters ×3, display cables ×4, Ethernet cables ×7 with
  the “plus one long cable” note, VGA ×1, adapter ×1, USB-C→HDMI ×2, HDMI ×1,
  MagSafe 2 ×1 and case fans ×2.
- `STO-06` flagged as an ambiguous loose-items group at confidence 45.
- Index and template examples excluded; “Empty boxes” appears once, not as a
  duplicate from the index.
- `APT-KIDS-01`, `APT-TOOLS-01`, `CAR-TOOLS-01` and `CAR-EMERGENCY-01` preserved
  as aliases/legacy identifiers.
- Applying the tree created correct nested rooms and containers; item locations
  and quantities matched the source.
- Re-importing the same fixture showed duplicate warnings; default decisions
  skipped the existing items, and the item total remained unchanged. Explicit
  override is available but not automatic.

The optional AI normalization path was exercised with controlled outputs; a real
model’s hierarchy accuracy was not benchmarked.

## 10. Markdown regression fixture verification

Backend test `tests/test_hierarchy_imports.py` asserts the exact node/item counts,
parent links, legacy IDs, ambiguous confidence, quantity parsing, notes, source
excerpts, index/template exclusion, apply order, idempotency and duplicate guard.
Playwright repeats the import/review/apply flow through the real UI and API on a
fresh disposable household.

## 11. Phase 5 integration

- Hierarchy apply uses Phase 5 container creation and permanent identifiers.
- Legacy IDs become aliases; no internal identifier is overwritten.
- Container-scoped scan defaults to that container and respects it after apply.
- Container detail links to **Scan contents**.
- Photo associations survive moves because they use the location UUID.
- Phase 5 Playwright container/move/label/QR tests still pass in the same run as
  the Phase 6 suite.

## 12. HTTPS/PWA verification

- Direct TLS stack: `compose.yaml` + `compose.tls.yaml`, self-signed
  localhost certificate, ports 80/443.
- HTTP returns `301 https://localhost/`.
- HTTPS returns HTTP/2, HSTS, CSP, `nosniff`, COOP/CORP and camera Permissions
  Policy.
- Authentication, secure cookies, deep links, manifest, service worker
  registration and mobile-width AI settings rendered successfully through
  `https://localhost`.
- The self-signed certificate required Playwright’s test-only certificate bypass.
  A real trusted certificate is required for real iPhone camera/PWA confidence.

## 13. Test results

- Backend: **156 pytest tests** passed against PostgreSQL with the full migration
  chain and `alembic check` clean.
- Frontend: **34 Vitest tests** passed; strict TypeScript and production build
  passed.
- Playwright: **8 workflows** passed over HTTP and again over direct HTTPS on a
  fresh disposable stack. Coverage includes Phase 5 regressions, provider
  configuration with a mocked local Ollama service, camera upload, multi-object
  review/approval, hierarchy import, duplicate prevention and PWA routing.
- Ruff checks passed for API and tests.

## 14. Security scans

- Production `pip-audit`: **no known vulnerabilities**.
- `npm audit --omit=dev` and full `npm audit`: **0 vulnerabilities**.
- Trivy HIGH/CRITICAL vulnerability scans: **0 findings** in the API, worker, web
  and database images after upgrading `cryptography` to 50.0.2.
- Ruff, strict TypeScript and production build pass.
- Live database role inspection confirms the API/worker role is not superuser
  and cannot create roles or databases.
- No real provider credentials or consumer account tokens were used.

## 15. Real-model versus mocked testing

Mocked/test-controlled:

- Ollama model discovery and chat responses.
- Multi-object suggestion content.
- Optional hierarchy normalization output.
- AI provider connection test via a local Node HTTP service.

Real:

- Backend HTTP requests to the mock official-format Ollama endpoint.
- PostgreSQL persistence and encryption/decryption.
- Actual file upload, image validation, thumbnail generation and authenticated
  retrieval.
- Actual hierarchy parsing/apply, database relationships and duplicate checks.
- Actual nginx HTTP/TLS proxying and browser service-worker registration.

Not real:

- Cloud provider account credentials, rate limits or model quality.
- A real local vision model's recognition accuracy.
- A physical iPhone camera, installed-home-screen PWA or printer.

### Screenshots

| AI providers | Hierarchical import review |
| --- | --- |
| ![AI providers](walkthrough/phase6/01-ai-providers.jpg) | ![Hierarchy review](walkthrough/phase6/02-hierarchy-review.jpg) |

| Upload file without an Obsidian tab | Mobile AI settings |
| --- | --- |
| ![Import upload](walkthrough/phase6/03-import-upload.jpg) | ![Mobile AI settings](walkthrough/phase6/04-mobile-ai-settings.jpg) |

## 16. Desktop/iPhone walkthrough

Desktop Chromium completed provider setup, camera preview/upload, scan review,
bulk approval, hierarchy tree review/apply and duplicate review with no failed
test steps. A 393×852 mobile context verified the AI settings page, scan layout,
container and label views. Real Safari/iPhone hardware was unavailable.

### Troubleshooting

- **Provider test fails:** confirm the base URL is an absolute `http(s)` URL,
  the model name exactly matches the provider's model list, the API key is
  current, and cloud consent is enabled for cloud providers. Local Ollama must be
  running and reachable from the API/worker container.
- **Saved credential cannot be decrypted:** restore the matching
  `AI_CREDENTIAL_KEY`, or set it as `AI_CREDENTIAL_KEY_PREVIOUS` together with a
  new key, restart API/worker, rotate, verify, then remove the previous key.
- **No camera action works:** camera APIs require a secure context. Use
  `https://` or localhost, allow camera permission, and in an installed PWA check
  iOS Settings → Housetory → Camera. The Choose Photo path remains available if
  `capture` is unsupported.
- **Scan shows OCR fallback:** assign a vision-capable model to the vision task
  in Settings → AI providers. OCR does not provide reliable object recognition.
- **Hierarchy tree is not shown:** the source lacked recognizable room/container
  structure or item bullets, so the normal flat import review was used. Add
  headings or legacy identifiers for the tree mode.
- **A hierarchy apply reports a duplicate:** review the existing match, choose
  skip/merge, or explicitly tick “Create a separate item anyway”. Default
  decisions never overwrite or duplicate silently.
- **PWA/service worker does not register over HTTPS:** use a trusted certificate;
  a self-signed certificate may allow page navigation but still block secure
  service-worker/camera features in Safari.
- **ZIP upload is rejected:** archives are limited by `IMPORT_MAX_FILES`,
  decompressed size and per-file size; encrypted entries, traversal paths and
  symlinks are rejected.

## 17. Known limitations and remaining risks

- Real cloud/local-model quality, latency and context-window behavior are
  unmeasured. Mocked tests validate contracts, not accuracy.
- No real iPhone camera/PWA test; secure-context and permission behavior must be
  confirmed on the device.
- No physical printer or QR scan test.
- Suggestion merge/split is not a separate control; users can reject, edit,
  re-quantify and route suggestions individually.
- Hierarchy AI normalization is intentionally conservative; ambiguous headings
  may need manual review.
- An operator who loses `AI_CREDENTIAL_KEY` must replace saved provider keys.
- Direct TLS requires correctly permissioned certificate/key files and a trusted
  certificate for real secure-context features.
- Public deployment still relies on first-run setup being claimed immediately,
  rate limiting, strong credentials and host patching. No WAF, MFA or external
  identity provider is implemented.
- Firefox/Safari camera `capture` hints vary; the UI falls back to normal file
  selection and still accepts uploads.

## 18. Recommended Phase 7 scope

Tauri 2 macOS desktop, followed by real-model benchmarks, physical iPhone
camera/PWA validation, optional suggestion merge/split, accessibility automation
and visual regression testing. Advanced organisation (custom fields, taxonomy UI
and multi-user sharing) should follow.
