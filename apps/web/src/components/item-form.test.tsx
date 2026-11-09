import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemForm } from "@/components/item-form";
import { api } from "@/lib/api";
import type { ItemDetail } from "@/lib/types";

const navigate = vi.hoisted(() => vi.fn());
const queryMocks = vi.hoisted(() => ({ defaultCurrency: "USD" }));

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
    useDefaultCurrency: () => queryMocks.defaultCurrency,
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

function renderForm(formItem: ItemDetail | null = item, duplicateOf?: ItemDetail) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ItemForm
          item={formItem ?? undefined}
          duplicateOf={duplicateOf}
          returnTo="/items/item-1"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const packItem: ItemDetail = {
  ...item,
  quantity: 2,
  purchase: item.purchase
    ? {
        ...item.purchase,
        items: [{ id: "item-1", name: "Toolbox" }],
        item_count: 1,
        is_shared: false,
        allocated_total_cents: 0,
        unallocated_cents: item.purchase.price_cents,
      }
    : null,
};

function makePackItem(quantity: number, priceCents: number): ItemDetail {
  return {
    ...packItem,
    quantity,
    purchase: packItem.purchase
      ? {
          ...packItem.purchase,
          price_cents: priceCents,
          unallocated_cents: priceCents,
        }
      : null,
  };
}

beforeEach(() => {
  queryMocks.defaultCurrency = "USD";
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
    expect(screen.getByText(/Shared purchase · \$100 transaction total/)).toBeVisible();
    expect(screen.getByText(/Stanley · Document: Toolbox warranty/)).toBeVisible();
    expect(screen.getByText(/Earlier record total \$50\b/)).toBeVisible();
    expect(screen.queryByLabelText(/Purchase total/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Estimated current value per unit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Provider/)).not.toBeInTheDocument();
  });

  it("uses the household default currency for new purchase entries without adding current-value controls", async () => {
    queryMocks.defaultCurrency = "EUR";
    renderForm(null);
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    expect(document.getElementById("purchase-currency")).toHaveValue("EUR");
    expect(screen.queryByRole("button", { name: /^Current value/ })).not.toBeInTheDocument();
  });

  it("does not rewrite existing records or expose their old estimate for editing", async () => {
    queryMocks.defaultCurrency = "EUR";
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    expect(document.getElementById("purchase-currency")).toHaveValue("USD");
    const earlierToggle = screen.getByRole("button", { name: /^Earlier estimate/ });
    await userEvent.click(earlierToggle);
    const earlier = earlierToggle.closest("section")!;
    expect(within(earlier).queryByLabelText("Currency")).not.toBeInTheDocument();
    expect(within(earlier).getByRole("link", { name: "Create insurance list" })).toHaveAttribute(
      "href",
      "/insurance?item_ids=item-1",
    );
  });

  it("duplicates identity and organisation without copying unit-specific financial details", async () => {
    vi.mocked(api.post).mockResolvedValue({ item });
    renderForm(null, packItem);
    expect(screen.getByLabelText("Item name")).toHaveValue("Toolbox");
    expect(screen.getByLabelText("Quantity")).toHaveValue(1);
    const identityToggle = screen.getByRole("button", {
      name: /Identity & organisation/,
    });
    expect(identityToggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(identityToggle);
    expect(identityToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/^Brand/)).toHaveValue("Stanley");
    expect(screen.getByLabelText(/^Model/)).toHaveValue("Pro-Stack");
    expect(screen.getByLabelText(/^Serial number/)).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Add to your home" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/items", expect.anything()));
    const [, payload] = vi.mocked(api.post).mock.calls[0]!;
    expect(payload).toMatchObject({
      name: "Toolbox",
      quantity: 1,
      brand: "Stanley",
      model: "Pro-Stack",
      serial_number: null,
      category_id: "category-1",
      tag_ids: ["tag-1"],
      purchase: null,
      warranty: null,
    });
    expect(payload).not.toHaveProperty("current_value_cents");
    expect(payload).not.toHaveProperty("current_value_currency");
    expect(payload).not.toHaveProperty("current_value_basis");
  });

  it("creates a sub-room without losing the item draft", async () => {
    const newRoom = {
      id: "room-new",
      name: "Garden cupboard",
      description: null,
      property_id: "property-1",
      parent_id: "room-1",
      sort_order: 0,
      item_count: 0,
      location_count: 0,
      total_item_count: 0,
      total_location_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    vi.mocked(api.post).mockImplementation(async (path) => {
      if (path === "/rooms") return newRoom;
      if (path === "/items") return { item };
      throw new Error(`Unexpected POST ${path}`);
    });
    renderForm(null);
    await userEvent.type(screen.getByLabelText("Item name"), "Garden tools");
    await userEvent.selectOptions(screen.getByLabelText("Room"), "room-1");
    await userEvent.selectOptions(screen.getByLabelText("Room"), "__new_room__");
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Room name"), "Garden cupboard");
    expect(within(dialog).getByLabelText(/Nested inside/)).toHaveValue("room-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add room" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Add to your home" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/items", expect.anything()));
    const [, payload] = vi.mocked(api.post).mock.calls.find(
      ([path]) => path === "/items",
    )!;
    expect(payload).toMatchObject({ name: "Garden tools", room_id: "room-new" });
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
      warranty: {
        provider: "Stanley",
        start_date: "2026-02-01",
        duration_months: 24,
        reminder_days: 30,
        document_id: "warranty-doc-1",
        notes: "Lifetime shell warranty",
      },
    });
    expect(payload).not.toHaveProperty("current_value_cents");
    expect(payload).not.toHaveProperty("current_value_currency");
    expect(payload).not.toHaveProperty("current_value_basis");
  });

  it("expands purchase, earlier estimate and warranty sections for review", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: /Purchase/ }));
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(100);
    expect(screen.getByLabelText(/Receipt document/)).toHaveValue("receipt-1");

    await userEvent.click(screen.getByRole("button", { name: /Earlier estimate/ }));
    expect(screen.getByText(/Earlier record total/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Convert to per-unit" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Warranty/ }));
    expect(screen.getByLabelText(/Provider/)).toHaveValue("Stanley");
    expect(screen.getByLabelText(/Warranty document/)).toHaveValue("warranty-doc-1");
  });

  it("stacks collapsed optional sections and offers package/per-unit pricing for a pack", async () => {
    renderForm(packItem);
    const sections = screen.getByTestId("optional-form-sections");
    const sectionButtons = within(sections).getAllByRole("button");
    expect(sectionButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Identity & organisation"),
      expect.stringContaining("Purchase"),
      expect.stringContaining("Earlier estimate"),
      expect.stringContaining("Warranty"),
    ]);
    for (const button of sectionButtons) {
      expect(button).toHaveAttribute("aria-expanded", "false");
    }

    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    expect(screen.getByRole("group", { name: "Purchase price basis" })).toBeVisible();
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(100);
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "$100 package total",
    );
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "$50 per unit",
    );

    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));
    const unitPrice = screen.getByLabelText(/price per unit/i);
    expect(unitPrice).toHaveValue(50);
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "2 units × $50 = $100",
    );

    await userEvent.clear(unitPrice);
    await userEvent.type(unitPrice, "60");
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "$120 package total",
    );
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "$60 per unit",
    );

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(payload).toMatchObject({
      quantity: 2,
      purchase: {
        price_cents: 12000,
      },
    });
  });

  it("preserves a non-divisible package total while inspecting its derived unit price", async () => {
    renderForm(makePackItem(3, 10000));
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));

    expect(screen.getByLabelText(/price per unit/i)).toHaveValue(33.33);
    const preview = screen.getByTestId("purchase-price-preview");
    expect(preview).toHaveTextContent("$100 package total");
    expect(preview).toHaveTextContent("≈ $33.33 per unit for 3 units.");
    expect(preview).not.toHaveTextContent("3 units ×");

    await userEvent.click(screen.getByRole("button", { name: "Total paid for package" }));
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(100);
    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));
    expect(screen.getByLabelText(/price per unit/i)).toHaveValue(33.33);

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(payload).toMatchObject({
      quantity: 3,
      purchase: { price_cents: 10000 },
    });
  });

  it("does not round a one-dollar total to zero across one thousand derived units", async () => {
    renderForm(makePackItem(1000, 100));
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));

    expect(screen.getByLabelText(/price per unit/i)).toHaveValue(0);
    const preview = screen.getByTestId("purchase-price-preview");
    expect(preview).toHaveTextContent("$1 package total");
    expect(preview).toHaveTextContent("≈ $0 per unit for 1000 units.");
    expect(preview).not.toHaveTextContent("1000 units ×");

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(payload).toMatchObject({
      quantity: 1000,
      purchase: { price_cents: 100 },
    });
  });

  it("restores the canonical total after a derived-unit quantity goes two to one to two", async () => {
    renderForm(packItem);
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));
    expect(screen.getByLabelText(/price per unit/i)).toHaveValue(50);

    const quantity = screen.getByLabelText("Quantity");
    await userEvent.tripleClick(quantity);
    await userEvent.keyboard("1");
    expect(
      screen.queryByRole("group", { name: "Purchase price basis" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(100);

    await userEvent.tripleClick(quantity);
    await userEvent.keyboard("2");
    expect(screen.getByRole("button", { name: "Total paid for package" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(100);

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(payload).toMatchObject({
      quantity: 2,
      purchase: { price_cents: 10000 },
    });
  });

  it("uses an explicitly edited unit price and the current quantity for the total", async () => {
    renderForm(packItem);
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    await userEvent.click(screen.getByRole("button", { name: "Price per unit" }));

    const unitPrice = screen.getByLabelText(/price per unit/i);
    await userEvent.clear(unitPrice);
    await userEvent.type(unitPrice, "60");
    const quantity = screen.getByLabelText("Quantity");
    await userEvent.tripleClick(quantity);
    await userEvent.keyboard("3");
    expect(screen.getByTestId("purchase-price-preview")).toHaveTextContent(
      "3 units × $60 = $180",
    );

    await userEvent.click(screen.getByRole("button", { name: "Total paid for package" }));
    expect(screen.getByLabelText(/purchase total/i)).toHaveValue(180);

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(payload).toMatchObject({
      quantity: 3,
      purchase: { price_cents: 18000 },
    });
  });

  it("keeps shared purchases total-only", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: /^Purchase/ }));
    expect(
      screen.queryByRole("group", { name: "Purchase price basis" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/shared purchase total/i)).toHaveValue(100);
    const preview = screen.getByTestId("purchase-price-preview");
    expect(preview).toHaveTextContent("$100 transaction total");
    expect(preview).not.toHaveTextContent("package total");
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
