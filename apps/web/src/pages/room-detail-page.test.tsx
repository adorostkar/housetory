import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import type { ItemSummary, Photo, Room, StorageLocation } from "@/lib/types";
import { RoomDetailPage } from "@/pages/room-detail-page";

const state = vi.hoisted(() => ({
  canWrite: true,
  photos: [] as unknown[],
  activeStocktake: false,
  itemFilters: null as Record<string, unknown> | null,
}));

const stamp = "2026-01-01T00:00:00Z";

const kitchen: Room = {
  id: "room-1",
  name: "Kitchen",
  description: "Ground floor, next to the hall.",
  property_id: "property-1",
  parent_id: null,
  sort_order: 0,
  item_count: 1,
  location_count: 1,
  total_item_count: 2,
  total_location_count: 1,
  created_at: stamp,
  updated_at: stamp,
};

const pantry: Room = {
  ...kitchen,
  id: "room-2",
  name: "Pantry",
  description: null,
  parent_id: "room-1",
  item_count: 0,
  location_count: 0,
  total_item_count: 0,
  total_location_count: 0,
};

const shelf: StorageLocation = {
  id: "shelf-1",
  room_id: "room-1",
  parent_id: null,
  name: "Top shelf",
  description: null,
  kind: "shelf",
  is_container: false,
  container_type: null,
  identifier: null,
  label_generated_at: null,
  sort_order: 0,
  item_count: 1,
  total_item_count: 1,
  created_at: stamp,
  updated_at: stamp,
};

const kettle = {
  id: "item-1",
  name: "Kettle",
  description: null,
  brand: null,
  model: null,
  quantity: 1,
  on_loan_quantity: 0,
  condition: "good",
  is_archived: false,
  room: { id: "room-1", name: "Kitchen" },
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

const photo: Photo = {
  id: "photo-1",
  original_filename: "kitchen.png",
  content_type: "image/png",
  byte_size: 100,
  width: 800,
  height: 600,
  sort_order: 0,
  created_at: stamp,
  url: "/photos/photo-1",
  thumbnail_url: "/photos/photo-1/thumbnail",
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  const idle = { isPending: false, isError: false, isSuccess: true, refetch: vi.fn() };
  return {
    ...actual,
    useCanWrite: () => state.canWrite,
    useSession: () => ({ data: { authenticated: true, user: { id: "user-1" }, households: [] } }),
    useInvalidateInventory: () => vi.fn(),
    useRooms: () => ({ ...idle, data: { items: [kitchen, pantry] } }),
    useLocations: () => ({ ...idle, data: { items: [shelf] } }),
    useProperties: () => ({ ...idle, data: { items: [] } }),
    useRoomPhotos: () => ({ ...idle, data: { items: state.photos } }),
    useLocationPhotos: () => ({ ...idle, data: { items: [] } }),
    useBorrowedList: () => ({ ...idle, data: { items: [] } }),
    useStocktakeSessions: () => ({ ...idle, data: { items: [] } }),
    useStocktakeScopeSummary: () => ({
      ...idle,
      data: {
        active_session: state.activeStocktake
          ? { id: "stocktake-1", status: "in_progress", checked_item_count: 1, expected_item_count: 2 }
          : null,
        last_completed_session: null,
      },
    }),
    useItems: (filters: Record<string, unknown>) => {
      state.itemFilters = filters;
      return {
        ...idle,
        data: { pages: [{ items: [kettle], total: 1, limit: 24, offset: 0 }], pageParams: [0] },
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        isFetchingNextPage: false,
      };
    },
  };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(entry = "/rooms/room-1") {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AddItemsProvider>
          <Routes>
            <Route path="/rooms/:roomId" element={<RoomDetailPage />} />
          </Routes>
          <LocationProbe />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function isBefore(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  sessionStorage.clear();
  state.canWrite = true;
  state.photos = [];
  state.activeStocktake = false;
  state.itemFilters = null;
  localStorage.clear();
});

describe("RoomDetailPage", () => {
  it("shows the contents before photographs, stocktake and the room notes", () => {
    state.photos = [photo];
    renderPage();
    expect(screen.getByRole("heading", { name: "Kitchen", level: 1 })).toBeVisible();
    expect(screen.getByTestId("room-count")).toHaveTextContent("2 items · 1 place");

    const item = screen.getByRole("link", { name: /Kettle/ });
    const chips = screen.getByRole("group", { name: "Places in this room" });
    expect(isBefore(chips, item)).toBe(true);
    expect(isBefore(item, screen.getByRole("region", { name: "Stocktake" }))).toBe(true);
    expect(isBefore(item, screen.getByRole("button", { name: "View photograph 1" }))).toBe(true);
    expect(isBefore(item, screen.getByText("Ground floor, next to the hall."))).toBe(true);

    // Management is one menu, not a row of buttons before the list.
    expect(screen.getByRole("button", { name: "Room options" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add a place" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export evidence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add items" })).not.toBeInTheDocument();
  });

  it("shows no checkboxes until Select is pressed, and hides them again", async () => {
    renderPage();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select all loaded/)).not.toBeInTheDocument();

    const select = screen.getByRole("button", { name: "Select items" });
    expect(select).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Select Kettle" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select all loaded items" })).toBeVisible();

    await userEvent.click(select);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps one tools row: the scoped search and nested choice open from Filters", async () => {
    renderPage();
    expect(screen.getByLabelText("Sort items in this room or place")).toBeVisible();
    expect(screen.getByRole("group", { name: "Item view" })).toBeVisible();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Search in this room or place")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Contents scope" })).not.toBeInTheDocument();

    await userEvent.click(filters);
    await userEvent.type(screen.getByLabelText("Search in this room or place"), "kettle");
    await waitFor(() => expect(state.itemFilters?.q).toBe("kettle"));
    expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1?q=kettle");

    await userEvent.click(screen.getByRole("button", { name: "Direct only" }));
    await waitFor(() => expect(state.itemFilters?.include_descendants).toBe(false));

    // Closed again, the active search and scope stay in view as chips.
    await userEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.queryByLabelText("Search in this room or place")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent(
      "Active filters: 2",
    );
    expect(screen.getByText("Search: kettle")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove Direct only" }));
    await waitFor(() => expect(state.itemFilters?.include_descendants).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Remove Search: kettle" }));
    await waitFor(() => expect(state.itemFilters?.q).toBeUndefined());
    expect(screen.getByRole("button", { name: "Filters" })).not.toHaveTextContent(
      "Active filters",
    );
  });

  it("shows a filter from the link as a chip while Filters is closed", () => {
    renderPage("/rooms/room-1?scope=direct&q=pan");
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("Direct only")).toBeVisible();
    expect(screen.getByText("Search: pan")).toBeVisible();
  });

  it("has no Back link on a top-level room and links a sub-room to its parent", () => {
    const { unmount } = renderPage();
    expect(screen.queryByRole("link", { name: /Back|All rooms/ })).not.toBeInTheDocument();
    unmount();
    renderPage("/rooms/room-2");
    expect(screen.getByRole("link", { name: "Kitchen" })).toHaveAttribute("href", "/rooms/room-1");
  });

  it("narrows the list with a place chip and offers that place's actions", async () => {
    renderPage();
    const chips = screen.getByRole("group", { name: "Places in this room" });
    expect(within(chips).getByRole("button", { name: "All, 2 items" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(chips).getByRole("link", { name: "Open Pantry, 0 items" })).toHaveAttribute(
      "href",
      "/rooms/room-2",
    );
    await userEvent.click(within(chips).getByRole("button", { name: "Top shelf, 1 item" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1?location_id=shelf-1");
    expect(state.itemFilters).toMatchObject({ room_id: "room-1", location_id: "shelf-1" });
    expect(screen.getByRole("link", { name: "Open Top shelf page" })).toHaveAttribute(
      "href",
      "/containers/shelf-1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Options for Top shelf" }));
    expect(screen.getByRole("menuitem", { name: "Move contents" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete place" })).toBeVisible();
  });

  it("keeps management in the menu and offers Add photo only while there is none", async () => {
    renderPage();
    expect(screen.queryByText("Add a photo.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Room options" }));
    for (const name of [
      "Add a place",
      "Add a sub-room",
      "Edit room",
      "Move contents",
      "Containers",
      "Export evidence",
      "Delete room",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeVisible();
    }
    await userEvent.click(screen.getByRole("menuitem", { name: "Add photo" }));
    expect(screen.getByText("Add a photo.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Take photo" })).toBeVisible();
  });

  it("shows a stocktake in progress above the list", () => {
    state.activeStocktake = true;
    renderPage();
    const stocktake = screen.getByRole("region", { name: "Stocktake" });
    expect(stocktake).toHaveTextContent("Stocktake in progress · 1 of 2 items checked");
    expect(within(stocktake).getByRole("link", { name: "Resume" })).toHaveAttribute(
      "href",
      "/stocktake/stocktake-1",
    );
    expect(isBefore(stocktake, screen.getByRole("link", { name: /Kettle/ }))).toBe(true);
  });

  it("gives viewers the list and read-only menu entries, without changes", async () => {
    state.canWrite = false;
    renderPage();
    expect(screen.getByRole("link", { name: /Kettle/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start stocktake" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select items" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Room options" }));
    expect(screen.getByRole("menuitem", { name: "Export evidence" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Delete room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add photo" })).not.toBeInTheDocument();
  });
});
