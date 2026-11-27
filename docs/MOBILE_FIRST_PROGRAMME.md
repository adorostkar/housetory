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
| — | Correction batch after the review of Phase 6 | Done (see "Correction batch record") |
| — | Check in Mobile Safari on the iOS Simulator, and fixes | Done (see "iOS Simulator record") |
| — | Pending corrections saved by themselves; more iOS sizes; Android; final production build | Done (see "Last round record") |
| — | Corrections kept on the device until the server has them; document review top fields; phone and tablet on their side with the keyboard open | Done (see "Data and keyboard round record") |
| — | Two devices: an older correction cannot go over a newer one without a choice | Done (see "Conflict check record") |

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

**Later:** this was checked in Mobile Safari on the iOS Simulator, with the
real iOS keyboard, and as an installed app there. That check found seven
defects that the shorter window did not show. See "iOS Simulator record". A
phone in the hand is still not checked.

### Screenshots

36 pictures of the finished app are kept outside the repository, on the
development machine:

`~/.copilot/session-state/3641ec55-9ea3-4388-a02a-630e6e621ce5/files/mfp-runtime/screenshots/`

They cover a 390 px phone (16 screens), a 320 px phone, landscape, a tablet, a
1440 px desktop with the item panel, and all four colour themes in light and
dark. The real-model record is next to them in `REAL_MODEL_CHECK.md`. The
clickable Design D mock is in `~/Downloads/housetory-mock-design-D.zip`.

## Correction batch record

Phase 6 was reviewed at `a846424`. The review asked for seven corrections.
This is what was done for each, on 27 Nov 2026.

### 1. A failed save of document details no longer loses them

Before, closing the add-a-document surface or pressing Done cleared the typed
details before the save had worked.

Now Done, ✕, Escape and a tap outside all first send the pending details and
item links. While that runs the surface cannot be closed. If the save fails,
the surface stays open with every field as typed, the server's message beside
the button, **Retry** and **Discard changes**. "Discard changes" says that the
document itself stays in the library. The surface closes only after a save
that worked, or after Discard. If the first upload fails, the chosen file is
kept and Retry is offered. The scan dialog asks before it drops pages or
details, and a failed save there keeps everything too.

### 2. Skip → reload → Restore keeps the whole edited draft

What was lost before the fix:

| Review kind | Lost |
| --- | --- |
| Import and photo rows | the chosen action, the duplicate to merge with, the fields to merge |
| Place and container rows | everything: name, quantity, description, kinds, parent, old identifier, "allow duplicate" |
| Document lines | everything but description, quantity and line total; Restore also deleted the note of the skip |
| Inventory suggestions ("Edit first") | the edited name and category, when the dialog closed |

Now the server stores the complete draft with the skip, in the JSON that each
row already has. No migration was needed. A reload returns it, Restore leaves
it alone, and a later Add uses it. This covers identity (name, make, model,
serial number), location, prices and dates, the action and its target, and
the other fields of the row editor.

Tests: for each kind a backend test edits every field group, skips, reads
again, restores, reads again, compares the whole draft, then adds the row and
checks the saved record. Frontend tests check that a restored row shows the
edited values and the action.

### 3. Selected review rows are highlighted

A selected row has a background (`bg-accent`), a border in the main colour
and a bar on its left edge, next to the checked box. It carries
`data-selected="true"`. On that background the "Check: …" and error lines use
the normal text colour with a coloured icon, because the brass and red text
were too weak there.

Contrast on the selected row, computed from the theme colours and measured
again in the running app:

| Theme | Text | Muted text | Edge against the page |
| --- | --- | --- | --- |
| Current, light | 13.0 | 4.8 | 14.4 |
| Current, dark | 11.7 | 5.4 | 16.8 |
| Design D, light | 11.7 | 5.5 | 9.1 |
| Design D, dark | 12.3 | 6.1 | 10.2 |
| Field notes, light | 11.7 | 5.1 | 6.8 |
| Field notes, dark | 8.8 | 5.8 | 10.0 |
| Collected, light | 9.5 | 4.6 | 5.8 |
| Collected, dark | 11.2 | 6.8 | 9.1 |

Text needs 4.5 and an edge needs 3. The background alone differs from the
card by only about 1.2 to 1.3, so the border, the bar and the checkbox carry
the selection, not the tint alone.

### 4. Numbered findings, pins on the photo, editing in the bottom bar

**Positions come from the recognition itself.** The same single request to the
vision model now also asks for a box around each thing it found, as fractions
of the picture. The prompt says: "Use null when you are not sure. Never guess
a box." The server never makes a position up. It drops a box that is not
well-formed, lies outside the picture, is tiny, covers almost the whole
picture when there are several findings, or is the same as another finding's
box. If more than half of the boxes of one photo fail these checks, all of
them are dropped. Pixel values are not converted, because their scale cannot
be known. What is left is stored as `source_region` on each entry, or `null`.

**The picture shown and the picture read are the same.** The review shows the
stored upright copy. For a photo that the phone saved turned (EXIF), or a HEIC
photo, the model now gets that upright copy, so positions fit. If the two
cannot be shown to match, the photo gets no positions at all.

**In the app.** Findings are numbered. The photo shows a numbered pin, 44 px,
at the middle of each finding that has a position. A pin and its row are
linked both ways and work with the keyboard. A finding with no position gets
no pin. The page then says so in plain words: "Positions are not available
for this photo." or "1 of 9 findings is not marked on the photo: its position
is not known."

**Editing in the bar.** Tapping a name, a quantity, a serial number, a price,
a line total or "Add as" on a closed row opens that value in the bottom bar.
Enter or ✓ saves, Escape or ✕ cancels and puts the focus back on the value.
The same checks apply as before; a value that is not valid keeps the editor
open with the reason. A tap on any other control (Add, Skip, a checkbox,
another value) first saves the open value, so the action never uses the old
one; if the open value is not valid, that tap does nothing until it is fixed
or cancelled. The editor closes without saving when the page changes. This
works on the page and inside the assistant sheet, for import, photo, place
and document rows. Selection, per-row Add, Skip, Undo and Restore are
unchanged. Outside the shell the old inline fields remain.

**Checked with the real model** (`openai/gpt-6-luna`, 10 vision requests, on
made-up photos):

| Set | Pins on the right thing |
| --- | --- |
| Pictures built from known tiles | 16 of 16 |
| Real photos of a pantry and a toolbox, judged by eye | 31 of 33 |
| Photos saved turned by the phone | same positions as upright, within 0.01 |

The two misses were a half-hidden carton, and one box around two jars that
stood apart. The prompt now says to box a group only when its things stand
together. **Limit:** only this one model was tried. The server can refuse a
broken box, but it cannot know that a well-formed box is on the wrong thing.

### 5. Touch targets

A new end-to-end file, `e2e/touch-targets.spec.ts`, measures every control on
a touch phone at 390 and 320 px and on a touch tablet. It does not trust the
drawn size. From the middle of each control it walks outwards and asks the
browser which element answers at each point, so a label or an enlarged tap
area counts, and a neighbour that covers part of a control is found. It fails
for an area under 44 px either way, for a control that cannot be tapped, and
for a page wider than the screen. Only two exceptions are allowed: a link or
text button inside a sentence, and a control that the browser sizes and the
app does not style.

It found 327 controls in 237 screen states. All are fixed, mostly with
touch-only rules, so the desktop keeps its density. It also found three pages
that were wider than the phone (labels at 390 px; a document page and
warranties at 320 px); these are fixed. Later runs with other data found
three more (the link to a nested room, "Clear" in the model picker, and the
dialog Close button on a touch tablet); these are fixed too, and the audit's
own data now shows them every time. The last run: 254 screen states, 5,098
controls, no finding. With a mouse nothing changed in size.

### 6. The production build behind nginx

The built app was run as in production: the repository's own Docker images,
nginx in front, in a throwaway stack with its own volumes. The PWA test that
could not run in Phase 6 passes.

| End-to-end file, against the production build | Passed |
| --- | --- |
| `ai-camera-import` (with the PWA test) | 6 of 6 |
| `navigation` | 10 of 10 |
| `offline-resource-audit` | 1 of 1 |
| `release-stabilisation` | 2 of 2 |
| `responsive-mobile` | 14 of 14 |
| `touch-targets` | 8 of 8 |

The build was made twice: once in the middle of the batch and once at the end
with all corrections in it. Both passed. Two touch-only size changes (the link
to a nested room, and "Clear" in the model picker) were made after the last
build; they were checked on the development server only.

Checked by hand on that build, all passing: the manifest (`standalone`) and
its icons; `/sw.js` is served with `no-cache`, registers and takes control;
an old `housetory-shell-v1` cache is deleted and only `v2` stays; nothing
under `/api/` is cached; a hard reload of `/items/<id>` and
`/settings/appearance` works; the Content-Security-Policy header is present
and nothing is blocked on the list, an item, the assistant, the desktop panel
or Appearance in all four themes, light and dark. Offline, the service worker
answers and the app shows its own "can't reach its server" screen with "Try
again"; it does not show the list offline, and it never did.

Two small things were seen and left, both older than this programme: offline,
the worker does not serve `/theme-init.js`, the icon and the manifest, though
it stores them; and the offline screen says "Check that the API container is
running", which is odd wording for a person who is only offline.

### 7. Online manual discovery with a real search and a real model

Run on made-up data with Brave Search and `openai/gpt-6-luna`. It used 11
searches and about 55 model requests. No key was printed or stored outside
the throwaway database, which is deleted.

| Case | Result |
| --- | --- |
| Settings show that online search is ready | Pass |
| Item page: search, pick, download, open the PDF | Pass for a Makita manual (1.98 MB). A web page that is not a file gets a plain message. Brother's official PDF was refused; fixed, see below |
| Assistant on an item: "find the manual" | Pass on the first try. No question about identity. DeWalt's own PDF saved in one task |
| Item with too little or conflicting identity | Pass. It asks for the label details and saves nothing. It does not name the conflict itself |
| From the list, no item open | Failed first: it asked "Does the label say DHP482?". Passes after the fix |
| A made-up model | Pass. Plain "could not find", a next step, no link |
| Stop during a search | Pass. Nothing is saved afterwards |
| In the browser at 390 and 1440 px | Failed first on the phone: the question typed in the bar lost the "This item" context. Passes after the fix |

No answer named a link or a site that was not in the search results.

Fixes that came out of this check:

- Brother's support page names every file link only "Download", so its files
  were not found. A link is now named by its table row.
- The maker's own file is offered first. Several official files give one
  proposal, not a question. One file whose source does not name the brand
  stays a proposal. The tool's result no longer pushes the model to ask about
  the label.
- A question typed in the bar on an item page now carries the item with it.
- A PDF that only forbids printing or copying, but opens without a password,
  was refused as "encrypted". Many makers' manuals are like that. Now only a
  PDF that needs a real password is refused.
- The list of found manuals was in no fixed order. It now shows the maker
  first, then other official sources, then the rest.
- The help text under an item's documents said the assistant always asks
  before it saves a manual. It now says what really happens.

Not checked with the real services: steering in the middle of a manual
search, and a real case of a file whose source does not name the brand. Both
are covered by scripted tests only.

### Defects found by a review of the batch, and fixed

A separate read-only review of the whole batch found six defects before the
commit. All are fixed, each with a test:

- A value typed in the bar was not used when Add or Skip was pressed without
  Enter first.
- Editing the name and then the quantity of one row, without Enter between
  them, put the old name back.
- The editor stayed open over the next page after going back.
- An inventory suggestion's kept edit could not be taken back: it returned
  after a reload.
- On a document line, the place chosen at capture replaced a place that was
  changed, skipped and restored.
- A position with a number too large to store failed the whole photo instead
  of only dropping that position.

The review found nothing serious in the document dialogs, the kept drafts of
import and place rows, the storage of positions, the PDF check, the manual
search changes or the touch-target changes.

### Checks after the corrections

On the final tree:

| Check | Result |
| --- | --- |
| Web type check and production build | clean |
| Web unit tests | 84 files, 593 tests, all pass |
| Backend tests | 919 tests, 917 pass; the 2 failures are the known ones in `tests/test_actual_inventory.py` |
| Backend lint (ruff) | clean |
| End-to-end, 54 files (the 53 of Phase 6 and `touch-targets`) | 215 pass, 1 skipped, none fail |
| The same against the production build behind nginx (6 files) | 41 of 41 |

Notes on the end-to-end run, stated plainly:

- The skipped test is `assistant-review-live`, which needs a real model. It
  passed in Phase 6 with one.
- `review-memory` and `review-overview` only run on a database with a special
  name. They were run as copies with that one check changed.
- Some files need a fresh database, because other files leave a second
  household or open reviews behind. They were run in an order that gives them
  one. One test file was corrected for this: `responsive-mobile` now accepts
  the robot button's name with a count of open reviews.
- Seven files of the assistant and document set were last run just before the
  final small change to the name label of a review row. They do not use that
  label.
- No failing test was simply repeated until it passed. Where a file failed,
  the cause was found: data left by other files (solved by the order), or the
  test file itself (one line in `item-storage`, which matched two rows once
  the list behind the item panel also showed the new item).

**Journeys after the fixes**, by script in desktop Chrome at 390 × 844 with
touch and at 1440 × 900. All 15 pass:

1. List → item (page on the phone, side panel on the desktop) → edit → back,
   with the list at the same place.
2. Room → container → move an item with the bulk bar.
3. Record a loan and its return.
4. Add one item by hand.
5. Add a document where saving the details fails once: the surface stays
   open with the fields kept, Retry saves; and again with "Discard changes".
6. Paste a short list → review: correct a name and a quantity in the bar, a
   wrong quantity is held with its message, a typed name is used by "Add item"
   without Enter, two rows selected and marked in all eight theme variants,
   Skip → reload → Restore keeps the name and the quantity, the added items
   carry the corrected values.
7. The same editing with the keyboard only (desktop).
8. Each of the four colour themes applies and stays after a reload.

**This is a phone-sized window in desktop Chrome. It is not an iPhone.** The
check with the real iOS keyboard came after this; see "iOS Simulator record".

### Evidence

Kept outside the repository, on the development machine, under
`~/.copilot/session-state/3641ec55-9ea3-4388-a02a-630e6e621ce5/files/mfp-runtime/`:
`GEOMETRY_CHECK.md` and `geometry/` (pictures with the boxes drawn),
`MANUAL_DISCOVERY_CHECK.md` and `manual-check/`, `correction-shots/` (pins,
bar editing, the selected row in all themes) and `journeys/`.

## iOS Simulator record

Done on 27 Nov 2026, after the correction batch.

**A mistake to record first.** The reports before this said "no device" and
left the iPhone check open. That was wrong in one point: Xcode with iPhone
simulators was on the development machine the whole time, and nobody looked.
The owner asked why no simulator was used. It was then used, and it found real
defects at once. A shorter window in desktop Chrome did not show any of them.

### How it was checked

- iPhone 17e, iOS 27.0, 390 × 844 points, in the Simulator. First tries also
  on an iPhone 17 (402 × 874).
- The real Mobile Safari, and the app put on the Home Screen and opened from
  its icon (no browser bars).
- The real iOS software keyboard, with its bar of arrows and "Done" above it.
- Taps and typing were made by an Xcode UI test, so they are real touches.
  The test also reads where each control is on the screen, in points.
- The test project and its pictures are kept outside the repository.

### What iOS does that a shorter window does not

When the keyboard opens, iOS does not make the window shorter. It makes only
the *visible part* shorter, and it often moves that part down the page so the
field is in view. A box fixed to the bottom of the window is then under the
keyboard, or far from it. In the installed app there is one more difference:
the window height that the browser reports shrinks, but fixed boxes are still
placed in the full height.

### Defects found, and fixed

| # | What happened on iOS | Fix |
| --- | --- | --- |
| 1 | The search results lay on top of the search field, or far above it | The list is placed in the visible part, follows the field, and hangs from its lower edge |
| 2 | In the assistant, with the keyboard open, the top row with Close was off the screen | The sheet starts at the top of the visible part |
| 3 | In Add items, with the keyboard open, the heading, Close and the "Review items" button were off the screen or under the keyboard | Sheets and phone dialogs stand on the keyboard and are never taller than the visible part; Close stays at the top; the main button is brought into view |
| 4 | The space under the keyboard was worked out wrongly when iOS had moved the page (it was 0, or the whole keyboard height) | It is now what is really left under the visible part |
| 5 | Editing an item opened the keyboard at once, over the form | On a touch screen the name is no longer focused when an existing item is opened for editing. A new item still starts in its name |
| 6 | A field of a form could end up under the Save bar while it was typed in | The page moves so the field is above the Save bar |
| 7 | **With the keyboard open in the bottom bar, a tap on the robot button did nothing.** The tap took focus from the field, the bar changed its layout in that moment, and the tap missed | The bar keeps its layout for a quarter of a second after the field loses focus, and no longer hides in that moment |
| 8 | In the installed app, point 2 came back, because the app reports a shrunken window height | The full layout height is used |

Point 7 is the kind of defect this check exists for: on a phone, it made the
assistant unreachable from the keyboard.

### Results after the fixes

All on the Simulator, each test run again on the final code:

| Check | Result |
| --- | --- |
| Sign in with the real keyboard | Pass |
| Bottom bar: field takes the bar when typed in; it sits above the keyboard's own bar; results are above the field | Pass |
| Assistant sheet: message field above the keyboard, Send and Close reachable | Pass |
| Robot and + buttons tapped while the keyboard is open | Pass |
| Add items: text box above the keyboard, "Review items" and Close reachable | Pass |
| Import review: a name changed in the bar editor with the real keyboard; ✕ and ✓ reachable; the rail's More stays free; the bar comes back | Pass |
| Quantity in the bar editor shows the number keys | Pass (seen); typing on those keys by the test tool was too slow to finish, so the wrong-value case was not run here |
| Item form: nothing has focus at first; the name and a field far down are both in view above the Save bar; Save can be pressed | Pass |
| List → item → Safari's Back: the list is at the same place | Pass |
| "Add to Home Screen" is offered, and the icon appears | Pass |
| Installed app: no browser bars; title below the status bar; bar above the home line (34 points free); keyboard, results, assistant and Close as above | Pass |

### Checks after these fixes

The fixes touch shared parts (dialogs, sheets, the bottom bar), so everything
was run again on fresh databases:

| Check | Result |
| --- | --- |
| Web type check and production build | clean |
| Web unit tests | 86 files, 601 tests, all pass (new: the keyboard values with the numbers measured on iOS, and the bar's layout after it loses focus) |
| End-to-end in desktop Chrome, all 54 files | 196 pass, 1 skipped (needs a real model), 1 not run (the PWA test needs the production build; it passed in the correction batch) |
| Touch audit | 254 screen states, 5,121 controls, no finding. It now also covers a warranty with a receipt |
| Simulator tests, Safari and the installed app | 8 of 8 on the final code |

Backend code did not change. The production build behind nginx was not built
again for this commit.

One end-to-end test (voice dictation in the assistant) failed once while a
file was being edited under the running development server. It passed in the
complete run afterwards and six more times alone.

### What this check is not

- **It is a simulator, not a phone in a hand.** Reach with a thumb, real
  speed, the camera, the microphone, and iOS versions other than 27.0 are not
  covered. Only one screen size was used for the full run.
- **Safari's edge swipe to go back** could not be made by the test tool.
  Safari's own Back button was used. It goes through the same history.
- **The name shown for the Home Screen icon** was "127.0.0.1" in the test,
  because the app ran from the development server. The production build
  serves the manifest that names it; that was checked in desktop Chrome only.
- After "Done" on the keyboard, the search results stay open until the next
  tap elsewhere. Left as it is.

## Last round record

Done on 27 Nov 2026, after the iOS Simulator record. Three things were asked
for: keep corrections on review rows across a reload without Skip or Apply;
test other iOS sizes and Android; build the final code and run the
production checks again behind nginx.

### 1. Corrections on review rows are saved by themselves

Before, a correction on a row that was neither skipped nor added lived in the
page only. A reload lost it.

Now the app sends a row's corrections to the server about 0.6 seconds after
the last change. There is no Save button. The row stays "waiting": nothing is
added, nothing counts as decided, no history line is written. A reload shows
the corrected row. This holds for all four kinds:

| Kind | Stored in | Endpoint |
| --- | --- | --- |
| Item rows of an import, a photo or a pasted list; place and container rows | the row's proposal, with the choices beside it | `PUT /imports/{batch}/entries/{entry}/draft` |
| Lines of a document | the line's kept draft | `PUT /documents/{document}/extraction/lines/{line}/draft` |
| Inventory suggestions ("Edit first" → "Keep for later") | the suggestion's kept edit | `PUT /inventory-review/suggestions/{suggestion}/draft` |

No migration was needed. Rules:

- One request per row with the whole current draft; never one per key press.
- What still waits is sent when the page is hidden or left.
- A viewer cannot save (403). Another household gets 404. A row that is no
  longer waiting answers 409 and stores nothing. A draft that is too large or
  not valid answers 422.
- An empty draft puts the first reading back.
- If saving fails, the corrections stay in the page, one quiet line says
  "Your corrections are not saved yet. Trying again.", and the app tries
  again. Add and Skip are never blocked by this; they send what is in the
  page, as before.
- Two tabs or two people: the last save wins.

A read-only review of this change found one serious defect before the commit:
a saved correction made the AI suggestions of that import unusable ("no longer
current"), because the suggestions compare the import with what they first
read. Fixed: the server keeps the first reading beside the draft and compares
that. Accepting suggestions now keeps every field that was corrected by hand.
Four backend tests and one web test cover it; they fail without the fix. The
review found nothing wrong in permissions, household checks, races with Add
and Skip, or the retry logic.

**Limits of the saving, stated plainly** (the Safari limit and the top fields
of a document review were closed in the next round; see "Data and keyboard
round record"):

- A correction made less than 0.6 seconds before the browser is killed, with
  no "page is leaving" event, can be lost.
- Leaving the page at once after a correction: in the production build, with
  the service worker in control, a save could be lost: 2 of 100
  tries in Chrome, and about 7 of 80 in earlier runs. The lost requests never
  reached nginx. Without the service worker none was lost (0 of 100). Fixed
  for browsers that can be told to send `/api/*` straight to the network
  (Chrome 123 and later): 0 of 200 lost. Safari cannot be told so yet; there
  a save sent at that moment may still be lost.
- The fields at the top of a document review (merchant, dates, total) are not
  rows. They still live in the page only.
- An empty name or a quantity that is not a whole number is not stored; the
  last valid value is.

### 2. More iOS sizes

All in the Simulator, real Mobile Safari, real keyboard. Upright phones:

| Device | System | Size in points | Checks passed |
| --- | --- | --- | --- |
| iPhone SE (3rd generation) | 27.0 | 375 × 667 | 61 of 61 (48 in Safari, 13 as installed app) |
| iPhone 13 mini | 27.0 | 375 × 812 | 48 of 48 |
| iPhone 17e | 27.0 | 390 × 844 | 48 of 48 |
| iPhone 17 | 26.1 | 402 × 874 | 48 of 48; the keyboard behaves as on 27.0 |
| iPhone Air | 27.0 | 420 × 912 | 48 of 48 |
| iPhone 18 Pro Max | 27.0 | 440 × 956 | 61 of 61 (48 + 13 installed app) |

Other shapes, with what does not fit:

| Device | Size | Result |
| --- | --- | --- |
| iPad mini, upright | 744 × 1133 | 43 of 45; the two that failed are the test tool (it did not reach a field far down) |
| iPad Pro 11, on its side | 1210 × 834 | passes after the fixes below, with two limits: in the item side panel Save is not in view while the keyboard is open, and Close of Add items scrolls out of the box |
| iPhone Air, on its side | 912 × 420 | the keyboard leaves 88 points; see the limits |
| iPhone 17, on its side | 874 × 402 | the keyboard leaves 74 points; see the limits |

Defects found on these sizes, and fixed:

- **iPhone SE, Add items:** with the keyboard open the heading lay on the
  text box and hid the typed text. The numbers passed; the picture showed it.
- **375-point phones, assistant:** the top row did not fit and one button
  dropped to a second row. The full-height button is now hidden under 380
  points of width.
- **iPad on its side, item side panel:** the field being typed in ended under
  the Save bar. In the side panel the Save bar no longer sticks while a touch
  keyboard is open.

### 3. Android

Chrome 145 on Android 17, in the Android emulator, with the real on-screen
keyboard. Touches are real touch events and typing is real key input. The
same journeys as on iOS: sign in, the bottom bar with the keyboard, the
assistant, the robot and + buttons while typing, Add items, the bar editor on
an import review, a correction kept across a reload, the item form, and
list → item → the system Back.

| Shape | Size in CSS pixels | Checks | Result |
| --- | --- | --- | --- |
| Phone | 411 × 834 | 46 | all pass |
| Small phone | 360 × 560 | 46 | 45 pass; 1 limit |
| Phone on its side | 914 × 331 | 45 | 41 pass; 4 limits |
| Tablet, upright | 800 × 1160 | 46 | all pass |
| Tablet on its side | 1280 × 680 | 44 | 42 pass; 2 limits |

On the usual phone size everything passed at the first run: Android makes the
visible part shorter and does not move it, which is the easy case. The other
shapes found defects, all fixed:

- **Small phone, assistant:** while typing, the top row with Close was pushed
  off the screen and the message field hung below the visible part. The
  suggested questions now hide while the keyboard is open, and a note hides
  when the room is short.
- **Tablet on its side (the desktop layout with a touch keyboard):** the
  bottom bar sat under the keyboard while it was typed in. The assistant box,
  the item side panel, centred dialogs and Add items were placed in the whole
  window, not in the visible part. All of them now follow the keyboard.
- **One trap found on the way:** a panel whose top followed the visible part
  down the page carried the focused field away again each time Chrome moved
  the view. Rule now: a box may follow the visible *bottom*; its top stays.
- **Phone on its side:** the keyboard leaves a strip of about 80 pixels. The
  Save bar of a form covered the field being typed in. In such a strip the
  Save bar does not stick, the room rail and the assistant's top row hide,
  and the field that is typed in has the strip.

### Limits on small strips and wide screens (iOS and Android)

Most of these were closed in the next round; see "Data and keyboard round
record". They are kept here as they were found.

- **A phone on its side with the keyboard open** shows one field and little
  else. Search results are not shown while typing. In Add items the main
  button is under the keyboard. In a form, Save is not in view. In the
  assistant, Close is hidden; on an iPhone 17 the lowest 8 points of the
  message field's frame lie under Safari's keyboard bar, the text is seen.
  Closing the keyboard brings everything back. Nothing traps the person.
- **A phone on its side with more than one Safari tab:** Safari's tab bar
  leaves 18 to 36 points. The bar editor is under it. Turning the phone
  upright solves it. This is Safari's layout.
- **A tablet on its side:** in the item side panel Save is not in view while a
  touch keyboard is open; it is at the end of the form. In Add items, Close
  scrolls out of the box; a tap outside or scrolling up reaches it.
- **iPad, "hide keyboard" key:** it leaves a small pill and the field keeps
  the focus. The bar then stays above the bottom until the field loses focus.
  To check on a real iPad.
- **Add items on the iPhone SE:** Close lies on the top right corner of the
  text box.
- These are emulators and simulators. One Android version and one Android
  browser (Chrome) were used. Samsung Internet and Firefox were not tried.

### 4. The final build behind nginx

The current code was built into images and run behind nginx, as its own
Docker project with its own volumes (`housetory-pwa-check`, port 8090). The
owner's `housetory-test` containers were not touched. The app and the API
images were built at 14:49 CET; the web image again at 15:29 after the change
to the service worker. No source file changed after these builds. The stack
and its images and volumes were removed at the end.

**End-to-end files against the production build** (Chromium):

| File | Result |
| --- | --- |
| `release-stabilisation` | 2 of 2 |
| `responsive-mobile` | 14 of 14 |
| `add-items` | 2 of 2 (run again after the worker change: 2 of 2) |
| `navigation` | 10 of 10 (again: 10 of 10) |
| `offline-resource-audit` | 1 of 1 (again: 1 of 1) |
| `ai-camera-import`, with the PWA test | 6 of 6 (PWA test again: 1 of 1) |
| `touch-targets` | 8 of 8 |
| `document-extraction` | 2 of 2 |
| `inventory-review`, kept correction | 1 of 1 |

**PWA checklist, all pass:** the manifest and icons load; the service worker
registers, activates and controls the page; an old cache is dropped; nothing
under `/api` is in the cache; an API read and a correction save both answer
200 with the worker in control; with no network the app shows its own "can't
reach the server" screen and "Try again" recovers; no content-security error
on the item list or on an import review with the bar editor open.

**A visitor who already had the old service worker:** the first page load
after the new build is still served by the old worker. About 4 seconds later
the new one takes over, with no reload and nothing to see.

**Corrections through nginx:** a row corrected in the bar editor is there
after a reload; see the numbers on leaving at once above.

**Devices against the production build** (not the development server):

| Device | Result |
| --- | --- |
| iPhone 17e, iOS 27.0, Safari | 48 of 48 |
| iPhone SE, iOS 27.0, Safari | 48 of 48 |
| iPhone 17, iOS 27.0, installed from "Add to Home Screen" | 13 of 13: the icon is named from the manifest, no browser bars, the bar stands on the keyboard |
| iPad Pro 11 on its side, Safari | 37 of 41; the 4 are the two limits named above (Close of Add items, Save in the side panel) |
| Android phone, Chrome | 47 of 48 in the full run; the one that failed (the password field in view on the sign-in page) was the first check after the screen size was reset, and passed 3 of 3 when run again |
| Android small phone | 45 pass, 1 limit |
| Android phone on its side | 41 pass, 4 limits |
| Android tablet, upright | 46 of 46 |
| Android tablet on its side | 42 pass, 2 limits |
| Android, installed | Chrome offers "Install"; the icon opens the app with no browser bars and with the service worker in control; the bar stands on the keyboard (554 of 866 pixels left) and returns. On this emulator Chrome made a home-screen shortcut, not a full package; a real phone with HTTPS makes a package. |

On the iPad the sign-in page showed one more small thing: on its side, the
keyboard covers the password field after the email is typed. The Tab key or
the arrow on the keyboard goes there and Safari brings it into view.

### Checks on the final code

| Check | Result |
| --- | --- |
| `tsc -b` | clean |
| `vitest run` | 86 files, 622 tests pass |
| `vite build` | passes |
| Backend `pytest` on a fresh database | 928 tests: 925 pass, 1 skipped, 2 fail (the two old failures in `tests/test_actual_inventory.py`) |
| `ruff check` | clean |
| End-to-end, development servers, three groups | 45 of 45; 51 of 51; 102 of 102 that can run, 1 skipped |
| `touch-targets` | 8 of 8; 5,101 controls measured, none under 44 × 44 |

### Evidence

Outside the repository, under the same `mfp-runtime` folder as before:
`ios-sim/IOS_MATRIX.md` (every iOS device, every check line, every try) with
pictures in `ios-sim/uitest/out-<device>/`; `android/` with the test script,
one folder of pictures and one log per shape.

## Data and keyboard round record

Done on 27 Nov 2026, after the last round record. Three things were asked
for: keep a correction even when the request that saves it is lost (Safari,
leaving, reloading); keep the fields at the top of a document review too; and
make Save, Close and the search results reachable on a phone or tablet held
sideways with the keyboard open.

### 1. A correction is kept on the device until the server has it

A browser can lose a request that is sent while a page closes. So the app no
longer relies on that request alone.

- Each correction is written to this device first (`localStorage`), at once,
  before anything is sent. The key names the person, the household, the
  review and the row:
  `housetory:review-draft:v1:<user>:<household>:<kind>:<review>:<row>`.
- The copy is removed only when the server has confirmed that same
  correction, when the row was added or skipped, when the server says the row
  is gone or decided, on sign-out, and after 14 days.
- When a review opens, each copy is put back into its row and sent again. The
  row still **waits**: nothing is added, nothing is applied.
- A copy can also stay behind when the request did arrive but the page was
  gone before the answer. In this round the page compared the copy with the
  row on the server, let the server win without a word, and sent a copy of
  the last 10 minutes again without comparing. **Both rules were replaced in
  the next round**: the server now checks every save, and a conflict is shown
  with a choice. See "Conflict check record".
- While saving fails the page keeps the correction, shows the line "Your
  corrections are not saved yet. Trying again." and tries again.

Read-only reviews of this change, in three passes, found seven defects before
the commit. All were fixed, each with a test that fails without the fix: a copy
removed when another tab changed the household; an old request going over a
newer saved correction; a copy going over a newer correction from another
device; a good copy dropped on a slow connection; the top fields returned
for a finished review; copies of other accounts never removed; and the
import page starting the next correction from an old row.

### 2. The top fields of a document review

Merchant, purchase date, document date, currency, total, order number and the
choice between "no purchase" and "new purchase" are now kept like a row:
`PUT /documents/{id}/extraction/draft`, returned as `header_draft`. No
migration. A viewer gets 403, another household 404. It does not change the
version of the reading, so AI suggestions stay usable. Putting the fields
back never applies anything: no purchase is recorded and the document is not
changed.

### 3. A phone or tablet held sideways with the keyboard open

A phone on its side leaves a strip of about 70 pixels. There is no room above
the field, but there is room beside it. In that strip:

| Thing | Before | Now |
| --- | --- | --- |
| Search results | not shown | beside the field, in one row that scrolls sideways; a tap opens the result |
| Assistant | Close hidden | Close stands to the left of the message field |
| Add items | main button under the keyboard | text box, main button and Close in one row |
| Item form | Save at the end of the form | Save stands beside the field; a tap saves with the keyboard open |

A tap on a button in that strip does not take the focus from the field
first. Otherwise the keyboard would start to close, everything would move
back, and the tap would miss its button. This was found on the Android
emulator: the first tap on Save closed the keyboard and saved nothing.

On a tablet held sideways: the Save bar of the item side panel stays in view
and the field is kept above it, and a dialog that scrolls keeps Close at its
top.

Two things in the test tools were wrong before and were corrected:

- The Android check "results are shown" passed with a list of height zero.
  It now needs a list at least one row high.
- On iOS each page was opened in a new Safari tab. With several tabs Safari
  shows a tab bar that covers half of the strip. The tests now close the
  other tabs, as a person with one tab has none.

### Results

**On the final code**

| Check | Result |
| --- | --- |
| `tsc -b`, `ruff check`, `vite build` | clean |
| `vitest run` | 87 files, 656 tests pass |
| Backend `pytest`, fresh database | 930 tests: 927 pass, 1 skipped, 2 fail (the two old failures) |
| End-to-end, development servers | 49 of 49; 54 of 54; 102 of 102 that can run, 1 skipped |
| `touch-targets` | 8 of 8; 5,110 controls, none under 44 × 44 |
| New `landscape-keyboard` spec | 4 of 4. It makes the browser report a short visible part; it has no real keyboard |

One spec of another area (`invoice-stage-a`) was updated: its stand-in server
did not know the new address for the top fields.

**Production build behind nginx** (own Docker project, removed at the end;
all images built at 17:50 CET, the web image again at 18:16 after the last
fix; no source file changed after that)

| Check | Result |
| --- | --- |
| 12 end-to-end files, Chromium | 64 of 64. The six that touch this work were run again on the last web image: 18 of 18 |
| PWA and service worker checklist | all pass |
| Leave the page at once after a correction, 50 tries | correction missing 0 of 50, in Chrome and in WebKit |
| The same with the saving request made to fail, 20 tries | missing 0 of 20; all saved afterwards; no copy left on the device |
| Reload at once, 50 tries, and 20 with the request failing | missing 0 of 50 and 0 of 20 |
| Saving answers 500 for a while | the line shows; after a reload the correction and the line are both there; when saving works the line goes and the server has it |
| Top fields of a document review | back after a reload; nothing applied; no purchase recorded |
| Sign-out | no copy left on the device |

WebKit here is Playwright's WebKit 27.2 on the Mac, not Safari on a phone.
It did not lose the leaving request in these runs (the server had the
correction in 50 of 50), so the Safari loss could not be shown by it. That
is why the request was also made to fail on purpose.

**iOS Safari, Simulator, production build** (iPhone 17e, iOS 27.0)

| Check | Result |
| --- | --- |
| Correct a row, kill Safari about one second later, open the page again | the correction is in its row |
| The server is stopped; correct a row | the correction is in its row, the line about unsaved corrections shows |
| Kill Safari, start the server, read the server | the server does not have the correction (3 of 3) |
| Open the page again | the correction is back in its row; then the server has it; the row still waits; nothing added (3 of 3) |
| Change the merchant of a document review, kill Safari, open again | the merchant is back; nothing applied |

The test tool cannot act faster than about one second, so "leave within 0.6
seconds" was not tried in real Safari. The stopped server stands in for the
lost request.

**Chrome on Android, emulator, production build**

| Check | Result |
| --- | --- |
| Leave the page 60 ms after the Enter key | correction there afterwards: 5 of 5 in each of 6 runs |
| Saving fails | line shows; server does not have it; copy on the device |
| Reload while saving fails | correction still in its row |
| Saving works again | saved by itself; line gone; no copy left; row still waits |
| Top fields of a document review | merchant and total back after a reload; nothing applied |
| The server is stopped; correct a row; go Home; the browser is killed; server back; open again | recovered and saved: 3 of 3 |

**Layout on devices, production build**

| Device | Result |
| --- | --- |
| iPhone 17e upright, Safari | 48 of 48 (three search checks only after two items were added, so that the search word had results) |
| iPhone 17 on its side, Safari, one tab | 45 of 45, 1 not applicable (the rail is hidden in the strip by design) |
| iPhone 17, installed app | 11 of 11 |
| iPad Pro 11 on its side, Safari | 43 of 43, 5 not applicable (iPad has no Done key) |
| Android phone, small phone, phone on its side, tablet | 59 of 59 each, no limits |
| Android tablet on its side | 57 of 58 in the full run. The one that failed (the total of a document review after a reload) was the test: it tapped a field that lay under the keyboard. It passed when the test closed the keyboard first |

All limits of the last round on these shapes are closed: none of the five
Android shapes reports a limit now, and the four iPad checks that failed
before pass.

### Limits that remain, stated plainly

- **A browser that is killed with no warning** (a crash, the power going)
  while the server cannot be reached can lose the last correction. Chrome
  writes its local storage to disk a moment later, and at once when it goes
  to the background. Measured on the Android emulator with the server
  stopped: Chrome killed from the foreground lost the correction in 4 of 8
  tries; after pressing Home first, 0 of 3. Safari on the Simulator kept it
  in 3 of 3 kills from the foreground.
- The copy is on **this device and this browser** only. With storage turned
  off (some private modes) the safety is as it was before.
- (Replaced in the next round: "the server wins without a word" and the
  10-minute rule. See "Conflict check record".)
- The choice of an **existing** purchase in a document review is not kept.
- The server tidies tags (it removes `#` and doubles). A copy that differs
  only in that can be dropped when the tab also died before the answer.
- **A phone on its side with more than one Safari tab:** Safari's tab bar
  covers half of the strip. This is Safari's layout; one tab or the phone
  upright solves it.
- In the sideways strip only Save is shown beside a form field; Cancel and
  Discard return when the keyboard closes. A tall text box shows its first
  two lines. Add items shows the text box and the main button; the place
  chooser and the photo buttons return when the keyboard closes.
- The small Save of the AI settings page in the sideways strip was built the
  same way but **not checked on a device**.
- A narrow upright phone whose keyboard leaves under 200 pixels still has
  Save at the end of the form.
- The **sign-in page** on a phone held sideways was not part of this round.
  One early Android run showed two failed checks there; it was not looked
  into.
- iPad "hide keyboard" key: as in the last round, to check on a real iPad.
- Still no real phone in the hand. One Android version, Chrome only.

### Evidence

Outside the repository, in the same `mfp-runtime` folder: `ios-sim/uitest/`
(`out-prod2-*`, `out-land3`), `android/` (`prod2-*`), and the scripts
`pwa/device-drafts.sh` (kill and stopped-server steps for both systems).

## Conflict check record

Done on 27 Nov 2026, after the data and keyboard round. One thing was asked
for: an older correction kept on one device must not go over a newer
correction that another device saved, without anyone knowing.

### The rule, kept by the server

Each kept correction of a review row now has a **revision** (a number that
goes up by one each time the stored correction changes) and a **writer** (the
device and person that stored it). Both are stored beside the correction, in
the JSON that was there already. No migration. They are not part of what the
review reads as its source, so AI suggestions stay usable, and they are never
copied to an item.

Every save says which revision it was made on and who sends it. Both are
required; a save without them is refused (422). The server decides while it
holds the lock of the row, so two devices cannot both win:

| The save | The server |
| --- | --- |
| says what is stored already | nothing to do, 200 (a request that arrived before and is sent again) |
| was made on the stored revision | stores it, revision + 1 |
| was made on an older revision, but the stored correction is from the same device and person | stores it, revision + 1 (that device saved before and never got the answer) |
| anything else | **409 `draft_conflict`**, nothing stored |

This holds for all four kinds: import rows, document lines, the top fields of
a document review, and inventory suggestions. A skip, taking AI suggestions,
a cleanup after scanning and a new reading of a document keep the revision
going; none of them starts it again at 0.

### What the app does

- Every copy on the device is sent again with its revision, whether its
  review is open or not. The 10-minute rule is gone, and the page no longer
  decides by comparing rows itself.
- **No conflict:** as before, by itself. The correction is back in its row,
  it is saved, the copy is removed, the row still waits.
- **Conflict:** the copy is kept and is not sent again by itself. The row
  shows what the server has, and one line on that row says: "This row was
  also corrected on another device. Yours: «Step ladder», quantity 2." with
  two buttons, **Use mine** and **Keep the other**. "Use mine" saves the copy
  on top of what the server has now. "Keep the other" removes the copy. The
  same line shows when two devices have the review open at the same time.
- Nothing here adds, skips or applies anything. A correction in conflict is
  not part of what Add, Skip or Apply sends until the person chose "Use
  mine".

### Defects found by review before the commit, all fixed

- On the import page, a row corrected earlier in the same visit could still
  go over a newer correction: device A corrects a row and leaves the page,
  device B corrects it, skips it and restores it, A comes back. The page now
  takes the server's row when someone else changed it.
- The "same device" rule matched two people on one browser. The writer is now
  the device together with the person.
- A cleanup after scanning started the revision of the top fields again at 0.
- A save without a revision was stored as before. Now it is refused.
- After "Accept suggestions" on the import page, a row that had no suggestion
  and that another device had corrected was put back as this page had it. The
  page now moves the revision on only for the rows the server changed.

### Tests

| Case | Where |
| --- | --- |
| Two devices read a row; B saves; A's save on the older row is refused; B's correction is intact | backend, all four kinds |
| A's save arrived but its answer was lost; A's newer correction is stored without a conflict | backend, all four kinds; web unit tests |
| The same request sent again after it arrived | backend: 200, no new revision |
| B saves a newer correction after that; A's older copy comes back | backend: refused; web: the copy is kept and the line shows |
| A new reading or a cleanup does not start the revision again | backend |
| Two browser windows as two devices on one import review; "Use mine" and "Keep the other" | end-to-end, 2 tests |
| A lost request with no conflict is still recovered by itself | end-to-end, as before |

| Check | Result |
| --- | --- |
| `tsc -b`, `ruff check`, `vite build` | clean |
| `vitest run` | 87 files, 673 tests pass |
| Backend `pytest`, fresh database | 934 tests: 931 pass, 1 skipped, 2 fail (the two old failures) |
| End-to-end: Add items, document review, inventory review | 21 of 21 |
| End-to-end: assistant, documents and reviews group | 102 of 102 that can run on a development server, 1 skipped (it needs a real AI model). A first pass had two failures while a source file was being saved; both passed in a full second pass with no file changing |

This round was not run on the iOS Simulator, the Android emulator or a
production build. The change is in the server rule and in what the page
sends; the layout did not change.

### Limits that remain, stated plainly

- **Add, Skip and Apply are not checked by revision.** A person who decides a
  row decides what is on their screen. If another device corrected that row a
  moment before, that correction is replaced by the decision.
- **Two tabs of one browser** are one device and one person. The newer save
  of either tab wins there, as before.
- With storage turned off, a conflict is remembered only while the page is
  open.
- The line shows the name and quantity of "yours" for a row, and the changed
  fields for the top of a document. It does not show a full comparison.

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
| Stable keyboard, safe areas, reachable main actions | Done on the iOS Simulator | "iOS Simulator record"; not checked on a phone in the hand |
| No zoom on focus; pinch zoom and text scaling kept | Done | 16 px rule kept; viewport tag unchanged |
| Predictable Back, Close, Cancel and outside tap | Done | Close fix on sheets; Escape closes the inner list first |
| Drafts and selections kept; cleared on sign-out | Done | item drafts as before; bulk selection survives opening an item; recent items cleared with drafts |
| List position and filters kept when opening and closing an item | Done | position restored at once; on desktop the list stays next to the panel |
| No nested scrolling or stacked overlays | Done | one panel on desktop, one sheet on phones |
| Reduced motion, labels and focus | Done | global rule kept; new controls have names |
| Add-items Close problem reproduced before fixing | Done | "Phase 1 record" |
| Small and large phone, short landscape, tablet, desktop exercised | Done | 320, 390, 844 x 390, 768 and 1440 px |
| iPhone and PWA checks reported apart from browser checks | Done | simulator and emulator checks have their own records ("iOS Simulator record", "Last round record"); none on a real phone |

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
| Uncertain fields are clear and can be edited | Done | "Check: …" line; name, quantity and other values open in the bottom bar |
| Empty fields under "More details" | Done | row editor |
| Checkboxes select only; nothing selected at first; Select all | Done | all four kinds |
| A direct Add or Apply on each row | Done | per-row button |
| Bulk button says what it does; off when nothing is selected; separate counts | Done | "Add 3 selected items" and similar |
| Skip removes the row, offers Undo, keeps edits | Done | "Skipped (n)" with Restore; the whole draft is kept on the server |
| Dismissals are remembered; reassessment still possible | Done | server state; "Reconsider dismissed" kept |
| Way back to skipped work after the message is gone | Done | "Skipped (n)" part |
| No routine Import/Skip/Reject dropdowns; merge only for duplicates | Done | removed |
| Required fields checked before accepting; errors beside the field | Done | row editor |
| Partial failure keeps what worked and what is left | Done | failed rows stay selected |
| Quiet line for optional suggestions in chat | Done | "N possible corrections · View suggestions" |
| An accepted row cannot be added twice | Done | server rules kept; row loses its actions |
| A small picture on each row where useful | Partly | photo reviews show the source photo once, with a numbered pin for each finding that has a position |
| A selected row is clearly marked | Done | background, border and bar, in all four themes |
| A failed save keeps the typed details | Done | Retry and "Discard changes" on the document surface |

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
| 6. Assistant: general help, evidence, manual discovery, correction, Undo | Done | real model for all parts; manual discovery also with a real search (correction batch, point 7) |
| 7. Long work, steering, stopping, recovery | Done | real model for stop and steer; scripted for recovery |
| 8. Insurance export, stocktake, Settings | Done | end-to-end |
| 9. No AI, permissions, household isolation | Done | end-to-end and backend tests |
| Phone at 320, 390 and 430 px, short and landscape, tablet, desktop | Partly | 320, 390, landscape, 768 and 1440 px were checked; 430 px was not checked on its own |
| Empty, large, loading and error states | Partly | covered where the end-to-end files cover them; not walked through one by one |
| Production build behind nginx, as a PWA in desktop Chrome | Done | correction batch, point 6 |
| Touch targets of 44 px | Done | `e2e/touch-targets.spec.ts`, correction batch, point 5 |
| Mobile Safari and installed app on the iOS Simulator | Done | "iOS Simulator record": eight defects found and fixed |
| Other iPhone sizes, iPad, iOS 26.1 (Simulator) | Done | "Last round record", point 2 |
| Android phone and tablet shapes (emulator, Chrome) | Done | "Last round record", point 3 |
| A real phone in the hand | **Not done** | a separate device check for Ashkan |

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
| `a846424` | Phase 6: end-to-end files, fixes found by them, real-model fixes, the Phase 6 record |
| `e55fd2a` | Correction batch: the seven points of the review, and its record |
| `d98436f` | Fixes from the iOS Simulator check, and its record |
| `9aada2f` | Corrections on review rows saved by themselves; fixes from more iOS sizes and Android; the last round record |
| `27cb43e` | Corrections kept on the device until the server has them; top fields of a document review; phone and tablet on their side with the keyboard open |
| the commit after `27cb43e` | The server checks every kept correction by revision; a conflict between two devices is shown with a choice |

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

1. **Photo review with numbered pins.** Built in the correction batch. One
   difference remains: a pin is shown only where the recognition gave a
   position that passed the checks. A finding without one has a number and a
   row but no pin, and the page says so.
2. **Correcting a finding by typing in the bottom bar.** Built in the
   correction batch, for the values shown on a closed row. Fields that are
   not on the closed row are still edited in the row's editor.
3. **The Add menu.** The mock's + opened a small menu with three choices. The
   app's + opens the existing "Add items" surface, where text, a link, a photo
   or voice go into one field. The paperclip opens the file chooser at once.
4. **The desktop panel** holds the item and its edit form. In the mock,
   reviews and documents also opened there. In the app they open as pages,
   dialogs or in the assistant.
5. **Fonts.** The mock used its own fonts. The app keeps its fonts in all four
   themes.

The mock's shortcut "a question mark means a question, anything else is a
note" was left out on purpose (point 3 of the decision).

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
- **Photo review rows** have no picture each. They have a number, and a pin
  on the shared photo when the position is known.
- **Positions on photos** were tried with one vision model only. Another model
  may give fewer or worse positions; bad boxes are dropped, wrong but
  well-formed ones cannot be detected.
- **Offline**, the app shows its "can't reach its server" screen, not the
  inventory. The wording of that screen speaks of the "API container".
- **"Rotate credentials"** in the AI settings acts without asking first, and
  Escape does not close a dialog while the focus is on an open list. Both
  were noticed in the touch audit, are older than this work, and were left.
- **Document matching** sorts equally strong matches by name. Older than this
  work.
- **In the new loan dialog**, the name list still covers "More options" while a
  name is being typed.
- **Each assistant change** costs three to five model requests.
- **The phone rail in landscape** shows only about two rooms at a time. It
  scrolls, and it can be hidden.
- **Keyboard on small strips and wide screens, and corrections saved by
  themselves:** see "Limits that remain" in the data and keyboard round
  record and in the conflict check record.

## Not complete

Stated plainly, after the last round:

1. **No check on a real phone in the hand.** The keyboard, the bottom bar and
   the installed app were checked on the iOS Simulator (six iPhone sizes, two
   iPads, iOS 27.0 and 26.1) and on the Android emulator (five shapes). These
   found and fixed real defects. They do not show reach with a thumb, real
   speed, the camera or the edge swipe. This stays a separate device check for
   Ashkan. Problems found there are to be fixed then.
2. **Video links in assistant answers are not built.**
3. **Hosted sign-up is design only**, as the specification allows.
4. **Two backend tests fail**, as they did before this work
   (`tests/test_actual_inventory.py`).
5. **Positions on photos and real manual search were each tried with one
   model** (`openai/gpt-6-luna`) and, for search, one search service (Brave).
6. **430 px was not checked on its own**, and empty, large, loading and error
   states were not walked through one by one. They are covered where the
   end-to-end files cover them.

Closed by the correction batch: the two missing Design D interactions, the
PWA test behind nginx, the real search check, and the touch controls under
44 px.

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
