# Insurance replacement lists

Valuation is an **export-time activity**, not a value the user maintains on every
item. Purchase prices remain historical evidence and are never mixed with
replacement estimates.

## One simple workflow

Open **Insurance** from Overview, an item, or the mobile More menu. Choose whole
household, property, room, container or explicitly selected items, then review
one table:

- include or exclude each item;
- enter a per-unit replacement amount manually, or request AI estimates;
- edit any suggestion and inspect its range, confidence, assumptions and real
  source links;
- leave the amount blank when value is unknown. Blank is not zero; an explicit
  zero is still valid.

The default currency comes from the household Settings. Choose the review date,
then generate a dated PDF and CSV. Large inventories can be estimated in batches
of up to 10 eligible items. Items with insufficient identity information remain
available for manual review instead of being silently excluded.

## AI and web comparisons

AI estimation uses the existing consented Assistant/text provider and the
existing replacement-valuation service. Each item runs as a separate bounded
background job, so one slow provider or failure does not abort the rest of the
batch. There is no automatic paid retry. Batch reads and cancellation are
household-scoped. Public comparison search is optional and uses the existing
Brave integration; without it, estimates are clearly rough AI estimates.

Only product-identifying context is used: name, description, brand/model,
condition and purchase context. Serials, room/location, borrowers, receipts and
account data are not sent to the model. Brave receives only the generic product
query. AI-produced URLs are never trusted; source links come only from actual
retrieved results.

AI is used only when the user explicitly starts a batch. Nothing is scheduled or
periodically re-valued.

## Export-only values and immutability

The existing `apply_valuation` path is **not** called by Insurance. Item
`current_value_*` fields and purchase records are unchanged.

Every included row stores either no reviewed value or:

- reviewed per-unit amount and owned total;
- current item fingerprint;
- optional estimate ID, with household/item/purpose/currency/expiry/fingerprint
  validation;
- estimate date, confidence, reasoning, assumptions and real source metadata.

Changing an item after review invalidates its expected fingerprint. A generated
job result freezes the reviewed values and metadata, so later item edits or
preview expiry do not alter the PDF/CSV already generated. These job snapshots
use the existing durable queue lifecycle and are not presented as permanent named
insurance-list records.

PDF output states that values are export-only, unknown is not zero, purchase
prices are separate, and estimates are not professional appraisals or insurer
payout guarantees. CSV uses explicit replacement columns and UTF-8 BOM for
spreadsheet compatibility.

## Existing values and compatibility

Existing `current_value_*` columns, financial endpoints, valuation endpoints and
generic evidence exports remain compatible for imports, older clients and older
evidence snapshots. In the ordinary UI they are read-only **Earlier estimates**:

- item create/edit does not offer current-value controls and omits all
  current-value keys on save;
- item detail shows older values without an Apply/Estimate action;
- Overview reports purchase facts only, without current-value cards/rankings.

The new Insurance workflow is the only primary place for creating fresh
replacement estimates. Generic receipt/photo evidence export remains a separate
action.

## Verification

- Backend tests cover scope/eligibility, AI batches, edited reviewed amounts,
  unknown and explicit-zero values, stale fingerprints, no item-value writes,
  immutable output, PDF text and CSV replacement columns.
- Frontend tests cover AI estimate editing, explicit zero versus unknown,
  downloads and the absence of `/valuation/apply` calls.
- Browser coverage uses mocked AI/Brave providers, edits a generated estimate,
  downloads PDF/CSV and checks responsive overflow.
