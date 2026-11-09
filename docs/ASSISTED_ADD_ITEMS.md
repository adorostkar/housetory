# Assisted add items

**Add items** opens one smart input: a dialog on large screens and a bottom
sheet below the `lg` breakpoint. There is no separate chooser or `/add-items`
page; `/add-items?room_id=…` deep links open the same overlay on `/` with that
context.

## One input

A single textbox accepts natural language or one product link. Take photo /
Choose photo (also paste or drag-and-drop, one image) attach a photo shown as a
removable thumbnail. A live chip shows what will be sent: **Text**, **Link**
(the whole box is one `http(s)://` URL), **Photo** or **Photo + note**. A photo
together with a link is blocked with a warning. **Review items** (or
Cmd/Ctrl+Enter) submits; Enter inserts a newline.

The microphone is its own flow and is only available when the box and photo are
empty and voice transcription is configured. Stop uploads the recording,
waits for transcription and creates a text import from the transcript, opening
its review directly; transcription never triggers the old voice interpretation
endpoint or writes inventory.

A context chip (`Room · Place` or `No place yet`) shows and edits the default
property/room/place sent with every submission. **or fill in the form yourself**
opens `/items/new` with the same context. The purchase date is set during review.

Submission paths all end at the ordinary `/imports/{batchId}` review:

| Input | Existing processing reused |
| --- | --- |
| Text | `POST /imports` and normal text interpretation |
| Image + optional context | `POST /ai/recognitions`, then `POST /imports/from-recognition/{id}` |
| Microphone | `POST /voice` for transcription only, poll `GET /voice/{id}`, then `POST /imports` with the transcript |
| One product URL | `POST /imports` with `product_url`, worker-side safe page retrieval |

The user confirms entries in the same review before anything is created. Missing
locations open the **Where is it?** controls immediately. Recognition suggestions
flagged for review start unselected. Duplicate checks, inline room/place creation,
purchase editing and the existing atomic apply/idempotency rules are unchanged.

## Recognition adaptation

Optional context text is bounded and passed to vision only inside an
`<untrusted_context>` block. It clarifies visible objects; it cannot add unrelated
off-image inventory. Private `_add_items` metadata is preserved in the existing
recognition JSON result across processing and retry.

A succeeded recognition becomes ordinary `ImportBatch` / `ImportEntry` rows with
confidence, duplicates, source context, review flags and location defaults.
Repeating the adapter returns the same batch. Once adapted, the old recognition
apply/retry routes return a conflict so the same suggestions cannot be created
through two workflows.

No migration is required: recognition metadata and the import-batch link use
existing JSONB fields.

## Product URLs

An explicit single HTTP(S) product URL is validated without credentials and
fetched only in the worker. Retrieval reuses the manual retrieval implementation's
DNS pinning, public-IP checks, redirect validation, byte limits and wall-clock
timeouts. The small HTML parser reads only title, Open Graph title/site and meta
description. It does not execute JavaScript, follow recommended products or trust
AI-generated links.

Current page prices are never treated as historical purchase facts. The user's
explicit purchase date remains marked explicit and is restored if interpretation
omits it. Failed pages retain their URL/date for retry. URLs embedded in broader
notes remain ordinary text and do not trigger unexpected outbound requests.

## Limits

- One image per assisted draft in this first version.
- Product URL and image are not fetched as one combined product request.
- Bot-protected, authenticated or JavaScript-only product pages may fail honestly.
- The legacy `/scan` and `/imports` routes remain available for deep links,
  history and focused workflows. The standalone `/voice` page was removed; the
  voice API remains.

## Verification

- Backend tests cover untrusted recognition context, one idempotent import review,
  duplicate-application guards, product worker fetch, explicit purchase dates,
  failure preservation and URL validation.
- Frontend tests cover input detection, text, image+note, product URL, the
  photo+link conflict, voice disabled states and transcript import, the context
  chip and the manual-form link.
- Browser coverage opens the smart input with container context, submits a note
  into the shared import review, and records a (faked) voice note.
