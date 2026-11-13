# Stage B: integrated assistant

Branch: `feature/integrated-assistant`, based on accepted Stage A correction
`79ea841cd19757778b9f843e1e7251a4c8858161`. No deployment, main merge or
production-data operation was performed. Stage C has not started.

## Scope continuity correction

The assistant previously recreated its scope from the underlying page URL each
time the panel opened, making another scope's conversation and draft appear lost.
The first assistant view still starts from the current page or remembered scope;
its selection then lives in the authenticated shared store across navigation,
closing, reopening and full-page handoff. Assistant changes do not rewrite the
page URL or its remembered search scope. Existing scope validation and server
authorization remain in effect. Answers and New conversation no longer update
the page search session when its scope differs from the assistant's.

The household and property browser regressions both failed before the fix and
pass afterward. They cover separate URL filters, drafts, navigation, full-page
handoff and a delayed property-scoped response while switching scopes. A
component regression also covers first opening after navigation, property scope
revalidation and isolation from another scope's search history. The tests use
synthetic API responses, not a live provider or production data.

Correction validation: full web suite **371 tests passed** and the production
web build passed. All **six** Stage B browser tests passed at their configured
mobile and desktop widths; the two scope regressions also passed after their
final assertions were added. No backend code was changed in this correction.

## What changed

The authenticated app provides a desktop assistant panel and a mobile full-screen
sheet, with the original full-page view sharing the same in-memory conversation,
draft and pending request. Conversations are kept separately by selected scope.
Opening the mobile sheet focuses its heading, not a text field. Existing direct
controls remain available.

Item, document, room, location and selected-item pages register visible context.
The client sends IDs and kinds, not displayed labels; the existing search service
resolves them again against the authorised household and property on every request.
Explicitly named alternatives take precedence or trigger clarification when
references conflict. Singular references to multiple selected records clarify;
the interface explains its 12-reference limit instead of submitting a partial
selection. A pending request retains its original scope and targets.

The assistant reuses the existing document upload, processing status and editable
extraction review, including local/manual review. Review edits survive switching
between assistant views; inactive reviews stop polling and household changes
unmount the previous household's review. No second extraction path or Stage C
assistant action/apply contract was added.

## Acceptance and evidence

| Requirement | Evidence / status |
| --- | --- |
| Shared surface, conversation and drafts | Component tests cover remounts, in-flight requests and scope changes; synthetic browser tests cover closing, reopening and full-page handoff at 390 and 1440px |
| Scope and authorised page context | Backend tests cover IDs, property and household restrictions, revocation, deleted records, conflicting names, ambiguity and forged labels; browser tests inspect selection and submitted IDs |
| English, Persian and mixed follow-ups | Focused deterministic/backend regressions; broader natural-language interpretation is not certified |
| Document capture, progress and editable review | Existing Stage A workflow reused; two synthetic browser tests cover capture and edit retention across views |
| Offline/manual failure | Component test retains the draft on network failure; scope-loading failure does not silently widen the selected scope. This is not a full network-isolated deployment test |
| Mobile focus and layout | Synthetic browser tests verify non-editable initial focus, focus restoration, simulated viewport resize and page width; physical devices and keyboards not tested |
| No Stage C actions | No new reviewed-write or autonomous assistant actions implemented |

[Mobile screenshot](assistant-stage-b-mobile.png) and
[desktop screenshot](assistant-stage-b-desktop.png) show intercepted synthetic
responses, not real household data or model output.

## Validation

- Web: `npm test` — 70 files, 368 tests passed; `npm run build` passed.
- Browser: `npx playwright test --config playwright.stage-b.config.ts` — four
  passed; `npx playwright test --config playwright.stage-a.config.ts --grep
  'assistant (document review|capture)'` — two passed. Both use synthetic
  intercepted API responses.
- Backend: isolated PostgreSQL 16, `pytest -q tests/test_unified_search.py` —
  32 passed. The full API suite also passed on a separate isolated database;
  it started before the final two focused contextual regressions were added.
  Ruff lint and changed-file format checks passed.

## Limitations

Page-target detection is a conservative name-based heuristic, not a guarantee
for every ambiguous or multilingual utterance. It reads names within the
authorised scope and may add work on large inventories; latency at scale has
not been measured. Provider tests use mocks: real-provider output quality,
consent behaviour under a live provider and real-provider latency were not
independently tested. The original failing invoice and four-minute incident
remain unverified, as recorded in the Stage A report.

Conversations and drafts persist while the authenticated app remains mounted,
not across browser reloads or devices. Document review instances are retained
within the current household to preserve edits, so opening many different
reviews can increase memory use. A simulated viewport is not a physical mobile
keyboard or touch-device test. Stage D's real-provider, network-isolation,
RTL and whole-journey release validation remains outstanding.
