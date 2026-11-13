# Stage A: invoice capture review

Branch: `feature/integrated-assistant`. Base: `origin/main` at `85b3ece`.
The original brief is committed as `f106322`.

Stage A implementation and validation are complete. Nothing has been deployed,
no pre-existing application data or database has been changed, and Stage B has not started.
The supplied brief remains the scope; this is not the shared-conversation rework.

## Evidence and root causes

**The reported four-minute real-invoice incident is not closed.** No failing
invoice, affected deployment trace, or authorised real-provider configuration was
supplied. The default local Ollama endpoint was not listening. Synthetic/provider
stub tests are not evidence of real model quality or a production latency SLA.

The existing path was inspected before editing:

| Step | Existing module reused |
| --- | --- |
| Add capture | `SmartAddInput`, `DocumentUploadDialog`, `POST /documents` |
| Original storage and local work | `services/documents.py`, `document_ocr.py`, `ocr.py` |
| Deterministic proposal | `document_extraction.py` |
| Optional configured AI | `enrichment.py`, `document_refinement.py`, `ai.py` |
| Queue execution | PostgreSQL `Job`, `jobs.py`, existing worker roles |
| Review and explicit application | `DocumentExtractionReview`, `document_extraction_apply.py` |

Local OCR and optional AI already had separate queues. Stage A does not claim
that separation was missing, nor that priority alone can interrupt a running
provider call.

### Confirmed extraction defects

A detached source archive of the exact `origin/main` baseline was executed
against the same synthetic fixture bank. No checkout or database was changed.

| Source case | Baseline result | Stage A result |
| --- | --- | --- |
| Grouped Nordic decimal amounts | Total 625 cents; drill unit 246 cents, line 900 cents | Total 308625; quantity 2, unit 123450, line 246900 |
| Credit note | Negative total and line became positive 1000 cents | Signed total and line remain -1000 |
| Unreadable product amount | Product line disappeared | Product retained with null amount and explicit attention checks |
| Ambiguous date and dollar symbol | No ambiguity warning | Typed date/currency attention checks |

The old grouped-number case already emitted a total-mismatch warning. That
warning did not repair the amount tokenisation. Stage A fixes the parsing and
adds shared typed reconciliation rather than pretending no validation existed.
Repeated descriptions at different prices remain separate records.

PDF evidence mapping also needed boundary-whitespace normalisation: individual
page text retained trailing newlines, while combined OCR text was stripped.
The regression now maps evidence back to its original page.

Two actual apply regressions were reproduced before their fixes:

- Applying cached AI suggestions after cancellation returned 200 and created an
  item. It now returns 409; local/manual review remains applicable.
- Sending signed credit evidence through an ordinary positive purchase reached a
  negative-allocation database constraint and was misreported as request-ID reuse.
  It now returns a deliberate 422 before writes. Refund accounting is not added.

## Changes

Add accepts supported PDF/document files through the existing upload path. Image
capture makes evidence-versus-inventory intent explicit; a chosen invoice does
not first go through redundant object recognition. Existing photo, text, voice,
manual entry and place-context paths remain available, including mobile
non-editable initial focus.

Review prefers one AI-assisted draft when ready. Local/manual review is available
while AI runs, and edited drafts are not silently replaced by late suggestions.
Original evidence, unknown values, quantity, source unit price, reviewed line
total and shared purchase total remain distinct. Credit evidence stays readable,
but ordinary purchase application is blocked with an explanation. Link/create/
exclude choices and existing transactional/idempotent application remain explicit.

Shared financial validation reports inclusive/exclusive/unknown tax treatment,
known product and charge totals, differences, and actionable per-line checks.
It preserves source amounts instead of silently balancing them. Old deterministic
extractions are rebuilt when their extractor version is stale.

Processing has correlated waiting/reading/interpreting/ready/attention/failure/
cancellation states, elapsed time, local availability, cancel/retry and worker
availability. The UI polls active processing every second, gives an honest slow
message after 15 seconds, and does not fabricate percentages. Local/manual entry
is available earlier than the 60-second fallback budget.

Normal review's Refine and Re-rank actions enqueue interpretation or matching
through `POST /documents/{id}/processing/retry`, rather than calling a provider
inside an API request. Both use the same progress, cancellation and proposal
review lifecycle. Deterministic Refresh matches remains local. Duplicate active
actions are disabled, enqueue errors are visible, and late responses cannot
replace a newer cancellation state or edited review.

### Scheduling and bounded execution

Reserved lanes execute supervised, non-daemonic job children. Actual worker-role
tests exercise local OCR and queued AI matching through these lanes, not merely
queue claims or heartbeats. On POSIX, cancellation, deadline and graceful
shutdown terminate the job's process group, including local OCR descendants.
Abrupt supervisor termination and independently detached descendants are outside
that graceful-cleanup guarantee.

The existing local and AI worker roles now reserve `documents` and `ai-documents`
lanes alongside their ordinary queues. The interactive budget is 90 seconds,
including queue wait, beginning after server-side upload storage/preprocessing.
One- to three-page work is interactive; larger PDFs are explicitly background
work with the configured page limit. This is not a network-upload deadline.

**Isolation correction:** previously, every document AI job, including a
background document, entered the serial `ai-documents` lane. A running slow
background call therefore blocked an interactive invoice despite the lane's
priority. Background document interpretation and matching now use the general
`ai` lane; only interactive document AI uses `ai-documents`. Background document
jobs retain subprocess supervision, cancellation and their persisted deadline.
The general `ai` lane also uses best-effort actor fairness at equal priority.
Background documents can still wait behind other general AI work; this change
does not promise separate background capacity or global provider concurrency.
Processing diagnostics use the actual assigned AI queue for worker availability.

On worker startup and periodic legacy routing, queued document AI jobs in the
old `default`, `ai` or `ai-documents` lanes are assigned according to their
persisted mode, with missing correlation metadata recovered from the document.
Running jobs are not moved or interrupted by routing. During a later authorised
rollout, coordinate compatible API and worker replacement; already-running old
worker calls must finish or be deliberately stopped before the new isolation
guarantee applies.

Cancellation prevents publication and application of the cancelled proposal,
including after a subsequent retry. It cannot guarantee that a remote model
stops generating or charging after its connection is closed. Actor scheduling is
best-effort fairness within a queue, not global cluster fairness; provider
concurrency remains per process rather than a distributed inference lease.

Local queue and processing timings remain available after completion and AI-only
retry. `validation_ms` measures interpretation schema, evidence and financial
validation; matching leaves it `null` because that phase is not separately
instrumented. Upload diagnostics cover server storage/preprocessing, not network
transfer. Legacy external clients of synchronous `/extraction/refine` and
AI-enabled `/extraction/matches` remain compatible but are outside the queued
deadline/cancellation guarantees; the normal review UI no longer uses them.

## Measurements

### Local PDF/image pipeline, external network blocked

Canonical extraction plus actual bundled Poppler/Tesseract, not mocked OCR.
Environment: Linux aarch64/glibc 2.36, Python 3.12.16, Tesseract 5.3.0, Poppler
22.12.0. A new read-only container had no network, two CPUs, a 1 GiB memory limit
and a 256 MiB temporary filesystem. Current API source was mounted read-only.
There was no database or provider/model call.

Seven fixed cases were rendered into each of three formats; three samples per
case/format: **21 combinations, 63 timing samples**. All 21 checked output
proposals match their expected fields, reconciliation/uncertainty and page
evidence. Ambiguous/unreadable fixtures are expected to require attention.

| Input | Pages | Samples | Median local time | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Embedded-text PDF | 1 | 21 | 0.867 ms | 1.278 ms | 97.902 ms |
| PNG, actual OCR | 1 | 21 | 401.792 ms | 433.620 ms | 440.974 ms |
| Image-only PDF, actual OCR | 3 | 21 | 1165.717 ms | 1214.611 ms | 1218.290 ms |

These are nearest-rank percentiles across a small synthetic fixture set, not
field percentiles. The first cold embedded-PDF sample is included in the maximum.
Fixture rendering is excluded; reading/OCR, parsing and validation are included.
Upload, authentication, queue wait and model latency are excluded, not zero.
[Per-case samples and quality results](assistant-stage-a/benchmark-local.json)
separate reading and parse/validation timings.

Reproduction with an installed API environment and bundled OCR tools:

```sh
PYTHONPATH=services/api services/api/.venv/bin/python \
  scripts/benchmark_invoice_stage_a.py \
  --fixtures services/api/tests/fixtures/invoice_stage_a.json --samples 3
```

The recorded network-blocked run used `docker run --network none --read-only
--cpus=2 --memory=1g --tmpfs /tmp:rw,noexec,nosuid,size=256m`, the preinstalled
`king-constants-scan-worker:test` image, and read-only mounts of the current
`services/api` directory and benchmark script. No running application container
was used for fixtures.

### Progress and screenshots

Chrome at 390px and 1440px with synthetic, entirely intercepted API responses:
one observed server-stage change reached the UI in **802 ms**. This is one
reference observation, not a p95 guarantee. Six browser regressions cover
progress/local fallback, cancel/reload persistence, late AI versus manual edits,
one coherent editable AI-assisted review without horizontal overflow, and both
bounded queued review actions with edit preservation and duplicate guards.

| | Mobile | Desktop |
| --- | --- | --- |
| Progress | [Screenshot](assistant-stage-a/progress-mobile.png) | [Screenshot](assistant-stage-a/progress-desktop.png) |
| Review | [Screenshot](assistant-stage-a/review-mobile.png) | [Screenshot](assistant-stage-a/review-desktop.png) |

The browser fixture model name is deliberately synthetic. Screenshots do not
demonstrate model inference, an actual uploaded private invoice, or a hardware
mobile keyboard.

### Queue isolation reference

A retained real-worker regression uploads a synthetic four-page PDF and blocks
its provider call, then uploads an interactive invoice. Before the correction,
the interactive provider call did not start within 12 seconds while its local
OCR had completed. After the correction, it starts while the background job is
still running. The test then cancels that background job and starts an explicit
background matching retry; it verifies both queue assignments and actual provider
dispatch. Separate real-supervisor tests cover cancellation, deadline and shutdown
for both interactive and background modes, including descendant cleanup.
The provider is a local synthetic HTTP stub: this demonstrates worker isolation,
not parallelism or quality of a real model.

A final five-sample synthetic scheduling experiment used an 80 ms stalled handler:

| Lane | Dispatch waits (ms) | Median |
| --- | --- | ---: |
| Shared | 91.0, 86.2, 92.5, 90.5, 92.3 | 91.0 ms |
| Reserved | 3.8, 6.0, 5.7, 4.6, 2.5 | 4.6 ms |

Five samples do not establish p95. This demonstrates the scheduling mechanism
under that artificial workload, not deployed queue latency, real-model throughput
or the proposed healthy-deployment queue p95 target. It did not exercise a
background *document* and therefore did not detect the routing defect above.

## Validation and acceptance

| Check | Result |
| --- | --- |
| Final full API suite | 616 passed in 669.57 seconds, including final queued operations, worker topology, descendant cleanup and apply fencing |
| Focused backend integration | 95 passed before the final full-suite run |
| Full web suite | 69 files, 360 tests passed |
| Web production TypeScript/Vite build | Passed |
| New isolated browser regressions | Six passed; final screenshots recaptured |
| New browser fixture/config strict types | Passed using the existing app compiler options plus Node types |
| Python lint and changed-file format checks | Passed |
| API/worker production-image builds | Passed again after final worker and queued-operation corrections; validation-only tags |
| Installed worker imports and bundled OCR tools, WAN blocked | Passed |
| Real reserved-lane worker-role regression | Passed in both focused and final full-suite validation |
| Background-document isolation correction | 112 affected queue/OCR/enrichment/worker/apply tests passed. The retained real-worker test was red before the correction and green afterward. |

Validation caught a nested-process topology error that direct worker-handler tests
could not detect: a daemonic reserved-lane process cannot start its supervised job
child. Non-daemonic peers with supervised shutdown and actual-role regressions
correct this; fresh heartbeats alone are not proof that jobs execute.

The full suite ran only against the newly created isolated PostgreSQL 16 instance.
Tests recreate the database named by `HOUSETORY_TEST_DATABASE_URL`; never point
that variable at an existing application database. Final full-suite command:

```sh
cd services/api
HOUSETORY_TEST_DATABASE_URL="$DISPOSABLE_STAGE_A_DATABASE_URL" \
  TMPDIR="$OWNED_SHORT_TEMP_DIRECTORY" \
  .venv/bin/pytest -o addopts='' -q --tb=short
```

The short, independently owned temporary directory avoids native macOS
multiprocessing socket-path limits. The directly affected subset is:

```sh
cd services/api
HOUSETORY_TEST_DATABASE_URL="$DISPOSABLE_STAGE_A_DATABASE_URL" \
  TMPDIR="$OWNED_SHORT_TEMP_DIRECTORY" \
  .venv/bin/pytest -o addopts='' -q --tb=short \
  tests/test_document_extraction.py tests/test_ocr.py \
  tests/test_enrichment.py tests/test_jobs.py \
  tests/test_document_processing_worker.py tests/test_invoice_apply_cancellation.py
```

Web/browser commands:

```sh
cd apps/web
npm test -- --run
npm run build
STAGE_A_SCREENSHOT_DIR=../../docs/assistant-stage-a \
  npx playwright test --config playwright.stage-a.config.ts
```

The isolated browser configuration starts its own temporary server and intercepts
every API request; it does not run the normal mutating global setup or use an
application account. No dependencies or database migrations were added.

| Stage A acceptance item | Evidence / status |
| --- | --- |
| PDF/image evidence enters Add through existing document storage | Focused Add/upload tests; normal text/photo/voice paths retained |
| Supported financial fixtures correct or explicitly uncertain | Seven cases, all 21 rendered combinations match expectations |
| Original source/page evidence retained | PDF/OCR page regressions and offline benchmark checks |
| Coherent AI-assisted review with usable local/manual fallback | Unit/browser regressions and desktop/mobile screenshots |
| No automatic trusted writes, duplicates or late edit overwrite | Existing apply/isolation/idempotency tests plus delayed-AI browser case |
| Cancellation stays authoritative after retry | Configured retry/apply regression; prior committed replay remains idempotent |
| Bounded interactive work, capacity reservation and fairness | Actual-role execution, deadline, cancellation, descendant cleanup and actor-scheduling tests passed; synthetic queue comparison above |
| Missing-worker, failure, timeout and retry visibility | Processing/worker regression suites and progress tests |
| Progress within proposed two-second budget | One mocked reference observation: 802 ms; one-second active polling |
| Healthy deployment queue p95 <=2 seconds | Not established by the small queue simulation |
| Named real-model 1-3-page p95 <=45 seconds | Not verified: no available authorised model |
| Reported failing real invoice and four-minute incident closed | Not verified: invoice and affected trace not supplied |
| No deployment, production mutation, main merge or Stage B work | Preserved; feature branch only |

## Limitations and review boundary

The proposed named-real-model 1-3-page p95 <=45-second budget is **unverified**.
The failing real invoice and its four-minute trace are still required to close
that incident. Useful diagnostic evidence is the document correlation ID, content
generation, page count/format, task/provider/model, worker availability, stage
timestamps, attempts and safe failure reason. Do not attach API keys, complete
prompts, raw private OCR or private invoices without explicit approval.

The existing cent-based purchase representation is unchanged. This is not a
complete ISO currency engine, fractional-quantity accounting, refund ledger,
complex VAT/line-discount parser, RTL/non-Latin-digit OCR quality certification,
or severe-camera-corruption fix. Ambiguous or unsupported evidence requires
review; none of those cases may justify fabricated amounts.

Expired queued work cannot start a provider attempt after its deadline. If no
worker or status reader is running, expiry is not autonomously persisted at the
deadline; a later worker/status read records it. A later authorised rollout must
upgrade compatible API and workers together: older workers do not consume the
new reserved queues. No rollout has been performed here.

Offline means an installed server/browser communicating locally with bundled
tools, not disconnected-browser synchronisation or guaranteed offline speech
recognition. No new cloud failover, model download, conversation shell, vector
database, automatic trusted write or Stage B feature is included.

**Stop here for Stage A review.** Later approved stages must continue on
`feature/integrated-assistant`; no merge to `main` or deployment is authorised.
