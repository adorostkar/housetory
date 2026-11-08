# Simplification 3: default AI setup, calmer navigation and optional schedules

This batch keeps the existing permissions, stored task assignments, provider
credentials, consent, search context and visual style. It reduces setup and
navigation friction without deleting features or adding a subscription.

## One default text model

The normal **Settings → AI providers** screen now presents:

- one **Default text model** provider/model choice for Assistant, document
  interpretation, smart imports and natural-language search;
- separate **Vision & voice** rows for image recognition and voice
  transcription;
- collapsed **Advanced task overrides** for the four text tasks.

The default is derived from existing stored task rows without a migration:

1. a provider/model pair used by multiple text tasks;
2. otherwise the Assistant route;
3. otherwise the only configured text route;
4. otherwise no default.

Tasks matching the chosen pair are labelled **Inherited**. Different configured
pairs are labelled **Custom override**. A task with no assignment is **Not
configured**.

Changing the default writes only inherited tasks. Explicit overrides, vision,
voice, provider credentials, provider default model and cloud consent are not
changed. Disabled inherited tasks stay disabled; saving the default does not
silently enable them. **Reset to default** on an override returns that one task to
the current default.

![Default text model with inherited and custom tasks](walkthrough/simplification3/01-ai-default-text.png)

![Advanced overrides remain explicit and editable](walkthrough/simplification3/02-ai-advanced-overrides.png)

### Compatibility and discovery

The existing task capability contract remains authoritative:

- confirmed incompatible API/input/output combinations are excluded or rejected;
- unverified compatible manual IDs remain selectable and are validated on save;
- recommendations are optional ordering, not a gate;
- the searchable model picker still discovers provider catalogs;
- retired illustration and label-headline tasks do not return.

System status keeps **Test all enabled AI tasks**, which tests each enabled and
configured effective task with its own saved provider/model and skips disabled or
unconfigured tasks with a reason. The passive action is now labelled **Reload
status snapshot** and explicitly does not call a provider. Credentials remain
encrypted and write-only.

## Navigation

Desktop navigation keeps the calm visual hierarchy:

- core: Overview, Items, Rooms, Loans;
- library: Documents, Containers;
- **More**: Review, Purchases, Warranties, Assistant.

The global search remains in the top centre. Assistant is secondary through the
Search page action and the More navigation/deep links. Review/Purchases/Warranties
are less prominent without being removed.

![Desktop core and library sections with calm More](walkthrough/simplification3/03-navigation-desktop-calm.png)

![Desktop More section](walkthrough/simplification3/04-navigation-desktop-more.png)

Mobile keeps exactly five bottom destinations: Home, Items, Rooms, Loans and More.
All other routes remain in the More menu, including Review, Documents, Purchases,
Warranties, Containers, Assistant, Search and Settings. Route origin, back links,
context and permissions are unchanged.

![Mobile five-destination bar and More menu](walkthrough/simplification3/05-navigation-mobile-more.png)

## Scheduled reviews

Scheduled review remains optional, owner-only and off by default. When no schedule
has ever been configured, setup sits behind **Advanced · Scheduled review** on the
Review page. Existing configured schedules remain visible even when disabled or
waiting for consent, so an active routine is not hidden.

The backend schedule, consent, scope, caps, timezone, next-due and run-status
behaviour is unchanged. Enabling a schedule still never enables AI or sends
household data automatically.

## Verification

- 455 backend tests pass, including default derivation, inherited-task updates,
  preserved overrides, disabled/missing/incompatible routes and owner-only access.
- 230 frontend tests pass, including default save/reset, advanced disclosure,
  navigation and existing schedule consent tests.
- 95 disposable-stack Playwright workflows pass (94 passed, 1 fixture-dependent
  skip), covering desktop/mobile navigation and More reachability, AI settings at
  320/390/768/1440, focused default/override screenshots, active schedule,
  reload-only system status and enabled-task bulk testing.
- No paid inference calls were made by automated tests. AI provider output was
  mocked/disposable; no real keys or main data were copied.

## Limits

- There is no new user-facing token, budget, subscription or follow-up model
  setting. Existing providers, models and consent are reused.
- The default text model is derived from stored assignments; it is not a new
  database field. Tasks are classified as inherited when they match the derived
  pair, and existing different pairs remain explicit overrides.
- Unverified compatible model IDs remain allowed and must be verified by the
  owner when desired; hard incompatible IDs are rejected.
- A schedule that was explicitly disabled remains visible but off; it is not
  auto-re-enabled by this batch.
