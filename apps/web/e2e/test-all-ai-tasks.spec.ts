import { expect, test } from "@playwright/test";

const task = (
  name: string,
  label: string,
  overrides: Record<string, unknown> = {},
) => ({
  task: name,
  label,
  provider_label: "Fixture provider",
  model: "shared-fixture-model",
  model_label: "Shared Fixture Model",
  model_listed: true,
  enabled: true,
  configured: true,
  compatibility: "compatible",
  capabilities: ["text"],
  live_tested: false,
  last_test_status: null,
  last_test_at: null,
  last_test_error: null,
  error: null,
  ...overrides,
});

const statusFixture = {
  release: {
    version: "0.1.0",
    commit: "fixture-commit",
    build_time: "2026-11-06T12:00:00Z",
    channel: "local",
    environment: "production",
    identity: "fixture-host",
  },
  readiness: [
    { name: "Database", status: "ok", detail: null },
    { name: "Storage", status: "ok", detail: null },
    { name: "Worker", status: "ok", detail: null },
  ],
  jobs: { counts: {}, recent_failed: [] },
  tasks: [
    task("assistant", "General assistant", { compatibility: "unverified" }),
    task("transcription", "Voice transcription", {
      capabilities: ["audio"],
    }),
    task("vision", "Photo recognition", {
      capabilities: ["vision"],
      model: "vision-fixture-model",
      model_label: "Vision Fixture Model",
    }),
    task("labels", "Label suggestions", { enabled: false }),
    task("search", "Search summaries", {
      enabled: true,
      configured: false,
      provider_label: null,
      model: null,
      model_label: null,
      model_listed: false,
      compatibility: "not_configured",
      capabilities: [],
      error: "No search provider is configured.",
    }),
  ],
  external_services: [],
  scheduled_review: {
    configured: false,
    enabled: false,
    state: "disabled",
    state_detail: "Automatic review is off.",
    scope_label: "Whole household",
    frequency: "weekly",
    timezone: "UTC",
    include_ai: false,
    ai_consent_valid: false,
    assistant_configured: true,
    assistant_provider_label: "Fixture provider",
    assistant_model: "fixture-model",
    last_run_at: null,
    last_run_status: "never",
    last_run_detail: null,
    next_due_at: null,
    max_items: 200,
    max_runs_per_day: 1,
    provider_request_cap: 1,
  },
  generated_at: "2026-11-06T12:30:00Z",
};

const result = (name: string, status: "passed" | "failed", message: string) => ({
  task: name,
  status,
  message,
  tested_at: "2026-11-06T13:00:00Z",
  model: "shared-fixture-model",
  provider_label: "Fixture provider",
});

test("system status separates passive refresh from confirmed bulk AI task tests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });

  const taskCalls: string[] = [];
  const liveStates = new Map<
    string,
    { status: "passed" | "failed"; message: string; tested_at: string }
  >();
  await page.route(/\/api\/v1\/system\/status$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        ...statusFixture,
        tasks: statusFixture.tasks.map((task) => {
          const live = liveStates.get(task.task);
          if (!live) return task;
          return {
            ...task,
            live_tested: live.status === "passed",
            last_test_status: live.status,
            last_test_at: live.tested_at,
            last_test_error: live.status === "failed" ? live.message : null,
          };
        }),
      },
    });
  });
  await page.route(/\/api\/v1\/ai\/tasks\/([^/]+)\/test$/, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    taskCalls.push(name);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const payload =
      name === "assistant"
        ? result(name, "passed", "The model returned structured test JSON.")
        : name === "transcription"
          ? result(
              name,
              "failed",
              "The transcription provider rejected the request.",
            )
          : name === "vision"
            ? result(name, "passed", "The model accepted a synthetic image.")
            : null;
    if (!payload) {
      await route.fulfill({
        status: 500,
        json: { detail: { code: "unexpected_test", message: "Unexpected task test." } },
      });
      return;
    }
    liveStates.set(name, {
      status: payload.status,
      message: payload.message,
      tested_at: payload.tested_at,
    });
    await route.fulfill({ status: 200, json: payload });
  });

  await page.goto("/settings/system-status");
  const systemStatus = page.locator(
    'section[aria-labelledby="system-status-heading"]',
  );
  await systemStatus.scrollIntoViewIfNeeded();
  await expect(
    systemStatus.getByRole("button", { name: "Refresh status" }),
  ).toBeVisible();
  await expect(
    systemStatus.getByRole("button", { name: "Test all AI tasks" }),
  ).toBeEnabled();
  expect(taskCalls).toEqual([]);
  await page.screenshot({
    path: "../../docs/walkthrough/test-all-ai-tasks/01-status-actions.png",
    fullPage: false,
  });

  await systemStatus.getByRole("button", { name: "Test all AI tasks" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/3 sequential, minimal synthetic probes/)).toBeVisible();
  await expect(dialog.getByText(/may incur usage or credits/)).toBeVisible();
  await expect(dialog.getByText(/no inventory, photos, real documents/)).toBeVisible();
  expect(taskCalls).toEqual([]);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "../../docs/walkthrough/test-all-ai-tasks/02-confirmation.png",
    fullPage: false,
  });

  await dialog.getByRole("button", { name: "Run 3 task tests" }).click();
  await expect(systemStatus.getByText("Running…")).toBeVisible();
  await expect(
    systemStatus.getByRole("button", { name: "Testing AI tasks…" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "../../docs/walkthrough/test-all-ai-tasks/03-running.png",
    fullPage: false,
  });

  await expect(
    systemStatus.getByText("The transcription provider rejected the request."),
  ).toBeVisible();
  await expect(
    systemStatus.getByText("3 of 3 live tasks finished"),
  ).toBeVisible();
  await expect(systemStatus.getByText("Skipped")).toHaveCount(2);
  await expect(systemStatus.getByText("Disabled for this household.")).toBeVisible();
  await expect(
    systemStatus.getByText("No search provider is configured.").first(),
  ).toBeVisible();
  expect(taskCalls).toEqual(["assistant", "transcription", "vision"]);
  await expect(
    systemStatus.getByRole("button", { name: "Test all AI tasks" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "../../docs/walkthrough/test-all-ai-tasks/04-mixed-results.png",
    fullPage: false,
  });
});
