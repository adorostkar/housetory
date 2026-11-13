# Stage D: whole-journey validation and release assessment

**Recommendation: not ready for release approval.** The offline and synthetic
checks below are encouraging, but a real configured provider, representative
end-to-end latency percentiles, and physical mobile devices remain unverified.
The original invoice and four-minute incident were not available and are not
claimed fixed.

## Environment and evidence

The tested baseline was `f19a6ea75a142389f24d09d57591ed629c38f501` on
`feature/integrated-assistant`, plus the Stage D OCR job-identity correction
and test in this commit. No production deployment or data was changed.
An isolated Docker Compose project used newly named volumes, synthetic
credentials and records, PostgreSQL 16, branch-built API/worker/web images,
both worker roles and Chrome on macOS. Migration reached `f7a9c1e3b5d7`.
The API and both workers could not connect to `1.1.1.1:443`; browser requests
outside the local origin were blocked in the invoice harness. The web container
itself could reach an external address, so this is not evidence that every
container was WAN-isolated. AI was disabled. The isolated backend pytest
databases were separate from all application databases.

No local Ollama endpoint responded at `127.0.0.1:11434`, and no known cloud
provider key was present in the current process environment. No existing
deployment configuration or credentials were copied or used. Real-provider
quality, privacy/consent behavior and latency therefore remain unverified.

## Journey results

| Journey | Evidence and limits |
| --- | --- |
| Invoice via Add and assistant | Two real-browser/real-API tests uploaded synthetic one-page text invoices with AI off, observed processing, corrected merchant and item name, selected a room and explicitly applied. Each verified a linked item, purchase, and byte-identical original. The retained test requires `STAGE_D_ISOLATED=1` because it creates records. This does not establish real-provider invoice quality. |
| Find and follow up | An isolated backend HTTP four-turn test uses mocked model plans to cover location, current and historical loans, similar items and a ten-day loan duration; other tests cover ambiguity, contextual references and household/property reauthorization. Browser follow-up continuity is intercepted. A complete live-browser history/similar-items/duration journey was not independently repeated. |
| Reviewed actions | Two real-API browser journeys cover move, editable item details, lend, borrow and partial returns, a lost Apply response and retry, duplicate-name clarification and Persian/mixed-language follow-ups. Full return, bulk move, rollback, stale state, revoked permissions and concurrent Apply are backend-test evidence, not all live-browser journeys. |
| Continuity and frozen scope | Intercepted browser checks cover closure/reopening, navigation, household and property scope, full-page handoff, drafts, in-flight answers and a pending proposal after scope changes. They are not multi-user live-deployment evidence. |
| Failures and safety | Stopping the isolated local worker made its unavailable state visible in the real browser; cancellation succeeded, and the worker was restarted. Isolated backend tests exercise real worker processes with a synthetic HTTP provider, slow background AI alongside interactive work, cancellation, deadlines and retries. Other tests simulate rate limits, provider failure, late edits, permission revocation, untrusted document instructions, idempotency and transaction rollback. These are not real-provider or production-concurrency results. |
| Offline/manual | The no-AI invoice and reviewed action journeys used real API/worker processes with API/worker WAN egress blocked. Ordinary search and manual controls have backend and intercepted-browser coverage; a complete installed-server WAN-blocked CRUD/search suite was not repeated here. |
| Usability | [Desktop review](assistant-stage-d-desktop.png) and [mobile review](assistant-stage-d-mobile.png) show synthetic data from the real-API browser journey at 1440 and 390 pixels. Intercepted tests cover focus restoration, no initial text focus, a 520px simulated keyboard-resized viewport, continuity, selection and no horizontal overflow. Persian and mixed input have sample-based browser and backend coverage; review controls are not fully localised. Physical keyboards, touch and native software keyboard behavior were not tested. |

Typing a question without sending it produced no search, intent or action
interpretation request in a real-browser, AI-disabled test. This does not prove
the behavior with every configured provider or browser.

## Measurements

The actual bundled local parser and Poppler/Tesseract pipeline ran with no
provider in the isolated Linux aarch64 worker. Seven synthetic fixture cases
were each run once in three formats: embedded one-page PDF, one-page PNG, and
three-page image PDF (21 samples). All 21 matched their fixture's expected
fields and uncertainty checks. Processing ranges were 0.9–83.8 ms, 513–776 ms,
and 1,485–1,937 ms respectively. These exclude upload, queue, browser and
provider time; one sample per case is not a percentile or real-world quality
estimate.

After the fix, two live synthetic text invoices reported local queue waits of
1,150 ms and 872 ms, local processing of 12 ms and 28 ms, and server upload
storage of 4 ms and 0 ms respectively. These are individual observations,
not p95. No provider/model was configured; AI queue, provider and validation
timings were not applicable. The named-provider 45-second p95 and interactive
dispatch p95 budgets cannot be assessed from these observations. Intercepted
progress tests check state transitions but do not establish live p95 timing.

## Bug found and corrected

New OCR jobs omitted their own job ID from the payload. The worker therefore
could not associate a new local job with its claim timestamp and completed
invoices reported `local_queue_ms: null`; existing tests supplied the ID
directly and missed the actual scheduling path. The correction includes the
flushed job ID in the payload, enabling existing timing and cancellation
guards. The retained real-browser upload/worker regression failed with null
before the correction and passed afterward for both capture paths. A worker
process test also checks the persisted timing. Legacy-job routing already
populates the ID; this change does not invent timing for completed old jobs.

## Rollout and rollback proposal — not executed

After the missing validation and release approval, back up the database and
file volumes and rehearse upgrade and recovery on a copy. Quiesce or drain
old workers and in-flight document jobs; deploy compatible API and both local
and AI worker images together, apply the additive
`f7a9c1e3b5d7` migration, then start the matching web image. Confirm worker
heartbeats for `documents` and `ai-documents`, legacy queued-job routing,
readiness, provider consent and a synthetic reviewed journey before opening
traffic. Old running calls are not migrated or preempted by queue priority.

For rollback, stop new traffic and drain or stop the new workers, preserve
current database/files and job state, and replace API, both workers and web
with a mutually compatible prior release. Do not automatically downgrade or
drop the proposal table: its downgrade deletes proposal state, and restoring
a backup would discard changes made since that backup. Decide recovery with
operators after examining queued jobs and supported schema compatibility;
rehearse the chosen rollback before rollout.

## Checks and unresolved areas

All Python tests used disposable databases on a task-owned PostgreSQL container.
The full backend run started on the baseline before the one-line correction;
the affected worker/OCR/enrichment/cancellation suites were rerun afterward.

- `pytest -q`: 769 passed in the full backend run.
- `pytest -q tests/test_document_processing_worker.py tests/test_ocr.py
  tests/test_enrichment.py tests/test_invoice_apply_cancellation.py`: 80 passed
  after the correction, including real worker processes and a synthetic provider.
- `npm test`: 371 passed; `npm run build`: production typecheck/build passed.
- `ruff check housetory_api tests`: passed before the correction; changed Python
  files passed `ruff check` and `ruff format --check` afterward.
- `STAGE_D_ISOLATED=1 STAGE_D_BASE_URL=http://127.0.0.1:18277 npx playwright
  test -c playwright.stage-d.config.ts` from `apps/web`: 2 passed against the
  explicitly isolated deployment after rebuilding its API and workers.
  The new test and configuration also passed a focused TypeScript check.
- Two existing real-API action browser journeys passed. Existing intercepted
  Stage A/B suites passed 44 checks initially; two encountered a concurrent
  Playwright artifact-directory collision and passed when rerun separately.
  One real-browser typing check and one stopped-worker/cancellation check passed.

External provider timeouts/rate limits are simulated, and provider/model output remains fallible.
Broader multilingual natural phrasing, comparative duplicate merging, realistic
concurrent users, native mobile behavior, and original-incident latency remain
open. No Stage D check justifies claiming a production SLA.

## Action interpretation contract correction

The user reported an exploratory comparison at `014702d`, with three synthetic
requests repeated twice per model on the same OpenRouter connection: DeepSeek
v4.1 Flash produced 5/6 correct proposals (median 11 seconds) and GPT-6 Luna
2/6 (median 3.3 seconds). These are user-reported small samples, not model
rankings or measurements of this correction. Luna's four failures had correct
semantics but imperfect framing; DeepSeek's missing borrower was a genuine
missing value. No proposal was applied in that comparison.

The interpreter no longer requires coverage of every residual word by model
framing. Its typed plan still requires source-anchored subject, person/place,
field and dates; explicit return quantities; and safety indicators. Existing
server checks for negation, conjunctions, unrepresented numbers/dates and
conditions remain, with additional checks for return direction, common
unrepresented descriptors and comma-separated additional actions. Missing
borrower, quantity or other values now trigger specific clarification.
Domain resolution, permission and scope rechecks, frozen proposals, stale
checks, transactions and explicit Apply remain authoritative. Review cards
display the original request, including after target clarification, edits
and refresh; they do not add another confirmation step.

The response optionally includes a privacy-conscious `reason` category:
`model_schema`, `ambiguity`, `unsupported_semantics`, `domain_resolution` or
`provider_unavailable`. No prompt, response, credential or household content
is logged by this change. These categories describe the detected failure,
not proof that every possible failure has been classified.

Regression evidence uses synthetic records and mocked provider outputs, not
actual inference. Four supplied-style incomplete framing examples failed
before the correction, while equivalent fully framed control tests passed.
Tests exercise absent, incomplete and reformatted framing; both partial-return
directions; English, Persian and mixed input; omitted and invented values;
conflicting return directions; conditions, exclusions, negation, quantities,
dates and multiple actions. Browser interception verifies the original request
is visible in desktop and mobile reviews and survives clarification, edit and
refresh. One provider call remains the normal path; no repair call or
additional per-request provider charge was introduced.

The deterministic guards are deliberately not a complete language parser:
an unrecognised modifier or action omitted by a model can still reach review,
and conservative checks may also reject harmless wording. Users must compare
the original request with the proposed change; this is not a guarantee of
perfect interpretation. No authorised configured provider was available for a
repeat comparison, so corrected real-model quality, provider latency and
actual token cost are unmeasured and need local validation. The original
invoice and four-minute incident remain unverified. The release recommendation
above remains **not ready**.

Checks for this correction, using the disposable `semantics_red_626d61c5`
database, intercepted browser responses and no provider credentials:

- `pytest -q tests/test_assistant_actions.py`: 114 passed before the final
  additional safety checks; a 77-case action/safety selection also passed
  before those final checks.
- Final `pytest -q tests/test_assistant_actions.py -k 'imperfect_framing or
  requests_specific_clarification_for_unresolved_semantics or
  reports_domain_resolution or additional_detail or ai_move_paraphrases or
  ai_records_past_loan or ai_records_persian_past or
  ai_records_mixed_language_borrowed_return or natural_item_detail_edit or
  mixed_language_condition or plan_requires_safety_fields'`: 35 passed.
- `pytest -q tests/test_assistant_actions.py -k
  'invalid_model_json_has_schema_reason or
  offline_provider_failure_preserves_deterministic_actions'`: 2 passed after
  the final diagnostic mapping change.
- `ruff check housetory_api tests` and `ruff format --check` on the three
  changed Python files: passed.
- `npm run build` and `npm test -- src/pages/assistant-page.test.tsx` in
  `apps/web`: build and 16 tests passed.
- `npx playwright test -c playwright.stage-b.config.ts -g 'a reviewed action
  becomes|duplicate action targets can be clarified'`: 2 passed.
- `npx playwright test -c playwright.stage-b.config.ts -g 'assistant move
  review edits|a stale move must be refreshed'`: 2 passed on a 390px viewport.
- `npx playwright test -c playwright.stage-b.config.ts -g 'pending proposal
  retains its original scope'`: 1 passed.
