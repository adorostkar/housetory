# Stage C: reviewed inventory actions — review report

Branch: `feature/integrated-assistant`, based on the Stage B correction
`a658d0e`. This report records the supported journeys and their limits;
it is not evidence of deployment or real-provider validation.

## Natural-language correction

The configured-provider action path no longer requires a fixed action verb or
a whitelist of residual words. A structured model result must identify its
action, literal target and value fragments, negation, additional actions,
unsupported details and exact remaining framing. The server checks source
coverage, explicit quantities and dates, and known safety indicators before
passing a canonical request through existing scoped target resolution and typed
proposal creation. Event dates and due dates are retained for lending and
borrowing; return dates are retained. Unsupported schedules, conditions and
ambiguous or incomplete output request clarification rather than silently
discarding details. Explicit Apply and existing reauthorization, conflict and
idempotency checks remain required.

Authenticated HTTP tests with a mocked provider reproduce and cover “Transfer
Drill to Kitchen” and “Could you move Drill into Kitchen for me?”, plus
paraphrases, Persian and mixed-language requests, past lending/returns, dates,
negation, exclusions, conditions and multiple actions. A mocked provider outage
also verifies deterministic routing remains available and reports the failure.
The browser routing test is intercepted; no real model has been tested.
Correction checks: 165 backend tests passed before the final clarification
refinement; 29 focused tests and a conflicting-date regression passed afterward.
Three intercepted browser tests, 371 web unit tests, the production web build
and changed-file Ruff checks also pass.

## Implemented and tested

The assistant can prepare persisted, typed proposals for item edits, moves,
lending, borrowing and both return directions. Review is editable and Apply
is explicit. The server rechecks membership, scope, versions and domain
validation, delegates to existing inventory modules and stores the result with
the proposal for idempotent retries. Cancellation is not undo.

| Acceptance area | Evidence and limitations |
| --- | --- |
| Review and Apply | Isolated real-HTTP browser journeys cover move, editable item details, lending, borrowing and partial returns on desktop and a simulated phone. Full returns are covered by backend tests. |
| Ambiguity and context | Backend and browser tests cover duplicate item choices, location clarification, selected items and action follow-ups. A loan-return follow-up resolves a previously authorised item and asks when page and conversation references conflict. |
| Permissions and frozen scope | Backend tests exercise revoked access and property restrictions. An intercepted browser regression switches household scopes with a proposal pending and checks that it remains in its original scope. |
| Conflicts and retries | Backend tests cover stale records, refreshed proposals and concurrent/repeated Apply. A real-HTTP browser test drops an Apply response after commit and retries the same idempotency key. |
| Bulk atomicity | An isolated backend test injects a mid-move failure and verifies rollback and successful retry. |
| Untrusted document content | A mocked-provider backend test confirms document text is not passed into action interpretation, and another checks that document instructions do not change the requested action. |
| Intent routing | With a configured single-household provider, a typed AI classification distinguishes questions, supported actions, unsupported actions and ambiguity. Questions use existing search; unsupported actions offer an existing form; ambiguous actions ask for clarification. Model output never applies a change. Search answers explicitly say that no changes were made. |
| Manual/offline | Deterministic action phrases and existing direct forms remain available without a configured model. Provider errors are reported and fall back to local routing; a browser regression confirms read-only search remains available. The isolated browser API ran with AI disabled; server-wide network isolation was not repeated. |
| Screenshots | [Desktop](assistant-stage-c-desktop.png) and [mobile](assistant-stage-c-mobile.png) show synthetic data from the isolated real-HTTP browser tests. |

## Validation

- Isolated PostgreSQL backend: 142 tests passed across assistant actions,
  unified search, lending, borrowed items and bulk operations. Changed-file
  Ruff lint and formatting checks passed.
- Web: 371 unit tests passed; the production typecheck/build passed.
- Browser: two isolated real-API journeys passed with AI disabled; 37 intercepted
  assistant tests passed, followed by four focused routing tests including the
  new provider-failure regression. Model classifications in those tests are
  mocked, not real-provider validation.

## Limitations and deferred work

- Intent classification uses the selected household's configured, consented
  provider. It does not choose a provider when an all-places scope spans multiple
  households; with no configured provider, deterministic action and fallback
  patterns are used instead. Unrecognised wording in those cases may reach
  read-only search rather than a specific form. A provider failure is reported
  before using the same local routing; search answers explicitly state that
  they did not make changes.
- Model output and semantic classifications are fallible: coverage checks and
  known safety indicators cannot guarantee that every possible qualifier is
  recognised. Exact source fragments and safety fields are required, so some
  providers or valid phrasing may instead produce clarification. Relative dates
  other than today/yesterday and non-ISO explicit dates need clarification.
  Some Persian action messages are translated; review controls, status and
  error messages remain in English.
- Name, description, brand, model, serial number, quantity and condition are
  editable in item proposals; other item fields require the linked full item
  editor, which is separate from the pending proposal.
- General inventory-item duplicate comparison/merge is deferred: the existing
  import-entry merge has not been shown safe for merging two inventory records.
- Real-provider output, latency and consent behavior have not been independently
  tested. The original Stage A invoice and four-minute incident remain unverified.
  Physical mobile keyboards and touch hardware were not tested.

No Stage D work, production-data modification, deployment or main merge was
performed. Real-provider classification quality and latency remain unverified.
