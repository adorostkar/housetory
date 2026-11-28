# On-demand inventory review

Review is one persistent destination at `/review` for inventory-management
suggestions. It is not limited to imports. Review can run on demand or on an
optional, owner-managed schedule that is off by default.

## Scopes

A review can cover:

- the current household;
- a property;
- a room;
- a storage place/container;
- up to 100 explicitly selected items, including a **Review** action in the
  existing Items/place bulk bar.

All scope IDs, item IDs and applied category/tag IDs are validated inside the current
household. Cross-household references are rejected.

## Offline rule-based suggestions

Rule checks require no AI and never modify inventory:

- **Category**: an uncategorised item gets a proposed existing category when
  exact-name sibling items all use that one category.
- **Naming consistency**: exact-name groups that differ only by capitalisation or
  spacing propose the most common display name. Brand, model and content are not
  rewritten.
- **Possible duplicate**: conservative advisory pairs with an exact matching
  serial number, or the same normalised name + brand + model. These are never
  merged by Review. The comparison dialog shows quantities, serials, placement,
  loans and categories; records must be edited individually.
- **Missing detail**: advisory finding for an existing purchase record that lacks
  a recorded date or price. Housetory does not invent purchase details.
- **Location wording**: advisory finding when an item description explicitly names
  exactly one other room in the same property. It never moves the item.

Related-items/kit grouping is not implemented in this phase.

## Persistent queue

Suggestions persist with:

- type, status, priority, source (rules/AI), title and explanation;
- scope, item/secondary item, proposed category, before/after values and evidence;
- fingerprint, timestamps and applied/reverted/dismissed history.

Statuses are `pending`, `accepted`, `dismissed`, `stale` and `reverted`. The same
unchanged fingerprint is not recreated, including after dismissal. A relevant
source change produces a new fingerprint so the suggestion can be re-evaluated.
Re-running an unchanged review does not flood the queue; existing pending
suggestions are reported and older pending versions for scanned items become
stale.

## Applying changes

Each suggestion is one closed row that shows what would change (old value →
new value). An actionable row has **Apply change** (or **Apply changes**) and
**Skip**. A checkbox only selects a row for **Apply N selected changes**.

Category, naming and combined AI organisation suggestions are actionable. The server:

- locks and rechecks the item against the exact analysis version;
- marks the suggestion stale instead of overwriting a changed item;
- validates category/tag ownership and display-name bounds;
- atomically creates any approved new category/tags, applies one proposed category and
  adds up to three proposed tags without removing existing tags;
- records an activity event for the applied change.

Accepted category/name/organisation changes can be undone while the item has not
changed since apply. Organisation undo compares the exact current category and tag IDs
with the applied snapshot, then restores the exact prior category and tag IDs. Original
taxonomy records must still exist; newly created taxonomy records may remain. Undo
records a separate history event. Stale or unsafe undos are refused honestly.

Dismissal records a history event. In the queue the button is **Skip**. A
skipped suggestion leaves the list and waits under **Skipped (n)** at the end.
**Undo** in the message, or **Restore** there, makes it pending again
(`POST /inventory-review/suggestions/{id}/undo` on a dismissed suggestion).
Restoring changes nothing else, and accepting it later still checks that the
item did not change. If the same suggestion is already pending again, nothing
is restored. Possible duplicates, missing details and
location wording are advisory and cannot be accepted as automatic mutations.

**Edit first** lets the person change the proposed name or category.
**Keep for later** closes the edit without deciding. The edit is then kept on
the server by itself, a short moment later and at once when the page is
hidden, left or closed (`PUT /inventory-review/suggestions/{id}/draft`). The
suggestion still waits: its status, its fingerprint, the memory of dismissals
and the history are not changed. A reload shows the row with **Your edit**,
and **Apply change** and the bulk action apply that edit. An empty draft
forgets the edit. A suggestion that no longer waits answers 409 and keeps
nothing. If a save fails, the page keeps the edit, shows one quiet line and
tries again. The edit is also written to this device first and removed when
the server has confirmed it, so a request that is lost while the page closes
does not lose the edit: after a reload the row shows it again and it is saved
by itself.

Two devices can edit the same suggestion. The kept edit has a revision and the
device that stored it (`draft_revision`, `draft_writer`; they are kept beside
the evidence and are not part of it). Every save says which revision it was
made on, and the server keeps it only when no other device changed the edit
since; otherwise it answers 409 `draft_conflict` and keeps nothing. Then the
row shows the edit the server has, and the edit of this device waits in one
plain notice under the row: *This suggestion was also edited on another
device. Yours: «Cordless drill 18V».* **Use mine** saves it on the revision
the server has now. **Keep the other** removes it. Nothing is applied or
skipped by either, and Apply and Skip only take what is shown. See
[Assisted add items](ASSISTED_ADD_ITEMS.md) for the full rule.
Bulk accept applies only compatible pending category/name/organisation suggestions and
reports applied/skipped/stale/unsupported outcomes. The `organisation` queue type and
`apply_organisation` action are additive; existing category/name rows and actions remain
supported.

## Optional AI-assisted review

- Offline review is always available.
- AI review is an explicit owner action and is off by default.
- It uses the existing household **Assistant** task/provider; no new provider or
  subscription is required.
- AI evaluates up to 40 items missing a category **or** tags. Items with both are
  skipped, as are items already covered by an offline category rule where sending them
  would duplicate that category suggestion.
- The confirmation dialog shows the reviewed scope and explains that one bounded
  request sends only item names, descriptions, brand/model, current category/tag names
  and existing household category/tag vocabularies, plus the scope context described
  under [Shared categories for related items](#shared-categories-for-related-items).
  It does not send photos, locations, receipts, loans, prices, private notes, borrower
  data or other households.
- Opening Review never calls AI. The provider may charge usage/cost.
- Model output is schema-validated, with at most one category and three practical
  use/activity tags per item. Existing taxonomy is selected by household-owned ID; a
  category or tag may instead carry one bounded new name. Output never changes inventory
  during analysis and cannot invent specifications.
- Each returned item index produces at most one combined `organisation` suggestion,
  which may be category-only or tags-only. Duplicate indexes are ignored. Invalid JSON,
  unknown existing IDs, over-bound names/counts or provider errors mark the run partial
  and keep offline suggestions without creating taxonomy.
- Runs persist `ai_item_count`, the number of items actually sent (zero for a skip or a
  pre-request failure). Latest review distinguishes completed, skipped and failed AI,
  its provider/model and sent-item count, alongside suggestion counts. No delay is
  simulated.
- Related-items, moves, merges, quantities and purchase values are never AI actions.

## Shared categories for related items

AI review proposes categories that people can browse by. Related items are grouped
around a shared purpose: a tent and camp pillows both fit *Camping & Hiking*. A
category that only repeats one item name is avoided.

- **Reuse first.** The model is asked to use an existing category when one fits. If
  none fits, it uses a category that was already proposed for the scope. Only then
  does it propose a new name.
- **Context across batches.** A review sends at most 40 items per request. So every
  request also gets a short picture of the rest of the selected scope:
  - up to 40 categories that items in the scope use, or that wait as proposals for
    the scope, each with a count and up to 3 example item names;
  - up to 80 names of other items in the scope that have no category yet.

  A category that was proposed in an earlier batch does not exist yet. A later batch
  reuses it by name, so a tent in the first batch and camp pillows in the second get
  the same category.
- **Only the selected scope.** The context is built from the reviewed scope: the
  household, property, room, container or the selected items. Items outside the scope,
  and proposals that wait for them, are never part of it.
- **Category lists.** A request lists at most 200 household categories. The ones the
  selected scope uses come first and the rest are filled in by name, so a category
  that the context points at is always one the answer may use. An existing category
  is known by its id, because two categories under different parents can have the
  same name. A category that does not exist yet is known by its name.
- **Scheduled review is unchanged.** The consent for scheduled AI covers the reviewed
  items and the household category and tag lists. A scheduled request sends no scope
  context: no proposed category names, no counts and no names of other items. Giving
  schedules this context would need a new consent from the owner.
- **Decisions during a request.** The context is background. A person can apply or
  skip another suggestion while a request is out; the answer for the batch is still
  used.
- **Shown together.** In the queue, waiting proposals that lead to the same category
  are listed together under the category name. A category under another one is shown
  with its parents (*Camping / Accessories*). A proposal with a kept **Edit first**
  choice goes with the category that was chosen. Each proposal keeps its own **Apply**
  and **Skip**. **Apply group (n)** applies the proposals shown in the group. A new
  category is created once, when the first of them is applied.
- **Nothing changes without approval.** Analysis never creates a category and never
  changes an item. A group is applied only when a person presses **Apply group**, and
  each applied change can be undone by itself.
- This change raised the AI coverage version. The next AI review looks again at items
  that still miss a category or tags, so older narrow proposals can be replaced.

## Scheduled review

Scheduling is optional and **off by default** for existing and new households.
The migration creates no enabled schedule and does not change on-demand review.

When no schedule has ever been configured, the setup panel sits behind an
**Advanced · Scheduled review** disclosure on the Review page. Existing configured
schedules remain visible, including disabled or consent-needed ones, so an active
or previously configured routine is never hidden. Only the household owner can
read or change the schedule:

- **Enable/disable** is explicit. Offline rules are the base of every scheduled
  run; optional AI is a separate choice.
- **Scope**: whole household, property, room or container/place. These scope IDs
  are validated against the current household when saving and again on every run.
- **Cadence**: weekly (weekday) or monthly (day 1–28), at a whole hour in a
  validated IANA timezone. Next due is computed in that timezone and follows
  daylight-saving changes.
- **Caps**: 1–500 items per run, 1–4 scheduled runs per local day, and at most one
  AI provider request per run. The existing server rule-scan cap of 500 and AI
  pass cap of 40 remain enforced. On-demand reviews do not count against the
  scheduled daily cap.
- **Fair coverage**: items changed or created since the last successful run are
  selected first; a persisted cursor rotates through older items on later runs so
  a bounded schedule does not permanently starve the rest of the scope.
- **No automatic mutation**: every scheduled run uses the same persistent
  suggestion queue, fingerprint dedupe, dismissed-unchanged suppression, stale
  handling and explicit apply/undo semantics as an on-demand review.

### Scheduled AI consent

Scheduled AI has its own opt-in. Provider-level cloud consent or a previous
on-demand AI review do **not** enable it. The consent text states that one
bounded request per run sends at most 40 items needing a category or tags from the
selected scope to the current Assistant provider. Only names, descriptions, brand/model,
current category/tag names and existing household category/tag vocabularies are
included; photos, locations, receipts, loans, prices, private notes, borrower data and
other households are excluded. It also states that the provider may charge usage or
cost; Housetory does not invent a cost estimate.

The consent is fingerprinted against the current Assistant route: provider,
endpoint/base URL, model, mode, source and cloud-consent state. If any of those
change, if the provider becomes unavailable, or if consent is withdrawn, the
scheduled run **skips AI** and continues with offline rules. The run is marked
partial and the Review/system status surfaces the reason. It never silently
switches to a different provider or model.

### Dispatch and safety

Due schedules are claimed with `FOR UPDATE SKIP LOCKED` and dispatched as
durable `inventory.review.scheduled` worker jobs. A per-schedule active-job check,
a row lock and a deterministic request id prevent duplicate or overlapping runs
across retries, multiple workers and restarts. A missed schedule dispatches at
most one catch-up run; the next due time is always recomputed from the current
time, so a restart cannot create a burst of historical runs.

Disabling a schedule stops future dispatch and cancels a still-queued scheduled
job. A run already in progress cannot be interrupted safely and may finish; the
recorded status says it was disabled while the run was in flight. Before every
run, the household scope and the approving owner's current owner membership are
validated. If the approving owner is no longer an owner, the run is skipped with
an actionable failure status until an owner saves the schedule again.

Review and System status show the last run, last status/detail, next due time and
clear disabled, not-configured, consent-needed and attention states.

## Limits and permissions

- Rule scans are bounded to 500 scoped items per run; scheduled scans also
  respect the owner's smaller item cap. Larger scopes are marked partial. AI
  receives at most 40 items missing a category or tags.
- On-demand runs are synchronous. Scheduled runs use the durable worker queue and
  report queued/running/completed/partial/failed/skipped states.
- Viewers can read suggestions but cannot run, apply, dismiss, undo or keep an edit.
- Members can run offline reviews and apply/dismiss; only owners can request the
  optional AI pass.
- Scheduling is opt-in, owner-only and off by default. On the Review page an
  unconfigured schedule is collapsed behind **Advanced · Scheduled review**;
  configured schedules remain visible. Enabling a schedule does
  not enable AI or trigger a provider call.
- Existing item ownership, borrowing records, locations, quantities, loans,
  documents, receipts, history and household permissions are preserved. Review
  does not merge inventory or alter borrowed records.

## API summary

- `GET /inventory-review/summary`
- `GET /inventory-review/schedule` (owner)
- `PUT /inventory-review/schedule` (owner)
- `GET /inventory-review/suggestions` (waiting proposals for one category are adjacent)
- `GET /inventory-review/scope-items`
- `POST /inventory-review/runs`
- `POST /inventory-review/suggestions/{id}/accept`
- `POST /inventory-review/suggestions/{id}/dismiss`
- `PUT /inventory-review/suggestions/{id}/draft`
- `POST /inventory-review/suggestions/{id}/undo`
- `POST /inventory-review/suggestions/bulk-accept` (optional `edits` by suggestion id)


## Queue context and navigation

Review queue filters are URL-backed. `scope_type`, `scope_id`, `item_ids`,
`status`, `suggestion_type` and `q` are validated and retained through reload,
deep links and back/forward navigation. Defaults are pending status, all types
and an empty search. **Reset filters** clears the queue filters without losing the
selected scope.

Item links, duplicate comparison links and **Open item** actions carry a safe
same-app Review origin containing the scope and active queue filters. Item edit
Save, Cancel and Back return to the same filtered Review context even after a
rename or move. External/arbitrary return URLs continue to be rejected by the
existing origin helper. Scroll restoration is best effort. Bulk suggestions are
cleared when queue filters or actionable results change; they are not retained
across a changed queue.


## Walkthrough screenshots

These are older screens, taken before the shared review row and the new
navigation.

- [Suggestion queue and review scope](walkthrough/inventory-review/01-suggestion-queue.png)
- [Accepted change with undo](walkthrough/inventory-review/02-accepted-with-undo.png)
- [Advisory duplicate comparison](walkthrough/inventory-review/03-duplicate-compare.png)
- [Selected-items scope from the Items bulk action](walkthrough/inventory-review/04-selected-items-scope.png)
- [Queue filters and item edit roundtrip](walkthrough/inventory-review/05-filter-context-roundtrip.png)
- [Offline scheduled review settings and next run](walkthrough/inventory-review/06-review-schedule.png)
