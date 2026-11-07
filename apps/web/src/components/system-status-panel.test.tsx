import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTaskTestPlan,
  SystemStatusPanel,
} from "@/components/system-status-panel";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { AiTaskTestResult, SystemStatus } from "@/lib/types";

const status: SystemStatus = {
  release: {
    version: "0.1.0",
    commit: "abc123release",
    build_time: "2026-11-06T12:00:00Z",
    channel: "local-test",
    environment: "production",
    identity: "fixture-host",
  },
  readiness: [
    { name: "Database", status: "ok", detail: null },
    { name: "Storage", status: "ok", detail: null },
    { name: "Worker", status: "degraded", detail: "Last heartbeat 120s ago." },
  ],
  jobs: {
    counts: { queued: 1, failed: 2, succeeded: 8 },
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
      label: "General assistant",
      provider_label: "OpenAI household",
      model: "shared-model",
      model_label: null,
      model_listed: false,
      enabled: true,
      configured: true,
      compatibility: "unverified",
      capabilities: ["text"],
      live_tested: true,
      last_test_status: "passed",
      last_test_at: "2026-11-06T11:00:00Z",
      last_test_error: null,
      error: null,
    },
    {
      task: "transcription",
      label: "Voice transcription",
      provider_label: "OpenRouter media",
      model: "shared-model",
      model_label: "Shared Model",
      model_listed: true,
      enabled: true,
      configured: true,
      compatibility: "compatible",
      capabilities: ["audio"],
      live_tested: false,
      last_test_status: null,
      last_test_at: null,
      last_test_error: null,
      error: null,
    },
    {
      task: "vision",
      label: "Photo recognition",
      provider_label: "Vision provider",
      model: "vision-model",
      model_label: "Vision Model",
      model_listed: true,
      enabled: true,
      configured: true,
      compatibility: "compatible",
      capabilities: ["vision"],
      live_tested: false,
      last_test_status: null,
      last_test_at: null,
      last_test_error: null,
      error: null,
    },
    {
      task: "labels",
      label: "Label suggestions",
      provider_label: "OpenAI household",
      model: "shared-model",
      model_label: "Shared Model",
      model_listed: true,
      enabled: false,
      configured: true,
      compatibility: "compatible",
      capabilities: ["text"],
      live_tested: false,
      last_test_status: null,
      last_test_at: null,
      last_test_error: null,
      error: null,
    },
    {
      task: "search",
      label: "Search summaries",
      provider_label: null,
      model: null,
      model_label: null,
      model_listed: false,
      enabled: true,
      configured: false,
      compatibility: "not_configured",
      capabilities: [],
      live_tested: false,
      last_test_status: null,
      last_test_at: null,
      last_test_error: null,
      error: "No search provider is configured.",
    },
  ],
  external_services: [
    {
      name: "Online manual search",
      configured: true,
      status: "configured",
      detail: "Configured via Household Settings (not probed).",
      source: "household",
      settings_path: "/settings#online-search",
    },
    {
      name: "Reference-image search",
      configured: true,
      status: "configured",
      detail: "Configured via Installation environment fallback for public-web reference-image lookup (not probed).",
      source: "environment",
      settings_path: "/settings#online-search",
    },
    {
      name: "Email delivery",
      configured: false,
      status: "not_configured",
      detail: "SMTP is not configured.",
    },
  ],
  scheduled_review: {
    configured: true,
    enabled: true,
    state: "scheduled",
    state_detail: "Next run 2026-11-10 09:00 GMT.",
    scope_label: "Whole household",
    frequency: "weekly",
    timezone: "Europe/London",
    include_ai: false,
    ai_consent_valid: false,
    assistant_configured: true,
    assistant_provider_label: "OpenAI household",
    assistant_model: "shared-model",
    last_run_at: "2026-11-03T09:00:00Z",
    last_run_status: "completed",
    last_run_detail: "Scanned 4 of 4; 2 new, 0 already queued.",
    next_due_at: "2026-11-10T09:00:00Z",
    max_items: 200,
    max_runs_per_day: 1,
    provider_request_cap: 1,
  },
  generated_at: "2026-11-06T12:30:00Z",
};

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSystemStatus: () => ({
      data: status,
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
    },
  };
});

function renderPanel(isOwner = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SystemStatusPanel isOwner={isOwner} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("SystemStatusPanel", () => {
  it("shows release identity, readiness, jobs, task states and external services", () => {
    renderPanel();
    expect(screen.getByText("abc123release")).toBeVisible();
    expect(screen.getByText("fixture-host")).toBeVisible();
    expect(screen.getByText("Database")).toBeVisible();
    expect(screen.getByText("Last heartbeat 120s ago.")).toBeVisible();
    expect(screen.getByText("fixture.failed")).toBeVisible();
    expect(screen.getByText("fixture failure")).toBeVisible();
    expect(screen.getByText(/saved ID not in catalog/)).toBeVisible();
    expect(screen.getAllByText("Compatible").length).toBeGreaterThan(0);
    expect(screen.getByText(/Live-tested/)).toBeVisible();
    expect(screen.getByText("Email delivery")).toBeVisible();
    expect(screen.getByText("not configured")).toBeVisible();
    expect(screen.getByText("Online manual search")).toBeVisible();
    expect(screen.getByText("Reference-image search")).toBeVisible();
    expect(screen.getByText("Source: Household settings")).toBeVisible();
    expect(screen.getByText("Source: Installation fallback")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Open settings" })).toHaveLength(2);
    expect(screen.getByText("Scheduled review")).toBeVisible();
    expect(screen.getByText(/Whole household · weekly/)).toBeVisible();
    expect(screen.getByText(/Next due:/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Review schedule" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Test all AI tasks" })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("retries a failed job through the owner endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({
      id: "job-1",
      task: "fixture.failed",
      status: "queued",
    });
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.post).toHaveBeenCalledWith("/system/jobs/job-1/retry");
  });

  it("does not expose operator details to non-owners", () => {
    renderPanel(false);
    expect(screen.getByText(/Owner access is required/)).toBeVisible();
    expect(screen.queryByText("abc123release")).not.toBeInTheDocument();
    expect(screen.queryByText("fixture.failed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Test all AI tasks" }),
    ).not.toBeInTheDocument();
  });

  it("selects exactly the enabled and configured tasks and explains skips", () => {
    const plan = buildTaskTestPlan(status.tasks);
    expect(
      plan.map((entry) => ({
        task: entry.task.task,
        state: entry.state,
        reason: entry.reason,
      })),
    ).toEqual([
      { task: "assistant", state: "queued", reason: undefined },
      { task: "transcription", state: "queued", reason: undefined },
      { task: "vision", state: "queued", reason: undefined },
      {
        task: "labels",
        state: "skipped",
        reason: "Disabled for this household.",
      },
      {
        task: "search",
        state: "skipped",
        reason: "No search provider is configured.",
      },
    ]);
  });

  it("requires one confirmation and sends no live request when cancelled", async () => {
    renderPanel();
    await userEvent.click(
      screen.getByRole("button", { name: "Test all AI tasks" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/3 sequential, minimal synthetic probes/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /General assistant, Voice transcription, Photo recognition/,
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/may incur usage or credits/)).toBeVisible();
    expect(
      within(dialog).getByText(/no inventory, photos, real documents/),
    ).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("runs sequentially, continues after failure, blocks duplicates and refreshes status", async () => {
    let resolveAssistant: (value: AiTaskTestResult) => void = () => {};
    const assistant = new Promise<AiTaskTestResult>((resolve) => {
      resolveAssistant = resolve;
    });
    const result = (
      task: string,
      taskStatus: AiTaskTestResult["status"],
      message: string,
    ): AiTaskTestResult => ({
      task,
      status: taskStatus,
      message,
      tested_at: "2026-11-06T13:00:00Z",
      model: "shared-model",
      provider_label: "Fixture provider",
    });
    vi.mocked(api.post).mockImplementation(((path: string) => {
      if (path === "/ai/tasks/assistant/test") return assistant;
      if (path === "/ai/tasks/transcription/test") {
        return Promise.resolve(
          result("transcription", "failed", "Transcription rejected"),
        );
      }
      if (path === "/ai/tasks/vision/test") {
        return Promise.resolve(result("vision", "passed", "Vision accepted"));
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }) as typeof api.post);

    const { client } = renderPanel();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(
      screen.getByRole("button", { name: "Test all AI tasks" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Run 3 task tests" }),
    );

    await waitFor(() => expect(screen.getByText("Running…")).toBeVisible());
    expect(api.post).toHaveBeenCalledTimes(1);
    const runningButton = screen.getByRole("button", {
      name: "Testing AI tasks…",
    });
    expect(runningButton).toBeDisabled();
    await userEvent.click(runningButton);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Skipped")).toHaveLength(2);
    expect(screen.getByText("Disabled for this household.")).toBeVisible();
    expect(
      screen.getAllByText("No search provider is configured.").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Queued")).toHaveLength(2);

    resolveAssistant(result("assistant", "passed", "Assistant accepted"));
    await waitFor(() =>
      expect(screen.getByText("Transcription rejected")).toBeVisible(),
    );
    expect(api.post).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.post).mock.calls.map(([path]) => path)).toEqual([
      "/ai/tasks/assistant/test",
      "/ai/tasks/transcription/test",
      "/ai/tasks/vision/test",
    ]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("1 failed"),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.systemStatus,
    });
    expect(
      screen.getByRole("button", { name: "Test all AI tasks" }),
    ).toBeEnabled();
    expect(screen.getByText("3 of 3 live tasks finished")).toBeVisible();
  });
});
