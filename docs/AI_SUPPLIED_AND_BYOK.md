# Supplied AI next to your own key

This is a design. Nothing in it is built, except the parts marked "today".
It says how AI that Housetory supplies could work next to a key that a
household brings itself ("bring your own key", BYOK). It also says how accounts,
households and memberships would work if Housetory were ever offered as a hosted
service with sign-up.

Read these first. They describe what exists:

- [AI providers, tasks and modalities](AI_PROVIDERS.md): "Default text model and
  overrides", "Task-specific selection contract", "Consent and privacy".
- [Multiple households](HOUSEHOLDS.md): "Account, household and role model",
  "First run, invitations and no-membership accounts", "Assistant and AI consent
  isolation".
- [Household permission matrix](PERMISSIONS.md): the matrix and "Enforcement".
- [README](../README.md): "Configuration", "AI providers" and "Accounts,
  household membership and email".

## Words

- **Own key (BYOK).** A household owner saves a provider and its API key in
  Settings → AI and online services → Manage AI providers. The provider bills
  the owner of that key.
- **Supplied AI.** The operator of the installation holds the provider account.
  Households use it without seeing a key.
- **Operator.** Whoever runs the server. On a home server this is usually the
  household owner. On a hosted service it is the service.

## What exists today

These are facts about the code. The design must not break them.

| Topic | Today |
| --- | --- |
| Who owns a credential | The household. `ai_providers` has a `household_id`. A household has at most one row for each provider type. The Brave Search key is also one per household. |
| How a key is stored | Encrypted with `AI_CREDENTIAL_KEY` from the deployment. It is never sent back to the browser and never logged. |
| Who sets it up | The household owner only. Every AI settings route needs the owner role. |
| Who uses it | Every member of the household, through the features their role allows. Viewers can ask read-only questions. |
| Installation-wide fallback | The `AI_*` environment variables. Text tasks use them only when the household has no provider and no saved text choice at all. Other tasks use them only when the household has no provider. `BRAVE_SEARCH_API_KEY` is a similar operator fallback for online lookups. |
| Routing | Per household and per task. Text tasks use the household's default text model or a task override. Image recognition and voice transcription must be chosen on their own. |
| When something is missing | The task fails closed. Housetory never picks another provider by itself. |
| Consent | One switch per provider. A private-network or cloud provider is not used until the owner turns its consent on. Saving a key is not consent. A local provider on the same machine needs none. |
| Several households | Each household's data goes only to that household's provider. "All my places" runs one household at a time. |
| Usage records | None. No table holds tokens, cost or request counts. |
| Who did what | Some work records hold the person: assistant runs, reference images, voice notes and some background jobs. They do not hold usage. |
| Limits | No spending limit. There are only technical limits: `AI_MAX_CONCURRENCY`, 10 items for each insurance estimate batch and a search rate limit for each account. The household also has a stored daily cap for generated images, but image generation is retired and no code reads it now. |

## Design

### 1. Who owns which credential

- **Own key: no change.** It stays in the household. The owner adds, replaces
  and removes it. Other members never see it.
- **Supplied AI: the operator owns it.** The key lives in the deployment
  configuration, next to `AI_CREDENTIAL_KEY`. It is not stored in a household
  table. No household can read it, copy it or change where it points.
- A household does not get a supplied key. It gets a **right to use** supplied
  AI. That right is a household setting that the owner turns on.
- Supplied AI appears in the provider list as one more provider, named
  "Housetory AI". It has no key field and no base URL field.

### 2. Who in a household may use it

- The owner decides if the household uses supplied AI, and for which tasks.
  This is the same place where the owner chooses models today.
- Members and viewers use it through features, as today. The permission matrix
  does not change.
- A later option: the owner can limit supplied AI to owners and members. Viewers
  would then get the direct, non-AI answer. This matters once usage has a cost
  for the household.
- A person who belongs to two households uses each household's own setting. The
  right to use supplied AI does not follow the person.

### 3. Routing

The order for one task in one household:

1. A task override, if the owner saved one.
2. The household's default text model, for text tasks.
3. Otherwise the task is off.

Supplied AI is a choice in steps 1 and 2. It is not a hidden step 4.

- If the household's own key fails, the task fails. It does not move to
  supplied AI. The other direction is the same.
- If the allowance for supplied AI is used up, the task fails with a clear
  message. It does not move to the household's own key unless the owner chose
  that key for the task.
- Image recognition and voice transcription stay separate choices.
- Each AI answer keeps saying which mode produced it: direct, AI or fallback.
  Settings and System status show which service each task uses.
- The environment fallback stays as narrow as it is today. A hosted service
  would leave `AI_PROVIDER` disabled and use supplied AI instead, so that
  consent and usage are always recorded.

### 4. Privacy and consent

- Supplied AI is a remote service. It needs consent like any other remote
  provider. It has its own consent switch. Consent for an own key does not count
  for supplied AI, and the reverse.
- The consent text names the operator and the model provider behind it, and
  says what is sent.
- The same limits on content apply to both: only what the task needs, no other
  household's data, no keys.
- The operator records usage numbers, not content. Prompts, answers, photos and
  audio are not kept for billing.
- A local model on the household's own server stays local. Turning supplied AI
  on never moves a local task to a remote service.
- Inventory, ordinary search, stored documents and exports keep working with no
  AI at all.

### 5. Usage records

Today nothing is recorded. Both kinds of AI need the same record, for two
reasons: the owner can see what the household used, and an allowance can be
checked.

One new table, added without changing existing tables (name for discussion:
`ai_usage_events`):

| Field | Meaning |
| --- | --- |
| household | Whose data and whose setting it was. |
| person | Who started the work. For a background job, the person who created the job. Empty for scheduled work. |
| task | Assistant, documents, imports, search, vision, transcription. |
| credential source | `household_key`, `supplied` or `environment`. |
| provider and model | As resolved at the time of the call. |
| amount | Input and output tokens when the provider reports them. Otherwise seconds of audio or number of images. |
| result | Succeeded or failed. |
| link | The job, assistant run or other record it belongs to. |
| time | When it happened. |

- No prompt or answer text is stored.
- Rows are written by the server at the one place that calls a provider.
- The owner sees totals for each month, task and person. A member sees their
  own. A viewer sees nothing.
- For an own key the numbers are for information. The provider's own bill is
  the truth.

### 6. Allowances and spending limits (later)

- **Supplied AI.** A household has an allowance for a period, for example a
  month. The server checks it before a call. When it is used up, AI tasks stop
  with a clear message and everything else goes on.
- The owner can set a lower limit than the allowance. The owner can also set a
  share for each member.
- Long work asks first. The existing "this may cost money" confirmations stay.
- **Own key.** Housetory cannot limit what a provider charges. It can offer an
  optional monthly count that stops tasks when reached. The owner should also
  set a limit at the provider.
- The technical limits that exist today stay as they are.

### 7. Keeping existing own-key setups

- No existing table or row changes. Providers, the default text model, task
  overrides, consent and test results stay as they are.
- Supplied AI is off for every household until its owner turns it on.
- An installation with no supplied AI configured shows no "Housetory AI"
  entry. It then behaves exactly as today.
- Removing an own key never switches a task to supplied AI.
- Key rotation with `AI_CREDENTIAL_KEY_PREVIOUS` is unchanged. The supplied key
  is rotated by the operator in the deployment.

## Accounts, households and memberships

### Today

- An **account** is one person's sign-in. It is global.
- A **household** owns all data: homes (properties), rooms, places, items,
  documents, loans, AI settings.
- A **membership** joins one account to one household with one role: owner,
  member or viewer. Access comes only from a membership.
- First-run setup works only while the server has no accounts. It creates the
  first account, a household, the owner membership and a first home.
- Any signed-in account can create another household and becomes its owner. An
  account can be in at most 20 households.
- Other people join by invitation. An invitation is for one household, one
  email address and one role.
- An account with no membership sees a page where it can create a household.
- Not built: leaving a household, giving ownership away, deleting a household.
  A household always keeps at least one owner.

### Owner setup and hosted sign-up are different things

| | Owner setup (today) | Hosted sign-up (design) |
| --- | --- | --- |
| When | Once, on an empty server. | Any time, if the operator turns it on. |
| Who | The person who runs the server. | Anyone with an email address. |
| Creates | Account, household, owner membership, first home. | An account only. |
| Next step | First item. | Create a household on the existing page, or accept an invitation. Then first item. |

### How hosted sign-up would work

- Sign-up creates an account and nothing else. The account then uses the
  existing "create a household" step, which makes it the owner and adds a first
  home. So ownership rules stay in one place.
- The email address must be confirmed before a household can be created.
  Invitations stay bound to the invited address.
- A household belongs to its owners, not to the account that created it. With
  more than one owner, each has the same rights.
- Before a hosted service opens, three things must exist: leave a household,
  give ownership to another member, delete a household with its data. They are
  not needed for a home server and are not built.
- **It is off by default.** One explicit setting, for example
  `HOSTED_SIGNUP_ENABLED=false`, guards it. While it is off, the sign-up route
  answers "not found" and no screen links to it. Owner setup, sign-in, password
  recovery and invitations work as today in both cases.
- **No destructive migration.** Existing accounts, households and memberships
  are not moved, merged or rewritten. New fields are added as empty, optional
  columns, for example the time an email address was confirmed. Existing
  accounts count as confirmed.
- Who pays for supplied AI is the household, through its owners. It is not the
  account. A person in two households does not carry an allowance from one to
  the other.

## Not built in this programme

- Supplied AI of any kind. Only own keys and the operator's environment
  fallback exist.
- The usage table, allowances and spending limits.
- Billing, payments, subscriptions, invoices and plans.
- A production hosted AI service.
- Public registration. No sign-up route, no sign-up screen and no setting for
  it exist in the code.
- Leaving, transferring and deleting a household.
