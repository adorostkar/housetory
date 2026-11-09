import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useInvalidateInventory: () => vi.fn(),
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PurchasesPage", () => {
  it("keeps vendor-first cards while promoting linked item names and preserving purchase facts", () => {
    renderPage();
    const vendor = screen.getByRole("heading", {
      name: "Workshop Supply Co.",
      level: 2,
    });
    expect(vendor).toHaveClass("text-[1.12rem]");
    expect(screen.getByText("$1,234.56")).toHaveClass("text-[1.2rem]");
    expect(screen.getByText(/Feb 1, 2026/)).toBeVisible();
    expect(screen.getByText("Shared · 2")).toBeVisible();
    expect(screen.getByText("Items in this purchase")).toBeVisible();

    const drill = screen.getByRole("link", {
      name: /Hammer drill with a deliberately long catalogue name/,
    });
    expect(drill).toHaveAttribute("href", "/items/item-drill");
    expect(drill).toHaveClass("text-xs");
    expect(drill.querySelector("span")).toHaveClass("break-words");

    expect(
      screen.getByRole("link", { name: /Carbide drill bit set/ }),
    ).toHaveAttribute("href", "/items/item-bits");
    expect(
      screen.getByRole("link", { name: "Workshop receipt" }),
    ).toHaveAttribute("href", "/documents/document-1");
    expect(screen.getByText(/Reviewed item allocations/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Edit purchase/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Delete purchase/ })).toBeVisible();
  });
});
