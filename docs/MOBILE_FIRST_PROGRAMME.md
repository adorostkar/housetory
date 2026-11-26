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
| 2 | Capture, documents and reviews | Not started |
| 3 | Natural assistant behaviour | Not started |
| 4 | Inventory-first navigation and everyday flows | Not started |
| 5 | Secondary flows and account design | Done (see "Phase 5 record") |
| 6 | Verification and final handoff | Not started |

The decision is made (see "Decision" below). Phases 1 to 6 now run without
stopping. Each finished phase is committed and pushed. Nothing is merged or
deployed.

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
- **Documents:** saved as soon as the file is chosen, with Undo. Details after.
- **Add and attach:** both open a small menu at the button that was pressed. On
  the phone it is a sheet from the bottom. On desktop it is a menu above the
  button. The chosen task opens after that.
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
