import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useSearchParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import { api } from "@/lib/api";
import { useCategories, useItems, useItemsByIds, useLocations, useTags } from "@/lib/queries";
import { recordItemOpened } from "@/lib/recent-items";
import type {
  BulkCategoryResult,
  BulkMoveResult,
  BulkTagResult,
  ItemSummary,
} from "@/lib/types";
import { ItemsPage } from "@/pages/items-page";

const itemBase = {
  description: null as string | null,
  brand: null as string | null,
  model: null as string | null,
  condition: "good",
  is_archived: false,
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
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} satisfies Partial<ItemSummary>;

const items: ItemSummary[] = [
  {
    ...itemBase,
    created_at: "2026-01-02T00:00:00Z",
    id: "item-1",
    name: "Camera",
    quantity: 2,
    on_loan_quantity: 1,
    room: { id: "room-1", name: "Office" },
    location: { id: "box-1", name: "Camera gear", kind: "box", parent_id: null, identifier: "BOX-001", container_type: "box", is_container: true },
  },
  {
    ...itemBase,
    id: "item-2",
    name: "Tent",
    quantity: 3,
    on_loan_quantity: 0,
    room: { id: "room-1", name: "Office" },
    location: null,
  },
];

const room = { id: "room-1", name: "Office", description: null, parent_id: null, sort_order: 0, item_count: 2, location_count: 1, total_item_count: 2, total_location_count: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const location = { id: "box-1", room_id: "room-1", parent_id: null, name: "Camera gear", description: null, kind: "box", is_container: true, container_type: "box", identifier: "BOX-001", label_generated_at: null, sort_order: 0, item_count: 2, total_item_count: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const category = { id: "category-1", name: "Electronics", parent_id: null, color: null, description: null, sort_order: 0, item_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const tag = { id: "tag-1", name: "Fragile", created_at: "2026-01-01T00:00:00Z", item_count: 0 };
const viewport = vi.hoisted(() => ({ desktop: true }));
const list = vi.hoisted(() => ({
  empty: false,
  findings: 0,
  pastDue: 0,
  expiring: 0,
}));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => viewport.desktop,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useRooms: () => ({ data: { items: [room] }, isSuccess: true }),
    useLocations: vi.fn(() => ({ data: { items: [location] }, isSuccess: true })),
    useCategories: vi.fn(() => ({ data: { items: [category] }, isSuccess: true })),
    useTags: vi.fn(() => ({ data: { items: [tag] }, isSuccess: true })),
    useInvalidateInventory: () => vi.fn(),
    useSession: () => ({
      data: { authenticated: true, user: { id: "user-1" }, household: { id: "house-1" } },
    }),
    useOverview: () => ({
      data: {
        room_count: 1,
        document_count: 0,
        overdue_loan_count: list.pastDue,
        warranties: { expiring_count: list.expiring },
      },
    }),
    useReviewSummary: () => ({ data: { pending_count: list.findings } }),
    useCaptureReviews: () => ({ data: [] }),
    usePendingActions: () => ({ data: { items: [], total: 0 } }),
    useItems: vi.fn(() => ({
      data: {
        pages: [{ items: list.empty ? [] : items, total: list.empty ? 0 : 5, limit: 24, offset: 0 }],
        pageParams: [0],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })),
    useItemsByIds: vi.fn((_filters: unknown, ids: string[], enabled: boolean) => ({
      data:
        enabled && ids.length > 0
          ? { items: items.filter((item) => ids.includes(item.id)) }
          : undefined,
      isPending: false,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const moveResult: BulkMoveResult = {
  request_id: "request-1",
  batch_id: "batch-1",
  history_event_id: "event-1",
  selected_count: 1,
  moved_count: 1,
  unchanged_count: 0,
  selected_unit_count: 2,
  moved_unit_count: 2,
  on_loan_quantity: 1,
  moved_item_ids: ["item-1"],
  destination: {
    room_id: "room-1",
    room_name: "Office",
    storage_location_id: "box-1",
    storage_location_name: "Camera gear",
    storage_location_identifier: "BOX-001",
    path: [],
  },
};

const tagResult: BulkTagResult = {
  request_id: "request-2",
  batch_id: "batch-2",
  history_event_id: "event-2",
  mode: "add",
  selected_count: 1,
  updated_count: 1,
  unchanged_count: 0,
  tag_ids: ["tag-1"],
  tag_names: ["Fragile"],
  updated_item_ids: ["item-1"],
};

const categoryResult: BulkCategoryResult = {
  request_id: "request-3",
  batch_id: "batch-3",
  history_event_id: "event-3",
  mode: "set",
  selected_count: 1,
  updated_count: 1,
  unchanged_count: 0,
  category_id: "category-1",
  category_name: "Electronics",
  updated_item_ids: ["item-1"],
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function SearchChangeButton() {
  const [, setSearchParams] = useSearchParams();
  return (
    <button type="button" onClick={() => setSearchParams({ q: "cam" }, { replace: true })}>
      Change search query
    </button>
  );
}

function renderPage(initialEntry = "/items") {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AddItemsProvider>
          <ItemsPage />
          <SearchChangeButton />
          <LocationProbe />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Turns selection on when it is off, as a user must before any checkbox exists. */
async function startSelecting() {
  const toggle = screen.getByRole("button", { name: "Select items" });
  if (toggle.getAttribute("aria-pressed") !== "true") await userEvent.click(toggle);
}

async function selectItem(name: string) {
  await startSelecting();
  await userEvent.click(screen.getByLabelText(`Select ${name}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  viewport.desktop = true;
  Object.assign(list, { empty: false, findings: 0, pastDue: 0, expiring: 0 });
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/items/bulk/move") return moveResult;
    if (path === "/items/bulk/tags") return tagResult;
    return categoryResult;
  });
});

describe("ItemsPage bulk organisation", () => {
  it("defers collapsed filter options and never requests unscoped locations", async () => {
    renderPage();
    expect(useLocations).toHaveBeenNthCalledWith(1, undefined, false);
    expect(useCategories).toHaveBeenNthCalledWith(1, false);
    expect(useTags).toHaveBeenNthCalledWith(1, false);

    await userEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(useCategories).toHaveBeenCalledWith(true);
    expect(useTags).toHaveBeenCalledWith(true);
    expect(useLocations).not.toHaveBeenCalledWith(undefined, true);
  });

  it("loads selected filter labels without opening the filters", () => {
    renderPage("/items?room_id=room-1&location_id=box-1&category_id=category-1&tag_id=tag-1");
    expect(useLocations).toHaveBeenNthCalledWith(1, "room-1", true);
    expect(useCategories).toHaveBeenNthCalledWith(1, true);
    expect(useTags).toHaveBeenNthCalledWith(1, true);
    expect(screen.getByLabelText("Filter by storage location")).toHaveValue("box-1");
  });

  it("selects only loaded items, moves them and clears selection", async () => {
    renderPage();
    expect(await screen.findByText("Camera")).toBeVisible();

    await selectItem("Camera");
    expect(screen.getByText(/Showing 2 of 5; only loaded items can be selected/i)).toBeVisible();
    expect(screen.getByText(/1 item selected · 2 units/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByRole("heading", { name: "Move selected items" })).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText("Destination room"), "room-1");
    await userEvent.selectOptions(screen.getByLabelText(/Storage place or container/), "box-1");
    await userEvent.click(screen.getByRole("button", { name: "Move selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/items/bulk/move");
    expect(payload).toMatchObject({
      item_ids: ["item-1"],
      room_id: "room-1",
      storage_location_id: "box-1",
    });
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() =>
      expect(screen.getByText(/Moved 1 item\. Each moved item/i)).toBeVisible(),
    );
    expect(screen.queryByText(/selected ·/)).not.toBeInTheDocument();
  });

  it("shows compact rows by default, with no checkboxes until Select is pressed", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Compact list view" })).toHaveAttribute(
      "aria-pressed", "true",
    );
    expect(screen.getByText(/1 on loan · 1 at home/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeVisible();
    expect(screen.getByText("5")).toHaveTextContent("5 items");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/only loaded items can be selected/)).not.toBeInTheDocument();

    const select = screen.getByRole("button", { name: "Select items" });
    expect(select).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Select all loaded items")).not.toBeChecked();
    expect(screen.getByText("Select all loaded (2)")).toBeVisible();
    expect(screen.getByLabelText("Select Tent")).not.toBeChecked();

    // Pressing it again with something selected hides the checkboxes and clears the selection.
    await userEvent.click(screen.getByLabelText("Select Tent"));
    expect(screen.getByRole("region", { name: "Selected items" })).toBeVisible();
    await userEvent.click(select);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Selected items" })).not.toBeInTheDocument();
    await userEvent.click(select);
    expect(screen.getByLabelText("Select Tent")).not.toBeChecked();
  });

  it("keeps a chosen card view, and shows a stored card view without asking", async () => {
    const first = renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Card view" }));
    expect(localStorage.getItem("housetory.items.view.v2")).toBe("grid");
    first.unmount();
    renderPage();
    expect(screen.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed", "true",
    );
  });

  it("selects all loaded items after Select is pressed, and clears on search change", async () => {
    renderPage();
    await screen.findByText("Camera");
    await startSelecting();
    await userEvent.click(screen.getByLabelText("Select all loaded items"));
    expect(screen.getByText(/2 items selected · 5 units/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Change search query" }));
    await waitFor(() =>
      expect(screen.getByText(/Selection cleared because the view changed/i)).toBeVisible(),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/items?q=cam");
    expect(screen.queryByText(/selected ·/)).not.toBeInTheDocument();
    // The view changed, but the user is still selecting.
    expect(screen.getByLabelText("Select Camera")).not.toBeChecked();
  });

  it("adds tags and sets or clears categories explicitly", async () => {
    renderPage();
    await screen.findByText("Camera");
    await selectItem("Camera");
    await userEvent.click(screen.getByRole("button", { name: "Tags" }));
    await userEvent.click(screen.getByRole("button", { name: "Fragile" }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected tags" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1));
    let [, payload] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "add", tag_ids: ["tag-1"] });

    await selectItem("Camera");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Category" }));
    await userEvent.selectOptions(screen.getByLabelText("Category"), "category-1");
    await userEvent.click(screen.getByRole("button", { name: "Apply category" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(2));
    [, payload] = vi.mocked(api.post).mock.calls[1] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "set", category_id: "category-1" });

    await selectItem("Camera");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Category" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear category" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear selected category" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(3));
    [, payload] = vi.mocked(api.post).mock.calls[2] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "clear", category_id: null });
  });


  it("keeps Move and Tags in a fixed bar, the rest under More, and the selection after opening an item", async () => {
    const first = renderPage();
    await selectItem("Camera");
    const bar = screen.getByRole("region", { name: "Selected items" });
    expect(bar).toHaveClass("fixed");
    expect(bar.className).toContain("var(--shell-bar-height,0px)+var(--keyboard-inset,0px)");
    expect(bar).toHaveTextContent("1 item selected · 2 units, 1 on loan");
    expect(
      Array.from(bar.querySelectorAll("button")).map(
        (button) => button.getAttribute("aria-label") ?? button.textContent,
      ),
    ).toEqual(["Move", "Tags", "More", "Clear selection"]);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      "Category", "Images", "Review", "Export evidence",
    ]);
    await userEvent.keyboard("{Escape}");

    // The item opens on its own page on a phone; the list is mounted again on the way back.
    first.unmount();
    renderPage();
    expect(screen.getByLabelText("Select Camera")).toBeChecked();
    expect(screen.getByRole("region", { name: "Selected items" })).toHaveTextContent(
      "1 item selected",
    );
    expect(screen.getByRole("button", { name: "Select items" })).toHaveAttribute(
      "aria-pressed", "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Selected items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows active filter chips and clears bulk selection when a filter changes", async () => {
    renderPage("/items?purchase_info=missing&room_id=room-1");
    await screen.findByText("Camera");
    expect(screen.getByText("Purchase: Missing or unknown")).toBeVisible();
    expect(screen.getByText("Room: Office")).toBeVisible();
    await selectItem("Camera");
    expect(screen.getByText(/1 item selected · 2 units/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Purchase: Missing or unknown" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Purchase: Missing or unknown"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Selection cleared because the view changed.")).toBeVisible();
    expect(screen.getByTestId("location")).not.toHaveTextContent("purchase_info=");
  });

  it("toggles the filter panel and shows the active filter count", async () => {
    renderPage("/items?room_id=room-1");
    await screen.findByText("Camera");
    const toggle = screen.getByRole("button", { name: /^Filters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens in Recent order and keeps that order when an item is opened and closed", async () => {
    const scope = { userId: "user-1", householdId: "house-1" };
    const names = () => screen.getAllByText(/^(Camera|Tent)$/).map((node) => node.textContent);
    recordItemOpened(scope, "item-2", Date.UTC(2026, 1, 1));

    const first = renderPage();
    expect(screen.getByLabelText("Sort items")).toHaveValue("recent");
    expect(vi.mocked(useItems).mock.lastCall?.[0]).toMatchObject({ sort: "created_desc" });
    expect(vi.mocked(useItemsByIds).mock.lastCall?.slice(1)).toEqual([["item-2"], true]);
    expect(names()).toEqual(["Tent", "Camera"]);

    // Opening Camera records it. On the way back the list must not move.
    await userEvent.click(screen.getByRole("link", { name: /Camera/ }));
    recordItemOpened(scope, "item-1", Date.UTC(2026, 1, 2));
    first.unmount();
    const back = renderPage();
    expect(names()).toEqual(["Tent", "Camera"]);

    // A later visit starts from the newest openings.
    back.unmount();
    renderPage();
    expect(names()).toEqual(["Camera", "Tent"]);
  });

  it("remembers the chosen sort for this user and lets a link override it", async () => {
    const first = renderPage();
    expect(
      Array.from(screen.getByLabelText("Sort items").querySelectorAll("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Recent", "Newest", "Name", "Location"]);
    await userEvent.selectOptions(screen.getByLabelText("Sort items"), "Location");
    expect(localStorage.getItem("housetory:items-sort:user-1")).toBe("location_asc");
    expect(vi.mocked(useItems).mock.lastCall?.[0]).toMatchObject({ sort: "location_asc" });
    expect(vi.mocked(useItemsByIds).mock.lastCall?.[2]).toBe(false);

    first.unmount();
    const second = renderPage();
    expect(screen.getByLabelText("Sort items")).toHaveValue("location_asc");

    second.unmount();
    renderPage("/items?sort=name_desc");
    expect(screen.getByLabelText("Sort items")).toHaveValue("name_desc");
    await userEvent.selectOptions(screen.getByLabelText("Sort items"), "Name");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/items$/);
    expect(vi.mocked(useItems).mock.lastCall?.[0]).toMatchObject({ sort: "name_asc" });
  });

  it("orders a search by relevance and hides the sort control", () => {
    recordItemOpened({ userId: "user-1", householdId: "house-1" }, "item-2", Date.UTC(2026, 1, 1));
    renderPage("/items?q=cam");
    expect(screen.queryByLabelText("Sort items")).not.toBeInTheDocument();
    expect(screen.getByText("Best matches first")).toBeVisible();
    expect(vi.mocked(useItems).mock.lastCall?.[0]).toMatchObject({ q: "cam" });
    expect(vi.mocked(useItemsByIds).mock.lastCall?.slice(1)).toEqual([[], false]);
    expect(screen.getAllByText(/^(Camera|Tent)$/).map((node) => node.textContent)).toEqual([
      "Camera", "Tent",
    ]);
  });

  it("shows one short row of notices only when there is something to look at", () => {
    const quiet = renderPage();
    expect(screen.queryByTestId("list-notices")).not.toBeInTheDocument();
    quiet.unmount();

    Object.assign(list, { findings: 3, pastDue: 1, expiring: 2 });
    renderPage();
    expect(screen.getByRole("link", { name: "3 findings to review" })).toHaveAttribute(
      "href", "/review",
    );
    expect(screen.getByRole("link", { name: "1 loan past due" })).toHaveAttribute(
      "href", "/loans?overdue=1",
    );
    expect(screen.getByRole("link", { name: "2 warranties expiring" })).toHaveAttribute(
      "href", "/warranties?status=expiring",
    );
  });

  it("shows the first steps when the inventory is empty", () => {
    list.empty = true;
    renderPage();
    const steps = screen.getByRole("region", { name: "Getting started" });
    expect(steps).toHaveTextContent("1 of 4 steps done");
    expect(screen.queryByLabelText("Select all loaded items")).not.toBeInTheDocument();
  });
});
