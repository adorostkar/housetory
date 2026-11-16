# Product design review

Date: 2026-11-16 · Reviewed at `651f71d` (`feature/tool-using-assistant`) · Analysis only, no application code changed.

## Verdict

Housetory's core is sound: browsing, lookup, manual entry and lending work without AI, the layout holds at 375px, and the header search/assistant entry is the right centre of gravity. The main weakness is accumulation. Each stage added a capability beside the previous one instead of replacing it, so the same job can now be done in several places that behave differently, and the screens carry a lot of text explaining themselves.

The most valuable next work is removal and merging, not new features. Three items matter most:

1. **Make the assistant panel and the Add items dialog one capture experience.** They feed the same pipeline but end in different review screens.
2. **Retire the superseded search/assistant stacks and orphaned pages.** About 2,500 lines of pages and tests are unreachable or unlinked, and three interpretation layers coexist on the server.
3. **Cut explanatory and operator text from everyday screens.** Settings is 666 words and 3,750px tall on desktop; the Review page is 321 words before any suggestion is shown.

## How this was assessed

- Read the README, `ARCHITECTURE.md`, and the design documents in `docs/` (assistant plan, unified search, simplification, review, responsive).
- Mapped routes, navigation, pages, endpoints and their callers by reading and searching the code.
- Ran the app against a disposable database, API and worker with synthetic data, and captured 23 screens at 1440px and 375px plus the Add items dialog, mobile More menu and header search. Screenshots are kept outside the repository.

Limits: no AI provider was configured for this walk-through, so assistant behaviour with a model rests on the earlier controlled-provider journeys. The data was one household with one property. Document scanning, stocktake and label printing were viewed but not exercised end to end.

## What already works well

- **Header entry.** Typing gives local matches with no model call; Enter without AI filters Items (`/items?q=ladder`); attachments and voice start from the same box.
- **Offline core.** With no provider, every inventory screen loaded, and the AI-dependent controls seen (scan, review, item image) said why they were unavailable.
- **Mobile layout.** None of the 23 screens overflowed horizontally at 375px, and the five-slot bottom bar is clear.
- **Explicit approval.** Proposals, captures and review suggestions all require a deliberate apply, with stale checks and idempotency behind them.
- **Shared review module.** The compact conversational review and the full Review workspace use one implementation.
- **Visual character.** Calm, consistent and distinctive. Nothing below requires changing it.

## Verified problems

### Essential

**1. Two front doors to the same capture pipeline, with different endings.**
The Add items dialog accepts text, a link, a photo or speech, then navigates to a full-page review at `/imports/:id` (`smart-add-input.tsx:182-225`). The assistant composer accepts the same inputs and shows the review inline in the panel. Both call the same import and recognition services. A user who adds a box of items one way and a receipt the other learns two flows, and unfinished work appears in different places.

**2. Orphaned and unlinked pages.**
- `pages/search-page.tsx` (560 lines, plus a 362-line test) is imported by nothing; `/search` redirects.
- `/scan` (848 lines) and `/recognize` (604 lines) are routed but no screen links to them. They are reachable only by typing the URL, and each presents a third and fourth capture flow with its own explanations.
- `/imports` is linked only from the assistant and from its own pages.

**3. Three interpretation layers on the server.**
- Current: the tool engine (`services/assistant_tools/`).
- Fallback: `/assistant/actions/intent` and `/interpret` in `api/routes/assistant_actions.py` (2,088 lines, 36 regular-expression calls), plus 17 pattern checks in `lib/assistant-conversation.tsx` (1,218 lines).
- Older: `global_assistant`, `unified_search`, and `assistant/planning.py` (30 regular-expression calls), still wired to `/search/query`.

`POST /assistant/query`, `POST /search/natural` and `GET /search/items` have no frontend caller, yet `ARCHITECTURE.md:154` still documents them. The effect on users is inconsistency: the same sentence can be understood with AI on and rejected or routed differently with AI off, because different code decides.

**4. Several kinds of "pending" with separate storage.**
Imports, document extraction, photo recognition and voice suggestions each have their own proposal model; inventory-review suggestions and assistant action proposals add two more. The header badge sums two of these (review suggestions and capture reviews). Action proposals awaiting Apply are not counted, so the badge can read zero while a prepared return is still waiting in the conversation.

**5. Everyday screens carry operator and reassurance text.**
- Settings (desktop): 666 words, 3,750px; 5,350px on mobile. It shows deployment variable names (`AI_CREDENTIAL_KEY`, `BRAVE_SEARCH_API_KEY`, `MANUAL_SEARCH_URL`), a backup script path and iPhone install instructions inline.
- AI providers: 282 words and 18 inputs before any provider exists, including credential-rotation instructions.
- Review: 321 words; "Review again", "Reconsider dismissed" and AI consent are all visible before the first run.
- Scan: three side cards ("How this works", "Accuracy note", "Contextual scan") beside a control that is disabled without a vision model.
- "Nothing is written/changed/created until…" appears in roughly twenty wordings across the app.

**6. Visible defects found while walking the app.**
- Import page placeholder shows literal `\n` characters (`imports-page.tsx:186`).
- Containers page search field collapses to about two characters ("Se") at 1440px.
- Items filter placeholder is cut off ("Choose a roon…").
- Mobile shows Loans both in the bottom bar and in More.

### Optional

**7. Too many ways to submit a search.** With text typed, the dropdown offers "Ask the assistant: “ladder”", "Ask Housetory" and "View all results", plus Enter and Shift+Enter. Enter already does the right thing.

**8. Add items is repeated.** On Overview and Items the sidebar button and a page-header button appear together; room and container pages add a third.

**9. Overview promotes rare tasks.** "Create insurance list" and "Export evidence" sit beside "Add items" in the page header. Purchases and warranty sections render explanatory empty states when there is nothing to show.

**10. Item page shows setup for features most items never use.** "Store items inside" and "Image source · Setup required" cards appear on every item. The loan caveat ("recorded home, not a current physical location") is stated twice on a lent item.

**11. Location breadcrumbs repeat the obvious.** Every card reads "Housetory Phase Five / Home / Workshop" even with one household and one property.

**12. Documentation has outgrown its usefulness.** `docs/` holds 40 documents and 195MB of images; the README is 1,347 lines and `IMPLEMENTATION_PLAN.md` 2,523. `UNIFIED_SEARCH.md` and `SIMPLIFICATION3.md` describe a Search page and Assistant navigation that no longer exist.

## Hypotheses (not verified)

- **Low-use features.** Stocktake, label printing with sheet calibration, insurance lists, evidence export, valuation and online manual/image lookup look like occasional tasks. No usage data exists to confirm this; ask the people using the app before demoting any of them.
- **"All my places" default.** For a single-household user the scope selector in the panel and the household name in breadcrumbs may be pure noise. Seen only with one household.
- **Review controls.** "Review again" and "Reconsider dismissed" are probably needed rarely enough to sit behind one disclosure.
- **AI task settings.** Six tasks, a default text model, per-task overrides, vision, voice, per-provider cloud consent, two online-search switches, an auto-image switch and a schedule consent may be more than a household owner can reason about. One model choice plus one "allow cloud" consent might cover nearly everyone.
- **Model compliance.** The assistant's two-field answer contract depends on the model using the fields as described; this has only been checked with a controlled provider.

## Remove, merge or simplify

| # | Proposal | Benefit | Trade-off |
|---|---|---|---|
| 1 | **Merge** Add items into the assistant panel: the button opens the panel with the composer focused and the current room/container as context; reviews always render inline. | One capture flow and one place for unfinished work. | The compact dialog is quicker to dismiss; keep "fill in the form yourself" as the manual path. |
| 2 | **Remove** `search-page.tsx` and its test. | 920 lines gone with no behaviour change. | None. |
| 3 | **Remove** `/scan` and `/recognize` pages, redirecting to the assistant with attachment. | Two fewer capture flows and about 2,000 lines. | Scan's default-destination pickers go; the panel's context and editable review cover it. |
| 4 | **Retire** `/assistant/query`, `/search/natural`, `/search/items` and the services only they use. | Smaller surface, accurate architecture document. | Check for external scripts using these endpoints first. |
| 5 | **Simplify** the no-AI fallback to: local search results plus direct links to forms. Drop phrase-based action interpretation. | One interpreter; offline behaviour becomes predictable. | Typed actions such as "lend the drill to Sam" stop working without AI; the forms remain two taps away. |
| 6 | **Merge** pending work into one count and one list (review suggestions, captures, action proposals). | The badge means "things waiting for you". | Needs a small read endpoint; storage can stay separate. |
| 7 | **Simplify** Settings into short pages: Household, AI, Online lookup, System. Move variable names, rotation and backup instructions to documentation behind a link. | Settings becomes scannable. | Self-hosters lose inline operator hints; a link preserves access. |
| 8 | **Simplify** AI settings to one default model, vision and voice, with overrides behind the existing Advanced section collapsed and empty states trimmed. | First-time setup is one decision. | None for existing overrides. |
| 9 | **Simplify** assurance text to one standard line on review surfaces only. | Less reading; the promise is clearer said once. | Slight loss of local reassurance. |
| 10 | **Simplify** the search dropdown to matches plus one "Ask the assistant" row. | Fewer choices at the moment of typing. | Shift+Enter users lose a visible hint. |
| 11 | **Simplify** Overview: keep Add items; move insurance list and evidence export under Financials; hide empty Purchases/Warranty sections. | Home shows what the user has. | One more tap for insurance and export. |
| 12 | **Simplify** the item page: move "Store items inside" and image-source controls into the item actions menu. | The page leads with facts and photo. | Slightly less discoverable. |
| 13 | **Merge** Rooms and Containers into one Places section with a type filter. | One mental model for "where things live". | Larger change; containers' label/QR actions need a home. Lowest priority. |
| 14 | **Remove** the duplicate Loans entry in mobile More; hide household/property in breadcrumbs when only one exists. | Small noise reductions. | None. |
| 15 | **Simplify** documentation to a short README, one architecture document, and an archive folder for stage reports and walkthrough images. | Current behaviour is findable. | Loses in-tree history unless archived. |

## Suggested order

1. Fix the four visible defects (item 6 above) and remove dead code (rows 2 and 14).
2. Merge Add items into the panel and retire Scan/Recognise (rows 1 and 3).
3. Unify the pending count (row 6).
4. Retire superseded server stacks and simplify the offline fallback (rows 4 and 5). This needs a decision: it removes typed actions without AI.
5. Trim Settings, AI settings and assurance text (rows 7–9).
6. Optional polish (rows 10–12, 15); consider row 13 only after the rest.

## Implementation status

Implemented on `feature/product-simplification`. Row numbers refer to the table above.

| Row | Outcome |
|---|---|
| 1 | **Adjusted.** The Add items dialog stays as the quick entry, because its place picker, camera buttons and "fill in the form yourself" link are the fastest way to start. Its captures are now reviewed inline in the assistant panel, so every capture ends in one review surface. |
| 2 | Done. `search-page.tsx` and its test removed. |
| 3 | Done. `/scan` and `/recognize` open Add items with their place context; the pages, their test and `lib/recognition.ts` are removed. |
| 4, 5 | **Not done, deliberately.** The three unused endpoints are thin routes over services that `/search/query` still uses, and about fifty backend tests enter through them. Removing them saves little and loses coverage. The phrase-based fallback is what keeps typed actions working without AI, so removing it would cut offline capability. |
| 6 | Done as a count and a list. Prepared actions waiting for Apply now count in the header badge and appear on the Review page, where they can be reopened or cancelled. Storage stays separate. |
| 7 | Partly. Online-search setup, iPhone install and credential instructions are collapsed until needed; Settings is still one page. |
| 8 | Partly. Credential operations are collapsed; the provider and task layout is unchanged. |
| 9 | Partly. Removed from Overview and the item page; review surfaces keep their own wording. |
| 10 | Done. One "Ask the assistant" row; the duplicate buttons are gone where the panel is available. |
| 11 | Done. Insurance list, evidence export and new room are in one Home actions menu on every size; the empty warranty section is hidden. |
| 12 | **Adjusted.** "Store items inside" stays visible with one line of text instead of moving into a menu; the duplicated loan caveat is removed. |
| 13 | Done as **Places**: one navigation entry, Rooms as the starting tab and Containers one tab away. Both pages keep their own behaviour, including label and QR actions. Room and container detail pages keep the Places entry highlighted. |
| 14 | Partly. The duplicate Loans entry is gone; breadcrumbs still show household and property. |
| 15 | Not done. Two superseded documents carry a note; the wider documentation clean-up remains. |

Also done: the four visible defects, restored conversation history now appears above a newly opened capture, and a capture already on screen no longer raises a separate "ready" notification. The valuation dialog, unwired from the interface by an earlier simplification, is removed; its server endpoints remain.

## Scale, for context

About 56,000 lines of frontend and 77,000 lines of backend code (excluding tests), 75 tables, 33 authenticated routes, 83 documented environment variables and 52 browser test files, for a household inventory. The numbers are not a problem in themselves, but they explain why consistency is hard to keep and why removal now pays more than addition.
