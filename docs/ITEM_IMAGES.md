# Item images, references and illustrations

Item images are display aids, not physical evidence. They never replace user
photographs, change inventory facts, or count as a stocktake/evidence observation.

## Source taxonomy and display priority

| Priority | Source | Meaning |
| --- | --- | --- |
| 1 | **Actual photo** (`item_photos`) | A user upload of the real unit. May show condition, colour and wear. |
| 2 | **Reference image** (`item_images`, `reference`) | A downloaded product image with recorded source/provenance. Not proof of the exact unit or condition. |
| 3 | **AI illustration** (`item_images`, `ai`) | A generated illustration from product text. Not a photo and never an exact-model claim. |
| 4 | **Built-in illustration** (`item_images` or derived) | Small curated offline line-art library matched conservatively from the item name/description/category. |
| 5 | **Category icon** | Lucide fallback when no image or built-in match exists. |

The detail page always uses the actual photo gallery first. Non-photographic
imagery is shown only when no actual photo exists, with an explicit
`Reference image`, `AI illustration` or `Generic illustration` label. The item
card/list thumbnail follows the same priority.

Users can **Change image**, **Remove** a stored reference/illustration, or
**Use generic** and choose one of the built-in illustrations. Actual photos are
never overwritten or deleted by these actions.

## Built-in library

A small local library ships with the app for: power drill, television, Ethernet
cable, suitcase, storage box, chair, sofa, camera, laptop, kettle, bicycle, book
and a generic item. The SVGs are inline React components, usable offline, with
no external assets, generated downloads, API keys or LLM calls.

Matching is deliberately conservative:

- strong name matches win;
- category, then description, are considered next;
- two conflicting strong types are ambiguous and fall back to the category icon;
- vague items are not forced into a specific illustration.

The user can correct a vague or wrong match from item details.

## Reference-image search

The supported integration is the documented **Brave Image Search API**
(`GET /res/v1/images/search`, `X-Subscription-Token`). It reuses the server's
existing `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_BASE_URL`, country/language and
timeout settings. No custom gateway is required for images. Manual document
search remains a separate feature.

`ITEM_IMAGE_SEARCH_PROVIDER` can be `auto`, `brave` or `none`; `auto` uses the
Brave key when present.

### Automatic selection, not candidate approval

An explicit **Find image** action, or the household's opt-in
**automatically find a reference image for new items** setting, searches, ranks
and selects a suitable image automatically. The user does not approve a
candidate list in the normal flow.

Ranking is deterministic and conservative:

- only results with a recorded public page/image URL are considered;
- well-known stock/watermark domains are rejected;
- the known brand must appear in the title, source domain, page host or image
  host;
- obvious conflicting product types are rejected;
- manufacturer-hosted pages/images are preferred;
- exact-model confirmation is set only when the known model identifier is
  present in the candidate evidence;
- otherwise a representative image may be accepted but is labelled
  **“exact model not confirmed”**.

The user specifically approved relaxing the full-model gate for images. A
description such as “LG TV” plus “OLED, 77-inch” can be enough for a
representative image. **Manual and model-specific instructions still require the
complete confirmed manufacturer/model gate**; that relaxation applies only to
images.

If no suitable candidate is found, the built-in/category fallback remains. A
search hit is never treated as proof of licensing. The current automated policy
is deliberately conservative: only manufacturer-hosted candidates are eligible
for download, and the source page, retrieval time, model-confirmation state and a
“reuse rights not independently verified” note are stored. Hotlink restrictions,
watermarks and paywalls are not bypassed; the app does not remove watermarks.

The result is downloaded through the same public-DNS/private-address/redirect/
byte/time limits as manual retrieval, then decoded and re-encoded into a private
derivative. Original EXIF/metadata is not copied into the derivative. Source URLs
are kept only as provenance.

### Reuse and deduplication

- Image choices are serialized per item.
- Re-running the same lookup does not create duplicate downloads.
- A household can reuse the same reference-image lookup for another item with
  the same normalized product fingerprint; the file is copied internally and
  provenance follows it.
- No image/reference metadata is shared across households.
- If an actual photo is added before or during lookup, the actual photo wins and
  the stale reference result is not attached.

## AI item illustrations

AI generation is optional and disabled by default. It uses an authenticated
**OpenAI Images API** task (`item_images`), not a chat/completions model. The
adapter calls `POST /images/generations` with the configured image model and
accepts only an inline `b64_json` image response; a URL-only or malformed response
is an explicit failure, never a fake success. The encrypted provider key,
provider enablement and cloud/private consent rules are the same as other AI
tasks. Other providers currently show an unsupported-task state rather than
being treated as image generators.

The prompt contains only minimized product text: item name, brand, model,
description and category. It never includes borrowers, room contents, receipts,
documents or notes. The prompt asks for a generic illustration with no logos,
text, people or claims about the exact unit's condition. Generated content is
untrusted and is normalized through the same image validation/derivative path.

Manual generation is always **preview → Use / Reject**:
1. Generate creates a pending AI illustration.
2. The pending preview is shown with an AI/not-a-photo label.
3. **Use** makes it the selected display image.
4. **Reject** deletes the pending file.
5. Regenerate creates a new pending image and removes older pending previews.

Automatic generation for newly saved items is a separate, default-off household
setting. It runs only after save, only when no actual photo exists and the item
has a sufficiently useful description. It is not triggered on keystrokes or on
existing-library items. The explicit batch action is the only way to process old
items.

### Spending and generation limits

- A hard per-household **daily AI generation count cap** is stored (1–100,
  default 10) and enforced before each generation. Counts include pending and
  accepted AI images for the current day.
- The app never retries paid image generation automatically; new-item and batch
  jobs use one attempt.
- A provider-specific monetary estimate is not claimed because pricing and
  billing eligibility depend on the account/provider. The settings UI explains
  the hard count cap and says billing cannot be estimated reliably.
- Batch/reference lookup is bounded to the explicit selection (maximum 50 items)
  and does not crawl the library.

## Household settings and permissions

Defaults for every household (including existing ones) are:
- automatic reference lookup: **off**
- automatic AI fallback: **off**
- daily generation cap: **10**

Owners can change these in Settings. Manual Find image/Generate remain available
according to provider configuration. Viewers can read image sources and labels
but cannot find, generate, accept, reject, remove or batch. Members can use image
actions. All routes require the current household context and reject
cross-household item/image IDs. Item images are stored under household/item paths
and private file routes require a current membership.

## Batch jobs

The batch dialog is an explicit action over selected items, with:
- preview counts (selected, eligible, already has a real photo, unavailable);
- estimated generation count and remaining hard cap;
- notices for missing search/generation configuration;
- durable worker job, progress counts, failure/skip counts and cancel;
- request-ID replay deduplication;
- no surprise full-library scan and no automatic retry storm.

Cancellation stops the worker before the next item. Progress is stored on the
durable job; queued/running jobs are household-scoped. Expired pending previews
and old superseded/rejected image files are pruned by maintenance.

## Evidence, recognition and stocktake exclusion

`item_images` is a separate table from `item_photos`. The following only use
actual photos:

- inventory evidence preview/PDF/CSV/ZIP (`photo_count`, photo bundle and PDF
  images);
- photo recognition and scan source pages;
- stocktake snapshots and condition/physical observations.

A reference or AI illustration therefore cannot appear as proof in an insurance
export, be interpreted as the physical unit, or mark an item as visually verified.
Last-checked/stocktake state is not changed by image actions. Item quantity, loan
state, purchase data and room/container placement are unchanged.

## Data model and migration

`item_images` stores:
- household/item/creator/provider ownership;
- source type (`reference`, `ai`, `builtin`) and status
  (`pending`, `active`, `superseded`, `rejected`);
- private storage keys, dimensions, MIME type and size;
- illustration key for built-ins;
- source URL/page/publisher, license note, retrieval time;
- exact-model confirmation, model label, search fingerprint and generation
  prompt/error.

A partial unique index ensures only one active non-photo image per item. The
append-only migration also adds the three household image settings and a durable
job result JSON field. It does not create image rows for existing items, change
item/photo IDs, or alter existing provider/task choices.

## API summary

- `GET /items/{id}/image` — current source, pending previews, settings and
  provider availability.
- `POST /items/{id}/image/find` — automatic reference lookup/selection.
- `POST /items/{id}/image/builtin` — explicit built-in choice.
- `POST /items/{id}/illustration` — generate pending AI preview.
- `POST /items/{id}/images/{image_id}/accept` — accept pending AI.
- `DELETE /items/{id}/images/{image_id}` — reject/delete pending or selected.
- `DELETE /items/{id}/image` — remove the selected non-actual source.
- `POST /items/{id}/image/reset` — reset to fallback.
- `POST /items/images/batch/preview` / `POST /items/images/batch` /
  `GET /items/images/batch/{job_id}` / `.../cancel` — explicit batch workflow.
- `GET /item-images/{id}/file|thumbnail` — authenticated private derivative.

## Verification and limits

Backend tests cover built-in selection, override/remove, actual-photo priority,
Brave image response parsing/ranking, brand/type conflict rejection, stock-host
rejection, exact vs representative labels, source/license provenance, lookup
reuse, evidence exclusion, AI preview/accept/reject, hard caps, batch
preview/dedupe/cancel, permission/IDOR and the OpenAI Images adapter contract.
They use fixture responses and never make live search/generation calls.

Vitest covers built-in/reference/actual card priority, source controls and
preview acceptance. Disposable Playwright covers built-in fallback, a mocked
automatic reference flow with source labels, actual-photo priority, manual AI
preview/accept, unconfigured states, household setting toggles and batch
cancellation. Screenshots are in
[`docs/walkthrough/item-images/`](walkthrough/item-images/).

Final local verification: **326 PostgreSQL backend tests**, **143 Vitest tests**
and **44 disposable-stack Playwright workflows** pass; Ruff, strict TypeScript
typecheck, production build and Alembic drift checks pass. Backup
`backups/housetory-20261106T031456Z` includes the database, uploads, imports and
exports volume; migration `a8c0e2f4b6d8` preserved the existing 51 items, 1 loan,
1 household/property, IDs, files and existing AI task choices. The real household
has no item-image rows and both automation settings remain off by default.

Remaining live validation (not performed here): a real Brave Image Search
subscription/key and a real OpenAI Images key/model with consent and billing.
Tests verify the documented request/response contract and safety/error paths but
cannot certify external provider image quality, availability, pricing or source
licensing for every result.
