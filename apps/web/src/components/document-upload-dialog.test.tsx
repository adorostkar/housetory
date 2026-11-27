import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
    api: { ...actual.api, postForm: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
  defaultType,
  manualMode = false,
  itemName,
}: {
  defaultItemIds?: string[];
  defaultType?: DocumentType;
  manualMode?: boolean;
  itemName?: string;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const onUploaded = vi.fn();
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DocumentUploadDialog
          open
          onOpenChange={onOpenChange}
          defaultItemIds={defaultItemIds}
          defaultType={defaultType}
          manualMode={manualMode}
          itemName={itemName}
          onUploaded={onUploaded}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onOpenChange, onUploaded };
}

function uploadedFormData(): FormData {
  const call = vi.mocked(api.postForm).mock.calls[0];
  expect(call?.[0]).toBe("/documents");
  return call?.[1] as FormData;
}

const processing = {
  correlation_id: "attempt-1", stage: "reading", started_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z", elapsed_ms: 1000, local_available: false,
  can_cancel: true, can_retry: false, worker_available: true, reason: null,
  timings: { local_queue_ms: null, local_processing_ms: null, ai_queue_ms: null, provider_ms: null, validation_ms: null },
};

beforeEach(() => {
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.postForm).mockResolvedValue(uploadedDocument);
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) =>
    (path.endsWith("/processing") ? processing : uploadedDocument) as never);
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.patch).mockImplementation(async (_path, body) =>
    ({ ...uploadedDocument, ...(body as object) }) as never);
  vi.mocked(api.delete).mockReset();
  vi.mocked(api.delete).mockResolvedValue(undefined as never);
});

describe("DocumentUploadDialog", () => {
  it("rejects an unsupported file without uploading it", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["zip"], "archive.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF");
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("saves the file as soon as it is chosen, with no metadata and no item", async () => {
    const { onOpenChange, onUploaded } = renderDialog();
    // No field has to be filled in before the file is saved.
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Merchant/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add test item" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Take a photo")).toHaveAttribute("capture", "environment");

    const file = new File(["receipt"], "receipt.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("File"), file);

    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const payload = uploadedFormData();
    expect(payload.get("file")).toBe(file);
    expect(payload.get("document_type")).toBe("other");
    expect(payload.get("title")).toBeNull();
    expect(payload.get("merchant")).toBeNull();
    expect(payload.getAll("item_ids")).toEqual([]);

    // The truthful reading state is shown, and the optional steps start closed.
    expect(await screen.findByText("Reading document")).toBeVisible();
    expect(screen.getByRole("button", { name: /Attach to an item/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Add details/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/details? found/)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUploaded).toHaveBeenCalledWith(uploadedDocument);
  });

  it("saves a dropped file", async () => {
    renderDialog();
    const file = new File(["%PDF"], "invoice.pdf", { type: "application/pdf" });
    fireEvent.drop(screen.getByText(/Drop a file here/).closest("div")!.parentElement!, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    expect(uploadedFormData().get("file")).toBe(file);
  });

  it("Undo deletes the document that was just saved and closing then reports nothing", async () => {
    const { onUploaded } = renderDialog();
    await userEvent.upload(screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/documents/document-1"));
    expect(await screen.findByLabelText("File")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("saves details and attached items after the file, on request", async () => {
    renderDialog();
    await userEvent.upload(screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }));
    await userEvent.click(await screen.findByRole("button", { name: /Add details/ }));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Clas Ohlson");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "receipt");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/documents/document-1",
      expect.objectContaining({ merchant: "Clas Ohlson", document_type: "receipt" })));

    await userEvent.click(screen.getByRole("button", { name: /Attach to an item/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add test item" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/documents/document-1",
      { item_ids: ["item-1", "item-1"] }));
  });

  it("names the item it was started from and attaches a manual without a selector or review", async () => {
    renderDialog({
      defaultItemIds: ["item-1"],
      defaultType: "manual",
      manualMode: true,
      itemName: "Cordless drill",
    });
    const file = new File(["%PDF-1.4"], "drill.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Manual file"), file);

    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const payload = uploadedFormData();
    expect(payload.get("document_type")).toBe("manual");
    expect(payload.getAll("item_ids")).toEqual(["item-1"]);
    expect(await screen.findByText(/Attached to:/)).toHaveTextContent("Attached to: Cordless drill");
    expect(screen.queryByRole("button", { name: /Attach to/ })).not.toBeInTheDocument();
    // A manual never asks for a purchase-style review, and its extraction is not loaded.
    expect(screen.queryByText(/Check what was read/)).not.toBeInTheDocument();
    expect(vi.mocked(api.get).mock.calls.some(([path]) => String(path).endsWith("/extraction"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /Add details/ }));
    expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Merchant/)).not.toBeInTheDocument();
  });

  it("shows a quiet line when details were read, and keeps the item selector closed from an item", async () => {
    const read = { ...uploadedDocument, document_type: "receipt" as const, ocr_status: "succeeded" as const, extracted_text: "Total 10" };
    vi.mocked(api.postForm).mockResolvedValue(read);
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.endsWith("/processing")) return { ...processing, stage: "ready", can_cancel: false } as never;
      if (path.endsWith("/extraction")) {
        return {
          fields: { merchant: "Shop", total_cents: 1000, serial_numbers: [] },
          lines: [{ kind: "product" }, { kind: "tax" }],
        } as never;
      }
      return read as never;
    });
    renderDialog({ defaultItemIds: ["item-1"], defaultType: "receipt", itemName: "Cordless drill" });
    await userEvent.upload(screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }));
    expect(await screen.findByText(/3 details found/)).toBeVisible();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/documents/document-1");
    expect(screen.getByText(/Attached to:/)).toHaveTextContent("Cordless drill");
    expect(screen.getByRole("button", { name: /Attach to more items/ })).toHaveAttribute("aria-expanded", "false");
  });
  // After the file is saved, typed details and chosen items are a draft. A failed
  // save must never lose it.
  async function saveFileAndTypeDetails() {
    await userEvent.upload(screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }));
    await userEvent.click(await screen.findByRole("button", { name: /Add details/ }));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Clas Ohlson");
    await userEvent.type(screen.getByLabelText(/^Notes/), "Return within 30 days");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "receipt");
  }
  const expectDraftKept = () => {
    expect(screen.getByLabelText(/^Merchant/)).toHaveValue("Clas Ohlson");
    expect(screen.getByLabelText(/^Notes/)).toHaveValue("Return within 30 days");
    expect(screen.getByLabelText("Type")).toHaveValue("receipt");
  };

  it("keeps the draft and offers Retry when Done cannot save; Retry saves and closes", async () => {
    const { onOpenChange, onUploaded } = renderDialog();
    await saveFileAndTypeDetails();
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("The library is not reachable."));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your changes are not saved yet. The library is not reachable.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expectDraftKept();
    expect(screen.getByText(/the document itself stays in the library/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch).toHaveBeenLastCalledWith("/documents/document-1", expect.objectContaining({
      merchant: "Clas Ohlson", notes: "Return within 30 days", document_type: "receipt",
    }));
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ merchant: "Clas Ohlson" }));
  });

  it("Discard changes closes without another save and keeps the saved document", async () => {
    const { onOpenChange, onUploaded } = renderDialog();
    await saveFileAndTypeDetails();
    vi.mocked(api.patch).mockRejectedValue(new Error("The library is not reachable."));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("alert");
    expect(api.patch).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();
    expect(onUploaded).toHaveBeenCalledWith(uploadedDocument);
  });

  it("Escape with unsaved edits saves them, and stays open with the draft when that fails", async () => {
    const { onOpenChange } = renderDialog();
    await saveFileAndTypeDetails();
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("Offline"));
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your changes are not saved yet. Offline");
    expect(onOpenChange).not.toHaveBeenCalled();
    expectDraftKept();

    // A second Escape tries again; this time the save works and the surface closes.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.patch).toHaveBeenLastCalledWith("/documents/document-1",
      expect.objectContaining({ merchant: "Clas Ohlson" }));
  });

  it("keeps a chosen item when attaching fails and sends it again with the retry", async () => {
    renderDialog();
    await userEvent.upload(screen.getByLabelText("File"),
      new File(["receipt"], "receipt.txt", { type: "text/plain" }));
    await userEvent.click(await screen.findByRole("button", { name: /Attach to an item/ }));
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("Offline"));
    await userEvent.click(screen.getByRole("button", { name: "Add test item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    // The choice is still there, not rolled back.
    expect(screen.getByText("2 selected")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith(
      "/documents/document-1", { item_ids: ["item-1", "item-1"] },
    ));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps the chosen file and offers Retry when the first upload fails", async () => {
    vi.mocked(api.postForm).mockRejectedValueOnce(new Error("Upload interrupted"));
    renderDialog();
    const file = new File(["receipt"], "receipt.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("File"), file);
    expect(await screen.findByRole("alert")).toHaveTextContent("The file was not saved. Upload interrupted");
    expect(screen.getByText("receipt.txt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(2));
    expect((vi.mocked(api.postForm).mock.calls[1]![1] as FormData).get("file")).toBe(file);
    expect(await screen.findByRole("button", { name: "Done" })).toBeVisible();
  });
});
