# On-demand inventory review

Review is one persistent destination at `/review` for inventory-management
suggestions. It is not limited to imports and does not schedule itself.

## Scopes

A review can cover:

- the current household;
- a property;
- a room;
- a storage place/container;
- up to 100 explicitly selected items, including a **Review** action in the
  existing Items/place bulk bar.

All scope IDs, item IDs and applied category IDs are validated inside the current
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

Only category and naming suggestions are actionable. The server:

- locks and rechecks the item against the exact analysis version;
- marks the suggestion stale instead of overwriting a changed item;
- validates category ownership and display-name bounds;
- records an activity event for the applied change.

Accepted category/name changes can be undone while the item has not changed since
apply. The original category must still exist for category undo. Undo records a
separate history event. Stale or unsafe undos are refused honestly.

Dismissal records a history event. Possible duplicates, missing details and
location wording are advisory and cannot be accepted as automatic mutations.
Bulk accept applies only compatible pending category/name suggestions and reports
applied/skipped/stale/unsupported outcomes.

## Optional AI-assisted review

- Offline review is always available.
- AI review is an explicit owner action and is off by default.
- It uses the existing household **Assistant** task/provider; no new provider or
  subscription is required.
- The confirmation dialog shows the reviewed scope and explains that one bounded
  request sends at most 40 uncategorised item names, descriptions, brand/model and
  existing category names. It does not send photos, receipts, loans, prices,
  borrower data or other households.
- Opening Review never calls AI. The provider may charge usage/cost.
- Model output is schema-validated. It may only choose an existing household
  category; invalid JSON, unknown categories, duplicate indexes or provider errors
  mark the run partial and keep the offline suggestions.
- Related-items, moves, merges, quantities and purchase values are never AI
  actions.

## Limits and permissions

- Rule scans are bounded to 500 scoped items per run; larger scopes are marked
  partial. AI receives at most 40 uncategorised items.
- Runs are synchronous; there is no background queue or cancellation UI yet.
- Viewers can read suggestions but cannot run, apply, dismiss or undo.
- Members can run offline reviews and apply/dismiss; only owners can request the
  optional AI pass.
- There is no automatic schedule, recurring run, last/next-run scheduler or
  notification in this phase. Scheduling remains separately reviewed future work.
- Existing item ownership, borrowing records, locations, quantities, loans,
  documents, receipts, history and household permissions are preserved. Review
  does not merge inventory or alter borrowed records.

## API summary

- `GET /inventory-review/summary`
- `GET /inventory-review/suggestions`
- `GET /inventory-review/scope-items`
- `POST /inventory-review/runs`
- `POST /inventory-review/suggestions/{id}/accept`
- `POST /inventory-review/suggestions/{id}/dismiss`
- `POST /inventory-review/suggestions/{id}/undo`
- `POST /inventory-review/suggestions/bulk-accept`


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

- [Suggestion queue and review scope](walkthrough/inventory-review/01-suggestion-queue.png)
- [Accepted change with undo](walkthrough/inventory-review/02-accepted-with-undo.png)
- [Advisory duplicate comparison](walkthrough/inventory-review/03-duplicate-compare.png)
- [Selected-items scope from the Items bulk action](walkthrough/inventory-review/04-selected-items-scope.png)
- [Queue filters and item edit roundtrip](walkthrough/inventory-review/05-filter-context-roundtrip.png)
