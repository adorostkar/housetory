# Item-detail loan status and compact photo follow-up

This follow-up makes loan state visible at the top of item detail without
replacing the existing shell, lending card, history/undo or gallery behaviour.
It does not add borrower accounts, reminders, schema changes or later milestone
work.

## Title-area loan state

The item header now shows a prominent, text-backed loan panel directly beneath the
title for any item with open loans:

- **Fully loaned, one borrower:** “On loan to Mohsen”, with owned/at-home/on-loan
  quantities and the recorded return date or “No return date set”.
- **Partially loaned:** an accurate quantity summary such as “1 of 3 units on loan
  to Mohsen”, plus owned, at-home and on-loan counts.
- **Multiple borrowers/loans:** a total summary plus one row per open loan with
  borrower name, outstanding quantity and recorded due date; no single borrower is
  shown as holding all stock.
- **Overdue:** an explicit “Past due” text badge in addition to the tone.
- **Returned/cancelled or no open loan:** no loan panel is shown; the existing
  lending card reports that everything is at home and history retains the closed
  loan.
- **No return date:** shown as “No return date set”, never guessed.
- Private borrower notes are not rendered in the header or status panel.

The panel includes one **Record return** action when exactly one loan is open.
When several loans are open, each loan row has its own
**Record return from [borrower]** action, so the user chooses the relevant loan.
Both paths reuse `ReturnLoanDialog`, the existing backend quantity validation,
partial returns, idempotency and history/undo. Viewers see the loan state but no
return, lend or edit controls.

## Usual home location

While any units are on loan, the Details row is labelled **Usual home location**
instead of Place. It explains:

- fully loaned: all owned units are out; the room/container is the recorded home,
  not a current physical location;
- partially loaned: the recorded home applies to the at-home units only; loaned
  units are not recorded there.

This preserves the existing room/container links and the detailed lending card.
The item is not moved to a fictitious borrower location.

## Empty photo state

The empty gallery now:

- uses a compact 150 px minimum-height panel rather than a large image placeholder;
- has one clear **Take photo** / **Choose photo** control pair;
- no longer renders the additional compact gallery toolbar while empty;
- keeps the full-size gallery, cover/order controls, removal, navigation and
  lightbox once a photo exists.

Populated galleries are unchanged apart from the existing consolidated upload
controls.

## Verification

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

Screenshots are under `docs/walkthrough/item-status-followup/` (before/after,
light/dark, desktop/mobile, full/partial/multiple states, empty and populated
photos).

## Remaining limits

- Multiple open loans use one return action per loan; there is no bulk return.
- Due dates are recorded facts, not return guarantees or reminders.
- Borrower accounts, contact details and automatic notifications remain out of
  scope.
- The next lending-usability follow-up (Loans-page new-loan entry and point-of-use
  actions) has not been started here; manuals and later milestones remain later.
