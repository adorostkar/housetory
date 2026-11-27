# Mobile responsiveness, focus zoom and navigation

This batch addresses the iPhone/PWA typing zoom, Settings horizontal overflow and
crowded mobile navigation reported in the live UI. It does not change the viewport
meta tag, disable pinch zoom or depend on user-agent sniffing.

## Input focus zoom

Root cause: shared text controls rendered at `0.95rem` (15.2px), while item filters
and the search scope were smaller still. Safari zooms a focused text control when
its computed font size is below 16px.

Fix: mobile and coarse-pointer layouts now enforce
`font-size: max(1rem, 16px) !important` for all text-entry controls, including
direct `<input>`, `<select>`, `<textarea>` and content-editable elements. Checkbox,
radio, range, file and button inputs are excluded because their font size does not
trigger the typing zoom. The `max(1rem, 16px)` form respects a larger root/system
text size. Desktop fine-pointer layouts keep the compact typography.

No `maximum-scale` or `user-scalable=no` is used.

## Settings overflow

Root cause: the Settings grid allowed its items' min-content width to expand the
single column. The Intelligence header's non-wrapping **Check provider** button was
the widest contributor, and a long environment-variable token could overflow its
paragraph.

Fix:

- `min-width: 0` on the shared surface panel and Settings grid
- wrapping Intelligence header
- breakable inline environment-variable code
- no blanket `overflow-x: hidden`, no data truncation and no reduced text size

The 320px document width now matches the viewport.

## AI task rows at intermediate widths

The `/settings/ai` task rows previously switched to a four-column layout at the
`sm` breakpoint. With real provider labels and six active task settings, the fixed
`auto` action group (Save + Test, about 208px wide) extended past the card at 768px
and at 1024px where the desktop sidebar appears.

The row now stays in a safe wrapped layout until the `xl` breakpoint, with
`min-width: 0` task/provider/model fields, full-width model row, and a wrapping
action group whose Save/Test buttons remain intact. At `xl` the four-column row is
used only when enough width exists.

Measured at 768px with two providers and six active tasks:

| Measurement | Before | After |
| --- | ---: | ---: |
| Document `scrollWidth` | 782 | 768 |
| Task card right | 711 | 711 |
| Action group right | 782.125 | 698 |
| Test button right | 782.125 | 278.125 |
| Test button height | 32 | 32 |

The action group no longer leaves the card, and the document no longer grows past
the 768px viewport.

## Mobile navigation

> **Replaced.** The five-tab bar described here was replaced by the room rail and
> the single bottom bar of Design D. See
> [`MOBILE_FIRST_PROGRAMME.md`](MOBILE_FIRST_PROGRAMME.md). The focus-zoom and
> overflow fixes in this file still apply.

The previous eight-tab bar was reduced to five healthy targets:

- Home
- Items
- Rooms
- Loans
- More

**More** opens an accessible menu containing Review, Documents, Purchases,
Warranties, Containers, Assistant, Search and Settings. The desktop sidebar keeps
Overview/Items/Rooms/Loans as core links, Documents/Containers under **Library**,
and Review/Purchases/Warranties/Assistant in a calm **More** disclosure. Search
remains the top-centred global entry; no route or origin behavior changed. Each target is at least
44px high; the primary tabs are 56px high and their label size was increased.
The active destination is marked normally, and More is marked active when one of
its destinations is open.

### Software keyboard behavior

`useSoftwareKeyboardOpen` watches a real visual-viewport reduction while a text
control is focused. When the visual viewport shrinks by more than 120px, the fixed
bottom bar unmounts instead of floating over the keyboard. It returns when the
viewport returns, without changing focus, selection or typed text.

- Focus alone (hardware keyboard or no software keyboard) leaves the bar visible.
- A normal browser-toolbar resize without a focused text control leaves it visible.
- Orientation changes reset the baseline.
- No viewport-meta mutation and no UA-only branches.

Since the mobile-first programme (see `MOBILE_FIRST_PROGRAMME.md`, "iOS
Simulator record") the rules are these:

- The bar hides only while a text field **of the page** has focus and the
  keyboard is up. Its own field and the bar editor keep it. A tap on a button
  of the bar while its field has the keyboard must work, so the bar keeps its
  layout for 250 ms after the field loses focus.
- `useKeyboardInset` sets three values on the root element. On iOS the keyboard
  does not make the window shorter; it makes the visual viewport shorter and
  can move it down the page.
  - `--keyboard-inset`: what is left of the window under the visible part.
    Things fixed to the bottom add it to their `bottom`.
  - `--visual-viewport-top`: how far the visible part has moved down.
    The assistant sheet uses it as its `top` while the keyboard is open.
  - `--visual-viewport-height`: the visible height, set only while the keyboard
    is open. Bottom sheets and phone dialogs use it as their largest height.
- The layout height is `layoutViewportHeight()`, not `window.innerHeight`: an
  installed iOS web app reports a shrunken window height while the keyboard is
  open.
- `useKeepFocusedFieldVisible` moves the page so that the field being typed in
  is above a sticky Save bar.
- On a touch screen, opening an existing item for editing does not focus a
  field, so the keyboard does not cover the form.
- The root element carries `data-keyboard="open"` while a touch keyboard is
  open, `"short"` when the visible height is under 420 px, and also
  `data-keyboard-tiny` under 200 px (a phone held sideways). Styles use them
  through `[[data-keyboard]_&]:…`. Short: the assistant's suggested questions
  and notes hide, the Add-items heading does not stick. Tiny: the room rail
  and the assistant's top row hide and a form's Save bar does not stick, so
  the field that is typed in has the strip.
- The wide layout follows a touch keyboard too (a tablet held sideways): the
  bar and the bar editor stand on it, the assistant box and centred dialogs
  stay in the visible part, the item side panel ends where the keyboard
  begins, and its Save bar does not stick while the keyboard is open.
- A box may follow the visible **bottom**. Its top must not follow
  `--visual-viewport-top` when the focused field can lie outside what is
  seen: the browser then moves the view again and the field runs away. The
  phone assistant sheet is the one exception; its field is at its bottom.
- The service worker tells the browser to send `/api/*` straight to the
  network where the browser supports that, so a save sent while the page is
  left does not pass through the worker.

## Dialogs and fixed controls

- Dialog height accounts for the safe-area inset and keeps internal scrolling.
- Bottom padding respects `env(safe-area-inset-bottom)`.
- Global scroll padding keeps focused fields clear of fixed navigation.
- Schedule, Add items, Lend and Return dialogs were measured at 320/390 and scroll
  internally without horizontal overflow.

## Verification matrix

Rendered with disposable dense records at:

| Width | Height | Context |
| ---: | ---: | --- |
| 320 | 568 | phone |
| 375 | 667 | phone |
| 390 | 844 | phone |
| 430 | 932 | phone |
| 844 | 390 | landscape phone |
| 768 | 1024 | tablet |
| 869 | 700 | tablet |
| 1024 | 768 | tablet/laptop |
| 1440 | 1000 | desktop regression |

Pages checked: overview, items, settings, settings/AI, review, search, item edit,
item detail with owned contents, loans, rooms, containers, documents, purchases
and assistant.

Assertions:

- document and body scroll width never exceed the viewport
- every visible text-entry control computes to at least 16px
- the 5-tab bar has no overlaps, at least 44px targets and readable labels
- the More menu exposes all secondary destinations and scrolls in landscape
- the software-keyboard simulation hides and restores the bar with focus and text
  preserved
- schedule, add-item, lend and return dialogs fit their viewport and scroll
- item contents search/scope/sort controls and storage actions fit a 390px phone
- the viewport meta does not disable zoom
- increasing the root font size to 20px increases the input size as well

Results:

- Chromium mobile/tablet matrix: pass
- WebKit 27.2 mobile/tablet matrix with touch and DPR 3: pass
- Full checked-in Playwright suite: **95 workflows, 94 passed, 1 fixture-dependent skip**
- Desktop 1440 regression: compact controls and no mobile bar

## Screenshots

Before:

- [Settings 320 overflow and crowded eight-tab bar](walkthrough/responsive-mobile/before-320-settings-overflow.png)
- [Item edit at 320 with 15.2px focused input](walkthrough/responsive-mobile/before-320-item-edit-focus.png)

After:

- [Settings at 320 with no horizontal overflow](walkthrough/responsive-mobile/after-320-settings.png)
- [Item edit at 320](walkthrough/responsive-mobile/after-320-item-edit.png)
- [Five-tab bar and More menu at 320](walkthrough/responsive-mobile/after-320-more-menu.png)
- [More menu in 844×390 landscape](walkthrough/responsive-mobile/after-844-landscape-more.png)
- [Schedule dialog at 390×844](walkthrough/responsive-mobile/after-390-schedule-dialog.png)
- [Keyboard-open simulation: bottom bar hidden](walkthrough/responsive-mobile/after-390-keyboard-hidden.png)
- [Keyboard dismissed: bar restored and text retained](walkthrough/responsive-mobile/after-390-keyboard-restored.png)
- [1440 desktop regression](walkthrough/responsive-mobile/after-1440-desktop.png)
- [768 AI task rows before the targeted fix](walkthrough/responsive-mobile/before-768-ai-settings.png)
- [768 AI task rows after the targeted fix](walkthrough/responsive-mobile/after-768-ai-settings.png)

## Limitation

Playwright WebKit and DOM metrics verify the CSS and viewport-response behavior,
but they cannot reproduce the real iOS software-keyboard animation, Safari toolbar
resize timing or installed-PWA standalone behavior. A real iPhone/PWA retest is
still required; this batch does not claim that it ran.
