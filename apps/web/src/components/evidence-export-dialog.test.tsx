import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { api } from "@/lib/api";
import type {
  EvidenceExportRecord,
  EvidenceOptions,
  EvidencePreview,
} from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

const defaultOptions: EvidenceOptions = {
  include_photos: true,
  include_receipts: true,
  include_warranty_documents: true,
  include_manuals: false,
  include_other_documents: false,
  include_document_originals: true,
  include_csv: true,
  include_attachments: true,
  excluded_document_ids: [],
};

function preview(options: Partial<EvidenceOptions> = {}): EvidencePreview {
  return {
    fingerprint: "fingerprint-1",
    format_version: "inventory-evidence-v1",
    household_name: "Ada's Home",
    generated_at: "2026-11-05T10:00:00+01:00",
    timezone: "CET (UTC+01:00)",
    scope_label: "Room: Workshop",
    scope: { room_ids: ["room-1"] },
    include_archived: false,
    options: { ...defaultOptions, ...options },
    item_count: 2,
    unit_count: 3,
    at_home_unit_count: 2,
    on_loan_unit_count: 1,
    archived_excluded_count: 0,
    missing_purchase_count: 1,
    photo_count: 2,
    included_photo_count: 2,
    photo_bytes: 4000,
    document_count: 2,
    included_document_count: 1,
    document_bytes: 5000,
    evidence_reference_count: 1,
    bundle_estimated_bytes: 9000,
    max_bundle_bytes: 100 * 1024 * 1024,
    bundle_within_limit: true,
    can_generate: true,
    items: [
      {
        id: "item-1",
        name: "Café Drill 日本",
        brand: "DeWalt",
        model: "DCD791",
        serial_number: "SN-1",
        quantity: 2,
        on_loan_quantity: 1,
        at_home_quantity: 1,
        condition: "Good",
        is_archived: false,
        category: "Tools",
        full_location_path: "Workshop / BOX-001 · Power tools",
        purchase_info_status: "recorded",
        purchase_currency: "USD",
        item_allocation_cents: 7000,
        current_value_cents: 9000,
        current_value_currency: "USD",
        photo_count: 1,
        document_count: 1,
      },
      {
        id: "item-2",
        name: "Lamp",
        brand: null,
        model: null,
        serial_number: null,
        quantity: 1,
        on_loan_quantity: 0,
        at_home_quantity: 1,
        condition: "Good",
        is_archived: false,
        category: null,
        full_location_path: "Workshop",
        purchase_info_status: "unrecorded",
        purchase_currency: null,
        item_allocation_cents: null,
        current_value_cents: null,
        current_value_currency: null,
        photo_count: 1,
        document_count: 1,
      },
    ],
    documents: [
      {
        id: "doc-receipt",
        title: "Shared receipt",
        document_type: "receipt",
        evidence_kind: "receipt",
        merchant: "Hardware Store",
        document_date: "2026-02-01",
        byte_size: 2000,
        original_byte_size: 2000,
        scan_page_count: 0,
        shared_with_unselected: true,
        category_included: true,
        excluded_by_user: false,
        included: true,
        selected_item_ids: ["item-1"],
      },
      {
        id: "doc-manual",
        title: "Long manual",
        document_type: "manual",
        evidence_kind: "manual",
        merchant: null,
        document_date: null,
        byte_size: 3000,
        original_byte_size: 3000,
        scan_page_count: 0,
        shared_with_unselected: false,
        category_included: false,
        excluded_by_user: false,
        included: false,
        selected_item_ids: ["item-1"],
      },
    ],
    currency_totals: [
      {
        currency: "USD",
        selected_allocated_purchase_cents: 7000,
        current_value_cents: 9000,
        allocated_item_count: 1,
        current_value_item_count: 1,
      },
    ],
    purchase_references: [
      {
        purchase_id: "purchase-1",
        merchant: "Hardware Store",
        purchase_date: "2026-02-01",
        total_cents: 12000,
        currency: "USD",
        item_count_in_household: 2,
        selected_item_count: 1,
        allocated_total_cents: 12000,
        selected_allocated_cents: 7000,
        unallocated_cents: 0,
        has_unselected_items: true,
        has_allocations: true,
        receipt_document_id: "doc-receipt",
      },
    ],
    warnings: [
      "1 purchase record is shared with items outside this selection.",
      "1 manual document is excluded by default.",
    ],
  };
}

function record(status: EvidenceExportRecord["status"] = "succeeded"): EvidenceExportRecord {
  return {
    id: "export-1",
    status,
    format_version: "inventory-evidence-v1",
    scope_label: "Room: Workshop",
    scope: { room_ids: ["room-1"] },
    include_archived: false,
    options: { ...defaultOptions },
    item_count: 2,
    unit_count: 3,
    evidence_counts: {},
    warnings: [],
    error: status === "failed" ? "The evidence package could not be generated." : null,
    created_at: "2026-11-05T10:00:00Z",
    completed_at: status === "succeeded" ? "2026-11-05T10:00:02Z" : null,
    expires_at: status === "succeeded" ? "2026-11-12T10:00:02Z" : null,
    pdf_available: status === "succeeded",
    csv_available: status === "succeeded",
    bundle_available: status === "succeeded",
    pdf_bytes: 1000,
    csv_bytes: 500,
    bundle_bytes: 1500,
    pdf_sha256: "a",
    csv_sha256: "b",
    bundle_sha256: "c",
    can_manage: true,
  };
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EvidenceExportDialog
        open
        onOpenChange={vi.fn()}
        scope={{ room_ids: ["room-1"] }}
      />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith("/evidence-exports?") || path === "/evidence-exports") {
      return { items: [] };
    }
    if (path.startsWith("/evidence-exports/")) return record("succeeded");
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
    if (path === "/evidence-exports/preview") {
      const payload = body as { options?: Partial<EvidenceOptions> };
      return preview(payload.options);
    }
    if (path === "/evidence-exports") return record("queued");
    if (path === "/evidence-exports/export-1/cancel") return record("cancelled");
    if (path === "/evidence-exports/export-1/retry") return record("queued");
    throw new Error(`Unexpected POST ${path}`);
  });
});

describe("EvidenceExportDialog", () => {
  it("previews scope and evidence, then generates and exposes private downloads", async () => {
    renderDialog();
    expect(await screen.findByText("Room: Workshop")).toBeVisible();
    expect(screen.getByText("Café Drill 日本")).toBeVisible();
    expect(screen.getByText("Shared receipt")).toBeVisible();
    expect(screen.getByText("Long manual")).toBeVisible();
    expect(screen.getByText(/Also linked elsewhere/)).toBeVisible();
    expect(screen.getByText(/receipts may contain other products/)).toBeVisible();
    expect(screen.getByText(/Manuals and specifications/)).toBeVisible();

    await userEvent.click(
      screen.getByRole("checkbox", { name: /Manuals and specifications/ }),
    );
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/evidence-exports/preview",
        expect.objectContaining({
          options: expect.objectContaining({ include_manuals: true }),
        }),
      ),
    );

    const generate = screen.getByRole("button", { name: "Generate package" });
    await waitFor(() => expect(generate).toBeEnabled());
    await userEvent.click(generate);
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/evidence-exports",
        expect.objectContaining({
          scope: { room_ids: ["room-1"] },
          fingerprint: "fingerprint-1",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    );
    expect(await screen.findByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      "/api/v1/evidence-exports/export-1/pdf",
    );
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      "/api/v1/evidence-exports/export-1/csv",
    );
    expect(screen.getByRole("link", { name: "Download evidence ZIP" })).toHaveAttribute(
      "href",
      "/api/v1/evidence-exports/export-1/bundle",
    );
  });

  it("shows failed state with retry and keeps private download scope clear", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith("/evidence-exports?")) return { items: [] };
      if (path === "/evidence-exports/export-1") return record("failed");
      throw new Error(`Unexpected GET ${path}`);
    });
    renderDialog();
    expect(await screen.findByText("Room: Workshop")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Generate package" }));
    expect(
      await screen.findByText("The evidence package could not be generated."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry generation" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download PDF" })).not.toBeInTheDocument();
  });

  it("keeps the dialog usable at narrow widths with keyboard controls", async () => {
    renderDialog();
    expect(await screen.findByText("Room: Workshop")).toBeVisible();
    const checkbox = screen.getByRole("checkbox", { name: /Item photos/ });
    checkbox.focus();
    await userEvent.keyboard(" ");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Generate package" })).toBeVisible();
  });
});
