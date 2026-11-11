import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DocumentCard } from "@/components/document-card";
import type { DocumentRecord } from "@/lib/types";

const document: DocumentRecord = {
  id: "doc-1",
  title: "Espresso receipt",
  document_type: "receipt",
  original_filename: "receipt.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 2048,
  original_byte_size: 2048,
  document_date: "2026-02-14",
  merchant: "La Marzocco",
  notes: null,
  extracted_text: null,
  extracted_metadata: {},
  ocr_status: "succeeded",
  ocr_error: null,
  ocr_confidence: 90,
  ocr_processed_at: "2026-02-14T10:00:00Z",
  created_at: "2026-02-14T10:00:00Z",
  updated_at: "2026-02-14T10:00:00Z",
  items: [
    { id: "item-1", name: "Espresso Machine" },
    { id: "item-2", name: "Grinder" },
  ],
  item_count: 2,
  pages: [],
  page_count: 0,
  url: "/api/v1/documents/doc-1/file",
  original_url: "/api/v1/documents/doc-1/original",
};

describe("DocumentCard", () => {
  it("links metadata, extraction state and downloads", () => {
    render(
      <MemoryRouter>
        <DocumentCard document={document} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Espresso receipt" })).toHaveAttribute(
      "href",
      "/documents/doc-1",
    );
    expect(screen.getByText("La Marzocco · Feb 14, 2026 · 2 KB · 2 items")).toBeInTheDocument();
    expect(screen.getByText("OCR: Extracted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Espresso receipt" })).toHaveAttribute(
      "href",
      "/api/v1/documents/doc-1/file",
    );
  });

  it("keeps item links and deletion independent and permission controlled", async () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <MemoryRouter><DocumentCard document={document} onDelete={onDelete} /></MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Espresso Machine" })).toHaveAttribute("href", "/items/item-1");
    await userEvent.click(screen.getByRole("button", { name: "Delete Espresso receipt" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(document);
    rerender(<MemoryRouter><DocumentCard document={document} compact /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Espresso receipt" })).toHaveAttribute("href", "/documents/doc-1");
  });
});
