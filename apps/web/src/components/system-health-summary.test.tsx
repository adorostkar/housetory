import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemHealthSummary } from "@/components/system-health-summary";
import type { SystemStatusSummary } from "@/lib/types";

let summary: SystemStatusSummary | null = null;
let error: Error | null = null;
let pending = false;

const healthy: SystemStatusSummary = {
  status: "healthy",
  attention_count: 0,
  core_issue_count: 0,
  configured_feature_issue_count: 0,
  optional_not_configured: ["Email delivery", "Online manual search", "AI tasks"],
  issues: [],
  generated_at: "2026-11-06T12:30:00Z",
};

const attention: SystemStatusSummary = {
  status: "attention",
  attention_count: 2,
  core_issue_count: 1,
  configured_feature_issue_count: 1,
  optional_not_configured: ["Email delivery"],
  issues: [
    {
      kind: "core",
      label: "Worker jobs",
      detail: "2 failed job(s) recorded.",
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

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSystemStatusSummary: () => ({
      data: summary,
      isPending: pending,
      isError: Boolean(error),
      error,
      refetch: vi.fn(),
    }),
  };
});

function renderSummary(isOwner = true) {
  render(
    <MemoryRouter>
      <SystemHealthSummary isOwner={isOwner} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  summary = healthy;
  error = null;
  pending = false;
});

describe("SystemHealthSummary", () => {
  it("shows a compact healthy summary and does not frame optional gaps as outages", () => {
    renderSummary();
    expect(screen.getByText("Healthy")).toBeVisible();
    expect(
      screen.getByText(/Core readiness, worker jobs and configured features are healthy/),
    ).toBeVisible();
    expect(
      screen.getByText(/Optional, not configured: Email delivery, Online manual search, AI tasks/),
    ).toBeVisible();
    expect(screen.getByText(/not core outages/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open System status" }),
    ).toHaveAttribute("href", "/settings/system-status");
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
  });

  it("separates core and configured-feature attention counts", () => {
    summary = attention;
    renderSummary();
    expect(screen.getByText("2 need attention")).toBeVisible();
    expect(screen.getByText(/1 core health issue/)).toBeVisible();
    expect(screen.getByText(/1 configured feature issue/)).toBeVisible();
    expect(screen.getByText(/Worker jobs:/)).toBeVisible();
    expect(screen.getByText(/Assistant:/)).toBeVisible();
    expect(screen.getByText(/Fixture live test failed/)).toBeVisible();
  });

  it("handles loading and unavailable status honestly", () => {
    pending = true;
    summary = null;
    const view = render(
      <MemoryRouter>
        <SystemHealthSummary isOwner />
      </MemoryRouter>,
    );
    expect(screen.getByText("System health")).toBeVisible();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
    view.unmount();

    pending = false;
    error = new Error("status endpoint unavailable");
    renderSummary();
    expect(screen.getByText("System health is unavailable.")).toBeVisible();
    expect(screen.getByText(/status endpoint unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("does not fetch or link for non-owners", () => {
    renderSummary(false);
    expect(screen.getByText(/Owner access is required/)).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open System status" }),
    ).not.toBeInTheDocument();
  });
});
