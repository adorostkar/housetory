import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
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
