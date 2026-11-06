# Item images, references and illustrations

Item images are display aids, not physical evidence. They never replace user
photographs, change inventory facts, or count as a stocktake/evidence observation.

## Source taxonomy and display priority

| Priority | Source | Meaning |
| --- | --- | --- |
| 1 | **Actual photo** (`item_photos`) | A user upload of the real unit. May show condition, colour and wear. |
| 2 | **Reference image** (`item_images`, `reference`) | A downloaded product image with recorded source/provenance. Not proof of the exact unit or condition. |
| 3 | **AI illustration** (`item_images`, `ai`) | An accepted generated illustration from product text. Not a photo and never an exact-model claim. |
| 4 | **Category icon** | A simple Lucide icon based on the item's category when no actual photo or selected reference/AI image exists. |

The detail page always uses the actual photo gallery first. Non-photographic
imagery is shown only when no actual photo exists, with an explicit
`Reference image` or `AI illustration` label. The item card/list thumbnail
follows the same priority.

Users can **Change image**, **Remove** a stored reference/AI image, or
**Use icon** to clear a selected non-photo image and return to the simple
category-icon fallback. Actual photos and accepted media are never overwritten
or deleted by these actions.

## No-photo state and category icons

There is no built-in illustration library, shape chooser or automatic line-art
matching. When an item has no actual photo and no selected reference/AI image,
the app renders a small category icon (tool, TV, cable, luggage, furniture,
camera, laptop, kitchen, book, bike or a generic package). The icon is derived
from the existing category name and is a compact fallback, not artwork or a
substitute photograph. It is not included in evidence, recognition or stocktake
physical evidence.

Legacy `item_images` rows with `source_type='builtin'` are retained but ignored
by display code; an append-only migration marks pending/active legacy rows as
`superseded`. No item, photo, reference, AI image or stored file is deleted by
this retirement. The old built-in endpoint and chooser are removed, so new
built-in rows cannot be created.

## Reference-image search

The supported integration is the documented **Brave Image Search API**
(`GET /res/v1/images/search`, `X-Subscription-Token`). It reuses the same
household Brave Search API key configured under **Settings → Online search** for
manual discovery, plus the installation country/language, base-URL and timeout
settings. No custom gateway is required for images. Manual document search
remains a separate feature with its own enable control.

The owner can enable **Reference-image search** independently of manual search
and must provide at least one permitted source domain in the same Settings card.
Changes apply on the next API or worker request without a restart. If no
household online-search row exists, `ITEM_IMAGE_SEARCH_PROVIDER` (`auto`,
`brave` or `none`) and `BRAVE_SEARCH_API_KEY` act as an operator-only
installation fallback. Saving the household row, explicitly disabling the
channel or removing the key suppresses that fallback. Parsing uses the documented
Brave Image Search response fields (`results[].title`, `url`, `source`,
`thumbnail.src`, `properties.url/width/height`). The current response has no
documented license field, so Housetory does not invent one; provider license
evidence is only used when an adapter actually supplies it.

### Automatic selection, not candidate approval

An explicit **Find image** action, or the household's opt-in
**automatically find a reference image for new items** setting, searches, ranks
and selects a suitable image automatically. The user does not approve a
candidate list in the normal flow.

Selection is deterministic and conservative:

- only results with a recorded public page/image URL are considered;
- well-known stock/watermark domains are rejected;
- brand and type can come from structured item fields or, when the structured
  brand is blank, from a bounded local lexicon plus the item name/description;
  this inference is query-only and is never written back to the item;
- screen size, display family (OLED vs LCD/LED/QLED), explicit variants and
  structured model identifiers are compared as product evidence;
- mutually contradictory known attributes are rejected; unknown candidate
  attributes are allowed only as an explicitly representative image;
- manufacturer provenance is verified against a registrable official-domain
  registry, not by finding brand letters anywhere in a hostname;
- exact-model confirmation requires whole model tokens and the same known
  variant set. `A1` never matches `A10` or `A1X`; a guessed model is never
  stored or labelled as exact;
- otherwise a representative image may be accepted but is labelled
  **“exact model not confirmed”**.

The user specifically approved relaxing the full-model gate for images. A name
such as “LG TV” plus a description such as “OLED77inch” is enough to build a
query-only profile and select a compatible representative image even when the
structured brand field is blank. **Manual and model-specific instructions still
require the complete confirmed manufacturer/model gate**; that relaxation
applies only to images.

### Manufacturer provenance

An official manufacturer is recognised only when the page host is the brand's
verified registrable domain (for example `lg.com` or `media.lg.com` for `lg`).
Brand text in an arbitrary hostname is not manufacturer provenance. Deceptive
hosts such as `lg.com.evil.example` or `lg-deals.example` are rejected. A
retailer candidate can still rank, but is marked non-manufacturer and must pass
the source-permission policy. Administrators can add or override
`brand=domain|domain` entries with `ITEM_IMAGE_MANUFACTURER_DOMAINS`.

### Source permission policy

A search hit is not permission to download or reuse an image. Automatic local
saves are **default deny**:

| Setting | Default | Meaning |
| --- | --- | --- |
| **Settings → Online search → permitted source domains** | empty | Structured registrable source domains whose terms the household owner has reviewed and permits for automatic reference downloads. Subdomains are included; schemes, paths, ports, wildcards and IP addresses are rejected. Empty keeps automatic downloads disabled and the category icon fallback available. |
| `ITEM_IMAGE_PERMITTED_SOURCE_DOMAINS` | empty | Operator-only installation fallback when no household online-search row exists. Comma-separated registrable domains; empty disables automatic downloads. |
| `ITEM_IMAGE_PERMITTED_LICENSES` | `cc0,cc-by,cc-by-sa,public-domain` | Provider-supplied license identifiers accepted as explicit evidence. The current documented Brave Image Search response does not include license metadata, so a domain policy is normally required. |
| `ITEM_IMAGE_MANUFACTURER_DOMAINS` | empty | Optional operator `brand=domain|domain` additions or overrides for provenance checks. |
| `ITEM_IMAGE_KNOWN_BRANDS` | empty | Optional operator extra brand names for conservative query-only inference. |

Before a candidate can be downloaded, its source page and asset host must match a
permitted domain, or it must carry explicit provider license metadata with an
allowed license identifier and evidence URL. If a compatible image has unknown
reuse rights, the app returns a `no_permitted_image_candidate` state and shows
the category icon fallback; it does not invent a license note or silently
download. The stored note records the policy basis or provider license plus the
evidence URL and says explicitly that this is not a legal determination or
permission guarantee. Housetory does not provide legal advice, does not claim
vendor terms are satisfied, and does not bypass hotlink restrictions, watermarks
or paywalls.

If no suitable candidate is found, the category icon fallback remains.
The result is downloaded through the same public-DNS/private-address/redirect/
byte/time limits as manual retrieval, then decoded and re-encoded into a private
derivative. Original EXIF/metadata is not copied into the derivative. Source URLs
are kept only as provenance. Redirected asset URLs are rechecked against the
same permitted-domain policy as the original asset; a thumbnail from an
unpermitted host is never downloaded as a fallback.

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

AI generation is optional and disabled by default. It supports two authenticated
image-generation adapters; neither is a chat-completions substitute:

- **OpenAI Images API:** `POST /images/generations`, accepting inline `b64_json`.
- **OpenRouter Image API:** `POST /api/v1/images`, accepting the documented
  `data[].b64_json` response and optional `media_type`.

URL-only responses are rejected rather than fetched. OpenRouter SVG/GIF or
unknown media types are rejected explicitly; accepted raster data is decoded,
size-bounded and normalized through the same private derivative path as other
item images. The encrypted provider key, provider enablement and cloud/private
consent rules are the same as other AI tasks. Anthropic, xAI, direct Gemini and
Ollama are not offered as item-image generators and are rejected at task save.

OpenRouter image models are discovered from the documented Models API with
`output_modalities=image`; the picker exposes only models advertising image
output, and manual IDs are validated when saved. See
[`docs/AI_PROVIDERS.md`](AI_PROVIDERS.md).

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
- source type (`reference`, `ai`; legacy `builtin` rows are retained but
  superseded/ignored) and status (`pending`, `active`, `superseded`, `rejected`);
- private storage keys, dimensions, MIME type and size;
- legacy illustration key (not written or rendered);
- source URL/page/publisher, retrieval time;
- permission basis (`configured_source_policy` or `provider_license`), provider
  license name/URL when supplied, and an honest policy/license note;
- exact-model confirmation, model label, search fingerprint and generation
  prompt/error.

A partial unique index ensures only one active non-photo image per item. The
append-only migrations add the three household image settings, a durable job
result JSON field, permission/license provenance columns, and retire legacy
built-in rows by status. They do not create image rows for existing items,
delete media, change item/photo IDs, or alter existing provider/task choices.

## API summary

- `GET /items/{id}/image` — current source, pending previews, settings and
  provider availability.
- `POST /items/{id}/image/find` — automatic reference lookup/selection.
- `POST /items/{id}/illustration` — generate pending AI preview.
- `POST /items/{id}/images/{image_id}/accept` — accept pending AI.
- `DELETE /items/{id}/images/{image_id}` — reject/delete pending or selected.
- `DELETE /items/{id}/image` — remove the selected non-actual source.
- `POST /items/{id}/image/reset` — reset to fallback.
- `POST /items/images/batch/preview` / `POST /items/images/batch` /
  `GET /items/images/batch/{job_id}` / `.../cancel` — explicit batch workflow.
- `GET /item-images/{id}/file|thumbnail` — authenticated private derivative.

## Verification and limits

Backend tests cover category-icon fallback, legacy built-in-row ignoring without
deletion, actual-photo priority,
Brave image response parsing/ranking, name-only brand and description-attribute
inference without persisted item facts, screen-size/technology/variant conflict
rejection, vague/brandless fallback, unknown-attribute representative labels,
exact-model token boundaries (`A1` vs `A10`/`A1X`), manufacturer registrable-domain
provenance, deceptive brand hosts, stock-host rejection, configured permitted
source policy vs unknown rights, provider license evidence, lookup reuse,
evidence exclusion, AI preview/accept/reject, hard caps, batch
preview/dedupe/cancel, permission/IDOR, the OpenAI Images adapter contract and
the OpenRouter Image API contract including URL-only/SVG/invalid-data rejection.
They use fixture responses and never make live search/generation calls.

Vitest covers category-icon/reference/actual card priority, source controls and
preview acceptance. Disposable Playwright covers category-icon fallback, a mocked
automatic reference flow with source labels, actual-photo priority, manual AI
preview/accept, unconfigured states, household setting toggles and batch
cancellation. Screenshots are in
[`docs/walkthrough/item-images/`](walkthrough/item-images/).

Final local verification: **338 PostgreSQL backend tests**, **146 Vitest tests**
and **46 disposable-stack Playwright workflows** pass; Ruff, strict TypeScript
typecheck, production build and Alembic drift checks pass. Backup
`backups/housetory-20261106T081932Z` includes the database, uploads, imports and
exports volume; migrations `a8c0e2f4b6d8`, `b2d4f6a8c0e1` and `d6f8b0c2e4a6` preserved the
existing 51 items, 1 loan, 1 household/property, IDs, files and existing AI task
choices. The real household has no item-image rows and both automation settings
remain off by default. No permitted source domain is configured, so automatic
downloads remain disabled until the operator reviews and sets a policy.

Remaining live validation (not performed here): a real Brave Image Search
subscription/key, a real OpenAI Images key/model, and a real OpenRouter
image-output key/model with consent, credit and billing.
Tests verify the documented request/response contract and safety/error paths but
cannot certify external provider image quality, availability, pricing or source
licensing for every result.
