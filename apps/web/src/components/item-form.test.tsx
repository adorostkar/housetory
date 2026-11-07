import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemForm } from "@/components/item-form";
import { api } from "@/lib/api";
import type { ItemDetail } from "@/lib/types";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  };
});

const receipt = {
  id: "receipt-1",
  title: "Toolbox receipt",
  document_type: "receipt" as const,
  content_type: "application/pdf",
  url: "/api/v1/documents/receipt-1/file",
};

const warrantyDocument = {
  id: "warranty-doc-1",
  title: "Toolbox warranty",
  document_type: "warranty_certificate" as const,
  content_type: "application/pdf",
  url: "/api/v1/documents/warranty-doc-1/file",
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useInvalidateInventory: () => vi.fn(),
    useProperties: () => ({ data: { items: [{ id: "property-1", name: "Home" }] } }),
    useRooms: () => ({
      data: { items: [{ id: "room-1", name: "Workshop", property_id: "property-1" }] },
    }),
    useCategories: () => ({
      data: { items: [{ id: "category-1", name: "Tools", color: null }] },
    }),
    useTags: () => ({ data: { items: [{ id: "tag-1", name: "Frequent" }] } }),
    useDocuments: () => ({ data: { items: [receipt, warrantyDocument] } }),
    useLocations: () => ({
      data: {
        items: [
          {
            id: "location-1",
            room_id: "room-1",
            parent_id: null,
            name: "Tool shelf",
            description: null,
            kind: "shelf",
            is_container: false,
            container_type: null,
            identifier: "SHELF-001",
            label_generated_at: null,
            sort_order: 0,
            item_count: 0,
            total_item_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    }),
  };
});

const item: ItemDetail = {
  id: "item-1",
  name: "Toolbox",
  description: "Metal toolbox with two trays",
  brand: "Stanley",
  model: "Pro-Stack",
  serial_number: "SN-123",
  quantity: 1,
  condition: "good",
  is_archived: false,
  room: { id: "room-1", name: "Workshop" },
  property: { id: "property-1", name: "Home", is_archived: false },
  location: {
    id: "location-1",
    name: "Tool shelf",
    kind: "shelf",
    parent_id: null,
    identifier: "SHELF-001",
    container_type: null,
    is_container: false,
  },
  location_path: [],
  category: { id: "category-1", name: "Tools", color: null },
  tags: [{ id: "tag-1", name: "Frequent" }],
  primary_photo: null,
  purchase: {
    id: "purchase-1",
    merchant: "Build Supply",
    vendor: "Build Supply",
    purchase_date: "2026-02-01",
    price_cents: 10000,
    currency: "USD",
    order_number: "ORD-1",
    notes: "Shared order",
    receipt_document_id: "receipt-1",
    receipt,
    items: [
      { id: "item-1", name: "Toolbox" },
      { id: "item-2", name: "Drill" },
    ],
    allocations: [],
    allocated_total_cents: 0,
    unallocated_cents: 10000,
    item_count: 2,
    is_shared: true,
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
  purchase_info_status: "recorded",
  purchase_info_missing_fields: [],
  warranty: {
    id: "warranty-1",
    provider: "Stanley",
    start_date: "2026-02-01",
    duration_months: 24,
    end_date: "2028-02-01",
    reminder_days: 30,
    effective_reminder_days: 30,
    notes: "Lifetime shell warranty",
    coverage_notes: null,
    status: "active",
    days_remaining: 500,
    document_id: "warranty-doc-1",
    document: warrantyDocument,
    item: null,
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
  current_value_cents: 5000,
  current_value_currency: "USD",
  current_value_basis: "legacy_record_total",
  current_value_total_cents: 5000,
  current_value_estimated_at: "2026-02-01T00:00:00Z",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  photos: [],
  documents: [receipt, warrantyDocument] as ItemDetail["documents"],
  import_source: null,
  storage: null,
};

function renderForm() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ItemForm item={item} returnTo="/items/item-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.patch).mockResolvedValue({ item });
  vi.mocked(api.post).mockReset();
});

describe("ItemForm optional sections", () => {
  it("shows essentials and compact summaries without rendering hidden fields", () => {
    renderForm();
    expect(screen.getByRole("heading", { name: "The essentials" })).toBeVisible();
    expect(screen.getByLabelText("Item name")).toBeVisible();
    expect(screen.getByLabelText("Quantity")).toBeVisible();
    expect(screen.getByLabelText("Room")).toBeVisible();
    expect(screen.getByLabelText("Storage location")).toBeVisible();
    expect(screen.getByText(/Shared purchase · \$100\b/)).toBeVisible();
    expect(screen.getByText(/Stanley · Document: Toolbox warranty/)).toBeVisible();
    expect(screen.getByText(/Legacy record total \$50\b/)).toBeVisible();
    expect(screen.queryByLabelText(/Purchase total/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Estimated current value per unit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Provider/)).not.toBeInTheDocument();
  });

  it("edits only the name while preserving collapsed shared purchase, value, warranty and links", async () => {
    renderForm();
    const name = screen.getByLabelText("Item name");
    await userEvent.clear(name);
    await userEvent.type(name, "Toolbox renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(path).toBe("/items/item-1");
    expect(payload).toMatchObject({
      name: "Toolbox renamed",
      brand: "Stanley",
      model: "Pro-Stack",
      serial_number: "SN-123",
      description: "Metal toolbox with two trays",
      category_id: "category-1",
      tag_ids: ["tag-1"],
      purchase: {
        merchant: "Build Supply",
        purchase_date: "2026-02-01",
        price_cents: 10000,
        currency: "USD",
        order_number: "ORD-1",
        notes: "Shared order",
        receipt_document_id: "receipt-1",
      },
      current_value_cents: 5000,
      current_value_currency: "USD",
      current_value_basis: "legacy_record_total",
      warranty: {
        provider: "Stanley",
        start_date: "2026-02-01",
        duration_months: 24,
        reminder_days: 30,
        document_id: "warranty-doc-1",
        notes: "Lifetime shell warranty",
      },
    });
  });

  it("expands purchase, value and warranty sections for review", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: /Purchase/ }));
    expect(screen.getByLabelText(/Purchase total/)).toHaveValue(100);
    expect(screen.getByLabelText(/Receipt document/)).toHaveValue("receipt-1");

    await userEvent.click(screen.getByRole("button", { name: /Current value/ }));
    expect(screen.getByLabelText(/Legacy recorded total/)).toHaveValue(50);
    expect(screen.getByText("Legacy recorded total", { selector: "p" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Convert to per-unit" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Warranty/ }));
    expect(screen.getByLabelText(/Provider/)).toHaveValue("Stanley");
    expect(screen.getByLabelText(/Warranty document/)).toHaveValue("warranty-doc-1");
  });

  it("expands identity fields and keeps focus/keyboard operation", async () => {
    renderForm();
    const identity = screen.getByRole("button", { name: /Identity & organisation/ });
    identity.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByLabelText(/Brand/)).toHaveValue("Stanley");
    expect(screen.getByLabelText(/Category/)).toHaveValue("category-1");
    expect(screen.getByRole("button", { name: "Frequent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
