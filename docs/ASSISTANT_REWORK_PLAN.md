# Integrated assistant rework

## Current direction: shared application tools

The historical A-D reports below describe earlier milestones, not the current
architecture or a deployment approval. The current correction replaces the
configured-AI intent classifier/action interpreter chain with:

```
AI assistant -> registered application tools -> shared domain logic -> actions
Offline UI / deterministic controls ---------> shared domain logic -> actions
```

### Audit and supported scope

Existing reusable interfaces: `ai_tools.execute_tool` (16 bounded inventory,
location, document, purchase, warranty and lending reads), `history_for_item`,
the persisted assistant proposal/edit/apply contract (edit, move, lend, borrow,
both return directions), assistant text imports, document/photo jobs and their
editable review, and `inventory_review.batches` with coverage/decision memory.
The existing header lookup and offline forms remain independent of inference.

The old `/intent` -> `/interpret` -> one read path is not a general tool loop.
Its phrase/fragment checks can reject supported semantics before domain
validation. It remains a compatibility/offline path, not the AI routing gate.
The assistant does not support deletion, archive/disposition, inventory merge,
account administration, arbitrary web browsing, SQL or arbitrary HTTP.
Location search and reviewed item moves are supported; creating/deleting places
is not advertised as an assistant capability in this stage.

### Coherent implementation stages

1. **Registry and execution.** Publish the executable registry at
   `GET /assistant/tools`, including strict input/output JSON schemas, frozen
   household/property scope, role, side effects and confirmation policy.
   The model requests one registered tool, inspects its result, and continues.
   Validate every request in application code. Reads need no confirmation.
   Mutations only prepare the existing editable proposals; no model-facing
   apply tool exists. Adding a capability normally registers another adapter,
   not a conversational intent or another saving pipeline.
2. **Durable bounded work.** Persist requests, parent references, tool results,
   generation, budgets and recovery state. Execute in the existing job queue,
   with cancellation, a deadline, bounded model/tool calls and explicit retry.
   Release database transactions before model calls; recheck route, consent,
   authorization and generation afterwards. Tool receipts/idempotent domain
   keys protect retries. Failed/invalid outputs preserve usable work.
3. **Conversation and review.** Header requests have no parent; panel follow-ups
   carry a server-verified parent and compact relevant results, not an inventory
   dump. Re-fetch authoritative targets before preparing changes and again at
   Apply. Show existing action/capture reviews and a compact conversational
   presentation of the shared review module. “Do a review and categorise the items” starts local
   review and exposes normal AI consent, progress, resume/cancel and approval
   without requiring navigation. Re-review and reconsideration remain separate.
4. **Verification and publication.** Exercise registry/schema/permission
   failures, injection, multiple tool steps, reference resolution, duplicates,
   stale approval, cancellation/retry/reload and desktop/mobile journeys with
   isolated data. Distinguish controlled-provider evidence from real inference.
   Commit/push the feature branch only; no merge or deployment.

### Authority, data and recovery

- The registry, not a model's claimed capability, is authoritative. Unknown tools
  and invalid arguments return structured recoverable errors, never HTTP/SQL.
- Household and property come from the authorized request, never tool arguments.
  Multiple households require an explicit choice for a tool conversation; no
  household's provider may receive another household's records.
- Uploaded/OCR/inventory text and tool results are untrusted evidence. Only
  authenticated UI approval of the exact reviewed proposal authorizes writes.
  Existing permissions, stale checks, frozen targets and idempotent Apply remain.
- Successful tool work and pending proposals survive reload. Interrupted jobs
  expose retry; cancellation fences late output, not already completed actions.
  Cost/deadline limits are real bounds, not progress estimates.
- Local review can run directly. External AI organisation retains the normal
  explicit owner consent and batch cost notice. Normal runs preserve successful
  relevant-input coverage and decisions; force/reconsider options do not erase
  history. Scheduled external processing remains independently opt-in/bounded.
- When AI is disabled/unreachable/incompatible, retain ordinary local search,
  manual forms and local capture; explain fallback and preserve the request.

### Implemented contract and operating limits

The registry currently exposes **22 tools**: the 16 audited reads, item history,
editable action preparation, AI-first text capture, starting/polling inventory
review, and capture status. The schemas are executable Pydantic contracts in
`services/assistant_tools/registry.py`, published through `/api/v1/assistant/tools`.
Tool use is structured JSON over the existing provider interface; native
function-calling support or a recommended-model label is not required.

`POST /assistant/runs` freezes scope and an optional authorized parent.
`GET /assistant/runs/{id}` restores authoritative proposal revisions and task
state; `/cancel` fences late results and `/retry` starts another generation.
Each planning attempt has at most eight model calls, a 90-second deadline
(including queued time), and a 100,000-character prompt. Existing capture and
review jobs keep their own bounded processing and explicit consent contracts;
the planning budget is not a promise of eight total downstream extraction calls.
Receipts reuse exact action proposals and one original-source text capture per
request, including after interrupted delivery. Approval uses the existing
proposal/version checks and idempotent application interfaces.

The conversation store polls outside the mounted panel, merges monotonic task
generations, and restores older tasks before newer requests. Fresh header
requests omit the parent and parked capture context. Follow-ups include up to
six authorized capture references and four same-scope parents with three recent
observations each. No complete inventory is sent by default. History restoration
currently shows the latest 30 scoped tasks; older records remain stored and
addressable by ID, but older-history pagination is not implemented.

The shared `InventoryReview` module owns both presentations and the existing
queries, consent, mutations, decision dialogs and suggestion cards. Its compact
conversation presentation shows scope, live local/AI coverage, consent,
cancel/resume and actionable proposals. Filters, scheduling, re-review /
reconsideration and detailed diagnostics remain in the full Review workspace,
reachable through a scope/run-preserving link. Successful-input coverage,
accepted/dismissed history and approval interfaces are unchanged.
Background batches continue across navigation.
Cancel preserves committed batches and fences any unfinished inference; resume
uses the saved remaining work. The foreground Review page retains its existing
after-current-batch cancellation behavior. Review inference releases its
transaction, then revalidates the prompt, configuration, permissions and lease
before publishing results.

The panel has one compact scope/control header; model/privacy information is
optional. Tool prose uses the existing safe formatted-answer renderer and
application record links, with technical details retained in Diagnostics.
Prepared action cards are authoritative, without a second generated proposal.
Live review/capture views own changing progress: generated summaries are not
displayed alongside them. Generic follow-up buttons and the unrelated capture
queue are absent from conversations. An explicitly opened capture is placed
inline; all pending captures remain accessible through the Review queue.

The final step separates what the user must read from remarks about prepared
work. `message` carries every answer, clarification, limitation and unsupported
or incomplete part; optional `prepared_note` holds any remark about a proposal,
capture or review and is kept for diagnostics. The run exposes `answer`, which
the conversation shows before the card or live view, so a mixed request such as
“How long have they had it? Prepare a return for today.” yields the duration and
the editable return together. An empty answer is valid only when prepared work
is the whole reply; otherwise the task becomes recoverable. Runs recorded before
this contract have no `answer` and keep their earlier presentation. The
separation depends on the model using the two fields as described; it is not
enforced by parsing prose.

Mixed-answer verification: 203 isolated backend cases (tools, actions, review
and scheduling) and 402 frontend cases pass, with typecheck, build and Ruff.
The four Chromium journeys pass on desktop and 375px mobile against a disposable
database, API and worker with the **controlled local provider**, covering the
combined duration/return request, a stated limitation, formatting, hidden
identifiers and note, order before the card, reload, and unchanged approval.
No real provider was reachable for this correction, so real-model use of the
two fields is unverified.

### Presentation correction verification

- 401 frontend tests, production typecheck/build and changed-backend Ruff checks
  pass. The build retains the existing nonfatal large-chunk advisory.
- 65 isolated backend tool, review/coverage/decision-memory and scheduled-review
  cases pass. The tool engine and its confirmation/permission checks are retained;
  the backend change only adds presentation instructions to its system prompt.
- Four Chromium journeys pass against a disposable PostgreSQL database and real
  API/worker with a **controlled local HTTP provider**. Desktop and 375px mobile
  journeys cover drill lookup, borrower, contextual duration, reviewed return,
  editable rename, reload, normal AI consent, cancellation/resume during inference,
  background completion while closed/reloading and explicit suggestion acceptance.
  An earlier genuinely pending suggestion and a newly generated suggestion verify
  their distinct labels/counts and successful-input coverage reuse. Deliberately
  stale generated review prose stays hidden while the live view reports completion.
  Separate task cancellation, late response fencing and retry also pass.
  The Review queue opens Alpha, Beta, then Alpha again inline through actual
  local/manual captures, retaining an unsent draft and PDF attachment. Explicit
  selection stays visible when durable tool history restores asynchronously.
- Inspected actual desktop/mobile return and review screenshots. Assertions check
  formatted prose, hidden technical IDs/paths, one accessible heading, the absent
  capture queue, record links, scope/control non-overlap and a 44px Send target.
  Screenshots are retained in session artifacts (`files/assistant-presentation`).
- No live-model quality claim is made for this correction; the user's independent
  real-model verification concerns the preserved preceding engine. Physical
  iPhone, native keyboard/voice and other real providers were not exercised here.

### AI-first review requests

“Review my items and suggest categories” is carried out, not handed back. The
`start_inventory_review` tool takes `analysis` (`ai` by default, `local` only on
request) and `review_again`, and the application decides how the work runs:

| Situation | What happens |
| --- | --- |
| Provider configured and consented, owner, up to 120 items in scope | AI analysis starts in background batches straight away. No checkbox or dialog. |
| Same, more than 120 items | Local checks run; the live review shows one “Run AI analysis” step with the item count and approximate number of provider requests. |
| Member (not owner) | Local checks only, with the reason. The owner-only rule for AI review is unchanged. |
| No usable provider | Local checks only, stated plainly. In the panel without any AI, a review request starts the local checks inline rather than falling through to search. |

Provider configuration and cloud consent are the existing consent; the assistant
does not ask again. The tool result tells the model which case applied, so its
answer cannot claim analysis that did not run or ask the user to enable AI after
it started. `get_inventory_review` reports running/finished, AI coverage and
pending suggestions for follow-ups; it is an answer, not new work, so it does
not open a second live review. The live review says “Analysing with AI…”,
“Analysis finished” or “Local checks finished”, and states how many suggestions
wait for approval and that nothing has changed. Coverage reuse, decision memory,
cancel/resume and explicit accept per suggestion are unchanged. Consecutive
background batches now hand over without a moment where the review looks paused.

Verification: backend cases cover direct AI analysis, follow-up, coverage reuse,
the large-scope confirmation, explicit local mode and the member fallback. Five
Chromium journeys with the **controlled local provider** and two without any
provider cover the request on desktop and 375px mobile, cancel/resume/reload,
follow-up, the large-scope confirmation and the no-AI fallback.
`e2e/assistant-review-live.spec.ts` runs the same request against a real
configured provider (`LIVE_AI_E2E=1`); it has **not** been run, because no real
provider was reachable from the development machine.

### Original tool-engine verification and remaining gaps

- Twenty new isolated backend cases cover multi-step retrieval and follow-ups,
  bounded execution, unknown/invalid tools, worker/provider/configuration failure,
  cancellation and late output, scoped authorization, proposal revisions,
  duplicate action/capture requests, AI-first English/Persian capture, and actual
  reviewed saves. Detached review also checks configuration/item/permission
  changes and overlapping inference. No transaction is held during either
  planning or review inference.
- A combined isolated run passed 454 backend cases, followed by another passing
  run of all 20 new cases after the final capture-idempotency correction.
  These regressions exercise the shared actions, captures, documents,
  review/scheduled review, lending/borrowing, search, jobs and migration metadata.
  The full frontend suite has 398 passing cases; typecheck and production build
  pass. Vite still reports its nonfatal large-chunk advisory.
- Three Chrome journeys use a real isolated PostgreSQL database, API and worker
  with a local **controlled HTTP provider**: desktop and 375px mobile retrieval,
  contextual editable approval, consented background review through reload,
  approved saved records, cancellation, late response fencing and retry.
  Desktop/mobile screenshots are retained as session artifacts.
- These are not live-model semantic or prompt-injection-resistance claims.
  Live-provider quality, physical iPhone/voice/keyboard behavior, native
  function-calling providers and long-history pagination remain unverified or
  outside this stage. Existing voice/attachment/manual interfaces are retained;
  no production records, provider defaults, scheduled cost limits or deployment
  configuration were changed.

---

## Historical brief and milestones

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
