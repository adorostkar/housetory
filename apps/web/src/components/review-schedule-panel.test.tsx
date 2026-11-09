import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSchedulePanel } from "@/components/review-schedule-panel";
import { api } from "@/lib/api";
import type { ReviewSchedule, ReviewScheduleSummary } from "@/lib/types";

const summary: ReviewScheduleSummary = {
  configured: false,
  enabled: false,
  state: "not_configured",
  state_detail: "No scheduled review has been configured. Automatic review is off.",
  scope_type: "household",
  scope_label: "Whole household",
  frequency: "weekly",
  timezone: "UTC",
  weekday: 0,
  monthly_day: 1,
  local_hour: 9,
  max_items: 200,
  max_runs_per_day: 1,
  provider_request_cap: 1,
  include_ai: false,
  ai_consent_valid: false,
  assistant_configured: true,
  assistant_provider_label: "OpenAI household",
  assistant_model: "gpt-test",
  last_run_at: null,
  last_run_status: "never",
  last_run_detail: null,
  next_due_at: null,
};

function scheduleFixture(overrides: Partial<ReviewSchedule> = {}): ReviewSchedule {
  return {
    ...summary,
    id: "schedule-1",
    household_id: "household-1",
    configured: true,
    enabled: true,
    state: "scheduled",
    state_detail: "Next run 2026-11-09 09:00 UTC.",
    scope_id: null,
    ai_consent: false,
    ai_consent_at: null,
    ai_consent_reason: null,
    ai_consent_provider_label: null,
    ai_consent_model: null,
    assistant_task: "assistant",
    assistant_mode: "cloud",
    assistant_error: null,
    last_run_id: null,
    last_run_job_id: null,
    last_dispatch_at: null,
    next_due_at: "2026-11-09T09:00:00Z",
    created_at: "2026-11-06T12:00:00Z",
    updated_at: "2026-11-06T12:00:00Z",
    ...overrides,
  };
}

let scheduleData: ReviewSchedule | null = null;
let schedulePending = false;
let aiReady = true;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useReviewSchedule: () => ({
      data: scheduleData,
      isPending: schedulePending,
      isError: false,
      error: null,
    }),
    useAiStatus: () => ({
      data: {
        provider: "openai",
        provider_label: "OpenAI household",
        model: "gpt-test",
        configured: aiReady,
        mode: "cloud",
        data_leaves_server: true,
        error: null,
      },
      isPending: false,
    }),
    useProperties: () => ({ data: { items: [] }, isPending: false }),
    useRooms: () => ({ data: { items: [] }, isPending: false }),
    useLocations: () => ({ data: { items: [] }, isPending: false }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      put: vi.fn(),
    },
  };
});

function renderPanel({
  isOwner = true,
  schedule = summary,
}: {
  isOwner?: boolean;
  schedule?: ReviewScheduleSummary | null;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ReviewSchedulePanel isOwner={isOwner} schedule={schedule} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  scheduleData = null;
  schedulePending = false;
  aiReady = true;
  vi.mocked(api.put).mockReset();
  vi.mocked(api.put).mockResolvedValue(
    scheduleFixture({ next_due_at: "2026-11-09T09:00:00Z" }),
  );
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("ReviewSchedulePanel", () => {
  it("shows scheduling as off by default and saves an offline-only schedule", async () => {
    renderPanel();
    expect(
      screen.getByRole("heading", { name: "Scheduled review" }),
    ).toBeVisible();
    expect(screen.getByText("Off")).toBeVisible();
    expect(screen.getByText(/Automatic review is off/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Set up schedule" }));
    expect(screen.getByLabelText("Enable scheduled review")).not.toBeChecked();
    expect(
      screen.getByLabelText("Include scheduled AI-assisted organisation"),
    ).not.toBeChecked();

    await userEvent.click(screen.getByLabelText("Enable scheduled review"));
    const timezone = screen.getByLabelText("Schedule timezone");
    await userEvent.clear(timezone);
    await userEvent.type(timezone, "Europe/London");
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith(
      "/inventory-review/schedule",
      expect.objectContaining({
        enabled: true,
        scope_type: "household",
        scope_id: null,
        frequency: "weekly",
        timezone: "Europe/London",
        include_ai: false,
        ai_consent: false,
      }),
    );
  });

  it("requires a scope detail before saving a property, room or container schedule", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Set up schedule" }));
    await userEvent.click(screen.getByLabelText("Enable scheduled review"));
    await userEvent.selectOptions(screen.getByLabelText("Schedule scope type"), "room");
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(
      screen.getByText("Choose the room to review."),
    ).toBeVisible();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("requires separate scheduled AI consent before saving", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Set up schedule" }));
    await userEvent.click(screen.getByLabelText("Enable scheduled review"));
    await userEvent.click(
      screen.getByLabelText("Include scheduled AI-assisted organisation"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(
      screen.getByText(/Scheduled AI needs separate explicit consent/),
    ).toBeVisible();
    expect(api.put).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText("Confirm scheduled AI consent"));
    expect(screen.getByText(/current category\/tag names/)).toBeVisible();
    expect(screen.getByText(/No photos, locations, receipts/)).toBeVisible();
    expect(screen.getByText(/private notes/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith(
      "/inventory-review/schedule",
      expect.objectContaining({
        enabled: true,
        include_ai: true,
        ai_consent: true,
      }),
    );
  });

  it("shows a consent-needed state without enabling AI automatically", () => {
    scheduleData = scheduleFixture({
      state: "consent_needed",
      state_detail:
        "The Assistant provider, endpoint or model changed after consent. Reconfirm scheduled AI consent.",
      include_ai: true,
      ai_consent: true,
      ai_consent_valid: false,
      ai_consent_reason:
        "The Assistant provider, endpoint or model changed after consent. Reconfirm scheduled AI consent.",
      next_due_at: "2026-11-09T09:00:00Z",
    });
    renderPanel({ schedule: scheduleData });

    expect(screen.getByText("Consent needed")).toBeVisible();
    expect(screen.getByText(/changed after consent/)).toBeVisible();
    expect(
      screen.getByText(/Scheduled AI will be skipped and offline rules will still run/),
    ).toBeVisible();
  });

  it("does not silently keep AI consent when the owner unchecks it", async () => {
    scheduleData = scheduleFixture({
      include_ai: true,
      ai_consent: true,
      ai_consent_valid: true,
      ai_consent_provider_label: "OpenAI household",
      ai_consent_model: "gpt-test",
    });
    renderPanel({ schedule: scheduleData });
    await userEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    await userEvent.click(screen.getByLabelText("Confirm scheduled AI consent"));
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(
      screen.getByText(/Scheduled AI needs separate explicit consent/),
    ).toBeVisible();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("does not expose owner controls to members and viewers", () => {
    scheduleData = scheduleFixture({ include_ai: false });
    renderPanel({ isOwner: false, schedule: scheduleData });

    expect(screen.getByText("Scheduled")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up schedule" })).toBeNull();
    expect(
      screen.getByText(/Only the household owner can change the schedule/),
    ).toBeVisible();
  });

  it("keeps existing valid AI consent when saving unrelated changes", async () => {
    scheduleData = scheduleFixture({
      include_ai: true,
      ai_consent: true,
      ai_consent_valid: true,
      ai_consent_provider_label: "OpenAI household",
      ai_consent_model: "gpt-test",
      max_items: 120,
    });
    renderPanel({ schedule: scheduleData });
    await userEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    const maxItems = screen.getByLabelText("Maximum items per run");
    fireEvent.change(maxItems, { target: { value: "120" } });
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith(
      "/inventory-review/schedule",
      expect.objectContaining({
        include_ai: true,
        ai_consent: true,
        max_items: 120,
      }),
    );
  });
});
