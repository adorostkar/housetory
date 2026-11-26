import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Purchase } from "@/lib/types";
import { PurchasesPage } from "@/pages/purchases-page";

const purchase: Purchase = {
  id: "purchase-1",
  merchant: "Workshop Supply Co.",
  vendor: "Workshop Supply Co.",
  purchase_date: "2026-02-01",
  price_cents: 123456,
  currency: "USD",
  order_number: "ORDER-2026-44",
  notes: null,
  receipt_document_id: "document-1",
  receipt: {
    id: "document-1",
    title: "Workshop receipt",
    document_type: "receipt",
    content_type: "application/pdf",
    url: "/api/v1/documents/document-1/file",
  },
  items: [
    { id: "item-drill", name: "Hammer drill with a deliberately long catalogue name" },
    { id: "item-bits", name: "Carbide drill bit set" },
  ],
  allocations: [
    {
      id: "allocation-1",
      item_id: "item-drill",
      item: { id: "item-drill", name: "Hammer drill with a deliberately long catalogue name" },
      document_id: "document-1",
      extraction_version: "v1",
      source_line_id: "line-1",
      description: "20V hammer drill",
      quantity: 1,
      unit_price_cents: 90000,
      line_total_cents: 90000,
      allocated_cents: 90000,
      currency: "USD",
      source_evidence: null,
      created_at: "2026-02-01T00:00:00Z",
    },
  ],
  allocated_total_cents: 90000,
  unallocated_cents: 33456,
  item_count: 2,
  is_shared: true,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
};

const state = vi.hoisted(() => ({ canWrite: true }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => state.canWrite,
    useInvalidateInventory: () => vi.fn(),
    useOverview: () => ({ data: undefined, isPending: false, isError: false }),
    usePurchases: () => ({
      data: { items: [purchase], total: 1, limit: 50, offset: 0 },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useDocuments: () => ({
      data: { items: [], total: 0, limit: 100, offset: 0 },
      isPending: false,
      isError: false,
    }),
  };
});

function renderPage(entry = "/purchases") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <PurchasesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.canWrite = true;
});

describe("PurchasesPage", () => {
  it("shows a short row per purchase: merchant, date, total and item count", () => {
    renderPage();
    const row = screen.getByTestId("purchase-row");
    const toggle = within(row).getByRole("button", { name: /Workshop Supply Co\./ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Feb 1, 2026 · 2 items");
    expect(toggle).toHaveTextContent("$1,234.56");
    expect(toggle).toHaveTextContent("Shared · 2");
    // Items, allocations and the receipt wait until the row is opened.
    expect(screen.queryByText("Items in this purchase")).not.toBeInTheDocument();
    expect(screen.queryByText(/Reviewed item allocations/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Workshop receipt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit purchase/ })).not.toBeInTheDocument();
  });

  it("opens a row to show items, allocations, the unallocated rest and the receipt", async () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: /Workshop Supply Co\./ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Order ORDER-2026-44")).toBeVisible();
    expect(screen.getByText("Items in this purchase")).toBeVisible();

    const drill = screen.getByRole("link", {
      name: /Hammer drill with a deliberately long catalogue name/,
    });
    expect(drill).toHaveAttribute("href", "/items/item-drill");
    expect(drill.querySelector("span")).toHaveClass("break-words");
    expect(
      screen.getByRole("link", { name: /Carbide drill bit set/ }),
    ).toHaveAttribute("href", "/items/item-bits");

    expect(screen.getByText(/Reviewed item allocations/)).toBeVisible();
    expect(screen.getByText(/^\$900(\.00)? allocated$/)).toBeVisible();
    expect(
      screen.getByText("$334.56 of the purchase total is not allocated to product lines."),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Workshop receipt" }),
    ).toHaveAttribute("href", "/documents/document-1");
    expect(screen.getByRole("button", { name: /Edit purchase/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Delete purchase/ })).toBeVisible();

    await userEvent.click(toggle);
    expect(screen.queryByText("Items in this purchase")).not.toBeInTheDocument();
  });

  it("keeps search in view and the other filters behind Filters with a count", async () => {
    renderPage("/purchases?q=drill&currency=USD&date_from=2026-01-01");
    expect(screen.getByLabelText("Search purchases")).toHaveValue("drill");
    const filters = screen.getByRole("button", { name: /Filters/ });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(filters).toHaveTextContent("Active filters: 2");
    expect(screen.queryByLabelText("Filter purchases by currency")).not.toBeInTheDocument();
    await userEvent.click(filters);
    expect(screen.getByLabelText("Filter purchases by currency")).toHaveValue("USD");
    expect(screen.getByLabelText("Purchases from date")).toHaveValue("2026-01-01");
    await userEvent.click(screen.getByRole("button", { name: "Remove USD" }));
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent(
      "Active filters: 1",
    );
  });

  it("shows one primary action and keeps import and export one tap away", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Add purchase" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Export" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More purchase actions" }));
    expect(screen.getByRole("link", { name: "Export" })).toHaveAttribute(
      "href",
      "/api/v1/exports/purchases.csv",
    );
    expect(screen.getByRole("button", { name: "Scan invoice" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload invoice" })).toBeVisible();
  });

  it("lets viewers open a row without edit or delete", async () => {
    state.canWrite = false;
    renderPage();
    expect(screen.queryByRole("button", { name: "Add purchase" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Workshop Supply Co\./ }));
    expect(screen.getByRole("link", { name: "Workshop receipt" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Edit purchase/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete purchase/ })).not.toBeInTheDocument();
  });
});
