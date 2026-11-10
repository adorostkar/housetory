import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ReceiptPicker } from "@/components/receipt-picker";

const doc = (id: string, title: string, document_type: string) => ({
  id,
  title,
  document_type,
});

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useInvalidateInventory: () => vi.fn(),
    useDocument: () => ({ data: undefined }),
    useDocuments: (filters: { type?: string }, _limit: number, enabled = true) => {
      const all = [
        doc("r1", "Clas Ohlson receipt", "receipt"),
        doc("i1", "Invoice 12", "invoice"),
        doc("m1", "Dishwasher manual", "manual"),
      ];
      const items = !enabled
        ? []
        : filters.type
          ? all.filter((entry) => entry.document_type === filters.type)
          : all;
      return { data: { items, total: items.length, limit: 100, offset: 0 } };
    },
  };
});

describe("ReceiptPicker", () => {
  it("hides manuals until all document types are shown", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ReceiptPicker id="r" value="" onChange={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("option", { name: /Clas Ohlson receipt/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Invoice 12/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Dishwasher manual/ })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: /Show all document types/ }));
    expect(screen.getByRole("option", { name: /Dishwasher manual/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scan receipt/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Upload receipt/ })).toBeVisible();
  });
});
