import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function ensureTextProvider(request: APIRequestContext) {
  const auth = await headers(request);
  const settingsResponse = await request.get("/api/v1/ai/settings", {
    headers: auth,
  });
  const settings = (await settingsResponse.json()) as {
    providers: Array<{ id: string; display_name: string; enabled: boolean; capabilities: string[] }>;
  };
  const existing = settings.providers.find(
    (provider) =>
      provider.display_name === "Simplification3 mock text" ||
      (provider.enabled && provider.capabilities.includes("text")),
  );
  if (existing) return existing.id;
  const created = await request.post("/api/v1/ai/providers", {
    headers: auth,
    data: {
      provider: "openai",
      display_name: "Simplification3 mock text",
      base_url: "https://api.openai.com/v1",
      default_model: "gpt-4o-mini",
      api_key: "sk-simplification3-not-real",
      enabled: true,
      cloud_consent: true,
    },
  });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
}

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/simplification3", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/simplification3/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("default text model and advanced overrides stay explicit and preserved", async ({
  page,
  request,
}) => {
  const providerId = await ensureTextProvider(request);
  const auth = await headers(request);
  const beforeSettings = (await (
    await request.get("/api/v1/ai/settings", { headers: auth })
  ).json()) as { default_text: { model: string | null } };
  const defaultModel = beforeSettings.default_text.model ?? "gpt-4o";
  const overrideModel = defaultModel === "gpt-4o-mini" ? "gpt-4o" : "gpt-4o-mini";
  const override = await request.put("/api/v1/ai/tasks/documents", {
    headers: auth,
    data: {
      provider_id: providerId,
      model: overrideModel,
      enabled: true,
    },
  });
  expect(override.ok()).toBeTruthy();
  const settings = await request.get("/api/v1/ai/settings", { headers: auth });
  const body = (await settings.json()) as {
    default_text: {
      provider_id: string;
      model: string;
      inherited_tasks: string[];
      override_tasks: string[];
    };
  };
  expect(body.default_text.provider_id).toBe(providerId);
  expect(body.default_text.model).toBe(defaultModel);
  expect(body.default_text.inherited_tasks).toContain("assistant");
  expect(body.default_text.override_tasks).toContain("documents");

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "Default text model" }),
  ).toBeVisible();
  await expect(page.getByText(/Inherited:/)).toContainText("Assistant");
  await expect(page.getByText(/Custom overrides:/)).toContainText(
    "Document interpretation",
  );
  await expect(
    page.getByRole("combobox", { name: "Assistant model", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("heading", { name: "Default text model" })
    .scrollIntoViewIfNeeded();
  await shot(page, "01-ai-default-text");

  await page.getByText("Advanced task overrides").click();
  await expect(page.getByText("Custom override").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset to default" }).first(),
  ).toBeVisible();
  await page
    .getByText("Advanced task overrides")
    .scrollIntoViewIfNeeded();
  await shot(page, "02-ai-advanced-overrides");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "Default text model" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await shot(page, "06-ai-default-text-mobile");
});
