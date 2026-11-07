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
follows the same priority. Both actual photos and representative reference/AI
images use the same bounded responsive frame (240 px phone, 320 px tablet,
340 px desktop) with `object-contain`; placeholders stay compact at 150 px.
Reference/AI images cannot stretch the frame through intrinsic height or flex.

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

The owner can enable **Reference-image search** independently of manual search.
No domain allowlist is required: the default is public-web lookup across suitable
public websites, with automatic single-image selection. An optional advanced
source restriction can narrow downloads to registrable domains if the owner
deliberately wants that. Changes apply on the next API or worker request without
a restart. If no
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

Selection is deterministic and conservative, and it does not stop at the first
ranked URL. It makes a bounded loop over up to six compatible public candidates.
A candidate that returns HTTP failure, private-address/redirect failure, HTML,
corrupt bytes, unsupported format or oversized content is skipped; the next
candidate is tried. A successful candidate is fully decoded, dimension-checked
and re-encoded into a private JPEG/PNG derivative before selection. AVIF is
accepted from public sources when Pillow's decoder is available because the
stored derivative is always re-encoded; unsupported formats such as GIF are
skipped. If every attempt fails, the error reports the bounded attempt count and
actual reasons rather than a user-upload format message.

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
- clean product-photo terms and URL/title signals are preferred; dimension
  drawings, specification/measurement sheets, installation diagrams, collages,
  text-heavy marketing images and box/packaging-only shots for product items
  receive a metadata-only penalty. Manufacturer authority still contributes to
  the score, but an official infographic does not automatically beat a cleaner
  usable product photo;
- items that are intentionally diagrams/documents are exempt from that
  infographic penalty;
- Brave's original/full-size `properties.url` is requested before its search
  thumbnail. If the original decodes below the quality floor, the thumbnail may
  be tried only when that image itself passes the same decoded check. Nothing is
  upscaled to pretend a small source is adequate;
- image dimensions and area are validated after a real decode, not from search
  metadata. The quality floor is a 256 px short side and 65,536 px area, with a
  bounded thin-product exception (at least 120 px short side, 600 px long side,
  120,000 px area and 2.5:1 aspect). Metadata resolution only affects ranking
  order; the decoder is authoritative;
- undersized, malformed or unsupported downloads are treated like other failed
  candidates and fall through within the existing six-attempt cap. Existing
  active/household-reused references are only reused when their stored
  dimensions pass the same floor. If no candidate passes, the lookup returns
  an explicit quality failure and does not report an existing undersized image
  as a successful update;
- otherwise a representative image may be accepted but is labelled
  **“exact model not confirmed”**.

The automatic flow is still a single selection, not a mandatory candidate chooser
or per-domain approval step. Exact make/model is not required for a representative
reference image; a name such as “LG TV” plus “OLED 77 inch” is sufficient. Manual
and model-specific manual discovery keep the full confirmed manufacturer/model
gate.

The user specifically approved relaxing the full-model gate for images. A name
such as “LG TV” plus a description such as “OLED77inch” is enough to build a
query-only profile and select a compatible representative image even when the
structured brand field is blank. A deliberately small alias mapping handles
“PS5” as Sony PlayStation 5 while retaining the item’s existing type word: a
“PS5 empty box” is matched as packaging, so a console-only candidate is rejected
rather than being presented as the actual box. **Manual and model-specific instructions still
require the complete confirmed manufacturer/model gate**; that relaxation
applies only to images.

### Manufacturer provenance

An official manufacturer is recognised only when the page host is the brand's
verified registrable domain (for example `lg.com` or `media.lg.com` for `lg`).
Brand text in an arbitrary hostname is not manufacturer provenance. Deceptive
hosts such as `lg.com.evil.example` or `lg-deals.example` are rejected. A
retailer candidate can still rank, but is marked non-manufacturer. It can still
be selected from the public web when the owner has not set an optional domain
restriction. Administrators can add or override `brand=domain|domain` entries with
`ITEM_IMAGE_MANUFACTURER_DOMAINS`.

### Source provenance and optional restriction

Public-web lookup is the default. It does **not** require a user-maintained
domain allowlist and does not ask for per-domain approval:

| Setting | Default | Meaning |
| --- | --- | --- |
| **Settings → Online search → optional source restriction (advanced)** | empty | Empty means public websites. A non-empty list is a deliberate optional restriction to registrable domains; subdomains are included. Schemes, paths, ports, wildcards and IP addresses are rejected. |
| `ITEM_IMAGE_PERMITTED_SOURCE_DOMAINS` | empty | Optional operator-only legacy restriction when no household online-search row exists. Empty means public-web lookup, not disabled. |
| `ITEM_IMAGE_PERMITTED_LICENSES` | `cc0,cc-by,cc-by-sa,public-domain` | Provider-supplied license identifiers accepted as explicit evidence when present. |
| `ITEM_IMAGE_MANUFACTURER_DOMAINS` | empty | Optional operator `brand=domain|domain` additions or overrides for provenance checks. |
| `ITEM_IMAGE_KNOWN_BRANDS` | empty | Optional operator extra brand names for conservative query-only inference. |

With no restriction, a compatible public result is downloaded with
`permission_basis = public_web`. The stored note records the public source page,
retrieval time and that no license metadata or reuse permission was established;
it explicitly says this is not a legal determination or permission guarantee and
that the image is a reference, not a user photo. If the optional restriction is
set, candidates and redirected asset hosts must stay inside it (or carry explicit
provider license evidence with an allowed identifier and evidence URL).

Unknown reuse permission is allowed for public-web references with an honest
note; it is not fabricated into a license. Housetory does not provide legal
advice, does not claim vendor terms are satisfied, and does not bypass hotlink
restrictions, watermarks, paywalls or access controls. If a result cannot be
downloaded or decoded, the category-icon fallback remains and the error states
the actual failure rather than asking for a domain setup that is no longer
required.

Online search Settings walkthrough:
[not configured](walkthrough/online-search/01-not-configured.png),
[saved write-only key](walkthrough/online-search/02-saved-write-only-key.png),
[test confirmation](walkthrough/online-search/03-test-confirmation.png),
[bounded test result](walkthrough/online-search/04-test-result.png), and
[public-web readiness reflected in system health](walkthrough/online-search/05-public-web-ready-summary.png).

If no suitable candidate is found, the category icon fallback remains.
The result is downloaded through public DNS resolution, private/link-local/
metadata-address rejection, pinned connections, bounded redirects, byte/time
limits and the same SSRF checks as manual retrieval. It is then decoded and
re-encoded into a private derivative; malformed or unsupported images are
rejected and original EXIF/metadata is not copied. Source URLs are kept only as
provenance. Redirected asset URLs are revalidated on every hop; if an optional
domain restriction is set, the asset host must remain inside it.

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
provenance, deceptive brand hosts, stock-host rejection, bounded candidate
fallback (HTTP/private/HTML/corrupt/oversized/unsupported then valid), real AVIF
re-encoding, PS5 empty-box packaging alias, public-web vs optional restriction
provenance, provider license evidence, lookup reuse,
evidence exclusion, AI preview/accept/reject, hard caps, batch
preview/dedupe/cancel, permission/IDOR, the OpenAI Images adapter contract and
the OpenRouter Image API contract including URL-only/SVG/invalid-data rejection.
They use fixture responses and never make live search/generation calls. Public-web
coverage verifies no-domain readiness, automatic single-image selection outside
any preexisting allowlist, `public_web` provenance/unknown-permission wording,
optional legacy restriction behavior, private/non-image/oversized/malformed
rejection, actual-photo priority and household/viewer boundaries. The decoded
resolution suite covers Brave-shaped original/thumbnail parsing, original-first
download, tiny-original-to-adequate-thumbnail fallback, deceptive 800×800
metadata over a real 90×90 payload, all-undersized rejection without storage,
and clean-product-photo preference over tiny banners and specification graphics.

Vitest covers category-icon/reference/actual card priority, source controls and
preview acceptance. Disposable Playwright covers category-icon fallback, a mocked
automatic reference flow with source labels, actual-photo priority, manual AI
preview/accept, unconfigured states, household setting toggles and batch
cancellation. Reference/AI gallery bounds are checked with real landscape,
portrait, square and AI fixture images at phone/tablet/desktop widths:
[landscape reference](walkthrough/photo-sizing/07-reference-landscape-desktop.png),
[portrait reference](walkthrough/photo-sizing/08-reference-portrait-desktop.png),
[square reference](walkthrough/photo-sizing/09-reference-square-desktop.png),
[800×800 product reference](walkthrough/photo-sizing/11-reference-product-800-desktop.png)
and [AI portrait mobile](walkthrough/photo-sizing/10-ai-portrait-mobile.png).
Item-image screenshots are in
[`docs/walkthrough/item-images/`](walkthrough/item-images/).

Final local verification: **423 PostgreSQL backend tests**, **214 Vitest tests**
and **77 disposable-stack Playwright workflows** (76 passed, 1 fixture-dependent
skip) pass; Ruff, strict TypeScript typecheck, production build and Alembic drift
checks pass. Backup
`backups/housetory-20261106T081932Z` includes the database, uploads, imports and
exports volume; migrations `a8c0e2f4b6d8`, `b2d4f6a8c0e1` and `d6f8b0c2e4a6` preserved the
existing 51 items, 1 loan, 1 household/property, IDs, files and existing AI task
choices. Tests use disposable households and do not modify real inventory,
uploads or credentials. No optional source-domain restriction is needed for
public-web reference lookup; the household still controls the explicit enable
toggle and Brave key.

Remaining live validation (not performed here): a real Brave Image Search
subscription/key, a real OpenAI Images key/model, and a real OpenRouter
image-output key/model with consent, credit and billing.
Tests verify the documented request/response contract and safety/error paths but
cannot certify external provider image quality, availability, pricing or source
licensing for every result.
