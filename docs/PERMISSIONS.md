# Household permission matrix

Accounts are global identities. Access to a household is granted by a row in
`household_members`; every authenticated household request resolves that
membership again. A session stores the selected household id, not a global role.

| Area | Owner | Member | Viewer |
| --- | --- | --- | --- |
| Read inventory, rooms, places, containers, photos, documents, manuals, purchases, warranties, search, assistant | Yes | Yes | Yes |
| Ask attached-manual or read-only online product questions | Yes | Yes | Yes |
| Upload/attach manuals, save confirmed product identity, search online or download online candidates | Yes | Yes | No |
| Create/update/delete inventory, rooms, places, containers, taxonomy | Yes | Yes | No |
| Upload/delete/order/cover item and entity photographs | Yes | Yes | No |
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
  access outside the household.
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
  re-read rather than trusted from the session.
- Invitations are bound server-side to household, email and role. Acceptance
  cannot choose a different email, household or role. Invitation tokens are
  hashed at rest, single-use, expire, and are locked during acceptance.
- Password reset tokens are hashed, single-use, expire, invalidate older reset
  tokens and revoke all of the account's sessions when consumed.
- Invite/recovery endpoints use the existing in-process sliding rate limiter with
  hashed email/IP keys. It resets on API restart and is not a substitute for
  reverse-proxy or Tailscale rate controls.

## UI behavior

Viewers see a read-only banner. Add-items controls, scan/import routes, entity
photo editing, item/document mutations, manual upload/attachment/identity/search
controls, purchase/warranty edits and label generation are hidden or routed away.
They retain manual reading, document downloads, attached-manual questions, CSV
exports, their own inventory evidence package previews/downloads and read-only
stocktake history/last-checked information. The server remains the authority; UI
hiding is only a usability layer. Account settings are separate from household
and member administration.
