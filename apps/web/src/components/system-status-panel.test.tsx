import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemStatusPanel } from "@/components/system-status-panel";
import { api } from "@/lib/api";
import type { SystemStatus } from "@/lib/types";

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
      model: "GPT-6 Luna",
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
      model: "openai/whisper-test",
      model_label: "Whisper Test",
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
      configured: false,
      status: "partial",
      detail: "Search provider is configured, but no permitted source domains are set.",
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
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SystemStatusPanel isOwner={isOwner} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
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
    expect(screen.getByText("Compatible")).toBeVisible();
    expect(screen.getByText(/Live-tested/)).toBeVisible();
    expect(screen.getByText("Email delivery")).toBeVisible();
    expect(screen.getByText("not configured")).toBeVisible();
    expect(screen.getByText("Online manual search")).toBeVisible();
    expect(screen.getByText("Reference-image search")).toBeVisible();
    expect(screen.getByText("Source: Household settings")).toBeVisible();
    expect(screen.getByText("Source: Installation fallback")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Open settings" })).toHaveLength(2);
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
  });
});
