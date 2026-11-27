# Assisted add items

**Add** in the bottom bar opens one smart input, **Add items**: a dialog on large screens and a bottom
sheet below the `lg` breakpoint. There is no separate chooser or `/add-items`
page; `/add-items?room_id=…` deep links open the same overlay on the item list
(`/` redirects to `/items`) with that context.

## One input

A single textbox accepts natural language or one product link. Take photo /
Choose photo (also paste or drag-and-drop, one image) attach a photo shown as a
removable thumbnail. A live chip shows what will be sent: **Text**, **Link**
(the whole box is one `http(s)://` URL), **Photo** or **Photo + note**. A photo
together with a link is blocked with a warning. **Review items** (or
Cmd/Ctrl+Enter) submits; Enter inserts a newline.

A PDF, or a photo marked as **Document**, is not interpreted as items. The
button is then **Save document**: the original is saved to the library at once
and the document page opens. The document type is optional (it is “Other
document” unless Invoice, Receipt, Manual or Warranty is chosen). The message
that follows has **Undo**, which removes the document that was just saved.

The microphone is its own flow and is only available when the box and photo are
empty and voice transcription is configured. Stop uploads the recording,
waits for transcription and creates a text import from the transcript, opening
its review directly; transcription never triggers the old voice interpretation
endpoint or writes inventory.

A context chip (`Room · Place` or `No place yet`) shows and edits the default
property/room/place sent with every submission. **or fill in the form yourself**
opens `/items/new` with the same context. The purchase date is set during review.

Submission paths all end at the same import review. It opens in the assistant
panel; `/imports/{batchId}` shows the same review as a page:

| Input | Existing processing reused |
| --- | --- |
| Text | `POST /imports` and normal text interpretation |
| Image + optional context | `POST /ai/recognitions`, then `POST /imports/from-recognition/{id}` |
| Microphone | `POST /voice` for transcription only, poll `GET /voice/{id}`, then `POST /imports` with the transcript |
| One product URL | `POST /imports` with `product_url`, worker-side safe page retrieval |

The user confirms entries in the same review before anything is created. Each
entry is one closed row that shows what will be saved; uncertain values are
marked “check”, including a room or place that could not be settled. **Edit**
opens the row with the place controls, and the row opens by itself when adding
it fails because of the place. No row is selected at the start. **Add item** adds one row, and
the checkboxes with **Add N selected items** add several. **Skip** moves a row
to the **Skipped** list at the end; **Undo** in the message or **Restore** there
brings it back with its edits
(`POST /imports/{batchId}/entries/{entryId}/restore`). Reject is inside the
opened row and can also be restored. A possible duplicate is not taken by
**Select all**; the user decides it. Duplicate checks, inline room/place creation,
purchase editing and the existing atomic apply/idempotency rules are unchanged.

Inside the app shell, tapping a name, a quantity or another value on a closed
row opens it in the bottom bar: Enter or ✓ saves, Escape or ✕ cancels. The
same checks apply as in the row editor. A skipped row keeps its whole edited
draft on the server, so Restore after a reload brings back every edit,
including the chosen action and its target. A selected row has a background
and a border as well as its checked box.

A correction on a row that still waits is kept too, without Skip or Add and
without a button. The app sends the whole draft of the row a short moment
(about 0.6 seconds) after its last change, and at once when the page is hidden,
left or closed (`PUT /imports/{batchId}/entries/{entryId}/draft`). The row
stays as it is: it still waits, nothing is added and no count changes. A
reload shows the row as it was corrected, with its action and target. This
is the same for item rows and for room, place and container rows. If a save
fails, the page keeps what was typed, shows one quiet line and tries again.
Add and Skip always send the row as it is on the page, so they never wait
for a save. Within one visit the page keeps showing what was typed there; after
a reload the server's draft is shown. A row that was added, skipped or rejected
answers 409 and keeps nothing. A request with no row field puts the row back as
it was read.

A browser can lose a request that is sent while a page closes or reloads.
Safari does this more often than others. So each correction is first written
to this device (`localStorage`), at once, before it is sent. The key is
`housetory:review-draft:v2:<user>:<household>:<kind>:<review id>:<row>` and the
value is `{ path, body, at, baseRevision }`. The copy is removed when the
server has confirmed that same correction, when the row was added or skipped,
when the server says the row is gone or decided, on sign-out, and after
fourteen days (for every account on the device). Copies in the older `v1` form
are removed.

**Two devices.** The same row can be corrected on a phone and on a laptop. An
older correction must never go over a newer one from another device without a
question. The server makes sure of that, for all four kinds of kept draft
(import row, document line, document fields, review suggestion):

- The kept draft of a row has a **revision**, a number that goes up by one
  each time the stored draft changes. A row without a draft is at 0. The server
  also keeps the **writer**: who stored it. A writer is one person on one
  browser: a random id that the browser makes once (`housetory:device-id`,
  which stays after sign-out so that a lost answer is still recognised),
  joined with the id of the person who is signed in. So a draft that another
  person kept on the same browser is never taken for one's own. The server
  only compares writers; it reads nothing from them. The review gets both
  with each row (`draft_revision`, `draft_writer`).
- Every save must say which revision the correction was made on
  (`expected_revision`) and who sends it (`writer`). A request without them
  answers 422 and stores nothing. The server decides while it holds the lock
  of the row:
  1. The draft says what is stored already: nothing changes, and the answer
     is 200 with the revision as it is. A request that is sent twice ends here.
  2. It was made on the stored revision: it is stored, and the revision goes
     up by one.
  3. The stored draft is from the same writer: that person saved it from this
     browser and never got the answer. Their newer draft is stored, and the
     revision goes up.
  4. Anything else: another device changed the row in the meantime. The answer
     is **409 `draft_conflict`**, with the server's row and its revision.
     Nothing is stored.
- Taking a draft back follows the same rule. The revision is kept afterwards.
  Skip, and loading AI suggestions into the review, also move the revision on,
  because they change what the server keeps for the row.
- The revision and the writer are kept beside the draft. They are not part of
  what AI suggestions are made for, so they never make suggestions out of
  date, and they are never copied to an item.

**After a reload.** A copy on this device says which revision it was made on.

- No conflict: the server still has that revision, or a newer one that this
  same browser wrote. The copy is shown in its row and saved by itself, as
  before, and then removed. The row still waits: nothing is added.
- Conflict: another device changed the row since. The row shows **what the
  server has**. The copy is kept and marked, and it is never sent again by
  itself. One plain notice sits beside the row: *This row was also corrected
  on another device. Yours: «Step ladder», quantity 2.* with two buttons.
  **Use mine** puts the correction into the row and saves it on the revision
  the server has now. If the server changed again in the meantime, the notice
  stays, with the newer row. **Keep the other** removes the copy.
- The same happens while both devices have the review open: a save that meets
  a newer revision is answered with a conflict, the row is read again and
  shows the other device's value, and the notice appears.
- Neither button adds, skips or applies anything. Add and Skip send the row as
  it is shown, so a correction that waits for a choice is never part of them.
  When the row is decided, its copy is removed.
- While a choice waits, the row can still be corrected. That correction is
  saved, but it is not written over the copy that waits.

A copy is also sent again when the app starts and when the connection returns,
whichever page is open and however old the copy is. It is sent with its
revision, so the server decides in the same way. A conflict found like this is
shown when its review is opened. A copy is read again just before it is sent,
so an older request that still waits cannot go over a newer correction that
was saved since. A copy is never sent while another household is selected, and
it stays when the server says so. While a save fails the page keeps the
correction, shows one quiet line and tries again. If the session ended, the
copy stays for the same person. A copy the server can never keep is removed,
and the app says so once.

A review page can also hold rows in memory while the person is on another
page of the app. When the review is opened again, a row of that visit is shown
as the server has it if someone else changed what the server keeps for it
since (a draft of another writer, a skip that was restored, or loaded
suggestions) and nothing of the row waits to be saved here. When this page
itself skips a row or loads suggestions, the row goes exactly one revision on
and the page goes on from there. If the server is further on than that,
another device was in between, and the next save is asked about.

Limits. The copy is on this device only: another browser does not have it, and
clearing site data removes it. Two tabs of one browser, with the same person
signed in, are the same writer, so between them the newer save still wins
without a question. Add, Skip and Apply are not checked by revision: they act
on the row as it is shown.

The server keeps the first reading of a corrected row beside the correction.
Optional AI suggestions are made for that first reading, so a kept correction
does not make them out of date: they stay ready, a job that is still running is
still offered, and Retry still works. **Load suggestions into review** keeps the
fields the person changed and the choices of the row, and takes the suggestion
for the rest. Skip is a decision and ends ready suggestions, as before.

A photo review numbers its findings. The vision request also asks for a box
around each finding. A box that passes the server's checks
(`services/recognition_geometry.py`) is returned as `source_region`
(`x`, `y`, `width`, `height`, fractions of the shown photo) and drawn as a
numbered pin linked to its row. A finding with no usable box has
`source_region: null` and no pin, and the page says so. The server never
makes a position up.

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
