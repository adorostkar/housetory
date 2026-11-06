import { expect, test } from "@playwright/test";

type Source = "household" | "environment" | "none";

function settingsFixture(overrides: Record<string, unknown> = {}) {
  return {
    provider: "brave",
    supported_providers: ["brave"],
    manual_enabled: false,
    reference_enabled: false,
    has_api_key: false,
    environment_api_key_available: false,
    credential_source: "none" as Source,
    api_key_version: 0,
    credential_storage_ready: true,
    permitted_source_domains: [] as string[],
    max_permitted_domains: 50,
    manual: {
      enabled: false,
      configured: false,
      source: "none" as Source,
      provider: null,
      provider_label: null,
      reason: "Add a Brave Search API key in Settings → Online search.",
    },
    reference: {
      enabled: false,
      configured: false,
      source: "none" as Source,
      provider: null,
      provider_label: null,
      reason: "Reference-image search is disabled in Settings → Online search.",
      permitted_source_domains: [] as string[],
      policy_configured: false,
    },
    environment_manual_available: false,
    environment_reference_available: false,
    updated_at: null,
    warning: null,
    ...overrides,
  };
}

test("owner can configure online search without env vars or plaintext key exposure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });

  let current = settingsFixture();
  const testBodies: unknown[] = [];
  await page.route(/\/api\/v1\/settings\/online-search$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, json: current });
      return;
    }
    const body = route.request().postDataJSON() as {
      api_key?: string;
      clear_api_key?: boolean;
      manual_enabled?: boolean;
      reference_enabled?: boolean;
      permitted_source_domains?: string[];
    };
    const hasKey = body.clear_api_key
      ? false
      : body.api_key
        ? true
        : current.has_api_key;
    current = settingsFixture({
      ...current,
      manual_enabled: body.manual_enabled ?? current.manual_enabled,
      reference_enabled: body.reference_enabled ?? current.reference_enabled,
      has_api_key: hasKey,
      api_key_version:
        body.api_key || body.clear_api_key
          ? current.api_key_version + 1
          : current.api_key_version,
      credential_source: "household",
      permitted_source_domains:
        body.permitted_source_domains ?? current.permitted_source_domains,
      manual: {
        ...current.manual,
        enabled: body.manual_enabled ?? current.manual_enabled,
        configured:
          (body.manual_enabled ?? current.manual_enabled) && hasKey,
        source: "household",
        provider: "brave",
        provider_label: "Brave Search API",
        reason: null,
      },
      reference: {
        ...current.reference,
        enabled: body.reference_enabled ?? current.reference_enabled,
        configured:
          (body.reference_enabled ?? current.reference_enabled) && hasKey,
        source: "household",
        provider: "brave",
        provider_label: "Brave Image Search API",
        reason: null,
        permitted_source_domains:
          body.permitted_source_domains ?? current.permitted_source_domains,
        policy_configured: Boolean(
          body.permitted_source_domains?.length ??
            current.permitted_source_domains.length,
        ),
      },
      updated_at: new Date().toISOString(),
    });
    await route.fulfill({ status: 200, json: current });
  });
  await page.route(/\/api\/v1\/settings\/online-search\/test$/, async (route) => {
    testBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        message: "Manual search connected. Reference-image search connected.",
        manual_ok: true,
        reference_ok: true,
        source: "household",
        provider_label: "Brave Search API",
        tested_at: new Date().toISOString(),
      },
    });
  });

  await page.goto("/settings");
  const card = page.locator("#online-search");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("heading", { name: "Online search" })).toBeVisible();
  await expect(card.getByText("No household Brave key saved.")).toBeVisible();
  await expect(card.getByText(/Brave is the only supported provider/)).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "../../docs/walkthrough/online-search/01-not-configured.png",
    fullPage: false,
  });

  await card
    .getByLabel("Brave Search API key")
    .fill("fixture-brave-key-not-a-real-credential");
  await card.getByLabel("Enable online manual search").check();
  await card.getByLabel("Enable reference-image search").check();
  await card
    .getByLabel("Permitted reference-image source domains")
    .fill("lg.com\nexample.com");
  await card.getByRole("button", { name: "Save online search" }).click();

  await expect(card.getByText(/Key saved · v1/)).toBeVisible();
  await expect(card.getByLabel("Replace Brave Search API key")).toHaveValue("");
  await expect(card.getByText("fixture-brave-key-not-a-real-credential")).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "../../docs/walkthrough/online-search/02-saved-write-only-key.png",
    fullPage: false,
  });

  await card.getByRole("button", { name: "Test connection" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/No inventory, manual, borrower/)).toBeVisible();
  expect(testBodies).toHaveLength(0);
  await page.screenshot({
    path: "../../docs/walkthrough/online-search/03-test-confirmation.png",
    fullPage: false,
  });

  await dialog.getByRole("button", { name: "Run connection test" }).click();
  await expect(card.getByText(/Manual search connected/)).toBeVisible();
  expect(testBodies).toEqual([{ confirm: true }]);
  await page.screenshot({
    path: "../../docs/walkthrough/online-search/04-test-result.png",
    fullPage: false,
  });
});
