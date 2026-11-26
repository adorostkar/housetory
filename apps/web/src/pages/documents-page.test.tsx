import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentsPage } from "@/pages/documents-page";

const state = vi.hoisted(() => ({
  total: 0,
  items: [] as unknown[],
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useInvalidateInventory: () => vi.fn(),
    useDocuments: () => ({
      data: { items: state.items, total: state.total, limit: 100, offset: 0 },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});

function renderPage(entry = "/documents") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <DocumentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.total = 0;
  state.items = [];
});

describe("DocumentsPage empty library", () => {
  it("prioritises scanning and upload instead of exporting an empty library", () => {
    renderPage();
    expect(screen.getByText("Your paper trail, in one place.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Scan pages" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add document" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Export" })).not.toBeInTheDocument();
  });

  it("keeps the normal export available once documents exist", () => {
    state.total = 1;
    state.items = [
      {
        id: "document-1",
        title: "Receipt",
        document_type: "receipt",
        original_filename: "receipt.pdf",
        content_type: "application/pdf",
        original_content_type: "application/pdf",
        byte_size: 100,
        original_byte_size: 100,
        document_date: null,
        merchant: null,
        notes: null,
        extracted_text: null,
        extracted_metadata: {},
        ocr_status: "not_requested",
        ocr_error: null,
        ocr_confidence: null,
        ocr_processed_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        items: [],
        item_count: 0,
        pages: [],
        page_count: 0,
        url: "/api/v1/documents/document-1/file",
        original_url: "/api/v1/documents/document-1/original",
      },
    ];
    renderPage();
    expect(screen.getByRole("link", { name: "Export" })).toBeVisible();
  });
});

describe("DocumentsPage filters", () => {
  it("keeps search in view and opens the other filters on request", async () => {
    renderPage();
    expect(screen.getByLabelText("Search documents")).toBeVisible();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Filter by document type")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Filter by merchant")).not.toBeInTheDocument();
    await userEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Filter by document type")).toBeVisible();
    expect(screen.getByLabelText("Filter by merchant")).toBeVisible();
    expect(screen.getByLabelText("Documents from date")).toBeVisible();
    expect(screen.getByLabelText("Sort documents")).toBeVisible();
  });

  it("counts the active filters, without the search, and removes one from its chip", async () => {
    renderPage("/documents?q=kettle&type=receipt&merchant=Acme&date_from=2026-01-01");
    const filters = screen.getByRole("button", { name: /Filters/ });
    expect(filters).toHaveTextContent("Active filters: 3");
    expect(screen.getByText("Merchant: Acme")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove Merchant: Acme" }));
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent(
      "Active filters: 2",
    );
    expect(screen.getByLabelText("Search documents")).toHaveValue("kettle");
  });
});
