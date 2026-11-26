import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readRecentItems } from "@/lib/recent-items";
import { ItemDetailPage } from "@/pages/item-detail-page";

const query = (data: unknown) => ({
  data,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
});

const baseItem = {
  id: "item-1",
  name: "Hammer drill",
  quantity: 1,
  on_loan_quantity: 0,
  condition: "good",
  description: "A solid drill",
  brand: "Makita",
  model: "HP-2",
  tags: [],
  is_archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  purchase: null,
  purchase_info_status: "unrecorded",
  purchase_info_missing_fields: [],
  warranty: null,
  category: { id: "category-1", name: "Tools", color: null },
  room: { id: "room-1", name: "Workshop" },
  location: null,
  location_path: [],
  household: null,
  property: null,
  photos: [],
  documents: [{ id: "document-1" }, { id: "document-2" }],
  import_source: null,
  storage: null as null | Record<string, unknown>,
};

const loan = {
  id: "loan-1",
  item_id: "item-1",
  borrower_name: "Mohsen",
  quantity: 1,
  returned_quantity: 0,
  outstanding_quantity: 1,
  status: "outstanding",
  lent_on: "2026-10-01",
  due_on: null,
  overdue: false,
};

const state = vi.hoisted(() => ({
  item: null as unknown,
  loans: null as unknown,
}));

vi.mock("@/lib/queries", () => ({
  useCanWrite: () => true,
  useInvalidateInventory: () => vi.fn(),
  useSession: () => query({ user: { id: "user-1" }, household: { id: "house-1" } }),
  useRooms: () => query({ items: [] }),
  useLocations: () => query({ items: [] }),
  useItemHistory: () => query({ items: [] }),
  useItemLoans: () => query(state.loans),
  useItem: () => query({ item: state.item }),
}));
vi.mock("@/components/loan-dialogs", () => ({
  LendLoanDialog: ({ open }: { open: boolean }) => (open ? <div>lend dialog</div> : null),
  ReturnLoanDialog: ({ loan: returning }: { loan: { borrower_name: string } }) => (
    <div>return dialog for {returning.borrower_name}</div>
  ),
}));
vi.mock("@/components/bulk-organise-dialogs", () => ({
  BulkMoveDialog: ({
    open,
    items,
    itemName,
  }: {
    open: boolean;
    items: { id: string }[];
    itemName: string;
  }) => (open ? <div>move dialog for {itemName} ({items.map((item) => item.id).join()})</div> : null),
}));
vi.mock("@/components/item-disposition-dialog", () => ({
  ItemDispositionDialog: () => null,
}));
vi.mock("@/components/photo-gallery", () => ({
  PhotoGallery: () => <div>gallery</div>,
}));
vi.mock("@/components/item-image-controls", () => ({
  ItemImageControls: () => null,
}));
vi.mock("@/components/item-storage-section", () => ({
  ItemStorageSection: ({ item }: { item: { storage: unknown } }) =>
    item.storage ? <div>contents panel</div> : <div>storage offer</div>,
}));
vi.mock("@/components/item-documents-manuals", () => ({
  ItemDocumentsAndManuals: () => <div>documents panel</div>,
}));
vi.mock("@/components/activity-timeline", () => ({
  ActivityTimeline: () => <div>timeline panel</div>,
}));

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderPage(entry = "/items/item-1", presentation?: "page" | "panel") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/items/:itemId"
            element={
              <>
                <ItemDetailPage presentation={presentation} />
                <Search />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  state.item = baseItem;
  state.loans = {
    on_loan_quantity: 0,
    available_quantity: 1,
    loans: [],
    outstanding_loan_count: 0,
  };
});

describe("ItemDetailPage", () => {
  it("switches panels, updates ?tab= and supports arrow keys", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Info", "Documents2", "Loans", "History",
    ]);
    expect(screen.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("About this item")).toBeInTheDocument();
    expect(screen.getByText("storage offer")).toBeInTheDocument();
    expect(screen.queryByText("documents panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Documents/ }));
    expect(screen.getByText("documents panel")).toBeInTheDocument();
    expect(screen.queryByText("About this item")).not.toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=documents");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/Documents/);

    screen.getByRole("tab", { name: /Documents/ }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("timeline panel")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=history");
  });

  it("keeps old ?tab=details links working and puts Contents first for storage items", () => {
    const plain = renderPage("/items/item-1?tab=details");
    expect(screen.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
    plain.unmount();

    state.item = { ...baseItem, storage: { active: true, item_count: 3 } };
    renderPage();
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Contents3");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("contents panel")).toBeInTheDocument();
    expect(screen.queryByText("storage offer")).not.toBeInTheDocument();
  });

  it("shows the name, where the item lives and that it is here, with Move and Lend", async () => {
    renderPage("/items/item-1?from=%2Fitems%3Fq%3Ddrill&from_label=Items");
    expect(screen.getByRole("heading", { level: 1, name: "Hammer drill" })).toBeVisible();
    expect(screen.getByText("1 piece · Tools · Makita HP-2")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Items" })).toHaveAttribute(
      "href", "/items?q=drill",
    );
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href", expect.stringMatching(/^\/items\/item-1\/edit\?from=/),
    );

    const card = screen.getByRole("region", { name: "Place and availability" });
    expect(card).toHaveTextContent("Lives in");
    expect(card).toHaveTextContent("Workshop");
    expect(card).toHaveTextContent("Right now");
    expect(card).toHaveTextContent("Here");

    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByText("move dialog for Hammer drill (item-1)")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Lend" }));
    expect(screen.getByText("lend dialog")).toBeVisible();

    // Opening the item is remembered on this device for the Recent order.
    expect(Object.keys(readRecentItems({ userId: "user-1", householdId: "house-1" }))).toEqual([
      "item-1",
    ]);
  });

  it("says who has the item and returns it from the same card", async () => {
    state.item = { ...baseItem, on_loan_quantity: 1 };
    state.loans = {
      on_loan_quantity: 1,
      available_quantity: 0,
      loans: [loan],
      outstanding_loan_count: 1,
    };
    renderPage();
    const card = screen.getByRole("region", { name: "Place and availability" });
    expect(card).toHaveTextContent("With Mohsen");
    expect(card).not.toHaveTextContent("Here");
    expect(screen.queryByRole("button", { name: "Lend" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Loans/ })).toHaveTextContent("Loans1");

    await userEvent.click(screen.getByRole("button", { name: "Return" }));
    expect(screen.getByText("return dialog for Mohsen")).toBeVisible();
  });

  it("reads Close in the side panel", () => {
    renderPage("/items/item-1", "panel");
    expect(screen.getByRole("link", { name: "Close" })).toHaveAttribute("href", "/items");
    expect(screen.queryByRole("link", { name: "All items" })).not.toBeInTheDocument();
  });
});
