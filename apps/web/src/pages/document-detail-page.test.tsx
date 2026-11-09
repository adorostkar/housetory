import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentDetailPage } from "@/pages/document-detail-page";
import type { DocumentRecord, DocumentType } from "@/lib/types";

const state = vi.hoisted(() => ({
  document: null as unknown,
  relations: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useInvalidateInventory: () => vi.fn(),
    useDocument: () => ({
      data: state.document as DocumentRecord,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useDocumentRelations: (documentId?: string) => {
      state.relations(documentId);
      return { data: { items: [], suggested_item_ids: [] }, dataUpdatedAt: 0 };
    },
  };
});

vi.mock("@/components/document-extraction-review", () => ({
  DocumentExtractionReview: ({ document }: { document: DocumentRecord }) => (
    <div>Extraction review loaded for {document.title}</div>
  ),
}));

function makeDocument(documentType: DocumentType): DocumentRecord {
  const manual = documentType === "manual";
  return {
    id: "document-1",
    title: manual ? "Drill manual" : "Hardware receipt",
    document_type: documentType,
    original_filename: manual ? "drill.pdf" : "receipt.pdf",
    content_type: "application/pdf",
    original_content_type: "application/pdf",
    byte_size: 4096,
    original_byte_size: 4096,
    document_date: null,
    merchant: null,
    notes: null,
    extracted_text: "Safety. Disconnect the battery before changing the bit.",
    extracted_metadata: {},
    ocr_status: "succeeded",
    ocr_error: null,
    ocr_confidence: 95,
    ocr_processed_at: "2026-01-01T01:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    items: [{ id: "item-1", name: "Cordless drill" }],
    item_count: 1,
    pages: [],
    page_count: 0,
    url: "/api/v1/documents/document-1/file",
    original_url: "/api/v1/documents/document-1/original",
  };
}

function renderPage(documentType: DocumentType) {
  state.document = makeDocument(documentType);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/documents/document-1"]}>
        <Routes>
          <Route path="/documents/:documentId" element={<DocumentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.relations.mockClear();
});

describe("DocumentDetailPage extraction review", () => {
  it("keeps manual extraction review collapsed and defers related-item lookup", async () => {
    renderPage("manual");

    const advanced = screen.getByTestId("manual-extraction-review");
    expect(advanced).not.toHaveAttribute("open");
    expect(
      screen.queryByRole("heading", { name: "Review extracted items" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Extraction review loaded for Drill manual"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Extracted text")).toBeVisible();
    expect(state.relations).toHaveBeenLastCalledWith(undefined);

    await userEvent.click(screen.getByText(/Advanced · Extraction review/));

    expect(
      await screen.findByRole("heading", { name: "Review extracted items" }),
    ).toBeVisible();
    expect(screen.getByText("Extraction review loaded for Drill manual")).toBeVisible();
    await waitFor(() => expect(state.relations).toHaveBeenLastCalledWith("document-1"));
    expect(screen.getByText("Extracted text")).toBeVisible();
  });

  it("keeps the existing extraction review open by default for receipts", () => {
    renderPage("receipt");

    expect(
      screen.getByRole("heading", { name: "Review extracted items" }),
    ).toBeVisible();
    expect(screen.getByText("Extraction review loaded for Hardware receipt")).toBeVisible();
    expect(screen.queryByTestId("manual-extraction-review")).not.toBeInTheDocument();
    expect(state.relations).toHaveBeenLastCalledWith("document-1");
  });
});
