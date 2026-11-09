import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ItemDetailPage } from "@/pages/item-detail-page";

const query = (data: unknown) => ({
  data,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
});

vi.mock("@/lib/queries", () => ({
  useCanWrite: () => true,
  useInvalidateInventory: () => vi.fn(),
  useRooms: () => query({ items: [] }),
  useLocations: () => query({ items: [] }),
  useItemHistory: () => query({ items: [] }),
  useItemLoans: () =>
    query({
      on_loan_quantity: 0,
      available_quantity: 1,
      loans: [],
      outstanding_loan_count: 0,
    }),
  useItem: () =>
    query({
      item: {
        id: "item-1",
        name: "Hammer drill",
        quantity: 1,
        condition: "good",
        description: "A solid drill",
        tags: [],
        is_archived: false,
        created_at: "2026-01-01T00:00:00Z",
        purchase: null,
        purchase_info_status: "unrecorded",
        purchase_info_missing_fields: [],
        warranty: null,
        category: null,
        room: null,
        location: null,
        household: null,
        property: null,
      },
    }),
}));
vi.mock("@/components/loan-dialogs", () => ({
  LendLoanDialog: () => null,
  ReturnLoanDialog: () => null,
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
  ItemStorageSection: () => null,
}));
vi.mock("@/components/item-loan-status", () => ({
  ItemLoanStatus: () => null,
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

describe("ItemDetailPage tabs", () => {
  it("switches panels, updates ?tab= and supports arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/items/item-1"]}>
          <Routes>
            <Route
              path="/items/:itemId"
              element={
                <>
                  <ItemDetailPage />
                  <Search />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("About this item")).toBeInTheDocument();
    expect(screen.queryByText("documents panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Documents" }));
    expect(screen.getByText("documents panel")).toBeInTheDocument();
    expect(screen.queryByText("About this item")).not.toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=documents");

    screen.getByRole("tab", { name: "Documents" }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("timeline panel")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=history");
  });
});
