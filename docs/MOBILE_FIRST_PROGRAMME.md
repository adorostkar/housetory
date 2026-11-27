# Mobile-first programme

This file is the working plan for the mobile-first programme. It holds the plan,
the decisions, the progress, the checks done and the known limits. The product
specification itself is not copied here.

Branch: `feat/mobile-first-programme` (from `origin/main` at `f026cae`).

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Three new UI designs in Figma | Done. **Design D approved on 26 Nov 2026.** |
| 1 | Shared mobile behaviour, shell and navigation | Done (see "Phase 1 record") |
| 2 | Capture, documents and reviews | Done (see "Phase 2 record") |
| 3 | Natural assistant behaviour | Done (see "Phase 3 record") |
| 4 | Inventory-first navigation and everyday flows | Done (see "Phase 4 record") |
| 5 | Secondary flows and account design | Done (see "Phase 5 record") |
| 6 | Verification and final handoff | Done (see "Phase 6 record" and "Final checklist") |

All phases are finished and pushed to the branch. Nothing is merged or deployed.
What is not complete is listed plainly under "Not complete" near the end.

## Phase 0: the three designs

Figma file: <https://www.figma.com/design/LhPz2zaE6qKP28QfwvMNjA/?node-id=15-971>
(page "New UI designs · three structures"). The earlier colour studies are on the
page "Three directions · mobile first". They were not changed.

Prototype flows (or open the page and press Present, then pick a flow):

- A: <https://www.figma.com/proto/LhPz2zaE6qKP28QfwvMNjA/?node-id=16-9&starting-point-node-id=16-9&page-id=15%3A971&scaling=scale-down>
- B: <https://www.figma.com/proto/LhPz2zaE6qKP28QfwvMNjA/?node-id=17-9&starting-point-node-id=17-9&page-id=15%3A971&scaling=scale-down>
- C: <https://www.figma.com/proto/LhPz2zaE6qKP28QfwvMNjA/?node-id=18-9&starting-point-node-id=18-9&page-id=15%3A971&scaling=scale-down>

Each design has 11 screens and one foundations sheet: inventory, item detail,
three review states, add document, empty inventory, two dark screens, a 320 px
phone with large text, and one desktop screen. All three use the same content.

| | A · Index | B · One bar | C · Rooms |
| --- | --- | --- | --- |
| Organised by | Destination | Intent | Location |
| Navigation | Five tabs: Items, Places, Add, Loans, More | Text tabs on top, one bar at the bottom for find, ask and add | Rail of rooms on the left, Add button, More in the rail |
| Search and assistant | Field at the top of Items | The bottom bar | Field at the top of the list |
| Item detail | Its own page, sections open in place | Sheet over the list | Its own page, place and "right now" first |
| Correct a finding | Fields open inside the row | Tap a value, type it in the bar | Bottom sheet with choices |
| Skipped findings | Message with Undo, plus "Skipped 1" | Thin row stays in the list with Undo | "Skipped (1)" drawer at the end |
| Add document | Page, Save button, options closed | Sheet, type chips, Save button | Saved at once with Undo, options after |
| Look | Cream, ink, sage, brass, serif titles | Warm white, deep green, round | Kraft paper, stamp blue, boxy, mono codes |
| Fonts (all OFL) | Source Serif 4, Source Sans 3 | Instrument Sans, Instrument Serif | Bricolage Grotesque, Figtree, DM Mono |

Icons are Lucide in all three (already in the app, no new dependency).

There are also clickable HTML mocks of the three designs, with sample data. They
are kept outside the repository and run only on the local machine. In them the
core flows work: open an item, review a photo, correct a finding, add a document.
In C the room rail can be hidden and shown again.

### Recommendation

**A · Index**, as the base.

- It is the safest for daily use: every area has a fixed place, and rows hold the
  most items per screen. It still works at 320 px with large text.
- It keeps the Housetory look that people know.
- It has no stacked sheets and no editing bar above the keyboard. Both are real
  risks in an iPhone PWA.
- B is the best for one-hand use and for the assistant, but it stacks sheets and
  asks people to learn a new way to edit.
- C is the best for "where is it" and for moving things, but the rail costs
  width on small phones and the review shows fewer findings at once.

Two ideas from the others fit A well and can be taken if wanted: the row that
stays in the list for a skipped finding (B), and saving a document at once with
Undo (C).

### Design D: the combined design

After trying A, B and C, a fourth design was worked out in the clickable mock.
It is not in Figma. **This is the approved design.** These choices are settled:

- **Layout and interactions:** as in the D mock, described below.
- **Colours:** four colour themes, chosen in Settings. Each has a light and a
  dark form.
  1. **Current Housetory** (default): the colours the app has today.
  2. **Design D**: kraft paper and stamp blue, from the mock.
  3. **Field notes**: warm paper and forest green, from the earlier Figma study.
  4. **Collected**: soft cream, terracotta and plum, from the earlier Figma study.
     Figma has no dark form for it, so the dark form is derived.

  A theme changes colours only. Fonts and shapes are the same in all four, and
  no font files are added. Shapes are round. Checkboxes stay square.
- **Rooms:** a rail on the left. It scrolls when there are many rooms. "All"
  stays on top; "On loan" and "More" stay at the bottom. With several homes, a
  home tile sits at the top of the rail.
- **Rail button:** at the left end of the bottom bar, in the same spot when the
  rail is open or hidden. The rail is hidden completely. It is open the first
  time and then stays as the user left it. When it is hidden, the title shows
  the room, and tapping the title opens the rail.
- **Bottom bar:** show/hide rooms, the search field, Add. The field keeps the
  robot, attach and microphone buttons that the app has today. Typing filters
  the list. Enter sends the text to the assistant.
- **Assistant:** the robot button opens it, as in the app today. It opens as a
  sheet that can go to full height. It follows the planned assistant behaviour
  of Phase 3.
- **Item:** a full page. Sections are tabs.
- **"This item":** on an item, the bar shows a "This item" chip, so text is
  about that item by default. The chip has an accessible × button on the phone
  and on desktop. Removing it widens the scope to the whole inventory. The
  assistant must also follow an explicit change of subject while the chip is
  there (for example asking about another thing by name).
- **No question-mark shortcut:** the mock treated text ending in "?" as a
  question and other text as a note. That was a mock trick and is not built.
  The planned assistant behaviour decides what the text means.
- **Review:** photo with numbered pins on top. Tap a value and type the
  correction in the bar. Skipped findings move to the end, with Undo.
  *(Built differently: no pins, and corrections are made in the row. See
  "Where the app differs from the Design D mock".)*
- **Documents:** saved as soon as the file is chosen, with Undo. Details after.
- **Add and attach:** both open a small menu at the button that was pressed. On
  the phone it is a sheet from the bottom. On desktop it is a menu above the
  button. The chosen task opens after that.
  *(Built differently: + opens the existing Add items surface and the
  paperclip opens the file chooser. See the same section.)*
- **More:** its choices roll up over the rooms, inside the rail (Loans,
  Documents, Places, Purchases, Insurance, Stocktake, Settings). The More tile
  turns into Close, which brings the rooms back. A chosen page opens next to
  the rail.
- **Desktop:** the rail becomes a sidebar with room names, the bar stays at the
  bottom of the list, and an item opens in a panel on the right. Reviews, documents
  and editing open in the same panel. The sidebar is always open on desktop, so
  the bar has no show/hide button there. The "findings to review" notice sits in
  the sort and filter row. The mock has this view.
- **Items that hold things** (a car, a toolbox): unchanged from today. The item
  page gets a Contents tab, grouped by the places inside.

### Decision

**Design D is approved** (owner, 26 Nov 2026), with these points:

1. Use D's layout and interactions. Offer four colour themes: Current Housetory
   (default), Design D, Field notes and Collected.
2. The "This item" context can be removed on the phone and on desktop with an
   accessible × control. Removing it widens the scope. The assistant must also
   understand explicit changes of subject.
3. The mock's question-mark-versus-note shortcut is not built. The planned
   assistant behaviour is used.
4. Bottom-bar space and real iPhone keyboard behaviour are tested after the
   implementation, and problems are corrected then.

The specification said not to build a theme chooser in this programme. The
owner asked for the four colour themes with the approval, so that request wins.

A, B and C are not built. The clickable mock is thrown away; no code from it
goes into the app.

## Plan after the decision

1. **Phase 1.** Design D's shell: room rail (phone) and sidebar (desktop), the
   bottom bar with the search field and Add, the More roll-up, the item panel on
   desktop, and the four colour themes. Also: inventory-first start, touch
   targets, keyboard and safe areas, no focus zoom, Back/Close/Cancel rules,
   drafts and list position kept, reduced motion. Reproduce the Add-items Close
   problem before fixing it.
2. **Phase 2.** Document add flow and one shared review pattern for recognition,
   document extraction, imports and organisation suggestions.
3. **Phase 3.** Assistant: evidence, direct reversible actions with Undo through
   a server allowlist, compact sources, progress, stop and recovery. The "This
   item" chip with ×, and following an explicit change of subject.
4. **Phase 4.** Remove Overview, one item list with Recent/Newest/Name/Location,
   item detail, rooms and containers, loans, bulk actions, documents and purchases.
5. **Phase 5.** Settings index, insurance, stocktake, onboarding, and the written
   design for supplied AI next to bring-your-own-key.
6. **Phase 6.** Journey checks, tests, builds, and the final checklist in this
   file. Bottom-bar space and the keyboard are checked here. A real iPhone is
   needed for the keyboard check; what could not be checked on a device is
   listed plainly.

Each finished phase is committed and pushed. Nothing is merged or deployed.

## Phase 1 record

What was built:

- **Shell.** The old top header and the five-tab bar are gone. On a phone there
  is a rail of rooms on the left (All, each top-level room, On loan, More) and
  one bar at the bottom: show/hide rooms, the search and ask field, Add. On
  desktop the rooms are a sidebar with names and counts, and the bar sits at the
  bottom of the main column.
- **Start page.** `/` now goes to the item list (`/items`).
- **More.** Its choices (Places, Documents, Purchases, Insurance, Stocktake,
  Review, Settings) roll up over the rooms and roll down again. They stay up while one
  of their pages is open.
- **Rail.** It can be hidden. The choice is remembered on the device. The button
  keeps its place in the bar. With the rail hidden, the page title opens it.
- **Homes.** With more than one property, a home tile at the top of the rail
  chooses which rooms are shown. The list pages follow the same choice.
- **"This item" chip.** On an item, room, place or document page the field shows
  a chip. Its × removes the page from the question. It works the same on the
  phone and on desktop.
- **Assistant.** It opens as a sheet from the bottom on a phone and as a box
  above the bar on desktop. A button makes it full height. Its content is the
  same assistant as before.
- **Colour themes.** Current Housetory (default), Design D, Field notes and
  Collected, each in light and dark. The choice is kept on the device. The
  chooser is on the Appearance screen in Settings (Phase 5).
- **Touch.** On touch screens buttons, menu rows and dialog Close buttons are at
  least 44 px. The bar and rail targets are 44 to 54 px.
- **Keyboard.** The bar and the assistant sheet follow the on-screen keyboard
  (`--keyboard-inset`). Other bottom bars use `--shell-bar-height` to sit above
  the bar.

The Add-items Close problem:

- Reproduced on a 390 px phone layout. The sheet header is sticky and lay over
  the lower two thirds of the Close button. Taps there hit the header. Escape
  still worked, because it does not need the button.
- Fixed by putting the Close button above the header. An end-to-end check now
  presses the lower part of the button.

Decisions:

- The item panel on desktop moves to Phase 4, with the new item page. The old
  item page is too wide for a panel.
- In the bar on a phone, the field takes the whole width while it has focus, and
  attach and voice hide while there is text. Voice also hides when the chip is
  shown and the field has no focus. This is the first answer to the small space.
  It is checked again on a real iPhone at the end.
- The theme toggle in the header was removed with the header.

Checks:

- Type check clean. Unit tests for the rail, the chip and the themes.
- `e2e/navigation.spec.ts` was rewritten for the new shell and run against a
  throwaway local stack: 9 of 9 pass (desktop and 390 px phone).
- Contrast for the three new themes was computed from the colour values: text
  11:1 or better, muted text 5:1 or better, input borders 3.3:1 or better.

Not checked yet: a real iPhone, and the other end-to-end files. Many of them
still name the old navigation. They are updated in Phase 6.

## Phase 2 record

What was built:

- **Adding a document.** The file is saved as soon as it is chosen, dropped or
  photographed. Undo deletes it again. After that the surface shows a preview
  and the real reading state. "Attach to an item" and "Add details" are optional
  and start closed. From an item page, a chip shows "Attached to: (item)". No
  type, merchant, date or item is needed. The same flow is used on the
  Documents page, on an item, and for the scan dialog. Through the assistant,
  a file is saved as "Other document" unless a type is chosen.
- **Manuals** do not open a purchase-style review any more. They are left out
  of the "to review" list.
- **One review row** (`components/review-row.tsx`) for photo recognition,
  imports, hierarchy imports and details read from a document. A row is closed
  at first. It shows name, quantity and what would happen: the read values for
  a new item, or old → new for an existing one. Uncertain values are marked
  "check". Name and quantity can be changed in the row. Other fields are under
  "More details".
- **Selection.** Checkboxes only select. Nothing is selected at the start.
  There is an explicit "Select all". Each row has its own "Add item" or "Apply
  changes". The bulk button says what it will do, for example "Add 3 selected
  items", and is off when nothing is selected. New items and updates have
  separate counts.
- **No more Import/Skip/Reject dropdowns.** Merge choices show only for a
  possible duplicate.
- **Skip with Undo.** Skip moves the row to a "Skipped (n)" part at the end. A
  message offers Undo. The server remembers the skip and the edits, so it is
  still there after a reload, and Restore brings the row back. New server
  calls: restore an import entry; skip and restore a document line; undo a
  dismissed suggestion.
- **Details read from a document** can be applied line by line. A line is never
  applied twice. All parts go to one purchase, and the parts together cannot
  be more than the purchase total. A document stays in the "to review" count
  until every line is applied or skipped.
- **Errors** sit beside the field. After a partial failure, the rows that
  worked are done and the rows that failed stay selected.
- **Suggestions in chat** start as one quiet line, for example "2 possible
  corrections · View suggestions".

Limits:

- Photo recognition rows have no small picture each. The source photo is shown
  once, above the rows.
- Line-by-line apply works inside one reading of the document. If the document
  is read again by AI after a part was applied, the older "already applied"
  rule is used.
- In Add items, a document still opens its page after saving, with an Undo
  message. It does not use the shared dialog.

Checks: backend tests for capture reviews, imports, hierarchy imports,
recognition, inventory review, documents and document extraction pass. One new
test applies 1 of 3 lines, reloads, skips and restores, sends the first line
again, tries to go over the total, then finishes: 3 items, 1 purchase, nothing
unallocated. Unit tests cover: nothing pre-selected, a row cannot be added
twice, the bulk label, skip and restore, a manual does not open a review, and
saving without details. The add-a-document flow was also tried in the running
app at 390 px: save on choose, then Undo.

## Phase 3 record

What was built:

- **The page is the default subject only.** With the "This item" chip, a
  question is about that item unless it names something else. Then it is about
  that. Removing the chip sends no page at all. A page record that is archived
  or gone is skipped; it no longer fails the question.
- **General questions** are answered without looking in the inventory first.
  Facts about recorded things, and limits or instructions for one product,
  still need evidence. General advice is said to be general.
- **Where a fact comes from.** Item details now say if a value was typed by a
  person, came from a source, or is an estimate.
- **Direct changes with Undo.** The server has a small allowlist: editing one
  item, and moving one item. A change is applied at once only when the new
  value or the place name is in the person's own words. It stays a preview
  when it is guessed, clears a value, sets zero, goes below what is on loan,
  touches more than one item, touches an item that holds other items, would be
  the fourth direct change in one request, or comes after text from a document
  or a web page was read. Viewers cannot change anything. Text inside
  documents and web pages never counts as permission.
- **Undo** puts the old values back only if the record still has the applied
  values. If someone changed it since, Undo changes nothing and says why.
  A replayed request does not apply twice.
- **Manuals.** When brand and model are recorded and consistent, the assistant
  searches without asking to confirm them. It still asks when they are missing
  or conflict. One clear match can be saved in the same task when the person
  asked for that.
- **Stop and steer.** While a request runs, the message field stays open. The
  words stop, cancel, avbryt or stopp end the request. Any other text changes
  the rest of the work; finished steps are kept. The stop message lists what
  was finished and what was already sent.
- **Progress** lines come from the real tool state. There are no percentages.
- **Answers** can use headings, numbered lists and tables. A table scrolls
  sideways on a small screen. Sources are one closed "Sources (n)" list.

New server calls: `POST /assistant/runs/{id}/steer` and
`POST /assistant/actions/proposals/{id}/undo`.

Not built:

- **Video links.** The search service's video results could not be checked
  without a network call, so nothing was guessed.
- Lending and returning through the assistant stay previews.
- A saved manual has no Undo in the assistant.

Checks and their limits:

- Backend assistant tests and the assistant unit tests pass, with new tests for
  each point above (for example: on a drill page, "where is the tent?" looks up
  the tent).
- **No real AI model was used.** No provider is configured here. All model
  behaviour above is proved only with scripted answers. The system prompt is
  3,987 of 4,000 characters and an earlier real-model run was sensitive to its
  wording, so a real-model check is still needed.

## Phase 4 record

What was built:

- **Overview is removed.** The app opens in the item list. Totals and purchase
  breakdowns moved to the top of Purchases. The warranty watch moved to
  Warranties. Both are one line until opened.
- **Item list.** Title with the count, one tools row (sort, Filters, view), a
  short notice row only when there is something to do (findings to review,
  loans past due, warranties ending), then compact rows. Cards are still
  available. Checkboxes, "Select all loaded (N)" and the "only loaded items"
  sentence appear after pressing Select.
- **Sort:** Recent (default), Newest, Name, Location. The choice is remembered.
  Recent uses the later of "added" and "opened". The order does not change
  while browsing, so opening an item and coming back keeps the place.
- **Search** results are ordered by how well the name matches. The sort control
  is hidden during a search.
- **Item page**, one column: name; "Lives in" with Move; "Right now" with Lend
  or Return; small photos that open full screen; then tabs: Contents (for items
  that hold things), Info, Documents, Loans, History. Photo source details are
  under "Manage photos". Record details are folded.
- **Item panel on desktop.** On screens 1200 px and wider an item opens beside
  the page it was opened from. Editing opens in the same panel. The list stays
  where it was. Below 1200 px the item is a full page.
- **Item form.** One place field that opens property, room and storage place.
  Save stays in view. Optional parts stay closed.
- **Bulk actions.** A compact bar above the bottom bar: Move, Tags, More, Clear.
  It hides while the keyboard is open. The selection survives opening an item.
  A message says so when a selection was cut down.
- **Rooms and containers.** Contents first. Places are a row of chips. An empty
  photo area shows nothing; "Add photo" is in the ⋯ menu. Stocktake is one
  line. All management is in one ⋯ menu. Delete and move still show what
  happens to the contents.
- **Loans.** The list starts under the title, with one summary line. Lent and
  borrowed are two chips. Other filters are behind "Filters" with a count. A
  new loan starts with item, person and quantity; dates and notes are under
  "More options".
- **Documents and Purchases.** Search is always visible; other filters open on
  request with a count. A purchase is a compact row that opens to show items,
  allocations and the receipt.

Decisions:

- Recently opened items are remembered **on the device only**, per person and
  household, at most 50, and are cleared on sign-out. Another device shows a
  different Recent order.
- The remembered card or row choice uses a new key. Someone who had chosen
  cards must choose once more.
- Insurance for one item moved into the item's ⋯ menu.
- The item list's Filters are closed on desktop too.

Checks: backend item tests (ids filter, location sort, match order) and the
unit tests of all changed pages pass. `e2e/navigation.spec.ts` has 10 checks,
all passing against a throwaway local stack, including the desktop panel.
The item list, item page, room page and desktop panel were looked at in the
running app at 390 px and 1440 px.

## Phase 5 record

Phase 5 was finished before Phases 2 to 4. The phases were built side by side.

What was built:

- **Settings is an index.** Rows lead to focused screens: Account, Appearance,
  Household, Members and invitations, AI and online services, System status,
  and Advanced (storage, install on iPhone, label calibration). Sign out is at
  the foot. Owner-only rows are hidden from other members, with one line that
  says so. Every old section moved without changing what it does. Old links
  (`/settings#online-search`, `#item-images`, `#system-status`) go to the new
  screen and scroll to the right place.
- **Appearance screen.** The four colour themes and light, dark or system.
- **Insurance** is three clear steps: Scope, Review, Export. The scope folds to
  one line once the review starts. Before the export there is a summary: items,
  how many have a value, how many are unknown, and the total. Per-unit and total
  values stay apart. "Export evidence" for the whole home now starts here.
- **Stocktake.** "Present" is one tap. The other results are one tap further,
  under "Other". The list starts on Unchecked. A short progress line stays in
  view. Controls are 44 px. A new Stocktake page (More → Stocktake) shows
  stocktakes in progress, starts one for a room or container, and lists recent
  ones. Review and Finish are as explicit as before.
- **Labels.** Calibration is under a closed "Advanced · Calibration" part.
- **First run.** Setup and "create a household" now land in the item list. The
  wording follows account, then home, then first item. Sign-in, password
  recovery and invitations are unchanged.
- **Design only:** `docs/AI_SUPPLIED_AND_BYOK.md` describes how AI supplied by
  the app could live next to bring-your-own-key, and how a hosted sign-up would
  own accounts and households. Nothing of this is built. There is no billing,
  no public sign-up and no hosted AI service.

Decision: a fourth screen, "AI and online services", was added. The AI provider
page is for owners only, but members could read the AI summary before. The new
screen keeps that.

Checks: type check clean; the unit tests of all changed pages pass, with new
tests for the Settings index, setup, labels, insurance steps and one-tap
Present. No backend change.

## Phase 6 record

### How it was checked

Everything ran on throwaway stacks on the development machine: a separate
Postgres on its own port, test databases, made-up items. No real household, no
production data and no production server was changed.

- **Type check and production build:** clean.
- **Unit tests (web):** 82 files, 562 tests, all pass. Before the programme
  there were 74 files and 462 tests.
- **Backend tests:** 881 tests. 879 pass. The two that fail are in
  `tests/test_actual_inventory.py`. They fail the same way on the commit the
  programme started from, so they are not from this work. Lint is clean.
- **End-to-end (Playwright, system Chrome):** all 53 files were brought in line
  with the new interface and run. See the table below.
- **Real AI model:** one session with `openai/gpt-6-luna` through OpenRouter,
  on made-up items. See "Real-model check".
- **By eye, in the running app:** item list, item page, room page, loans, add a
  document, Settings, Appearance and the desktop panel at 390 px and 1440 px.
  27 pages were checked by script at 320 px for sideways overflow and errors
  (none), and again at 844 x 390 landscape and 768 px (none).

### End-to-end results

| Group | Files | Tests passed |
| --- | --- | --- |
| Shell: `navigation.spec.ts` (rewritten) | 1 | 10 of 10 |
| Shell, Settings, accounts, search, AI settings | 17 | 45 of 45 |
| Items, places, loans, purchases, stocktake, evidence | 20 | 50 of 50 |
| Assistant, documents, reviews | 15 | 101 of 102 |
| **Total** | **53** | **206 of 207** |

The one test that did not run is the PWA test in `ai-camera-import.spec.ts`. It
needs the built app behind nginx.

What changed in the tests:

- Tests were moved to the new interface with the same goal and the same checks
  on data. Checks that named removed things (the header theme button, the five
  tabs, the Overview page, the old `/search` result page) were replaced by
  checks on what took their place.
- No check on data, permissions or "not applied twice" was removed.
- One rewritten test turned out to pass for the wrong reason. It was corrected
  to check what the original meant (the assistant draft survives closing and
  reopening).
- Many end-to-end files save pictures into `docs/walkthrough/`. Those tracked
  pictures were put back after every run. **They still show the old
  interface.** New pictures are kept outside the repository (see
  "Screenshots").

### Real-model check

Model: `openai/gpt-6-luna` through OpenRouter. 63 requests, made-up items only.
The owner supplied the key and chose the model. The key was only ever in a
throwaway test database.

| Scenario | Result |
| --- | --- |
| General question, nothing looked up, said to be general | Pass |
| Facts about recorded things | Pass |
| On the drill page: "Where is it?" | Pass: the drill |
| On the drill page: "Where is the tent?" | Pass: the tent |
| Vague "tool for making holes" | Failed, then pass after a fix |
| Stated serial number | Pass: applied at once; Undo restored it; Undo after a newer edit was refused and changed nothing |
| "Move the tent to the Garage." | Failed, then pass after a fix |
| "Move everything in the Attic…" | Pass: one preview, nothing moved |
| "The drill is a Makita." (record said Bosch) | Pass: applied with Undo; the answer said what changed |
| Swedish question and a follow-up | Pass: right items, answers in Swedish |
| Stop, and steer ("actually only the kitchen") | Pass |
| The same request sent twice | Pass: applied once |
| A table in the answer | Pass |
| A viewer cannot change anything | Not run live (an invitation needs email); covered by backend tests |
| `assistant-review-live.spec.ts` | Pass |

Fixes that came out of it: the search tool now tells the model to try single
words when a long phrase finds nothing; a reply from the model that cannot be
read is asked for again (at most twice) instead of ending in an error; looking
up a room now returns its id, so the model does not look twice.

Limits of this check: one model, one short session. Online manual search was
not tested with a real search (no search key). "The drill is a Makita." was
applied at once; it can be undone and was explained, but a preview would also
have been reasonable. Whether a person "stated" a change is the model's claim;
the server only checks the allowlist and that the new value is in the person's
own words.

### Bugs found and fixed in Phase 6

- The bulk action bar was drawn off-screen. It is now drawn in the page body.
- On a phone the assistant sheet could close right after it opened.
- A question sent to the assistant stayed in the bar as a filter on the item
  list. The field is now emptied.
- Escape in the borrower name field closed the whole dialog. It now closes the
  open list first.
- The name list in the new loan dialog opened by itself and covered other
  controls.
- With the keyboard open on a form, the Save bar and the bottom bar together
  covered about 125 px. The bottom bar now steps aside while a field on the
  page has the keyboard.
- A list came back to its place with a slide. It now comes back at once.
- A warning on a review row ("this is part of the building") only showed after
  opening the row. It now shows on the closed row.
- Small overflow on narrow phones on several screens (AI settings, purchase
  totals, Appearance, long unbroken text on an item).
- Back links, section tabs, the password button and native checkboxes were
  smaller than 44 px on touch screens.
- Older than this work, found on the way: per-unit price entry was hidden for
  some items; "Test all enabled AI tasks" did not start on the development
  server; a review run could show an in-between count.

### Bottom-bar space and the keyboard

This is point 4 of the decision. What was done:

- On a phone the field takes the whole bar while it has focus. Attach and voice
  hide while there is text. With the "This item" chip, voice hides until the
  field has focus. Under 360 px attach hides too, the chip can shrink, and the
  field keeps at least 44 px.
- The bar and the assistant sheet follow the keyboard through the visual
  viewport. While a field on the page has the keyboard, the bar is hidden.
- Tests make the window shorter to act like a keyboard, at 390 px.

**Not done: a real iPhone.** No device was available. A shorter window is not
the same as the iOS keyboard. The bar's place above the real keyboard, the
safe area in the installed PWA, and how the field feels with one hand still
need a check on a device. Problems found there are to be fixed then, as agreed.

### Screenshots

36 pictures of the finished app are kept outside the repository, on the
development machine:

`~/.copilot/session-state/3641ec55-9ea3-4388-a02a-630e6e621ce5/files/mfp-runtime/screenshots/`

They cover a 390 px phone (16 screens), a 320 px phone, landscape, a tablet, a
1440 px desktop with the item panel, and all four colour themes in light and
dark. The real-model record is next to them in `REAL_MODEL_CHECK.md`. The
clickable Design D mock is in `~/Downloads/housetory-mock-design-D.zip`.

## Final checklist

State is one of: **Done**, **Partly** (with what is missing), **Not done**.

### Working method and principles

| Requirement | State | Where |
| --- | --- | --- |
| One feature branch from `origin/main`; unrelated work kept | Done | `feat/mobile-first-programme` |
| Specification not copied into the repository; plan kept here | Done | this file |
| Design work kept outside Git; stop for the design decision | Done | Figma, mock zip; decision of 26 Nov 2026 |
| Commit and push each finished phase; no merge, no deploy | Done | "Commits" below |
| Reuse shared components, services, the assistant registry, jobs and history | Done | no new framework; one new shared row, one new policy module |
| Mobile first, desktop with the same functions | Done | rail and bar on phones; sidebar, bar and item panel on desktop |
| Compact by default, more on request; uncertainty and consequences stay visible | Done | review rows show "Check: …" closed; delete and move previews unchanged |
| Core inventory, search, documents and exports work without AI | Done | unchanged; the test stacks ran without AI |
| No second assistant or competing interpretation pipeline | Done | one registry; the "?" shortcut of the mock was not built |
| Household isolation, permissions, provenance, idempotency, source documents kept | Done | no data migration; backend tests for these still pass |

### Phase 0

| Requirement | State | Where |
| --- | --- | --- |
| Three new, clearly different UI designs in Figma, with prototypes | Done | "Phase 0: the three designs" |
| Comparison, recommendation, honest limits, then stop | Done | same section, "Limits" |
| Selected design recorded | Done | Design D, with four colour themes ("Decision") |
| Rejected designs not built | Done | A, B and C are not in the app |
| No theme chooser | Changed by the owner | four colour themes were asked for with the approval |

### Phase 1: shared mobile behaviour

| Requirement | State | Where |
| --- | --- | --- |
| Design tokens, shared controls, shell and navigation of the chosen design | Done | `components/app-shell.tsx`, `components/shell/` |
| Four colour themes, light and dark | Done | `styles/globals.css`, Settings → Appearance |
| Inventory-first start | Done | `/` goes to `/items` |
| Touch targets of 44 px | Partly | shared buttons, menus, tabs, back links, checkboxes, rail and bar are done. A few controls on Settings screens are 36 to 40 px (role select, AI model fields) and the label start grid is 36 px |
| Stable keyboard, safe areas, reachable main actions | Partly | built and tested with a shorter window; **not checked on an iPhone** |
| No zoom on focus; pinch zoom and text scaling kept | Done | 16 px rule kept; viewport tag unchanged |
| Predictable Back, Close, Cancel and outside tap | Done | Close fix on sheets; Escape closes the inner list first |
| Drafts and selections kept; cleared on sign-out | Done | item drafts as before; bulk selection survives opening an item; recent items cleared with drafts |
| List position and filters kept when opening and closing an item | Done | position restored at once; on desktop the list stays next to the panel |
| No nested scrolling or stacked overlays | Done | one panel on desktop, one sheet on phones |
| Reduced motion, labels and focus | Done | global rule kept; new controls have names |
| Add-items Close problem reproduced before fixing | Done | "Phase 1 record" |
| Small and large phone, short landscape, tablet, desktop exercised | Done | 320, 390, 844 x 390, 768 and 1440 px |
| iPhone and PWA checks reported apart from browser checks | Done | none were done; said so here |

### Phase 2: capture, documents and reviews

| Requirement | State | Where |
| --- | --- | --- |
| Choose, photograph, scan or drop a file | Done | upload dialog, scan dialog |
| Preview and true processing state | Done | `document-add-steps.tsx` |
| Details and item are optional and closed | Done | "Attach to an item", "Add details" |
| Suggestions shown when there are some | Done | "N details found · View" |
| Save to the library without an item; nothing required | Done | save on choose, with Undo |
| From an item, the link is kept and shown | Done | "Attached to: (item)" |
| Original saved before any review; failed reading keeps the original | Done | unchanged server order; retry and download stay |
| Manuals do not open a purchase review | Done | left out of pending captures |
| One compact row for all four review kinds | Done | `components/review-row.tsx` |
| Old → new for existing records; read values for new ones | Done | row body |
| Uncertain fields are clear and can be edited | Done | "Check: …" line; inline name and quantity |
| Empty fields under "More details" | Done | row editor |
| Checkboxes select only; nothing selected at first; Select all | Done | all four kinds |
| A direct Add or Apply on each row | Done | per-row button |
| Bulk button says what it does; off when nothing is selected; separate counts | Done | "Add 3 selected items" and similar |
| Skip removes the row, offers Undo, keeps edits | Done | "Skipped (n)" with Restore |
| Dismissals are remembered; reassessment still possible | Done | server state; "Reconsider dismissed" kept |
| Way back to skipped work after the message is gone | Done | "Skipped (n)" part |
| No routine Import/Skip/Reject dropdowns; merge only for duplicates | Done | removed |
| Required fields checked before accepting; errors beside the field | Done | row editor |
| Partial failure keeps what worked and what is left | Done | failed rows stay selected |
| Quiet line for optional suggestions in chat | Done | "N possible corrections · View suggestions" |
| An accepted row cannot be added twice | Done | server rules kept; row loses its actions |
| A small picture on each row where useful | Partly | photo reviews show the source photo once, above the rows |

### Phase 3: assistant

| Requirement | State | Where |
| --- | --- | --- |
| One entry point; no second launcher | Done | robot button in the bar |
| General questions need no item and no lookup | Done | answer kind `general`; real-model pass |
| Questions about recorded things use the page and current records | Done | real-model pass |
| "This item" can be removed on phone and desktop | Done | chip with × in the field |
| An explicit change of subject is followed | Done | real-model pass ("Where is the tent?" on the drill page) |
| Clarify only when it matters | Done | no routine identity confirmation |
| Product limits need matching evidence; general advice is said to be general | Done | prompt rule and server gate |
| Prefer local records, then read further or go online | Partly | local first works; online is manual discovery only, and it was not tried with a real search |
| Tell typed facts, sourced facts and estimates apart | Done | provenance in item details |
| Working source and page links; nothing invented | Done | citations come from pages actually read |
| Use stated information to improve the record | Done | direct edit |
| Clear, reversible instructions run at once, with Undo | Done | allowlist: edit one item, move one item |
| Uncertain, conflicting, large or consequential changes get one preview | Done | everything outside the allowlist |
| Server-enforced policy, small allowlist | Done | `assistant_tools/policy.py` |
| Undo is safe; a conflict is explained, nothing overwritten | Done | 409 with a reason; real-model pass |
| Text in documents or websites is never permission | Done | direct apply is refused after such text was read |
| Manual discovery and saving as one task | Partly | built and covered by scripted tests; not tried with a real search |
| Suggest a correction on a real mismatch; no housekeeping flood | Done | prompt rule; scripted tests |
| Paragraphs, headings, lists and tables | Done | `answer-text.tsx` |
| Only supported components, no model-made UI | Done | unchanged |
| One compact Sources list | Done | "Sources (n)" |
| Video links from real online results | **Not done** | see "Not complete" |
| Progress from real states; short updates; no percentages | Done | progress labels from tool states |
| Stop by button or by words; steer the rest | Done | stop words and `POST /assistant/runs/{id}/steer` |
| Stop prevents further changes; says what was done | Done | stop message |
| Finished results kept across recovery; no repeated writes | Done | unchanged step store; receipts |
| Time, retry and spending limits stay with the application | Done | limits kept; a steer limit of six was added |
| Technical details behind a disclosure | Done | unchanged |
| Tests: general guidance, evidence, vague references, corrections, conflicts | Done | scripted and real-model |
| Tests: direct change, Undo, preview, cancel, duplicates | Done | scripted and real-model |
| Other languages and follow-ups | Done | Swedish, real-model |
| A few real-model checks on isolated data | Done | "Real-model check" |
| No real household record changed | Done | throwaway databases only |

### Phase 4: inventory-first navigation and everyday flows

| Requirement | State | Where |
| --- | --- | --- |
| Overview removed as a main place; open in the inventory | Done | page deleted |
| One item list | Done | `/items` |
| Recent order from adding or opening, not view counts | Done | `lib/recent-items.ts` |
| Recent access kept locally, scoped and cleared | Done | per person and household, on the device; limit written down |
| Later of created and opened, fixed tie-break | Done | id as tie-break |
| Order does not change while browsing | Done | snapshot, 30 minutes |
| Recent, Newest, Name, Location; choice remembered | Done | sort control |
| Search order comes first | Done | server match order |
| Short notices only when useful | Done | notice row |
| Totals and money reports still reachable | Done | Purchases, Warranties |
| Home and Items no longer double; clear desktop form | Done | rail, sidebar |
| Item: name, place, availability and actions first | Done | "Lives in", "Right now" |
| Photos less dominant; full screen still there | Done | thumbnail strip |
| Documents and Loans near the item facts | Done | tabs |
| Photo source text and record details out of the way | Done | "Manage photos", "Record details" |
| Essentials-first editing; optional parts closed | Done | unchanged, plus one place field |
| Better place choice; Save always reachable | Done | one field; sticky Save |
| Price per unit and loan rules kept | Done | a hidden per-unit entry was also repaired |
| Rooms and containers: contents and a compact place choice first | Done | place chips |
| Empty photo areas, stocktake text and management folded | Done | ⋯ menu |
| Add in context, bulk actions, way back kept | Done | unchanged behaviour |
| What delete or move does to the contents is shown | Done | previews unchanged |
| Loans: open items and people first | Done | list under the title |
| Filters joined; lent and borrowed kept apart | Done | two chips, "Filters" |
| Direct Return | Done | on rows and on the item |
| Loan entry starts with item, person, quantity; dates default | Done | "More options" |
| Name suggestions and reuse kept; partial returns and history kept | Done | unchanged |
| Compact bulk bar that respects keyboard and bar | Done | fixed above the bar |
| Common actions first, others under More | Done | Move, Tags, More, Clear |
| "All loaded" never looks like "all matching" | Done | wording kept |
| Selection kept across navigation and partial failure; pruning explained | Done | per page |
| Documents and purchases: search visible, filters on request with a count | Done | both pages |
| Compact purchase rows that open | Done | Purchases |
| Totals, shared allocations and item links stay correct | Done | figures unchanged; partial apply is guarded |
| Source details without repeated paragraphs | Done | folded |

### Phase 5: secondary flows and account design

| Requirement | State | Where |
| --- | --- | --- |
| Settings as an index into focused screens | Done | "Phase 5 record" |
| Normal preferences apart from administration; advanced settings kept | Done | owner-only rows hidden for others |
| Insurance: scope, review, export; honest values | Done | three steps and a summary |
| Stocktake: fast counting, progress, resume; explicit reconciliation | Done | one-tap Present; Stocktake page |
| Label calibration under Advanced | Done | Labels |
| Sign-in, recovery and invitations kept | Done | unchanged |
| First run toward account, home, first item | Done | lands in the item list with the first-run steps |
| Account, household and membership ownership designed | Done | design document |
| Onboarding tested locally | Done | unit tests and the end-to-end setup path |
| Hosted sign-up, if built, off by default | Not built | design only, by choice |
| No destructive migration of members or households | Done | no migration at all |
| Supplied AI next to bring-your-own-key: ownership, usage, routing, privacy | Done | `docs/AI_SUPPLIED_AND_BYOK.md` (design only) |
| No billing, payments or hosted AI built | Done | none |

### Phase 6: verification

| Journey | State | How |
| --- | --- | --- |
| 1. Capture → compact review → correct → save → find | Done | end-to-end (photo and import with a scripted model, documents with real OCR) |
| 2. Save to the library, then attach; add from an item | Done | end-to-end and by hand at 390 px |
| 3. Browse or search → item → edit, documents, loans → back | Done | end-to-end and by hand |
| 4. Room and container browsing; move selected items | Done | end-to-end |
| 5. Lend, borrow, partial return, correction | Done | end-to-end |
| 6. Assistant: general help, evidence, manual discovery, correction, Undo | Partly | real model for all but online manual discovery, which ran with a fixture search only |
| 7. Long work, steering, stopping, recovery | Done | real model for stop and steer; scripted for recovery |
| 8. Insurance export, stocktake, Settings | Done | end-to-end |
| 9. No AI, permissions, household isolation | Done | end-to-end and backend tests |
| Phone at 320, 390 and 430 px, short and landscape, tablet, desktop | Partly | 320, 390, landscape, 768 and 1440 px were checked; 430 px was not checked on its own |
| Empty, large, loading and error states | Partly | covered where the end-to-end files cover them; not walked through one by one |
| Real iPhone and PWA | **Not done** | no device |

## Commits

All on `feat/mobile-first-programme`, on top of `main` at `f026cae`.

| Commit | What |
| --- | --- |
| `ce03d7f` | Plan, Phase 0 record and the Design D decision |
| `d3a650f` | Phase 1 |
| `316393c` | Phase 5 |
| `b1d85fd` | Phase 2 |
| `4ee2b4b` | Phase 3 |
| `1f59cf8` | Phase 4 |
| `ea69ef7` | Docs in line with the new interface; touch targets |
| the commit after `ea69ef7` | Phase 6: end-to-end files, fixes found by them, real-model fixes, this record |

The phases were built side by side, so they are not in number order.

## Removed UI and code

- The Overview page and its route. Its totals live on Purchases and its
  warranty watch on Warranties.
- The top header, the five-tab bar and the "More destinations" menu.
- The theme button in the header. The choice is in Settings → Appearance.
- The Import/Skip/Reject dropdowns and "Approve N entries" in reviews.
- The required document type before an upload in the assistant.
- The separate "choose lend or borrow", item picker and borrow dialogs. There
  is one "New loan" surface.
- The large photo frame on the item page.

## Where the app differs from the Design D mock

The mock was a sketch with made-up data. These parts of it were **not** built
as drawn:

1. **Photo review with numbered pins.** The mock put numbered pins on the
   photo. The app shows the photo once above the rows, with no pins. Photo
   recognition returns names and values but no positions in the picture, so
   pins need a change to what the AI is asked for and to what is stored. That
   was not done.
2. **Correcting a finding by typing in the bottom bar.** In the mock, tapping a
   value moved it into the bar for editing. In the app, name and quantity are
   edited in the row itself, and other fields in the row's editor. This
   follows the specification ("small corrections happen inline") but it is not
   what was chosen in the mock.
3. **The Add menu.** The mock's + opened a small menu with three choices. The
   app's + opens the existing "Add items" surface, where text, a link, a photo
   or voice go into one field. The paperclip opens the file chooser at once.
4. **The desktop panel** holds the item and its edit form. In the mock,
   reviews and documents also opened there. In the app they open as pages,
   dialogs or in the assistant.
5. **Fonts.** The mock used its own fonts. The app keeps its fonts in all four
   themes.

Points 1 and 2 are the largest gaps. They can be built later if wanted.

## Known limits and deferred work

- **Recent order is per device.** Opening times are not sent to the server.
- **Fonts.** The themes change colours only. Design D's own fonts are not
  shipped, so the "Design D" theme uses the app's fonts.
- **"Collected" dark** has no Figma original; it was derived.
- **Pictures in `docs/walkthrough/`** and in older reports show the old
  interface. They were left as records.
- **The import page (`/imports`)** has no link in the navigation. This was so
  before the programme.
- **The review count on the robot button** can lag up to 30 seconds after an
  Add-items capture.
- **Photo review rows** have no picture each.
- **Document matching** sorts equally strong matches by name. Older than this
  work.
- **In the new loan dialog**, the name list still covers "More options" while a
  name is being typed.
- **Each assistant change** costs three to five model requests.
- **The phone rail in landscape** shows only about two rooms at a time. It
  scrolls, and it can be hidden.

## Not complete

Stated plainly:

1. **No check on a real iPhone or as an installed PWA.** The keyboard and the
   bottom-bar space are only tested with a shorter browser window.
2. **Video links in assistant answers are not built.**
3. **Online manual discovery was not tried with a real search and a real
   model together.** It passes with a fixture search and a scripted model.
4. **One end-to-end test did not run** (the PWA test behind nginx).
5. **A few touch controls are still under 44 px** on Settings screens and the
   label start grid.
6. **Hosted sign-up is design only**, as the specification allows.
7. **Two backend tests fail**, as they did before this work
   (`tests/test_actual_inventory.py`).
8. **Two interactions of the Design D mock are not built:** numbered pins on
   the review photo, and correcting a finding by typing in the bottom bar. See
   "Where the app differs from the Design D mock".

## Judgement

- **Are the phone journeys simple and usable?** In the browser, yes for the
  ones tried: the list starts at once, an item shows where it lives and who has
  it, a document is saved in one step, a review is a short row with one button.
  The honest gap is the real phone. The bar holds a lot in little width, and
  only a device can show how it feels with a thumb and a real keyboard.
- **Is Design D coherent across flows?** Mostly, with the differences from the
  mock listed above. The shell, the item list, the
  item, rooms, loans, documents, reviews and Settings follow one pattern: title,
  one tools row, compact rows, one ⋯ menu. Less reworked screens (AI settings,
  system status, labels, imports) keep their older, denser look inside the new
  shell.
- **Does desktop still work?** Yes. The sidebar, the bar and the item panel
  work at 1440 px, and every end-to-end file with desktop steps passes. Between
  1024 and 1200 px an item is a full page, not a panel.

Tests passing is not the claim here. The claim is narrower: on the widths
tried in a browser, the rebuilt flows do what the specification asks, with the
gaps listed above.

## Checks done in Phase 0

- Figma read-back: 36 top-level frames, all editable. About 1,960 text layers,
  2,340 icon vectors and 3,600 auto-layout frames. No screen-sized image.
- Fonts in Figma match the design fonts. The keyboard drawings use a system font
  on purpose.
- 45 prototype links, each on a real layer, checked by read-back.
- Contrast, measured from the colour values: text 13:1 or better, muted text
  6:1 or better, input borders 3.3:1 or better, in light and dark.
- The earlier page has the same 112 layers as before.

## Limits

- The screens were built as HTML outside the repository and then captured into
  Figma. Layers are editable, but many have general names such as "Container".
- Screens are not built from component instances. Each sheet has three button
  components. No Figma variables or styles were made for the new designs.
- The prototypes switch between drawn states. Scrolling, typing and sheet
  dragging do not work. They were not opened in Figma's player by the agent.
- Nothing was checked on a real iPhone. The 320 px large-text frames are drawn,
  not measured on a device.
- Each design would add local font files (45 to 150 kB). The app uses system
  fonts today.
- Sample photos are CC0 or public domain from Wikimedia Commons. They are only
  in the mockups.

## Repository size (reported only, nothing removed)

- `docs/walkthrough/`: 275 tracked screenshots, about 186 MB.
- `docs/assistant-*.png` (9 files): about 4.7 MB. `docs/assistant-stage-a/`
  (4 files): about 3.2 MB.
- Together about 194 MB of images in a tracked tree of about 200 MB. The Git
  pack is about 380 MB, so older versions of images are in history too.

Removing these from history needs its own reviewed decision. It is not part of
this programme.
