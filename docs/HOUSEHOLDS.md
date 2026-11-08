# Multiple households and All my places

An account is global. A household is the membership, permission and data
boundary. One account may belong to several households with a different role in
each, but there is no global role and no automatic access between households.

```text
Account
  Membership (owner/member/viewer) -> Household
                                       Property -> Room -> Place -> Item
```

The **current editable workspace** is one household at a time. Search and the
assistant default to **All my places** across the account's current memberships.
That broad read scope is deliberately separate from the workspace used for
editing.

## Account, household and role model

- `owner`, `member` and `viewer` are membership roles, not account roles.
- The same account can be an owner in one household and a viewer in another.
  Selecting a household recomputes the effective role for every request.
- The creator of a new household becomes its owner.
- Last-owner demotion/removal protection and household row locks are unchanged.
- Existing households, properties, rooms, items, IDs, QR payloads, loans,
  stocktakes, evidence, imports, documents and AI provider settings are not
  recreated or reassigned by household switching.
- Household deletion, leaving, ownership transfer and cross-household inventory
  transfer are intentionally not implemented in this milestone. Ask an owner to
  remove a membership.

### First run, invitations and no-membership accounts

- First-run setup remains available only while the instance has zero users.
  Creating additional households never reopens public signup.
- Invitations are still bound to one household, one email address and one role.
  The invited email must match the signed-in account; wrong-account acceptance
  is rejected. Accepting an invitation adds a membership to the existing account
  or creates an account only for the invited address.
- An authenticated account with no memberships gets a useful no-household page
  with an account-level household-creation form. Creating that first household
  makes the account its owner and creates an initial property.

## Creating and switching households

- `GET /households` returns only the caller's current memberships.
- `POST /households` creates a household, owner membership and initial property,
  then selects it. Creation is bounded to 20 memberships per account and has an
  in-process rate limit.
- `POST /households/{id}/select` validates membership before changing the session
  selection. A household id from another account returns the same not-found
  response as an id that does not exist.
- The compact desktop selector and the mobile account menu list current
  households and roles. Settings also exposes the selector and create action.
- Account settings remain separate from household settings, members and
  properties.

### Stale tabs and explicit mutation context

The session stores the selected household. The browser API client also sends the
rendered household id in `X-Household-Id` on requests.

- A multi-household account must send a current `X-Household-Id` for unsafe
  requests. No header is accepted when there is only one membership for
  compatibility with simple API clients.
- The header must match the selected session household. If another tab switched
  households, the stale tab receives `409 household_context_changed` and must
  reload; it never mutates the newly selected household.
- Switching clears every non-session frontend query cache, cancels in-flight
  reads and changes the query hash prefix, so an older async response cannot
  populate the new household's cache. It also clears the remembered property
  filter and an invalid remembered search scope.
- Bulk selections, import reviews, voice proposals, recognition reviews,
  stocktake reviews and other in-page state are discarded by the workspace
  navigation and cache reset. All server-side applies remain household-scoped and
  revalidate their entities before writing.
- Background import/recognition/voice work retains the household that created
  it. It cannot apply to a different household through a stale browser tab.

## Revoked access

Every household request resolves the membership from the database again. If the
selected membership was removed or changed to a household the account no longer
belongs to:

- a data request returns `401 household_access_revoked`;
- the frontend refreshes session state;
- session state falls back to another current membership, or to the
  no-household state if none remain;
- old caches are removed. The browser never keeps showing authorized-looking data
  for a revoked membership.

## All my places search

`GET /search/scopes` returns only current memberships and their active
properties. Search and assistant scope selectors use it and remember a deliberate
household/property choice in local storage and the URL.

- The default is **All my places**. It covers every current membership, capped at
  20 households per request with an explicit notice if the cap is reached.
- An explicit `household_id` narrows to one current membership. An explicit
  `property_id` narrows to one property in one current household; a property id
  without a household is resolved through a current membership and is never
  trusted as a caller-supplied scope.
- Caller-supplied ids from another account return not-found. Search cannot use
  one membership's role to get data from another household.
- Keyword search works without AI. Results include the household, property, room
  and place path. Same item or room names in different households are distinct
  results, not merged.
- `GET /search/items` paginates across all authorized households. Totals are the
  sum of authorized household totals. The search window is bounded, and
  per-household queries use joins rather than per-row N+1 lookups.
- `GET /search/quick` powers the compact search panel and returns the same
  household labels and loan context.
- Search is rate-limited per account in-process (300 requests per minute for this
  local deployment) in addition to the household fanout cap.

## Assistant and AI consent isolation

The assistant is read-only. It never creates, edits or deletes inventory from a
conversation.

- **All my places and property-scoped requests** execute the unified submit-time
  flow one household at a time. Each household's bounded labels and facts may be
  interpreted only by that household's own configured provider and consent. The
  results are merged with household labels, so one household's data is never
  sent through another household's provider.
- **One household** uses that household's configured search task, or its
  configured assistant task when no search task is assigned. A property filter
  narrows the same household-scoped tools and provider boundary.
- If a household has no provider, provider consent is absent, or the task is
  disabled, direct deterministic retrieval still runs for that household. The
  response reports the actual mode and never falls back to an unapproved
  provider.
- All-my-places/property notices state when only part of the scope could use a
  provider, and the visible `direct`, `ai` and `fallback` labels distinguish
  direct facts from AI-assisted answers and AI-unavailable results.
- Follow-up context is bounded and re-authorised per household. Candidate items,
  loans and borrower references from one household/property are discarded when
  the scope changes. In all-my-places or property scopes, raw mixed conversation
  prose is not sent to any provider; each provider receives only that
  household/property's validated structured context. A single household without
  a property filter may reuse its own recent dialogue.
- Loans preserve quantity facts. A unique whereabouts answer can include the
  borrower and household-qualified home path. Duplicate names across households
  produce distinct matches and ask which one the person meant. Ambiguity is never
  resolved by silently choosing a household.
- Assistant candidate context remains minimized and tool output is constrained to
  validated read-only tools. Item names, documents and notes remain untrusted
  data.

## Deep links and QR

- Item/container/room links from all-places results append a validated
  `household_id` context parameter.
- The app switches workspace only after the select endpoint confirms current
  membership, then removes the parameter. A revoked link fails without revealing
  the household's name and leaves the user in an authorized state.
- Search/assistant pages use `household_id`/`property_id` as their own remembered
  scope parameters and do not switch the editing workspace.
- Existing item, room, container, loan, document and QR URLs remain stable within
  their household. QR payloads still point to the same container id.

## Audit summary

Every listed entity/flow remains explicitly household-owned or scoped through a
household-owned parent:

| Area | Ownership/scope | Additional check |
| --- | --- | --- |
| Items, rooms, properties, containers, labels, QR | household | membership resolved each request |
| Categories, tags, custom fields | household | direct household filters |
| Documents, scans, extraction, manuals, online search | household | household-owned document/item checks |
| Purchases, allocations, warranties | household | shared purchase totals counted once |
| Imports, voice notes, AI recognitions/tasks/providers | household | job payloads and applies revalidate household |
| Loans, returns, history, undo | household | borrower/loan facts stay within household |
| Stocktake, evidence exports, reports/downloads | household | session/export retrieval revalidates household |
| Photos and private files | household via owning entity | authenticated file routes only |

No new public links, caller-selected household grants, role elevation or
cross-household write are introduced.

## Limits

- No household deletion, leave, archive, ownership transfer or cross-household
  inventory transfer yet.
- No global account role and no automatic access between households.
- Property-wide assistant answers are deterministic; AI is available only for one
  household without a property filter.
- Documents, purchases and manuals remain household-owned and may relate to items
  in more than one property. A property filter narrows item-backed document and
  purchase results, but these records are not duplicated per property.
- The in-process search rate limiter is not a distributed rate limiter; PostgreSQL
  or a gateway limiter is required before horizontal API scaling.
- Role-aware private search fields are limited to whatever the household role can
  already read. Viewer/member/owner inventory and loan read access is unchanged;
  writes remain blocked for viewers.

## Verification

- PostgreSQL tests cover household creation/listing/switching, first/no-membership
  flow, same account with different roles, stale mutation context, revoked
  membership fallback, invitation wrong-account rejection, all-places search
  counts/paths/loans, duplicate names across households, property-scoped search
  and assistant isolation, cross-household IDOR, and per-household AI provider
  selection. An assertion confirms all-places assistant/search never invokes AI.
- Vitest covers the household selector, search scope selector, cache/hash reset
  on switch and existing surface behavior.
- Disposable Playwright covers UI household creation, switching, property-filter
  reset, all-places keyword and loan answers, remembered/narrowed scope and a
  cross-household result link opening in the correct household.

Final verification: **317 PostgreSQL backend tests**, **138 Vitest tests** and
**40 disposable-stack Playwright workflows** pass. Ruff, strict TypeScript
typecheck, production build and Alembic drift checks pass. Local backup
`backups/housetory-20261106T011330Z` includes database, uploads, imports and the
separate exports volume; checksums are valid. The local rebuild preserved the
existing household's 1 property, 8 rooms, 10 storage locations, 51 items, 1 user,
1 membership, 1 loan and all uploads/imports/export bytes, with unchanged
room/item ID and item `updated_at` hashes. No new migration was required. Real
external provider quality was not tested; no paid AI or email was sent.

Screenshots: [`docs/walkthrough/households/`](walkthrough/households/).
