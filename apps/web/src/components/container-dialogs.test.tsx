import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContainerCreateDialog,
  ContainerMoveDialog,
} from "@/components/container-dialogs";
import { api } from "@/lib/api";
import type { Container, Room } from "@/lib/types";
import { itemContainer } from "@/lib/utils";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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

const rooms: Room[] = [
  {
    id: "room-1",
    name: "Storage Room",
    description: null,
    parent_id: null,
    sort_order: 0,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "room-2",
    name: "Attic",
    description: null,
    parent_id: null,
    sort_order: 0,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const container: Container = {
  id: "box-1",
  identifier: "BOX-001",
  name: "BOX-001",
  description: null,
  kind: "box",
  container_type: "box",
  is_container: true,
  room_id: "room-1",
  parent_id: null,
  room: { id: "room-1", name: "Storage Room" },
  path: [],
  item_count: 0,
  total_item_count: 0,
  total_quantity: 0,
  child_count: 0,
  container_count: 1,
  summary_short: null,
  summary_headline: null,
  qr_payload: "http://localhost:8080/containers/box-1",
  qr_url: "/api/v1/containers/box-1/qr.svg",
  qr_warning: null,
  label_generated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function wrapper(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
});

describe("container dialogs", () => {
  it("creates an unnamed container in one request", async () => {
    vi.mocked(api.post).mockResolvedValue(container);
    const user = userEvent.setup();
    render(
      wrapper(
        <ContainerCreateDialog
          open
          onOpenChange={() => undefined}
          rooms={rooms}
          locations={[]}
          defaultRoomId={rooms[0]!.id}
        />,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Create container" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/containers",
        expect.objectContaining({
          room_id: "room-1",
          container_type: "box",
          name: null,
          parent_id: null,
        }),
      ),
    );
  });

  it("bulk creates the requested quantity", async () => {
    vi.mocked(api.post).mockResolvedValue({
      items: [container, container, container],
      identifiers: ["BOX-002", "BOX-003", "BOX-004"],
    });
    const user = userEvent.setup();
    render(
      wrapper(
        <ContainerCreateDialog
          open
          onOpenChange={() => undefined}
          rooms={rooms}
          locations={[]}
          defaultRoomId={rooms[0]!.id}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("How many?"), { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: "Create 3 containers" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/containers/bulk",
        expect.objectContaining({ quantity: 3, room_id: "room-1" }),
      ),
    );
  });

  it("moves a container to another room", async () => {
    vi.mocked(api.post).mockResolvedValue({ ...container, room_id: "room-2" });
    const user = userEvent.setup();
    render(
      wrapper(
        <ContainerMoveDialog
          open
          onOpenChange={() => undefined}
          container={container}
          rooms={rooms}
          locations={[]}
        />,
      ),
    );
    await user.selectOptions(screen.getByLabelText("Destination room"), "room-2");
    await user.click(screen.getByRole("button", { name: "Move container" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/containers/box-1/move", {
        room_id: "room-2",
        parent_id: null,
      }),
    );
  });
});

describe("itemContainer", () => {
  it("finds the nearest container in a nested location path", () => {
    expect(
      itemContainer({
        location: {
          id: "nested-1",
          name: "Small parts",
          kind: "other",
          parent_id: "box-1",
          identifier: null,
          container_type: null,
          is_container: false,
        },
        location_path: [
          {
            id: "box-1",
            name: "BOX-001",
            kind: "box",
            parent_id: null,
            identifier: "BOX-001",
            container_type: "box",
            is_container: true,
          },
          {
            id: "nested-1",
            name: "Small parts",
            kind: "other",
            parent_id: "box-1",
            identifier: null,
            container_type: null,
            is_container: false,
          },
        ],
      })?.identifier,
    ).toBe("BOX-001");
  });
});
