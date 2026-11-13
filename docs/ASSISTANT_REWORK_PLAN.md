# Integrated assistant rework

Status: implementation brief, 13 November 2026. Application code unchanged.

## Product outcome

Housetory helps a person complete inventory tasks by describing the outcome or
providing evidence. When AI is configured, consented and reachable, it leads
interpretation naturally. Core inventory functions remain usable without AI or
internet. Functional simplicity, existing visual character and reliable results
take priority over additional features.

Do not treat the previously reported Items search behaviour as a confirmed bug.
Do not redesign search routing without establishing the intended current behaviour.
The microphone lifecycle concern remains unverified and is a separate issue.

## Experience decisions

- One assistant identity and conversation model across the app. Keep a full-page
  view and a contextual panel as views of the same conversation, not separate bots.
- A persistent assistant entry is available throughout authenticated screens;
  desktop uses a side panel, mobile a full-screen sheet. Preserve drafts and
  conversation when navigating, closing and reopening. Do not autofocus on mobile.
- Page actions such as asking about an item or interpreting a document open that
  same assistant with explicit context. Existing direct controls remain available.
- Show a compact context chip: current item/document/place/selection and scope.
  Page context is a hint, not a substitute for explicit wording. Clarify conflicting
  or ambiguous targets. Freeze targets when creating a proposal; navigation cannot
  silently change what a pending confirmation will affect.
- New conversation is available. Follow-up questions resolve entities using
  verified references and relevant history. Returning to a conversation retains
  its stated scope; changing scope is visible and re-authorised.
- Add accepts supported PDF/image documents, inventory photos, text and voice.
  Users do not need to identify the internal import or document subsystem first.
  A brief intent choice is allowed when a file could be either evidence or items.
- Put actionable cards, comparisons, editable extraction and progress inside the
  current flow. Avoid answers that merely instruct users to navigate elsewhere.
- No new required AI subscription or replacement of existing task/provider choices.
  Use task-compatible configured providers; explain missing capability once and
  provide the usable alternative. Do not silently send data to another provider.

## Capability scope

Initial complete journeys:

1. Invoice/receipt attachment -> purchase and item proposal -> explicit save.
2. Item lookup -> location/loan answer -> contextual follow-ups and linked facts.
3. Edit item fields and move one or several items -> reviewed action -> result.
4. Lend, borrow and record full/partial return -> reviewed action -> result.
5. Find incomplete records and possible duplicates -> compare -> approved changes.

The first action release covers edits, moves and lending/returns. Duplicate merge
comes after those paths are reliable and reuses existing merge rules. Other
features may initially offer a correctly scoped existing form, with values filled
in, rather than pretend to execute unsupported actions. Deletion, household/account
administration and arbitrary web automation are outside this rework's first scope.
Existing permitted manual/image lookup remains available; do not expand external
search or download permissions as a side effect of this work.

## Invoice contract

- Keep the original document and use an existing extraction draft, not duplicate
  processing paths. Handle multipage files and supported image formats. Unsupported
  files get a useful explanation before upload where possible.
- When AI is available, present one coherent AI-assisted review rather than exposing
  low-confidence OCR proposals followed by a competing AI proposal. OCR/local layout
  analysis supplies evidence. Do not wait for OCR if compatible direct document or
  vision processing is demonstrably faster and still preserves evidence.
- Show merchant, invoice number, date, currency, invoice total, tax, shipping,
  discounts and line items only where established. Distinguish gross/net amounts.
- Each line distinguishes quantity, unit price, line total and description. A
  purchase total is not an item unit price. Preserve source text, page and available
  evidence references; unknowns remain unknown, not fabricated zeroes.
- Use decimal arithmetic and currency-aware rounding. Reconcile quantities, line
  sums, tax, discounts and total. Flag ambiguity/inconsistency rather than silently
  correcting source amounts. Handle decimal commas, credit notes and negative lines.
- Suggest link to an existing item versus create new. Explain likely matches;
  uncertain matches stay unresolved. Fees and service lines need not create items.
- Review can exclude lines, change quantities, select destination and correct fields.
  Repeated identical units can become one item with quantity, but materially
  different models, prices or serialised assets must not be blindly collapsed.
- Commit is idempotent: retry/double-click cannot duplicate purchases or items.
  Preserve existing purchase, document-link and price semantics. Saving extracted
  suggestions never happens merely because background AI completed.
- If a user edits the review while AI is working, late output cannot overwrite those
  edits. Offer a comparison if refreshed suggestions are useful.

## Assistant execution contract

- Reuse authorised application services for all reads/writes. Models never execute
  SQL, arbitrary code or arbitrary HTTP calls. Document text and retrieved content
  are untrusted evidence, never instructions to execute tools.
- Support bounded multi-step tool use: retrieve candidates, resolve target, obtain
  relevant history, then answer or propose an action. Do not send the whole household
  on every turn. Preserve user usefulness with relevant recent turns, structured
  references and a faithful summary; do not truncate essential constraints blindly.
- A model proposes typed operations. The server validates capabilities, schema,
  permissions, entity IDs, quantities, scope and preconditions. Revalidate at apply
  time and reject stale/conflicting proposals with an understandable recovery path.
- Reads require no extra confirmation. Inventory writes use a compact preview and
  explicit Apply; multi-step changes can share one review. Ambiguities are resolved
  before review, not guessed. Existing permission roles always apply.
- Apply carries an idempotency key and concurrency preconditions. Use transactions
  for one logical change where feasible; never claim success for partial failure.
  Record actor and resulting activity. Offer undo only where the existing domain
  can actually reverse the operation safely.
- Conversation cancellation, job cancellation and undo are distinct. Cancellation
  prevents subsequent proposal application but does not claim already committed
  changes were reversed. Uncancellable provider calls may finish, but stale results
  must be ignored and charges cannot be promised to disappear.
- Respond naturally in the user's language, retaining real item/model/person names.
  Answers cite relevant app records and distinguish evidence from inference. Test
  English, Persian and mixed-language follow-ups without punctuation heuristics.
- Follow-ups include: Where is my drill? Was it lent before? Do I own another one?
  How long did Mohsen have the other one? Ask which loan/item when ambiguous.
- Re-authorise conversation references on every request. Never mix households'
  evidence into another household's provider; retain existing consent boundaries.
  No automatic cross-household writes in this release.

## Processing and responsiveness

First diagnose the observed four-minute wait. Existing jobs already support queue
names, priority, retries and worker heartbeats. Inspect actual routing, worker
availability, blocking calls, attempts and provider timings before changing them.

- Track upload/local preprocessing/queue wait/provider call/validation separately
  using a correlation ID, safe error codes and timestamps. Never log credentials or
  raw private documents by default. Give owners useful per-job diagnostics without
  requiring access to infrastructure logs.
- Visible states: uploading, reading document, waiting, interpreting, ready,
  needs attention, failed, cancelled. Report actual stage and elapsed time; no
  fabricated percentage or completion estimate.
- Interactive work takes precedence over scheduled/batch tasks with bounded
  concurrency and per-household/user fairness. Priority alone cannot interrupt a
  blocking running call; reserve interactive capacity or use an equivalent proven
  isolation strategy. Ordinary local work must not wait behind external AI calls.
- Prevent background starvation and runaway retries. Rate limits honour provider
  retry guidance; interactive work cannot remain silently queued through repeated
  backoff. Retry is explicit after the bounded interactive deadline, unless a short
  transparent retry still fits that deadline. Deduplicate active work.
- Cancel/retry actions appear where the job was started. No manual queue-priority
  button initially. If workers are unavailable, show that rather than a spinner.
- Proposed acceptance budgets, measured rather than promised for every provider:
  progress updates within 2 seconds after a server transition; interactive queue
  dispatch p95 <= 2 seconds on the healthy single-user reference deployment;
  simple 1-3-page invoice review p95 <= 45 seconds after upload with a named tested
  provider/model. At 15 seconds show an honest slow-stage message. At 60 seconds
  offer local/manual review and cancellation; the interactive attempt terminates
  within 90 seconds, with partial evidence retained. Large documents use explicit
  background processing and page limits. If quality/latency conflict, report it and
  benchmark alternatives rather than lower extraction quality silently.
- Provider/network unavailable: preserve input and offer local/manual workflow.
  A household without AI never waits for provider discovery or connection attempts.
  No external calls per keystroke. Scheduled external processing stays opt-in.

## Settings and presentation

Keep existing provider/task configuration. Consolidate entry points, not all task
models into one mandatory model. Show assistant readiness and actionable missing
configuration. Put advanced budgets and diagnostics in advanced/system settings,
not the normal capture journey. No unrelated visual redesign or new navigation hub.
Use accessible progress announcements, keyboard navigation, RTL support, readable
mobile inputs, stable keyboard layout and bounded document previews.

## Stages and acceptance gates

### A — Diagnose and repair invoice capture

Audit current code and deployed-version evidence where available. Produce a short
root-cause report for latency and incorrect extraction. Add PDF/document attachment
to Add through existing document services. Implement the coherent review, financial
validation, job visibility and interactive scheduling required above. Benchmark a
fixed fixture set. Do not attempt the entire assistant redesign in this stage.

Gate: correct supported fixture extraction or explicit uncertainty, working manual
fallback, bounded failure/cancellation, no duplicates/stale overwrite and measured
latency. A supplied failing real invoice is needed to close that specific incident;
synthetic fixtures alone cannot establish its resolution. Do not block other work
while awaiting that file. Use redacted fixtures unless private test use is approved.

### B — One assistant surface and conversation

Implement shared conversation/page context and attachment/result components. Reuse
existing full-page assistant as a view, add contextual access, preserve navigation
and mobile behaviour. Connect Stage A review without creating another extraction
implementation. Validate continuity, scope changes and multilingual follow-ups.

### C — Reviewed actions

Introduce a small typed proposal/apply contract using existing domain services.
Complete item edits, bulk moves and loan/borrow/return journeys first. Test stale
data, permissions, repeated Apply, partial returns and multi-item atomicity. Then
connect existing duplicate comparison/merge, only where its domain rules support it.

### D — Whole-journey validation and release

Check desktop, narrow phone, keyboard-open mobile and RTL. Exercise real configured
models with authorised test data and bounded calls; distinguish mock tests from real
provider evidence. Test no provider, WAN blocked, missing worker, slow/rate-limited
provider, bad document, cancellation and concurrent users. Verify existing direct
controls continue working. Produce review evidence and a staged release plan; do not
deploy until requested. Do not add unrelated features before this gate.

## Meaningful test set

- Invoice fixtures: clean PDF, image-only multipage invoice, Nordic decimal comma,
  tax-inclusive/exclusive, discount/shipping, quantity >1, repeated lines, ambiguous
  date/currency, credit note and unreadable amount. Assert exact financial fields
  and reconciliation, not just successful HTTP responses.
- User journeys: invoice -> corrected proposal -> save -> purchase/item/document;
  repeat save; edit during AI; delayed result after cancel; retry after timeout.
- Queue: interactive arrival during long background work, fairness between two
  users, missing/stale worker, retry backoff, no duplicate provider dispatch.
- Assistant: follow-up referents, ambiguous drills/loans, malicious invoice text,
  unauthorised IDs and revoked membership. No cross-household disclosure.
- Actions: edit/move/lend/return success plus stale proposal and repeated apply.
- Accessibility/mobile: attachment selection, review editing, assistant continuity,
  fixed controls while typing, visible status/errors and focus restoration.

## Copilot handoff — first task

Read this document and repository instructions. Implement Stage A only. First map
the current capture, extraction, AI dispatch, worker and review paths; report what
already exists and identify the measured bottleneck if runtime access exists.
If this system has no access to the affected deployment, add safe diagnostics and
provide exact evidence needed; do not invent a production root cause.

Keep work on a dedicated branch and preserve unrelated changes. Reuse current
services and migration conventions. Do not weaken authentication, household
isolation, upload/fetch protections or consent. Do not copy secrets or private
documents into commits. Do not modify production data, deploy, or reset databases.
Use isolated test fixtures/databases and existing checks. Add meaningful regression
tests for the changed journeys. Preserve visual character and direct offline use.

Deliver: root-cause evidence and remaining unknowns; completed Stage A changes;
screenshots of desktop/mobile review and progress; exact tests and benchmark results
(environment, provider/model, page count, sample size, queue wait and processing
times); limitations; commit ID; and an explicit Stage A acceptance checklist. Stop
for review before Stage B. Ask only for information that blocks the work; make
routine implementation choices independently. Do not claim the user's real invoice
is fixed unless it was actually tested.
