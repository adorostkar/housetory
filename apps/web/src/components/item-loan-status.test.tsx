import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ItemLoanStatus } from "@/components/item-loan-status";
import type { Loan } from "@/lib/types";

function loan(overrides: Partial<Loan>): Loan {
  return {
    id: "loan-1",
    item_id: "item-1",
    item_name: "Heavy drill",
    item_name_snapshot: "Heavy drill",
    home_room_id: "room-1",
    home_room_name_snapshot: "Workshop",
    home_location_id: "box-1",
    home_location_name_snapshot: "Power tools",
    home_location_identifier_snapshot: "BOX-001",
    borrower_name: "Mohsen",
    quantity: 1,
    returned_quantity: 0,
    outstanding_quantity: 1,
    status: "outstanding",
    lent_on: "2026-10-01",
    due_on: null,
    notes: "PRIVATE BORROWER NOTE",
    overdue: false,
    days_past_due: null,
    latest_returned_on: null,
    created_by_user_id: null,
    created_by_name: null,
    cancelled_at: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function renderStatus(
  props: Partial<ComponentProps<typeof ItemLoanStatus>> = {},
) {
  const onReturnLoan = vi.fn();
  render(
    <MemoryRouter>
      <ItemLoanStatus
        ownedQuantity={1}
        atHomeQuantity={0}
        loans={[loan({})]}
        canWrite
        onReturnLoan={onReturnLoan}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onReturnLoan };
}

describe("ItemLoanStatus", () => {
  it("prominently identifies a fully loaned single-borrower item without exposing notes", () => {
    renderStatus();
    expect(screen.getByText("On loan to Mohsen")).toBeVisible();
    expect(screen.getByText(/Owned 1 · at home 0 · on loan 1/)).toBeVisible();
    expect(screen.getByText(/No due date recorded/)).toBeVisible();
    expect(
      screen.getByText(/usual home, not a current physical location/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Record return" })).toBeVisible();
    expect(screen.queryByText(/PRIVATE BORROWER NOTE/)).not.toBeInTheDocument();
  });

  it("shows partial quantities and the at-home meaning of the recorded home", () => {
    renderStatus({
      ownedQuantity: 3,
      atHomeQuantity: 2,
      loans: [loan({ due_on: "2026-11-20" })],
    });
    expect(
      screen.getByText("1 of 3 units on loan to Mohsen"),
    ).toBeVisible();
    expect(screen.getByText(/at home 2 · on loan 1/)).toBeVisible();
    expect(screen.getByText(/Due/)).toBeVisible();
    expect(
      screen.getByText(/usual home for the 2 at-home units/),
    ).toBeVisible();
  });

  it("lists each borrower for multiple loans and offers a return choice per loan", async () => {
    const mohsen = loan({ id: "loan-mohsen", borrower_name: "Mohsen" });
    const alex = loan({
      id: "loan-alex",
      borrower_name: "Alex",
      due_on: "2026-11-30",
    });
    const { onReturnLoan } = renderStatus({
      ownedQuantity: 3,
      atHomeQuantity: 1,
      loans: [mohsen, alex],
    });
    expect(screen.getByText("2 of 3 units on loan")).toBeVisible();
    expect(screen.getByText(/Mohsen · 1 of 1 on loan/)).toBeVisible();
    expect(screen.getByText(/Alex · 1 of 1 on loan/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Record return from Mohsen" }),
    );
    expect(onReturnLoan).toHaveBeenCalledWith(mohsen);
    expect(
      screen.queryByRole("button", { name: "Record return" }),
    ).not.toBeInTheDocument();
  });

  it("keeps state visible but hides return controls from viewers", () => {
    renderStatus({ canWrite: false });
    expect(screen.getByText("On loan to Mohsen")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Record return" }),
    ).not.toBeInTheDocument();
  });

  it("uses text as well as tone for overdue loans", () => {
    renderStatus({
      loans: [loan({ due_on: "2026-10-01", overdue: true })],
    });
    expect(screen.getByText("Past due")).toBeVisible();
  });
});
