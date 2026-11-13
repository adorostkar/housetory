import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentDetailPage } from "@/pages/document-detail-page";
import { api } from "@/lib/api";
import type { DocumentRecord, DocumentType } from "@/lib/types";

const state = vi.hoisted(() => ({
  document: null as unknown,
  relations: vi.fn(),
  canWrite: true,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => state.canWrite,
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
  DocumentExtractionReview: ({ document, onOpenChange }: {
    document: DocumentRecord; onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      Extraction review loaded for {document.title}
      <button onClick={() => onOpenChange?.(true)}>Review extraction</button>
    </div>
  ),
}));

vi.mock("@/components/document-scan-dialog", () => ({
  DocumentScanDialog: ({ open, targetDocumentId }: { open: boolean; targetDocumentId?: string }) =>
    open ? <div>Cleanup draft for {targetDocumentId}</div> : null,
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

function renderPage(documentType: DocumentType, overrides: Partial<DocumentRecord> = {}) {
  state.document = { ...makeDocument(documentType), ...overrides };
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
  state.canWrite = true;
  vi.mocked(api.get).mockResolvedValue({
    correlation_id: "attempt-1", stage: "ready", started_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z", elapsed_ms: 1000, local_available: true,
    can_cancel: false, can_retry: true, worker_available: true, reason: null,
    timings: { local_queue_ms: 1, local_processing_ms: 2, ai_queue_ms: null,
      provider_ms: null, validation_ms: null },
  });
});

describe("DocumentDetailPage extraction review", () => {
  it("takes manual review to the review section without focusing an editable field", async () => {
    renderPage("invoice");
    await userEvent.click(await screen.findByRole("button", { name: "Use local/manual review now" }));
    expect(screen.getByRole("region", { name: "Extraction review" })).toHaveFocus();
  });

  it("offers image cleanup in place and labels the actual original type, not page count", async () => {
    renderPage("receipt", {
      original_content_type: "image/png",
      page_count: 1,
    });
    expect(screen.queryByRole("link", { name: "Original PDF" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Original" })).toHaveAttribute(
      "href", "/api/v1/documents/document-1/original",
    );
    await userEvent.click(screen.getByRole("button", { name: "Clean up scan" }));
    expect(screen.getByText("Cleanup draft for document-1")).toBeVisible();
  });

  it("does not offer cleanup for an arbitrary PDF or a read-only viewer", () => {
    renderPage("manual");
    expect(screen.queryByRole("button", { name: "Clean up scan" })).not.toBeInTheDocument();
  });

  it("keeps image cleanup unavailable to read-only viewers", () => {
    state.canWrite = false;
    renderPage("receipt", { content_type: "image/png", original_content_type: "image/png" });
    expect(screen.queryByRole("button", { name: "Clean up scan" })).not.toBeInTheDocument();
  });

  it.each(["manual", "receipt", "invoice", "warranty_certificate", "specification", "other"] as const)(
    "shares compact extraction review and defers related-item lookup for %s", async (kind) => {
    renderPage(kind);
    expect(screen.getByText(/^Extraction review loaded for/)).toBeVisible();
    expect(screen.queryByTestId("manual-extraction-review")).not.toBeInTheDocument();
    expect(screen.getByText("Extracted text")).toBeVisible();
    expect(state.relations).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Review extraction" }));
    await waitFor(() => expect(state.relations).toHaveBeenLastCalledWith("document-1"));
    expect(screen.getByText("Extracted text")).toBeVisible();
  });
});
