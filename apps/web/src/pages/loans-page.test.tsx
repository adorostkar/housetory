import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  BorrowedDetail,
  BorrowedList,
  BorrowedRecord,
  ItemSummary,
  Loan,
  LoanDetail,
  LoanList,
} from "@/lib/types";
import { LoansPage } from "@/pages/loans-page";

const state = vi.hoisted(() => ({
  canWrite: true,
  loans: null as unknown,
  borrowed: null as unknown,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn(), patch: vi.fn() },
  };
});

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => state.canWrite,
    useLoans: () => ({
      data: state.loans,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useBorrowedList: () => ({
      data: state.borrowed,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useProperties: () => ({ data: { items: [] }, isPending: false, isError: false }),
    useRooms: () => ({ data: { items: [] }, isPending: false, isError: false }),
    useLocations: () => ({ data: { items: [] }, isPending: false, isError: false }),
    useItems: () => ({
      data: {
        pages: [
          {
            items: [
              {
                id: "item-1",
                name: "Heavy drill",
                description: null,
                brand: "Makita",
                model: "HP-2",
                quantity: 3,
                on_loan_quantity: 1,
                condition: "good",
                is_archived: false,
                room: { id: "room-1", name: "Workshop" },
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
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              } satisfies ItemSummary,
            ],
            total: 1,
            limit: 30,
            offset: 0,
          },
        ],
        pageParams: [0],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
      refetch: vi.fn(),
    }),
  };
});

const loan: Loan = {
  id: "loan-1",
  item_id: "item-1",
  item_name: "Ethernet cable",
  item_name_snapshot: "Ethernet cable",
  home_room_id: "room-1",
  home_room_name_snapshot: "Office",
  home_location_id: "box-2",
  home_location_name_snapshot: "Box 2",
  home_location_identifier_snapshot: "BOX-002",
  borrower_name: "Sam",
  quantity: 3,
  returned_quantity: 1,
  outstanding_quantity: 2,
  status: "partially_returned",
  lent_on: "2026-01-01",
  due_on: "2026-01-10",
  notes: null,
  overdue: true,
  days_past_due: 2,
  latest_returned_on: "2026-01-05",
  created_by_user_id: "user-1",
  created_by_name: "Ada",
  cancelled_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-05T00:00:00Z",
};

const detail: LoanDetail = {
  ...loan,
  returns: [],
  history: [],
};

const borrowed: BorrowedRecord = {
  id: "borrowed-1",
  direction: "borrowed",
  item_name: "Tile cutter",
  brand: "Rubi",
  model: "TC-75",
  owner_name: "Ali",
  quantity: 3,
  returned_quantity: 1,
  outstanding_quantity: 2,
  physically_held_quantity: 2,
  status: "partially_returned",
  borrowed_on: "2026-01-02",
  due_on: "2026-01-12",
  notes: null,
  overdue: false,
  days_past_due: null,
  latest_returned_on: "2026-01-05",
  property_id: null,
  property_name: null,
  room_id: "room-1",
  room_name: "Workshop",
  storage_location_id: null,
  storage_location_name: null,
  storage_location_identifier: null,
  photo: null,
  created_by_user_id: null,
  created_by_name: null,
  cancelled_at: null,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-05T00:00:00Z",
};

const borrowedDetail: BorrowedDetail = {
  ...borrowed,
  returns: [],
  history: [],
};

const emptyBorrowedList: BorrowedList = {
  items: [],
  total: 0,
  limit: 50,
  offset: 0,
  open_count: 0,
  overdue_count: 0,
  total_borrowed_quantity: 0,
  outstanding_quantity: 0,
  returned_quantity: 0,
  physically_held_quantity: 0,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoansPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.canWrite = true;
  state.loans = {
    items: [loan],
    total: 1,
    limit: 50,
    offset: 0,
    outstanding_count: 1,
    overdue_count: 1,
    on_loan_quantity: 2,
  } satisfies LoanList;
  state.borrowed = emptyBorrowedList;
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue(detail);
});

describe("LoansPage", () => {
  it("shows plain borrower text, item link, quantities, dates and separate actions", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Loans" })).toBeVisible();
    expect(screen.getByText("to Sam").tagName).toBe("SPAN");
    expect(screen.getByRole("link", { name: "Ethernet cable" })).toHaveAttribute(
      "href",
      "/items/item-1",
    );
    expect(screen.getByText("Partially returned")).toBeVisible();
    expect(screen.getAllByText("Past due").length).toBeGreaterThan(0);
    expect(screen.getByText(/of 3 out/)).toBeVisible();
    expect(screen.getByText(/Lent Jan 1, 2026/)).toBeVisible();
    expect(screen.getByText(/due Jan 10, 2026/)).toBeVisible();
    expect(screen.getByRole("link", { name: "View details" })).toHaveAttribute(
      "href",
      "/loans/loan-1",
    );
    expect(screen.getByRole("button", { name: "Record return" })).toBeVisible();
  });

  it("records a partial return directly from the outstanding row", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Record return" }));
    expect(
      screen.getByRole("heading", { name: "Return from Sam" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Quantity")).toHaveValue(2);
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "1");
    await userEvent.click(
      screen.getByRole("button", { name: "Record return" }),
    );
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/loans/loan-1/returns");
    expect(payload).toMatchObject({ quantity: 1 });
  });

  it("creates a new loan by choosing the owned-lending direction and an item", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New loan" }));
    expect(screen.getByRole("heading", { name: "New loan" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Lend out an item/ }));
    expect(screen.getByText("2 available")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Choose Heavy drill for a new loan" }),
    );
    expect(
      screen.getByRole("heading", { name: "Lend Heavy drill" }),
    ).toBeVisible();
    await userEvent.type(screen.getByLabelText("Borrower"), "Mohsen");
    await userEvent.click(screen.getByRole("button", { name: /Record loan/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/loans");
    expect(payload).toMatchObject({
      item_id: "item-1",
      borrower_name: "Mohsen",
      quantity: 1,
    });
  });

  it("shows a mixed list with protected direction badges and direction filters", async () => {
    state.borrowed = {
      ...emptyBorrowedList,
      items: [borrowed],
      total: 1,
      open_count: 1,
      total_borrowed_quantity: 3,
      outstanding_quantity: 2,
      returned_quantity: 1,
      physically_held_quantity: 2,
    } satisfies BorrowedList;
    renderPage();
    expect(screen.getByTestId("loan-row")).toBeVisible();
    expect(screen.getByTestId("borrowed-row")).toBeVisible();
    expect(screen.getAllByText("Lent out").length).toBeGreaterThan(0);
    expect(screen.getByText("Borrowed", { selector: "[data-testid='direction-badge']" })).toBeVisible();
    expect(screen.getByText("from Ali")).toBeVisible();
    expect(screen.getByText("to Sam")).toBeVisible();

    await userEvent.click(screen.getByRole("tab", { name: "Borrowed" }));
    expect(screen.queryByTestId("loan-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("borrowed-row")).toBeVisible();

    await userEvent.click(screen.getByRole("tab", { name: "Lent out" }));
    expect(screen.getByTestId("loan-row")).toBeVisible();
    expect(screen.queryByTestId("borrowed-row")).not.toBeInTheDocument();
  });

  it("records a partial return to a borrowed owner directly from the mixed row", async () => {
    state.borrowed = {
      ...emptyBorrowedList,
      items: [borrowed],
      total: 1,
      open_count: 1,
      total_borrowed_quantity: 3,
      outstanding_quantity: 2,
      returned_quantity: 1,
      physically_held_quantity: 2,
    } satisfies BorrowedList;
    vi.mocked(api.post).mockResolvedValue(borrowedDetail);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Return to owner" }));
    expect(screen.getByRole("heading", { name: "Return to Ali" })).toBeVisible();
    expect(screen.getByLabelText("Quantity")).toHaveValue(2);
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Return to owner" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/borrowed/borrowed-1/returns");
    expect(payload).toMatchObject({ quantity: 1 });
  });

  it("creates a borrowed record through the clear direction choice", async () => {
    vi.mocked(api.post).mockResolvedValue(borrowedDetail);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "New loan" }));
    await userEvent.click(screen.getByRole("button", { name: /Borrow from someone/ }));
    expect(
      screen.getByRole("heading", { name: "Borrow from someone" }),
    ).toBeVisible();
    await userEvent.type(screen.getByLabelText("Item name"), "Tile cutter");
    await userEvent.type(screen.getByLabelText("Owner display name"), "Ali");
    await userEvent.click(screen.getByRole("button", { name: "Record borrowed item" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/borrowed");
    expect(payload).toMatchObject({
      item_name: "Tile cutter",
      owner_name: "Ali",
      quantity: 1,
    });
  });

  it("hides mutation controls from viewers but keeps item and loan navigation", () => {
    state.canWrite = false;
    renderPage();
    expect(screen.queryByRole("button", { name: "New loan" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record return" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Return to owner" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View details" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Ethernet cable" })).toBeVisible();
  });
});
