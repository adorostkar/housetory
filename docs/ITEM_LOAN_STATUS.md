# Item-detail loan status and compact photo follow-up

This follow-up makes loan state visible at the top of item detail without
replacing the existing shell, lending card, history/undo or gallery behaviour.
It does not add borrower accounts, reminders, schema changes or later milestone
work.

## Title-area loan state

Under the title the item page has two rows: **Lives in** (the recorded place)
and **Right now**. For any item with open loans the Right now row states the
loan in text:

- **Fully loaned, one borrower:** “With Mohsen”, then “Lent (date) · due (date)”
  or “no return date”. When more than one unit is owned, the line also shows
  the owned, here and on-loan counts.
- **Partially loaned:** an accurate quantity summary such as “1 of 3 with
  Mohsen”, plus owned, here and on-loan counts, and a second line “2 here”.
- **Multiple borrowers/loans:** a total summary (“2 of 3 on loan” or “All 3
  units on loan”) plus one row per open loan with
  borrower name, outstanding quantity and dates; no single borrower is
  shown as holding all stock. At most four rows are shown; a link opens all
  open loans of the item.
- **Overdue:** an explicit “Past due” text badge on a single loan, and
  “· past due” in the row of each overdue loan when there are several.
- **Returned/cancelled or no open loan:** the row says “Here” (and “all N” when
  more than one unit is owned); the **Loans** tab and history retain the closed
  loan.
- **No return date:** shown as “no return date”, never guessed.
- Private borrower notes are not rendered in the Right now row.

The row has one **Return** action when exactly one loan is open.
When several loans are open, each loan row has its own
**Return** action (labelled “Return from [borrower]” for screen readers), so the
user chooses the relevant loan.
Both paths reuse `ReturnLoanDialog`, the existing backend quantity validation,
partial returns, idempotency and history/undo. **Lend** is in the same row
while units are here. Viewers see the loan state but no
return, lend or edit controls.

## Usual home location

The **Usual home location** label was removed with the new item page. The
recorded room/container is always shown in the **Lives in** row, with its links
and a **Move** button. Where the units are now is said by the **Right now** row
next to it: with the borrower, or how many are here.

The item is not moved to a fictitious borrower location.

## Empty photo state

The item's photos are a strip of small thumbnails:

- without a photo, the strip shows one small tile (“No photograph yet”, or the
  reference image) and an **Add photo** tile with a camera button and a library
  button;
- with photos, each thumbnail opens the photo full screen (the lightbox), and
  the Add photo tile stays at the end;
- **Manage photos** opens the cover/order controls, removal and the image
  source; they are closed by default.

## Verification

This is the record of the original follow-up. The counts are from that time.
The current tests are in `item-loan-status.test.tsx`, `photo-gallery.test.tsx`,
`item-detail-page.test.tsx` and `e2e/item-status.spec.ts`.

- 267 PostgreSQL tests (existing lending validation unchanged)
- 114 Vitest tests, including title status for fully/partially/multiple loaned
  items, return-choice callbacks, viewer restrictions, overdue text, note privacy,
  and empty/populated photo control counts
- 30 disposable-stack Playwright workflows, including isolated fully/partially/
  multiple-borrower/item-status fixtures, authorized return, returned state, no
  due date, usual-home label, viewer restrictions, empty/populated galleries and
  all previous flows
- Ruff, strict TypeScript typecheck, production build and migration checks pass
- No real Heavy drill/Mohsen loan or other household record was used as a test
  fixture

Screenshots are under `docs/walkthrough/item-status-followup/` (older screens: before/after,
light/dark, desktop/mobile, full/partial/multiple states, empty and populated
photos).

## Remaining limits

- Multiple open loans use one return action per loan; there is no bulk return.
- Due dates are recorded facts, not return guarantees or reminders.
- Borrower accounts, contact details and automatic notifications remain out of
  scope.
- The next lending-usability follow-up (Loans-page new-loan entry and point-of-use
  actions) has not been started here; manuals and later milestones remain later.
