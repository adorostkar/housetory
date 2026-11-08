import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LendLoanDialog, ReturnLoanDialog } from "@/components/loan-dialogs";
import { api } from "@/lib/api";
import type { Loan, LoanDetail } from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useLoanPeople: () => ({
      data: { items: [], total: 0 },
      isPending: false,
      isError: false,
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
      patch: vi.fn(),
    },
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
  overdue: false,
  days_past_due: null,
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

function renderDialog(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.post).mockResolvedValue(detail);
});

describe("Loan dialogs", () => {
  it("records a loan with an idempotency request id", async () => {
    renderDialog(
      <LendLoanDialog
        open
        onOpenChange={vi.fn()}
        itemId="item-1"
        itemName="Ethernet cable"
        available={2}
      />,
    );
    await userEvent.type(screen.getByLabelText("Borrower"), "Sam");
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "2");
    await userEvent.click(screen.getByRole("button", { name: /Record loan/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/loans");
    expect(payload).toMatchObject({
      item_id: "item-1",
      borrower_name: "Sam",
      quantity: 2,
    });
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.lent_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("records a partial return with the outstanding quantity", async () => {
    renderDialog(
      <ReturnLoanDialog open onOpenChange={vi.fn()} loan={loan} />,
    );
    expect(screen.getByLabelText("Quantity")).toHaveValue(2);
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "1");
    await userEvent.click(screen.getByRole("button", { name: /Record return/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/loans/loan-1/returns");
    expect(payload).toMatchObject({ quantity: 1 });
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
