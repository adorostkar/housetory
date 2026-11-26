import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import type { ContainerDetail, ItemSummary } from "@/lib/types";
import { ContainerDetailPage } from "@/pages/container-detail-page";

const state = vi.hoisted(() => ({
  itemFilters: null as Record<string, unknown> | null,
}));

const stamp = "2026-01-01T00:00:00Z";

const box = {
  id: "box-1",
  identifier: "BOX-001",
  name: "Camping gear",
  description: null,
  kind: "box",
  container_type: "box",
  is_container: true,
  room_id: "room-1",
  parent_id: null,
  room: { id: "room-1", name: "Garage" },
  room_path: [{ id: "room-1", name: "Garage" }],
  path: [],
  item_count: 1,
  total_item_count: 1,
  total_quantity: 1,
  child_count: 1,
  container_count: 0,
  owner_item: null,
  qr_payload: "http://localhost/containers/box-1",
  qr_url: "/api/v1/containers/box-1/qr",
  qr_warning: null,
  label_generated_at: null,
  created_at: stamp,
  updated_at: stamp,
  items: [],
  children: [
    {
      id: "bag-1",
      identifier: null,
      name: "Peg bag",
      kind: "bag",
      container_type: "bag",
      is_container: true,
      room_id: "room-1",
      parent_id: "box-1",
      item_count: 0,
      total_item_count: 0,
      total_quantity: 0,
      child_count: 0,
    },
  ],
  documents: [],
  summary: {
    item_count: 1,
    total_quantity: 1,
    direct_item_count: 1,
    direct_total_quantity: 1,
    empty: false,
    categories: [],
    label_generated_at: null,
  },
} as unknown as ContainerDetail;

const tent = {
  id: "item-1",
  name: "Tent",
  description: null,
  brand: null,
  model: null,
  quantity: 1,
  on_loan_quantity: 0,
  condition: "good",
  is_archived: false,
  room: { id: "room-1", name: "Garage" },
  location: null,
  location_path: [],
  category: null,
  tags: [],
  primary_photo: null,
  purchase: null,
  purchase_info_status: "unrecorded",
  purchase_info_missing_fields: [],
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  current_value_basis: null,
  current_value_total_cents: null,
  current_value_estimated_at: null,
  created_at: stamp,
  updated_at: stamp,
} satisfies ItemSummary;

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  const idle = { isPending: false, isError: false, isSuccess: true, refetch: vi.fn() };
  return {
    ...actual,
    useCanWrite: () => true,
    useSession: () => ({ data: { authenticated: true, user: { id: "user-1" }, households: [] } }),
    useInvalidateInventory: () => vi.fn(),
    useContainer: () => ({ ...idle, data: box }),
    useContainerHistory: () => ({ ...idle, data: { items: [] } }),
    useRooms: () => ({ ...idle, data: { items: [] } }),
    useLocations: () => ({ ...idle, data: { items: [] } }),
    useLocationPhotos: () => ({ ...idle, data: { items: [] } }),
    useBorrowedList: () => ({ ...idle, data: { items: [] } }),
    useStocktakeSessions: () => ({ ...idle, data: { items: [] } }),
    useStocktakeScopeSummary: () => ({
      ...idle,
      data: { active_session: null, last_completed_session: null },
    }),
    useItems: (filters: Record<string, unknown>) => {
      // Dialogs on the page list items too; only the contents list is of interest.
      if (filters.location_id === "box-1") state.itemFilters = filters;
      return {
        ...idle,
        data: { pages: [{ items: [tent], total: 1, limit: 24, offset: 0 }], pageParams: [0] },
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        isFetchingNextPage: false,
      };
    },
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/containers/box-1"]}>
        <AddItemsProvider>
          <Routes>
            <Route path="/containers/:containerId" element={<ContainerDetailPage />} />
          </Routes>
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  state.itemFilters = null;
});

describe("ContainerDetailPage", () => {
  it("shows the contents with one tools row and no checkboxes until Select", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "BOX-001", level: 1 })).toBeVisible();
    expect(screen.getByTestId("container-count")).toHaveTextContent(
      "Camping gear · 1 item · 1 nested place",
    );
    // The Back link goes to the room that holds this container.
    expect(screen.getAllByRole("link", { name: "Garage" })[0]).toHaveAttribute(
      "href",
      "/rooms/room-1",
    );
    expect(screen.getByRole("link", { name: /Tent/ })).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Container options" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Select items" }));
    expect(screen.getByRole("checkbox", { name: "Select Tent" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select all loaded items" })).toBeVisible();
  });

  it("opens the search inside this place and the nested choice from Filters", async () => {
    renderPage();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Search inside this place")).not.toBeInTheDocument();

    await userEvent.click(filters);
    await userEvent.type(screen.getByLabelText("Search inside this place"), "tent");
    await waitFor(() => expect(state.itemFilters?.q).toBe("tent"));
    expect(state.itemFilters).toMatchObject({ location_id: "box-1", include_descendants: true });
    await userEvent.click(screen.getByRole("button", { name: "Direct only" }));
    await waitFor(() => expect(state.itemFilters?.include_descendants).toBe(false));
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent(
      "Active filters: 2",
    );
  });
});
