# Household permission matrix

Accounts are global identities. Access to a household is granted by a row in
`household_members`; every authenticated household request resolves that
membership again. A session stores the selected household id, not a global role.

| Area | Owner | Member | Viewer |
| --- | --- | --- | --- |
| Read inventory, rooms, places, containers, photos, documents, manuals, purchases, warranties, search, assistant | Yes | Yes | Yes |
| Search/assistant across **All my places** for every current membership | Yes | Yes | Yes (read-only, current memberships only) |
| Create a household and become its owner; switch the current workspace | Yes (account-level) | Yes (account-level) | Yes (account-level) |
| Ask attached-manual or read-only online product questions | Yes | Yes | Yes |
| Upload/attach manuals, save confirmed product identity, search online or download online candidates | Yes | Yes | No |
| Create/update/delete inventory, rooms, places, containers, taxonomy | Yes | Yes | No |
| Upload/delete/order/cover item and entity photographs | Yes | Yes | No |
| Read item image sources/provenance and category-icon fallback | Yes | Yes | Yes |
| Find/change/remove item reference images, use the category-icon fallback, generate/accept/reject AI illustrations, run image batches | Yes | Yes | No |
| Change household automatic item-image lookup/generation settings and generation cap | Yes | No | No |
| Create imports, scans, recognition records, OCR and summary jobs | Yes | Yes | No |
| Generate/download label PDFs that record label timestamps | Yes | Yes | No |
| Read/export CSV reports, preview and download evidence packages, and use read-only quick/natural search | Yes | Yes | Yes |
| Generate and manage own evidence package jobs | Yes | Yes | Yes (own packages only; no role escalation) |
| Read stocktake sessions, observations and last-checked state | Yes | Yes | Yes |
| Start, mark, refresh, review/apply, complete or abandon stocktakes | Yes | Yes | No |
| Read properties and property-scoped inventory | Yes | Yes | Yes |
| Create, rename, archive or delete properties; move room subtrees across properties | Yes | Yes | No |
| Manage household name and reminder settings | Yes | No | No |
| Manage AI providers, credentials, task models and consent | Yes | No | No |
| Invite, revoke, resend, remove members and change roles | Yes | No | No |
| Manage own account name/password | Yes | Yes | Yes |

## Enforcement

- Household creation and selection are account-level routes. Any authenticated
  account may create a household and becomes its owner; this never changes its
  role in another household. Selecting a household validates the membership
  before changing the session.
- Item images are separate from item photographs. Reference/AI images are private
  household/item artifacts with authenticated file routes, explicit provenance
  and one active non-photo image per item. Viewers can read them but cannot
  search, generate, accept/reject, remove or batch. Outbound Brave image search
  receives minimized product text only; OpenAI Images generation receives the
  same minimized text and requires the household Item illustrations task and
  provider consent. Online-search settings and the encrypted Brave credential
  are owner-only, household-scoped and write-only; members and viewers cannot
  read or change them. Automatic reference downloads are default-deny and
  require an owner-configured permitted-source domain policy or explicit
  provider license evidence. Non-photographic images are excluded from evidence,
  recognition and stocktake physical evidence.
- `enforce_household_context` requires a current `X-Household-Id` on unsafe
  requests for accounts with more than one membership and rejects a stale id with
  `409 household_context_changed`. The frontend sends the id of the workspace it
  rendered; this prevents a tab left on the old household from writing after
  another tab switched.
- `enforce_household_write_access` is attached at router level to all
  household-data routers. Unsafe HTTP methods are rejected for viewers before
  endpoint code runs. The read-only POST exceptions are assistant questions,
  natural-language search, item manual questions and evidence-package
  preview/generation/cancel/retry. Evidence generation is a read-only report over
  data the member can already read; viewers may manage only packages they created,
  and manual upload/attachment, identity confirmation, online search and online
  candidate download remain writer-only. Stocktake writes stay behind the same
  household write guard; viewers may read sessions and reviews only. Property
  management follows the same owner/member write rules; property IDs never grant
  access outside the household. All-places search resolves only the caller's
  current memberships and validates any explicit household/property scope; it is
  read-only and never implies a cross-household write.
- Owner-only endpoints use `require_owner`. Account endpoints use the account
  session without requiring a household, so an invited existing account can sign
  in before accepting membership.
- Household-scoped services continue to filter every query by
  `auth.household.id`; cross-household IDs return 404.
- Membership mutations lock the household row with `SELECT ... FOR UPDATE`.
  Counting and demoting/removing owners therefore serializes across concurrent
  requests and can never leave zero owners.
- Removing a membership deletes that account's sessions for the selected
  household. Role changes take effect on the next request because membership is
  re-read rather than trusted from the session. A session whose selected
  membership was revoked returns `401 household_access_revoked`; session state
  then falls back to another current membership or the no-household state.
- Invitations are bound server-side to household, email and role. Acceptance
  cannot choose a different email, household or role. Invitation tokens are
  hashed at rest, single-use, expire, and are locked during acceptance.
- Password reset tokens are hashed, single-use, expire, invalidate older reset
  tokens and revoke all of the account's sessions when consumed.
- Invite/recovery/creation and all-places search endpoints use in-process sliding
  limits in addition to household fanout caps. They reset on API restart and are
  not a substitute for reverse-proxy or Tailscale rate controls.

## UI behavior

Viewers see a read-only banner. Add-items controls, scan/import routes, entity
photo editing, item/document mutations, manual upload/attachment/identity/search
controls, purchase/warranty edits and label generation are hidden or routed away.
They retain manual reading, document downloads, attached-manual questions, CSV
exports, their own inventory evidence package previews/downloads and read-only
stocktake history/last-checked information. The server remains the authority; UI
hiding is only a usability layer. Account settings are separate from household
and member administration. The compact household selector changes the editable
workspace; the search/assistant scope selector defaults to All my places and is a
separate read scope.
