import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import type {
  FinancialOverview,
  ItemSummary,
  Overview,
  SessionState,
} from "@/lib/types";
import { OverviewPage } from "@/pages/overview-page";

const item: ItemSummary = {
  id: "item-drill",
  name: "Heavy drill",
  description: null,
  brand: "Makita",
  model: "HP-2",
  quantity: 2,
  on_loan_quantity: 1,
  condition: "good",
  is_archived: false,
  room: { id: "room-1", name: "Workshop" },
  location: null,
  location_path: [],
  category: null,
  tags: [],
  primary_photo: null,
  purchase: null,
  purchase_info_status: "unrecorded",
  purchase_info_missing_fields: [],
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  current_value_basis: null,
  current_value_total_cents: null,
  current_value_estimated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const sessionState: SessionState = {
  authenticated: true,
  setup_required: false,
  role: "owner",
  user: {
    id: "user-1",
    name: "Phase Five Owner",
    email: "owner@example.com",
    created_at: "2026-01-01T00:00:00Z",
  },
  household: {
    id: "household-1",
    name: "Housetory Phase Five",
    default_currency: "USD",
    warranty_reminder_days: 30,
  },
};

const sparseOverview: Overview = {
  room_count: 1,
  location_count: 0,
  item_count: 1,
  total_quantity: 2,
  value_by_currency: [],
  current_value_by_currency: [],
  document_count: 0,
  warranties_expiring_soon: 0,
  warranties: {
    active: [],
    expiring_soon: [],
    expired: [],
    active_count: 0,
    expiring_count: 0,
    expired_count: 0,
    unknown_count: 0,
    reminder_days: 30,
  },
  items_missing_purchase_count: 1,
  photo_bytes: 0,
  document_bytes: 0,
  outstanding_loan_count: 1,
  overdue_loan_count: 0,
  on_loan_quantity: 1,
  recent_items: [{ ...item, location: null }],
};

const sparseFinancial: FinancialOverview = {
  item_count: 1,
  items_with_purchase_count: 0,
  items_missing_purchase_count: 1,
  currency_totals: [],
  value_by_category: [],
  value_by_room: [],
  most_valuable_items: [],
  missing_purchase_items: [item],
  exchange_rates_configured: false,
  conversion_note: "",
};

const populatedOverview: Overview = {
  ...sparseOverview,
  value_by_currency: [{ currency: "USD", total_cents: 49900 }],
  current_value_by_currency: [{ currency: "USD", total_cents: 30000 }],
  warranties: {
    active: [],
    expiring_soon: [],
    expired: [],
    active_count: 1,
    expiring_count: 0,
    expired_count: 0,
    unknown_count: 0,
    reminder_days: 30,
  },
};

const populatedFinancial: FinancialOverview = {
  ...sparseFinancial,
  items_with_purchase_count: 1,
  items_missing_purchase_count: 0,
  currency_totals: [
    {
      currency: "USD",
      purchase_total_cents: 49900,
      current_value_total_cents: 30000,
      purchase_item_count: 1,
      current_value_item_count: 1,
    },
  ],
  value_by_category: [
    {
      name: "Tools",
      currency: "USD",
      purchase_total_cents: 49900,
      current_value_total_cents: 30000,
      item_count: 1,
    },
  ],
  value_by_room: [
    {
      name: "Workshop",
      currency: "USD",
      purchase_total_cents: 49900,
      current_value_total_cents: 30000,
      item_count: 1,
    },
  ],
  missing_purchase_items: [],
};

const state = vi.hoisted<{
  overview: Overview | null;
  financial: FinancialOverview | null;
}>(() => ({
  overview: null,
  financial: null,
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: sessionState }),
    useCanWrite: () => true,
    useOverview: () => ({
      data: { ...state.overview, financial: state.financial },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRooms: () => ({ data: { items: [] } }),
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddItemsProvider>
          <OverviewPage />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.overview = sparseOverview;
  state.financial = sparseFinancial;
});

describe("OverviewPage sparse and populated states", () => {
  it("keeps all secondary actions available through the mobile menu", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Home actions" }));
    expect(screen.getByRole("menuitem", { name: "Create insurance list" })).toHaveAttribute("href", "/insurance");
    expect(screen.getByRole("menuitem", { name: "Export evidence" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "New room" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("keeps sparse value and warranty panels compact while surfacing loans and rooms", () => {
    renderPage();
    expect(screen.getByText("1 unit")).toBeVisible();
    expect(screen.getByText(/on loan across/)).toBeVisible();
    expect(screen.getByText("No purchase values yet.")).toBeVisible();
    expect(screen.getByText(/No warranties recorded/)).toBeVisible();
    expect(screen.queryByText("Expiring soon")).not.toBeInTheDocument();
    expect(screen.queryByText("Purchase value")).not.toBeInTheDocument();
    expect(screen.queryByText("Current value")).not.toBeInTheDocument();
    expect(screen.getByText("Recently added")).toBeVisible();
  });

  it("restores value cards and warranty groups when useful data exists", () => {
    state.overview = populatedOverview;
    state.financial = populatedFinancial;
    renderPage();
    expect(screen.getByText("Purchase value")).toBeVisible();
    expect(screen.queryByText("Current value")).not.toBeInTheDocument();
    expect(screen.getByText("Purchases by category")).toBeVisible();
    expect(screen.getByText("Expiring soon")).toBeVisible();
    expect(screen.getByText("Missing purchase info")).toBeVisible();
  });
});
