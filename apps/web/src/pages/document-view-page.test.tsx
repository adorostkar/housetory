import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "@/lib/api";
import type { DocumentRecord } from "@/lib/types";
import { DocumentViewPage } from "@/pages/document-view-page";

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), getBlob: vi.fn(), post: vi.fn() } };
});

vi.mock("@/components/pdf-pages", () => ({
  PdfPages: ({ file, title, initialPage }: { file: Blob; title: string; initialPage: number }) => (
    <div data-testid="pdf-pages" data-bytes={file.size} data-page={initialPage}>
      Pages of {title}
    </div>
  ),
}));

const manual: DocumentRecord = {
  id: "doc-1",
  title: "ASIM6K0R-EN-v2",
  document_type: "manual",
  original_filename: "ASIM6K0R-EN-v2.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 4096,
  original_byte_size: 4096,
  document_date: null,
  merchant: null,
  notes: null,
  extracted_text: "CURRENT MEASUREMENT",
  extracted_metadata: {},
  ocr_status: "succeeded",
  ocr_error: null,
  ocr_confidence: null,
  ocr_processed_at: "2026-01-01T01:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  items: [{ id: "item-1", name: "Multimeter" }],
  item_count: 1,
  pages: [],
  page_count: 0,
  url: "/api/v1/documents/doc-1/file",
  original_url: "/api/v1/documents/doc-1/original",
};

/** Renders the page; `null` stands for a document the current household cannot reach. */
function renderPage(entry: string, document: Partial<DocumentRecord> | null = {}) {
  if (document) vi.mocked(api.get).mockResolvedValue({ ...manual, ...document });
  else {
    vi.mocked(api.get).mockRejectedValue(
      new ApiError(404, "document_not_found", "Document not found."),
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/documents/:documentId/view" element={<DocumentViewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.getBlob).mockReset().mockResolvedValue(
    new Blob(["%PDF-1.4 synthetic"], { type: "application/pdf" }),
  );
});

describe("DocumentViewPage", () => {
  it("shows the PDF itself at the cited page and starts no extraction or processing", async () => {
    renderPage("/documents/doc-1/view?page=12");
    const pages = await screen.findByTestId("pdf-pages");
    expect(pages).toHaveTextContent("Pages of ASIM6K0R-EN-v2");
    expect(pages).toHaveAttribute("data-page", "12");
    expect(pages).toHaveAttribute("data-bytes", "18");
    expect(screen.getByRole("heading", { name: "ASIM6K0R-EN-v2" })).toBeVisible();

    // Only the record and its file are read: no extraction, processing or item matching.
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(["/documents/doc-1"]);
    expect(vi.mocked(api.getBlob).mock.calls.map(([path]) => path)).toEqual(["/documents/doc-1/file"]);
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByText(/extraction/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/OCR/)).not.toBeInTheDocument();

    // Managing the document is a separate page; the file can still be downloaded.
    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute("href", "/documents/doc-1");
    expect(screen.getByRole("link", { name: "Download" }))
      .toHaveAttribute("href", "/api/v1/documents/doc-1/file");
  });

  it("shows an image manual as the image, without fetching it twice", async () => {
    renderPage("/documents/doc-1/view", { content_type: "image/jpeg", title: "Quick start card" });
    expect(await screen.findByRole("img", { name: "Quick start card" })).toHaveAttribute(
      "src", "/api/v1/documents/doc-1/file?v=2026-01-02T00%3A00%3A00Z",
    );
    expect(api.getBlob).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pdf-pages")).not.toBeInTheDocument();
  });

  it("shows a text manual as plain text", async () => {
    vi.mocked(api.getBlob).mockResolvedValue(
      new Blob(["Step 1: turn the dial to 10A.\n<script>alert(1)</script>"], { type: "text/plain" }),
    );
    renderPage("/documents/doc-1/view", { content_type: "text/plain", title: "Notes" });
    const text = await screen.findByRole("region", { name: "Text of Notes" });
    expect(text).toHaveTextContent("Step 1: turn the dial to 10A. <script>alert(1)</script>");
    expect(text.querySelector("script")).toBeNull();
  });

  it("requests nothing until the app has switched to the link's household", async () => {
    renderPage("/documents/doc-1/view?page=2&household_id=house-2");
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
    expect(api.getBlob).not.toHaveBeenCalled();
  });

  it("does not show a document outside the current household", async () => {
    renderPage("/documents/doc-1/view", null);
    expect(await screen.findByText("This document is out of reach")).toBeVisible();
    expect(api.getBlob).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("offers the download when the file cannot be shown", async () => {
    vi.mocked(api.getBlob).mockRejectedValue(new ApiError(500, "request_failed", "Failed."));
    renderPage("/documents/doc-1/view");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file cannot be shown here. Download it to open it in another app.",
    );
    await waitFor(() => expect(screen.queryByTestId("pdf-pages")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Download" })).toBeVisible();
  });
});
