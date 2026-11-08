import fs from "node:fs/promises";

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

type AiTask = {
  task: string;
  provider_id: string | null;
  model: string | null;
  enabled: boolean;
  inherits_text_default: boolean;
};

type AiSettings = {
  providers: Array<{
    id: string;
    display_name: string;
    enabled: boolean;
    capabilities: string[];
    default_model: string | null;
  }>;
  tasks: AiTask[];
  default_text: {
    provider_id: string | null;
    model: string | null;
    inherited_tasks: string[];
    override_tasks: string[];
  };
};

const TEXT_TASKS = ["assistant", "documents", "imports", "search"] as const;

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function getSettings(request: APIRequestContext) {
  const response = await request.get("/api/v1/ai/settings", {
    headers: await headers(request),
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AiSettings;
}

async function setDefault(
  request: APIRequestContext,
  providerId: string,
  model: string,
) {
  const response = await request.put("/api/v1/ai/default-text", {
    headers: await headers(request),
    data: { provider_id: providerId, model },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AiSettings;
}

async function saveTask(
  request: APIRequestContext,
  task: string,
  providerId: string,
  model: string,
) {
  const response = await request.put(`/api/v1/ai/tasks/${task}`, {
    headers: await headers(request),
    data: {
      provider_id: providerId,
      model,
      enabled: true,
      inherit_default: false,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AiTask;
}

async function inheritTask(request: APIRequestContext, task: string) {
  const response = await request.put(`/api/v1/ai/tasks/${task}`, {
    headers: await headers(request),
    data: { inherit_default: true, enabled: true },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AiTask;
}

async function ensureTextProvider(request: APIRequestContext) {
  const settings = await getSettings(request);
  const named = settings.providers.find(
    (provider) => provider.display_name === "Simplification3 mock text",
  );
  if (named) {
    if (named.enabled) return named;
    const enabled = await request.patch(
      `/api/v1/ai/providers/${named.id}`,
      { headers: await headers(request), data: { enabled: true } },
    );
    expect(enabled.ok()).toBeTruthy();
    return (await enabled.json()) as AiSettings["providers"][number];
  }
  const created = await request.post("/api/v1/ai/providers", {
    headers: await headers(request),
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
  if (created.ok()) {
    return (await created.json()) as AiSettings["providers"][number];
  }
  expect(created.status()).toBe(409);
  const fallback = settings.providers.find(
    (provider) => provider.enabled && provider.capabilities.includes("text"),
  );
  expect(fallback).toBeTruthy();
  return fallback as AiSettings["providers"][number];
}

async function shot(locator: Locator, name: string) {
  await fs.mkdir("../../docs/walkthrough/simplification3", { recursive: true });
  await locator.screenshot({
    path: `../../docs/walkthrough/simplification3/${name}.png`,
    animations: "disabled",
  });
}

function defaultSection(page: Page) {
  return page
    .getByRole("heading", { name: "Default text model" })
    .locator("xpath=ancestor::section[1]");
}

function taskRow(page: Page, label: string) {
  return page.getByTestId("ai-task-row").filter({ hasText: label }).first();
}

test("saved default text model and explicit task inheritance stay stable", async ({
  page,
  request,
}) => {
  const provider = await ensureTextProvider(request);
  const initial = await getSettings(request);
  const defaultModel =
    initial.default_text.model ?? provider.default_model ?? "gpt-4o-mini";
  const overrideModel = defaultModel === "gpt-4o" ? "gpt-4o-mini" : "gpt-4o";

  await setDefault(request, provider.id, defaultModel);
  await saveTask(request, "documents", provider.id, overrideModel);
  for (const task of ["assistant", "imports", "search"]) {
    await inheritTask(request, task);
  }

  const seeded = await getSettings(request);
  expect(seeded.default_text.provider_id).toBe(provider.id);
  expect(seeded.default_text.model).toBe(defaultModel);
  expect(seeded.default_text.inherited_tasks).toContain("assistant");
  expect(seeded.default_text.override_tasks).toEqual(["documents"]);
  expect(
    seeded.tasks.find((task) => task.task === "documents"),
  ).toMatchObject({
    provider_id: provider.id,
    model: overrideModel,
    inherits_text_default: false,
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "Default text model" }),
  ).toBeVisible();
  await expect(page.getByText("Saved household default")).toBeVisible();
  await expect(page.getByText(/Inherited:/)).toContainText("Assistant");
  await expect(page.getByText(/Custom overrides:/)).toContainText(
    "Document interpretation",
  );
  await expect(
    page.getByRole("combobox", { name: "Assistant model", exact: true }),
  ).not.toBeVisible();
  await shot(defaultSection(page), "01-ai-default-text");

  await page.getByText("Advanced task overrides").click();
  const assistantRow = taskRow(page, "Assistant");
  await expect(assistantRow.getByText("Inherited")).toBeVisible();
  await assistantRow.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => {
      const current = await getSettings(request);
      return {
        inherits: current.tasks.find((task) => task.task === "assistant")
          ?.inherits_text_default,
        overrides: current.default_text.override_tasks,
        model: current.default_text.model,
      };
    })
    .toEqual({
      inherits: false,
      overrides: ["assistant", "documents"],
      model: defaultModel,
    });
  await expect(assistantRow.getByText("Custom override")).toBeVisible();

  await expect(page.getByText("Assistant updated")).toBeHidden();
  await shot(
    page
      .getByText("Advanced task overrides")
      .locator("xpath=ancestor::details[1]"),
    "02-ai-advanced-overrides",
  );

  await assistantRow.getByRole("button", { name: "Reset to default" }).click();
  await expect
    .poll(async () => {
      const current = await getSettings(request);
      return {
        inherits: current.tasks.find((task) => task.task === "assistant")
          ?.inherits_text_default,
        overrides: current.default_text.override_tasks,
      };
    })
    .toEqual({ inherits: true, overrides: ["documents"] });

  await page.reload();
  await page.getByText("Advanced task overrides").click();
  await expect(taskRow(page, "Assistant").getByText("Inherited")).toBeVisible();
  await expect(
    taskRow(page, "Document interpretation").getByText("Custom override"),
  ).toBeVisible();

  // A default change updates inherited tasks only. The explicit documents
  // override intentionally equals the new default and must still stay explicit.
  await setDefault(request, provider.id, overrideModel);
  const changed = await getSettings(request);
  expect(changed.default_text.model).toBe(overrideModel);
  expect(changed.default_text.inherited_tasks).toEqual([
    "assistant",
    "imports",
    "search",
  ]);
  expect(changed.default_text.override_tasks).toEqual(["documents"]);
  const changedTasks = Object.fromEntries(
    changed.tasks.map((task) => [task.task, task]),
  );
  for (const task of ["assistant", "imports", "search"]) {
    expect(changedTasks[task]).toMatchObject({
      model: overrideModel,
      inherits_text_default: true,
    });
  }
  expect(changedTasks.documents).toMatchObject({
    model: overrideModel,
    inherits_text_default: false,
  });

  await page.reload();
  await page.getByText("Advanced task overrides").click();
  await expect(
    taskRow(page, "Document interpretation").getByText("Custom override"),
  ).toBeVisible();
  await taskRow(page, "Document interpretation")
    .getByRole("button", { name: "Reset to default" })
    .click();
  await expect
    .poll(async () => {
      const current = await getSettings(request);
      return {
        inherits: current.tasks.find((task) => task.task === "documents")
          ?.inherits_text_default,
        model: current.tasks.find((task) => task.task === "documents")?.model,
        overrides: current.default_text.override_tasks,
      };
    })
    .toEqual({ inherits: true, model: overrideModel, overrides: [] });

  // The saved default remains visible even when every text task is an explicit
  // override, and reloads keep the explicit intent.
  for (const task of TEXT_TASKS) {
    await saveTask(request, task, provider.id, overrideModel);
  }
  const allOverrides = await getSettings(request);
  expect(allOverrides.default_text.model).toBe(overrideModel);
  expect(allOverrides.default_text.inherited_tasks).toEqual([]);
  expect(new Set(allOverrides.default_text.override_tasks)).toEqual(
    new Set(TEXT_TASKS),
  );

  await page.reload();
  await expect(page.getByText("Saved household default")).toBeVisible();
  await expect(page.getByText(/Inherited:/)).toContainText("None");
  await expect(page.getByText(/Custom overrides:/)).toContainText("Assistant");
  await expect(page.getByText(/Custom overrides:/)).toContainText(
    "Document interpretation",
  );

  for (const task of TEXT_TASKS) {
    await inheritTask(request, task);
  }

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
  await shot(defaultSection(page), "06-ai-default-text-mobile");
});
