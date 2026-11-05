import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityTimeline } from "@/components/activity-timeline";
import { api } from "@/lib/api";
import type { ActivityEvent } from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn() },
  };
});

const event: ActivityEvent = {
  id: "event-1",
  action: "item.moved",
  entity_type: "item",
  entity_id: "item-1",
  item_id: "item-1",
  container_id: null,
  loan_id: null,
  actor_user_id: "user-1",
  actor_name: "Ada",
  summary: "Moved Router from Office / Shelf to Garage",
  details: {
    from: { room_name: "Office", location_name: "Shelf" },
    to: { room_name: "Garage", location_name: null },
  },
  created_at: "2026-01-01T00:00:00Z",
  undoes_event_id: null,
  undo_event_id: null,
  can_undo: true,
  undo_blocked_reason: null,
};

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue({
    event: { ...event, action: "item.move_undone", can_undo: false },
    undone_event_id: "event-1",
    message: "The action was undone with a new compensating history event.",
  });
});

describe("ActivityTimeline", () => {
  it("requires confirmation and posts an idempotent compensating undo", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ActivityTimeline events={[event]} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText(/Office \/ Shelf/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Undo this action?")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Undo safely" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/history/event-1/undo");
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the batch context on a bulk-moved item event", () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const batched: ActivityEvent = {
      ...event,
      details: {
        ...event.details,
        batch: {
          batch_id: "batch-1",
          batch_action: "items.bulk_moved",
          batch_item_count: 2,
          batch_unit_count: 5,
        },
      },
    };
    render(
      <QueryClientProvider client={client}>
        <ActivityTimeline events={[batched]} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText(/Part of a bulk move · 2 item\(s\), 5 unit\(s\) selected/),
    ).toBeVisible();
  });
});
