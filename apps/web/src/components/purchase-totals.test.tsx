import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PurchaseTotals } from "@/components/purchase-totals";
import { WarrantyWatch } from "@/components/warranty-watch";
import type { FinancialOverview, Overview, Warranty } from "@/lib/types";

const warranties: Overview["warranties"] = {
  active: [],
  expiring_soon: [],
  expired: [],
  active_count: 3,
  expiring_count: 2,
  expired_count: 1,
  unknown_count: 0,
  reminder_days: 30,
};

const overview: Overview = {
  room_count: 1,
  location_count: 0,
  item_count: 4,
  total_quantity: 6,
  value_by_currency: [
    { currency: "USD", total_cents: 62400 },
    { currency: "EUR", total_cents: 87000 },
  ],
  current_value_by_currency: [],
  document_count: 0,
  warranties_expiring_soon: 2,
  warranties,
  items_missing_purchase_count: 0,
  photo_bytes: 0,
  document_bytes: 0,
  outstanding_loan_count: 0,
  overdue_loan_count: 0,
  on_loan_quantity: 0,
  recent_items: [],
};

const financial: FinancialOverview = {
  item_count: 4,
  items_with_purchase_count: 1,
  items_missing_purchase_count: 0,
  currency_totals: [
    {
      currency: "USD",
      purchase_total_cents: 62400,
      current_value_total_cents: 0,
      purchase_item_count: 1,
      current_value_item_count: 0,
      purchase_allocated_cents: 49900,
      purchase_unallocated_cents: 12500,
      purchase_unallocated_count: 2,
      purchase_over_allocated_cents: 0,
    },
  ],
  value_by_category: [
    { name: "Tools", currency: "USD", purchase_total_cents: 49900, current_value_total_cents: 0, item_count: 1 },
  ],
  value_by_room: [],
  most_valuable_items: [],
  missing_purchase_items: [],
  exchange_rates_configured: false,
  conversion_note: "",
};

const state = vi.hoisted<{ overview: unknown }>(() => ({ overview: null }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useOverview: () => ({ data: state.overview }) };
});

beforeEach(() => {
  localStorage.clear();
  state.overview = { ...overview, financial };
});

describe("PurchaseTotals", () => {
  it("is one line until opened, and stays as the user left it", async () => {
    const view = render(<MemoryRouter><PurchaseTotals /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: /^Totals/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("4 items · 1 room · $624 + €870 · 5 active warranties");
    expect(screen.queryByText("Purchases by category")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByText("Purchases by category")).toBeVisible();
    const card = screen.getByRole("link", { name: /Active warranties/ });
    expect(card).toHaveAttribute("href", "/warranties");
    expect(card).toHaveTextContent("2 expiring soon · 1 expired");
    const line = screen.getByTestId("unallocated-purchases");
    expect(line).toHaveTextContent("USD · 2 purchases");
    expect(line).toHaveTextContent("$125");

    view.unmount();
    render(<MemoryRouter><PurchaseTotals /></MemoryRouter>);
    expect(screen.getByRole("button", { name: /^Totals/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("hides every amount at once and remembers that", async () => {
    localStorage.setItem("housetory.totals", "open");
    const view = render(<MemoryRouter><PurchaseTotals /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Hide purchase values" }));
    expect(screen.queryAllByText(/\$|€/)).toHaveLength(0);
    expect(screen.getByTestId("unallocated-purchases")).not.toHaveTextContent("$125");
    view.unmount();

    render(<MemoryRouter><PurchaseTotals /></MemoryRouter>);
    expect(screen.queryAllByText(/\$|€/)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Show purchase values" })).toHaveAttribute(
      "aria-pressed", "true",
    );
  });

  it("shows nothing for an empty inventory", () => {
    state.overview = { ...overview, item_count: 0, financial };
    const { container } = render(<MemoryRouter><PurchaseTotals /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WarrantyWatch", () => {
  it("summarises the counts and opens to the three groups", async () => {
    const expiring = {
      id: "warranty-1",
      provider: "Makita",
      end_date: "2026-12-10",
      status: "expiring",
      days_remaining: 14,
      item: { id: "item-1", name: "Heavy drill" },
    } as unknown as Warranty;
    state.overview = { ...overview, warranties: { ...warranties, expiring_soon: [expiring] } };
    render(<MemoryRouter><WarrantyWatch /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: /^Warranty watch/ });
    expect(toggle).toHaveTextContent("2 expiring soon · 3 active · 1 expired");
    expect(screen.queryByText("Heavy drill")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByRole("link", { name: /Heavy drill/ })).toHaveAttribute("href", "/items/item-1");
    expect(screen.getAllByRole("link", { name: "View all" })[0]).toHaveAttribute(
      "href", "/warranties?status=expiring",
    );
  });
});
