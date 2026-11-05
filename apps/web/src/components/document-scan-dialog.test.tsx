import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { api } from "@/lib/api";
import type { DocumentPage, DocumentRecord, DocumentScan } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    api: {
      ...actual.api,
      post: vi.fn(),
      postForm: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const fullCorners = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function makePage(id: string, number: number): DocumentPage {
  return {
    id,
    page_number: number,
    width: 600,
    height: 900,
    original_filename: `${id}.png`,
    original_content_type: "image/png",
    original_byte_size: 100,
    cleaned_content_type: "image/jpeg",
    cleaned_byte_size: 80,
    original_url: `/api/v1/documents/scans/scan-1/pages/${id}/original`,
    cleaned_url: `/api/v1/documents/scans/scan-1/pages/${id}/file`,
    adjustments: {
      rotation: 0,
      corners: fullCorners,
      color_mode: "color",
      contrast: 1,
    },
    updated_at: `2026-01-0${number}T00:00:00Z`,
  };
}

const pageOne = makePage("page-1", 1);
const pageTwo = makePage("page-2", 2);

const scan: DocumentScan = {
  id: "scan-1",
  status: "draft",
  pages: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const committed: DocumentRecord = {
  id: "document-1",
  title: "Scanned receipt",
  document_type: "receipt",
  original_filename: "Scanned receipt.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 2048,
  original_byte_size: 4096,
  document_date: null,
  merchant: null,
  notes: null,
  extracted_text: null,
  extracted_metadata: { scan: { page_count: 2, source: "scanner" } },
  ocr_status: "queued",
  ocr_error: null,
  ocr_confidence: null,
  ocr_processed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [],
  item_count: 0,
  pages: [pageOne, pageTwo],
  page_count: 2,
  url: "/api/v1/documents/document-1/file",
  original_url: "/api/v1/documents/document-1/original",
};

function renderDialog(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <DocumentScanDialog
      open
      onOpenChange={onOpenChange}
      defaultItemIds={["item-1"]}
      defaultType="receipt"
      onSaved={onSaved}
    />,
  );
  return { onSaved, onOpenChange };
}

function uploadInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    'input[type="file"]:not([capture])',
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.delete).mockReset();
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/documents/scans") return scan;
    if (path.endsWith("/pages/reorder")) {
      return { ...scan, pages: [pageTwo, pageOne] };
    }
    if (path.endsWith("/commit")) return committed;
    throw new Error(`Unexpected POST ${path}`);
  });
  vi.mocked(api.postForm).mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo);
  vi.mocked(api.patch).mockImplementation(async (_path, body) => ({
    ...pageOne,
    adjustments: body as DocumentPage["adjustments"],
    updated_at: "2026-01-01T00:01:00Z",
  }));
  vi.mocked(api.delete).mockResolvedValue(undefined);
});

describe("DocumentScanDialog", () => {
  it("uploads pages, previews original and cleaned copies, rotates and saves", async () => {
    const { onSaved, onOpenChange } = renderDialog();
    const container = document.body;
    const input = uploadInput(container);
    expect(input).toBeTruthy();
    await userEvent.upload(
      input as HTMLInputElement,
      new File(["page one"], "receipt-page-1.png", { type: "image/png" }),
    );
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith(
        "/documents/scans/scan-1/pages",
        expect.any(FormData),
      ),
    );
    expect(await screen.findByAltText("Original page 1")).toBeVisible();
    expect(screen.getByAltText("Cleaned page 1")).toBeVisible();
    expect(screen.getByText("Attach to items")).toBeVisible();
    expect(screen.getByText("1 selected")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Rotate page right" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/documents/scans/scan-1/pages/page-1",
        expect.objectContaining({ rotation: 90 }),
      ),
    );

    const titleInput = screen.getByLabelText(/^Title/);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Scanned receipt");
    await userEvent.click(
      screen.getByRole("button", { name: "Save scanned document" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(committed));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const commit = vi
      .mocked(api.post)
      .mock.calls.find(([path]) => path === "/documents/scans/scan-1/commit");
    expect(commit).toBeTruthy();
    expect(commit?.[1]).toMatchObject({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      item_ids: ["item-1"],
      document_type: "receipt",
      title: "Scanned receipt",
    });
  });

  it("reorders and removes pages and supports keyboard corner adjustment", async () => {
    renderDialog();
    const input = uploadInput(document.body) as HTMLInputElement;
    await userEvent.upload(input, [
      new File(["page one"], "one.png", { type: "image/png" }),
      new File(["page two"], "two.png", { type: "image/png" }),
    ]);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Edit page/ })).toHaveLength(2),
    );

    const topLeft = screen.getByRole("button", { name: "Adjust Top left corner" });
    topLeft.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/documents/scans/scan-1/pages/page-1",
        expect.objectContaining({
          corners: expect.arrayContaining([expect.objectContaining({ x: 0.01 })]),
        }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Move page 2 earlier" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/scans/scan-1/pages/reorder",
        { page_ids: ["page-2", "page-1"] },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove page 1" }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/documents/scans/scan-1/pages/page-2",
      ),
    );
  });

  it("cancels and discards an uncommitted draft", async () => {
    const { onOpenChange } = renderDialog();
    const input = uploadInput(document.body) as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(["page one"], "receipt-page-1.png", { type: "image/png" }),
    );
    await waitFor(() => expect(screen.getByAltText("Original page 1")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/documents/scans/scan-1"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reuses the same request id when a commit retry follows a network error", async () => {
    renderDialog();
    const input = uploadInput(document.body) as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(["page one"], "receipt-page-1.png", { type: "image/png" }),
    );
    await waitFor(() => expect(screen.getByAltText("Original page 1")).toBeVisible());
    vi.mocked(api.post)
      .mockRejectedValueOnce(new Error("network disconnected"))
      .mockResolvedValueOnce(committed);
    await userEvent.click(screen.getByRole("button", { name: "Save scanned document" }));
    expect(await screen.findByText("network disconnected")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save scanned document" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
    const commits = vi
      .mocked(api.post)
      .mock.calls.filter(([path]) => path === "/documents/scans/scan-1/commit");
    expect(commits).toHaveLength(2);
    expect((commits[0]?.[1] as { request_id: string }).request_id).toBe(
      (commits[1]?.[1] as { request_id: string }).request_id,
    );
  });
});
