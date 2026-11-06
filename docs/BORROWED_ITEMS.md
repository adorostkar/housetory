# Borrowed-from-others tracking

Borrowed possessions are recorded in separate `borrowed_records` tables. They are
never inserted into `items`, `loans` or owned stock counts. A borrowed record is a
private household log of something temporarily held from an external owner, not a
claim of ownership.

## Record semantics

A borrowed record stores:

- item name, optional brand/model and one private actual photo;
- owner **display name only** (no owner account, email or reminder);
- borrowed quantity, borrowed date and optional due date;
- keeping property/room/container, with names and identifier snapshots so the
  record remains readable if a place is later removed;
- optional private notes and creator/time metadata.

Quantities are deliberately separate:

| Field | Meaning |
| --- | --- |
| `total_borrowed_quantity` | Units recorded as borrowed from owners, excluding cancelled records |
| `returned_quantity` | Units already given back to their owners |
| `outstanding_quantity` | Units still held and not returned |
| `physically_held_quantity` | Same as outstanding for active records; the physical borrowed stock |
| `quantity` | Original borrowed quantity for one record (corrections update it with history) |

These never appear in owned item counts, total quantity, purchase/current value,
insurance totals, evidence packages or owned stocktake quantities.

## Returns, corrections, cancellation and history

- Partial returns are append-only `borrowed_returns` rows. Each return records
  quantity, date, notes and actor. No endpoint silently deletes a return.
- A return cannot exceed outstanding quantity or precede the borrowed date.
- Corrections update the borrowed record but append a history event with the
  before/after facts. A correction cannot reduce quantity below what was already
  returned, move the borrowed date after an existing return, or set a due date
  before the borrowed date.
- Cancellation is allowed only before any return. It preserves the record and
  history, removes it from outstanding totals and cannot be used to erase returns.
- Every create/return/correction/cancel request carries a client request id.
  The server stores a payload fingerprint. A replay with the same payload returns
  the existing result; a reused request id with different details returns `409`.
- Returns/corrections/cancellation lock the borrowed row with
  `SELECT … FOR UPDATE`. Concurrent returns cannot over-return or drive counts
  negative.

## Keeping location

Household-owned room/container/property ids are validated against the current
household on every create/correct/filter request. Cross-household ids are rejected
with `404`, and mismatches between property, room and container are rejected with
`422`. Borrowed goods do not change owned item counts on room/container pages. A
separate "Borrowed items kept here" section labels them explicitly where shown.

## Photos

One optional actual photo is stored under the private uploads directory and shown
only through authenticated, household-scoped endpoints:

- `GET /api/v1/borrowed/{id}/photo/file`
- `GET /api/v1/borrowed/{id}/photo/thumbnail`
- `POST /api/v1/borrowed/{id}/photo`
- `DELETE /api/v1/borrowed/{id}/photo`

Files are normalized with the existing bounded JPEG/PNG/WebP/HEIF pipeline, use
private `0600` files and `0700` directories, and return `Cache-Control:
private, no-store`. The photo is not copied into item photos, ownership evidence,
search results or evidence exports. Replacing/removing a photo deletes the old
private files and records a history event.

## Search and deterministic assistant

Borrowed records are included in authorized all-places search as a distinct
`borrowed` kind with their own label and link. Search never presents them as owned
items. Result text includes owner, keeping place, due date and outstanding quantity,
for example: "Borrowed tile cutter — belongs to Ali, kept at Home / Workshop / BOX-002,
due Nov 20, 2026 · 2 outstanding".

Deterministic (no-AI) questions supported include:

- "What do I need to return?"
- "What have I borrowed?"
- "Who owns X?"
- "Where is X?" when X is only a borrowed record (and alongside owned matches when
  the same name exists in both domains).

Owned questions such as "What is on loan?" remain about household-owned loans.
Borrowed answers never invent an owner, date or location.

## Reports and stocktake

- Evidence exports remain owned-inventory packages. Borrowed records, owner names
  and private borrowed photos are excluded; the evidence dialog states this.
- Stocktake snapshots and expected quantities include only owned `items`. The
  stocktake entry states that borrowed records are out of scope and they are never
  auto-created as unexpected owned stock.
- Container/room owned counts, values and searches keep their existing semantics;
  borrowed quantities are reported only through the explicit borrowed totals.

## Roles and security

- Owner/member can create, correct, return, cancel and manage photos.
- Viewers can read borrowed lists/details/photos but all mutations return `403`.
- Every record, return, history event, photo and file lookup is household-scoped.
  Cross-household ids return `404` without leaking existence.
- Existing multi-household `X-Household-Id` stale-context checks apply to all
  borrowed mutations.
- Logs contain action summaries and identifiers, not private notes, owner emails or
  photo contents.

## API surface

- `GET/POST /api/v1/borrowed`
- `GET/PATCH /api/v1/borrowed/{id}`
- `POST /api/v1/borrowed/{id}/returns`
- `POST /api/v1/borrowed/{id}/cancel`
- `GET /api/v1/borrowed/{id}/history`
- photo endpoints listed above

## Explicit non-goals

No owner accounts, invitations, emails, reminders, contact details, service/budget
records or owned-inventory conversion. Maintenance/service history is a later
milestone. The borrower/owner name is a display string supplied by the household,
not an identity claim.
