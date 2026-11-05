import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import { api } from "@/lib/api";
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
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} satisfies Partial<ItemSummary>;

const items: ItemSummary[] = [
  {
    ...itemBase,
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
const location = { id: "box-1", room_id: "room-1", parent_id: null, name: "Camera gear", description: null, kind: "box", is_container: true, container_type: "box", identifier: "BOX-001", summary_headline: null, summary_short: null, label_generated_at: null, sort_order: 0, item_count: 2, total_item_count: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const category = { id: "category-1", name: "Electronics", parent_id: null, color: null, description: null, sort_order: 0, item_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const tag = { id: "tag-1", name: "Fragile", created_at: "2026-01-01T00:00:00Z", item_count: 0 };

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useRooms: () => ({ data: { items: [room] }, isSuccess: true }),
    useLocations: () => ({ data: { items: [location] }, isSuccess: true }),
    useCategories: () => ({ data: { items: [category] }, isSuccess: true }),
    useTags: () => ({ data: { items: [tag] }, isSuccess: true }),
    useInvalidateInventory: () => vi.fn(),
    useItems: () => ({
      data: {
        pages: [{ items, total: 5, limit: 24, offset: 0 }],
        pageParams: [0],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    }),
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/items"]}>
        <AddItemsProvider>
          <ItemsPage />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/items/bulk/move") return moveResult;
    if (path === "/items/bulk/tags") return tagResult;
    return categoryResult;
  });
});

describe("ItemsPage bulk organisation", () => {
  it("selects only loaded items, moves them and clears selection", async () => {
    renderPage();
    expect(await screen.findByText("Camera")).toBeVisible();
    expect(screen.getByText(/Showing 2 of 5; only loaded items can be selected/i)).toBeVisible();

    await userEvent.click(screen.getByLabelText("Select Camera"));
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

  it("selects all loaded items, remembers list view and clears on search change", async () => {
    renderPage();
    await screen.findByText("Camera");
    await userEvent.click(screen.getByLabelText("Select all loaded items"));
    expect(screen.getByText(/2 items selected · 5 units/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Compact list view" }));
    expect(localStorage.getItem("housetory.items.view")).toBe("list");
    expect(screen.getByText(/1 on loan · 1 at home/)).toBeVisible();

    await userEvent.type(screen.getByLabelText("Search items"), "cam");
    await waitFor(() =>
      expect(screen.getByText(/Selection cleared because the search changed/i)).toBeVisible(),
    );
    expect(screen.queryByText(/selected ·/)).not.toBeInTheDocument();
  });

  it("adds tags and sets or clears categories explicitly", async () => {
    renderPage();
    await screen.findByText("Camera");
    await userEvent.click(screen.getByLabelText("Select Camera"));
    await userEvent.click(screen.getByRole("button", { name: "Tags" }));
    await userEvent.click(screen.getByRole("button", { name: "Fragile" }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected tags" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1));
    let [, payload] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "add", tag_ids: ["tag-1"] });

    await userEvent.click(screen.getByLabelText("Select Camera"));
    await userEvent.click(screen.getByRole("button", { name: "Category" }));
    await userEvent.selectOptions(screen.getByLabelText("Category"), "category-1");
    await userEvent.click(screen.getByRole("button", { name: "Apply category" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(2));
    [, payload] = vi.mocked(api.post).mock.calls[1] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "set", category_id: "category-1" });

    await userEvent.click(screen.getByLabelText("Select Camera"));
    await userEvent.click(screen.getByRole("button", { name: "Category" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear category" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear selected category" }));
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(3));
    [, payload] = vi.mocked(api.post).mock.calls[2] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ mode: "clear", category_id: null });
  });
});
