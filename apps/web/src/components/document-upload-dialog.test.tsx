import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { api } from "@/lib/api";
import type { DocumentRecord, DocumentType } from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useInvalidateInventory: () => vi.fn() };
});

vi.mock("@/components/item-multi-select", () => ({
  ItemMultiSelect: ({
    selected,
    onChange,
    label,
  }: {
    selected: string[];
    onChange: (ids: string[]) => void;
    label?: string;
  }) => (
    <div>
      <span>{label}</span>
      <span>{selected.length} selected</span>
      <button type="button" onClick={() => onChange([...selected, "item-1"])}>
        Add test item
      </button>
    </div>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, postForm: vi.fn() },
  };
});

const uploadedDocument: DocumentRecord = {
  id: "document-1",
  title: "Drill manual",
  document_type: "manual",
  original_filename: "drill.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 100,
  original_byte_size: 100,
  document_date: null,
  merchant: null,
  notes: null,
  extracted_text: null,
  extracted_metadata: {},
  ocr_status: "queued",
  ocr_error: null,
  ocr_confidence: null,
  ocr_processed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [{ id: "item-1", name: "Cordless drill" }],
  item_count: 1,
  pages: [],
  page_count: 0,
  url: "/api/v1/documents/document-1/file",
  original_url: "/api/v1/documents/document-1/original",
};

function renderDialog({
  defaultItemIds,
  defaultType = "receipt",
  manualMode = false,
}: {
  defaultItemIds?: string[];
  defaultType?: DocumentType;
  manualMode?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const onUploaded = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DocumentUploadDialog
        open
        onOpenChange={onOpenChange}
        defaultItemIds={defaultItemIds}
        defaultType={defaultType}
        manualMode={manualMode}
        onUploaded={onUploaded}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onUploaded };
}

function uploadedFormData(): FormData {
  const call = vi.mocked(api.postForm).mock.calls[0];
  expect(call?.[0]).toBe("/documents");
  return call?.[1] as FormData;
}

beforeEach(() => {
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.postForm).mockResolvedValue(uploadedDocument);
});

describe("DocumentUploadDialog", () => {
  it("rejects an unsupported replacement without discarding the selected document or title", async () => {
    renderDialog();
    const file = new File(["%PDF"], "invoice.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/^File/), {
      target: { files: [new File(["zip"], "archive.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF");
    expect(screen.getByDisplayValue("invoice")).toBeVisible();
    expect(screen.getByText("invoice.pdf")).toBeVisible();
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("attaches an item-context manual automatically without asking for compatible items", async () => {
    const { onOpenChange, onUploaded } = renderDialog({
      defaultItemIds: ["item-1"],
      defaultType: "manual",
      manualMode: true,
    });

    expect(screen.queryByText("Compatible items")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Find items")).not.toBeInTheDocument();
    expect(screen.getByText(/attached to this item automatically/)).toBeVisible();
    expect(screen.queryByLabelText(/Manufacturer/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Model/i)).not.toBeInTheDocument();

    const file = new File(["%PDF-1.4"], "drill.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Manual file"), file);
    expect(screen.getByLabelText(/^Title/)).toHaveValue("drill");
    await userEvent.clear(screen.getByLabelText(/^Title/));
    await userEvent.type(screen.getByLabelText(/^Title/), "Drill manual");
    await userEvent.type(screen.getByLabelText(/^Notes/), "Keep for torque settings.");
    expect((screen.getByLabelText("Manual file") as HTMLInputElement).files).toHaveLength(1);
    fireEvent.submit(screen.getByRole("button", { name: "Add manual" }).closest("form")!);

    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const payload = uploadedFormData();
    expect(payload.get("file")).toBe(file);
    expect(payload.get("title")).toBe("Drill manual");
    expect(payload.get("notes")).toBe("Keep for torque settings.");
    expect(payload.get("document_type")).toBe("manual");
    expect(payload.getAll("item_ids")).toEqual(["item-1"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUploaded).toHaveBeenCalledWith(uploadedDocument);
  });

  it("keeps item selection and purchase fields in the global document upload", async () => {
    renderDialog();

    expect(screen.getByText("Linked items")).toBeVisible();
    expect(screen.getByLabelText("Type")).toBeVisible();
    expect(screen.getByLabelText(/^Merchant/)).toBeVisible();
    expect(screen.getByLabelText(/^Document date/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add test item" }));
    await userEvent.upload(
      screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }),
    );
    expect((screen.getByLabelText("File") as HTMLInputElement).files).toHaveLength(1);
    fireEvent.submit(screen.getByRole("button", { name: "Add document" }).closest("form")!);

    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const payload = uploadedFormData();
    expect(payload.get("document_type")).toBe("receipt");
    expect(payload.getAll("item_ids")).toEqual(["item-1"]);
  });

  it("keeps the linked-item selector for non-manual uploads launched from an item", () => {
    renderDialog({ defaultItemIds: ["item-1"], defaultType: "other" });

    expect(screen.getByText("Linked items")).toBeVisible();
    expect(screen.getByText("1 selected")).toBeVisible();
  });
});
