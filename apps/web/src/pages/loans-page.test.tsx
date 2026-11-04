import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoansPage } from "@/pages/loans-page";
import type { LoanList } from "@/lib/types";

let loans: LoanList;

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useLoans: () => ({ data: loans, isPending: false, isError: false }),
  };
});

beforeEach(() => {
  loans = {
    items: [
      {
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
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    outstanding_count: 1,
    overdue_count: 1,
    on_loan_quantity: 2,
  };
});

describe("LoansPage", () => {
  it("shows borrower, item, quantity, dates and overdue state", () => {
    render(
      <MemoryRouter>
        <LoansPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Loans" })).toBeVisible();
    expect(screen.getByText("Sam")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ethernet cable" })).toHaveAttribute(
      "href",
      "/items/item-1",
    );
    expect(screen.getByText("Partially returned")).toBeVisible();
    expect(screen.getAllByText("Past due").length).toBeGreaterThan(0);
    expect(screen.getByText(/of 3 out/)).toBeVisible();
    expect(screen.getByText(/Lent Jan 1, 2026/)).toBeVisible();
    expect(screen.getByText(/due Jan 10, 2026/)).toBeVisible();
  });
});
