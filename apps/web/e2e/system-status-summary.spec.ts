import { expect, test } from "@playwright/test";

const summary = {
  status: "attention",
  attention_count: 2,
  core_issue_count: 1,
  configured_feature_issue_count: 1,
  optional_not_configured: ["Email delivery", "Online manual search"],
  issues: [
    {
      kind: "core",
      label: "Worker jobs",
      detail: "2 failed job(s) recorded. Review the job details and retry after fixing the cause.",
      settings_path: "/settings/system-status",
    },
    {
      kind: "configured_feature",
      label: "Assistant",
      detail: "Fixture live test failed.",
      settings_path: "/settings/ai",
    },
  ],
  generated_at: "2026-11-06T12:30:00Z",
};

const detailed = {
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
    { name: "Worker", status: "ok", detail: "Last heartbeat 2s ago (v0.1.0)." },
  ],
  jobs: {
    counts: { failed: 2, succeeded: 8 },
    recent_failed: [
      {
        id: "job-1",
        task: "fixture.failed",
        attempts: 2,
        max_attempts: 3,
        error: "fixture failure",
        created_at: "2026-11-06T10:00:00Z",
        finished_at: "2026-11-06T10:01:00Z",
      },
    ],
  },
  tasks: [
    {
      task: "assistant",
      label: "Assistant",
      provider_label: "Fixture provider",
      model: "fixture-model",
      model_label: "Fixture model",
      model_listed: true,
      enabled: true,
      configured: true,
      compatibility: "compatible",
      capabilities: ["text"],
      live_tested: false,
      last_test_status: "failed",
      last_test_at: "2026-11-06T11:00:00Z",
      last_test_error: "Fixture live test failed.",
      error: "Fixture live test failed.",
    },
  ],
  external_services: [
    {
      name: "Online manual search",
      configured: false,
      status: "not_configured",
      detail: "Add a Brave Search API key in Settings → Online search.",
      source: "none",
      settings_path: "/settings#online-search",
    },
  ],
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

test("Settings shows compact health and the detailed status page is deep-linkable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  let summaryCalls = 0;
  let statusCalls = 0;
  await page.route(/\/api\/v1\/system\/status\/summary$/, async (route) => {
    summaryCalls += 1;
    await route.fulfill({ status: 200, json: summary });
  });
  await page.route(/\/api\/v1\/system\/status$/, async (route) => {
    statusCalls += 1;
    await route.fulfill({ status: 200, json: detailed });
  });

  await page.goto("/settings");
  const health = page.locator("#system-status");
  await health.scrollIntoViewIfNeeded();
  await expect(
    health.getByRole("heading", { name: "System health" }),
  ).toBeVisible();
  await expect(health.getByText("2 need attention")).toBeVisible();
  await expect(health.getByText(/1 core health issue/)).toBeVisible();
  await expect(health.getByText(/1 configured feature issue/)).toBeVisible();
  await expect(health.getByText(/Worker jobs:/)).toBeVisible();
  await expect(health.getByText(/Fixture live test failed/)).toBeVisible();
  expect(summaryCalls).toBe(1);
  expect(statusCalls).toBe(0);
  await page.screenshot({
    path: "../../docs/walkthrough/system-status-page/01-settings-summary-light.png",
    fullPage: false,
  });

  await health.getByRole("link", { name: "Open System status" }).click();
  await expect(page).toHaveURL(/\/settings\/system-status$/);
  await expect(
    page.getByRole("heading", { name: "System status", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to Settings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Detailed status" }),
  ).toBeVisible();
  await expect(page.getByText("fixture-commit")).toBeVisible();
  await expect(page.getByText("fixture.failed")).toBeVisible();
  expect(statusCalls).toBeGreaterThanOrEqual(1);
  expect(summaryCalls).toBe(1);
  await page.screenshot({
    path: "../../docs/walkthrough/system-status-page/02-detailed-status-light.png",
    fullPage: false,
  });

  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#system-status")).toBeVisible();
});
