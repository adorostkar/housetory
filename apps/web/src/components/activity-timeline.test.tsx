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
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
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
  vi.mocked(api.get).mockReset();
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

  it("previews and confirms restore-assisted undo for a deleted container", async () => {
    const restoreEvent: ActivityEvent = {
      ...event,
      id: "event-restore",
      can_undo: false,
      undo_blocked_reason: "The original storage place no longer exists.",
      restore_assisted: {
        available: true,
        reason: null,
        legacy_unrecoverable: false,
        will_restore_container: true,
        will_move_item: true,
        item_count: 1,
        container: {
          id: "box-1",
          name: "Cable box",
          identifier: "BOX-007",
          legacy_identifier: null,
          kind: "box",
          container_type: "box",
          is_container: true,
          room_id: "room-1",
          room_name: "Office",
          property_id: "property-1",
          property_name: "Home",
          parent_id: null,
          parent_name: null,
          deleted_at: "2026-11-06T12:00:00Z",
          deleted_by_name: "Ada",
        },
        item: {
          id: "item-1",
          name: "Router",
          quantity: 2,
          current_room_id: "room-2",
          current_room_name: "Garage",
          current_location_id: null,
          current_location_name: null,
          current_location_identifier: null,
          target_room_id: "room-1",
          target_room_name: "Office",
          target_location_id: "box-1",
          target_location_name: "Cable box",
          target_location_identifier: "BOX-007",
        },
      },
    };
    vi.mocked(api.get).mockResolvedValue(restoreEvent.restore_assisted);
    vi.mocked(api.post).mockResolvedValue({
      event: { ...restoreEvent, action: "item.move_undone", restore_assisted: null },
      undone_event_id: "event-restore",
      restored_container_id: "box-1",
      message: "Container restored and one item move undone.",
    });
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ActivityTimeline events={[restoreEvent]} />
      </QueryClientProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Restore container and undo move…" }),
    );
    expect(screen.getByText("Restore container and undo one move?")).toBeVisible();
    expect(await screen.findByText("BOX-007")).toBeVisible();
    expect(screen.getByText(/Home \/ Office \/ BOX-007 · Cable box/)).toBeVisible();
    expect(screen.getByText("Router ×2")).toBeVisible();
    expect(
      screen.getByText(/Only this item move is reversed/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Restore and undo" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/history/event-restore/restore-undo");
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows an honest blocker for a legacy hard-deleted place", () => {
    const legacyEvent: ActivityEvent = {
      ...event,
      id: "event-legacy",
      can_undo: false,
      undo_blocked_reason: "The original storage place no longer exists.",
      restore_assisted: {
        available: false,
        reason:
          "The original storage place was permanently deleted before recoverable tombstones existed. Its identity cannot be restored or invented safely.",
        legacy_unrecoverable: true,
        will_restore_container: false,
        will_move_item: false,
        item_count: 1,
        container: null,
        item: null,
      },
    };
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ActivityTimeline events={[legacyEvent]} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Restore unavailable/)).toBeVisible();
    expect(screen.getByText(/permanently deleted before recoverable/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Restore container and undo move…" }),
    ).not.toBeInTheDocument();
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
