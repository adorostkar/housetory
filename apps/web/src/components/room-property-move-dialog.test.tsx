import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoomPropertyMoveDialog } from "@/components/room-property-move-dialog";
import { api } from "@/lib/api";
import type { Property, Room } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const properties: Property[] = [
  {
    id: "property-home",
    name: "Home",
    description: null,
    is_archived: false,
    sort_order: 0,
    room_count: 1,
    container_count: 1,
    location_count: 1,
    item_count: 2,
    total_quantity: 3,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "property-cabin",
    name: "Cabin",
    description: null,
    is_archived: false,
    sort_order: 1,
    room_count: 0,
    container_count: 0,
    location_count: 0,
    item_count: 0,
    total_quantity: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const room: Room = {
  id: "room-1",
  name: "Workshop",
  description: null,
  property_id: "property-home",
  property: { id: "property-home", name: "Home", is_archived: false },
  parent_id: null,
  sort_order: 0,
  item_count: 2,
  location_count: 1,
  total_item_count: 2,
  total_location_count: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useProperties: () => ({ data: { items: properties }, isPending: false }),
    useInvalidateInventory: () => vi.fn(),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async () => ({
        room_id: "room-1",
        room_name: "Workshop",
        current_property: { id: "property-home", name: "Home", is_archived: false },
        destination_property: { id: "property-cabin", name: "Cabin", is_archived: false },
        descendant_room_count: 2,
        descendant_container_count: 1,
        item_count: 2,
        total_quantity: 3,
        on_loan_quantity: 1,
        fingerprint: "preview-fingerprint",
        can_move: true,
        warning: null,
      })),
      post: vi.fn(async () => ({
        preview: {},
        result: { history_event_id: "event-1" },
      })),
    },
  };
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RoomPropertyMoveDialog open onOpenChange={vi.fn()} room={room} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockClear();
  vi.mocked(api.post).mockClear();
});

describe("RoomPropertyMoveDialog", () => {
  it("previews the affected subtree and confirms with the review fingerprint", async () => {
    renderDialog();
    expect(await screen.findByText("Cabin")).toBeVisible();
    expect(await screen.findByText(/3 owned units/)).toBeVisible();
    expect(screen.getByText(/1 unit\(s\) remain on loan/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Move subtree" }));
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/rooms/room-1/property-move",
        expect.objectContaining({
          property_id: "property-cabin",
          preview_fingerprint: "preview-fingerprint",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    );
  });
});
