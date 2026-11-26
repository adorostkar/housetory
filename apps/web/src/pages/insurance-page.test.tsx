import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InsurancePage } from "@/pages/insurance-page";
import { api } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useDefaultCurrency: () => "EUR",
    useProperties: () => ({ data: { items: [] } }),
    useRooms: () => ({ data: { items: [] } }),
    useLocations: () => ({ data: { items: [] } }),
  };
});

const scopeItem = {
  item_id: "item-1",
  name: "Camera",
  description: "Mirrorless camera with charger",
  brand: "Fujifilm",
  model: "X-T4",
  serial_number: "SN-1",
  quantity: 2,
  condition: "good",
  is_archived: false,
  valuation_fingerprint: "a".repeat(64),
  ai_eligible: true,
  ai_ineligible_reason: null,
};

const estimate = {
  estimate_id: "estimate-1",
  item_id: "item-1",
  item_name: "Camera",
  fingerprint: "a".repeat(64),
  purpose: "replacement",
  source: "ai",
  currency: "EUR",
  low_cents: 3500,
  suggested_cents: 4500,
  high_cents: 5500,
  owned_quantity: 2,
  low_total_cents: 7000,
  suggested_total_cents: 9000,
  high_total_cents: 11000,
  as_of: "2026-11-09",
  confidence: "medium",
  reasoning: "Comparable replacements support this range.",
  assumptions: [],
  web_used: false,
  web_reason: null,
  web_query: null,
  sources: [],
  existing_value_cents: null,
  existing_value_basis: null,
  existing_value_currency: null,
  disclaimer: "Estimate only",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/insurance?item_ids=item-1"]}>
        <InsurancePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/insurance-valuations/scope-preview") {
      return { items: [scopeItem], scope_label: "1 selected item", archived_excluded_count: 0, max_items: 500 };
    }
    if (path === "/insurance-valuations/batches") {
      return {
        request_id: "batch-1",
        status: "running",
        total: 1,
        processed: 0,
        estimated: 0,
        failed: 0,
        items: [{ item_id: "item-1", status: "running", estimate: null, error: null }],
      };
    }
    if (path === "/insurance-lists") {
      return {
        id: "list-1",
        status: "succeeded",
        error: null,
        pdf_url: "/api/v1/insurance-lists/list-1/pdf",
        csv_url: "/api/v1/insurance-lists/list-1/csv",
      };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/insurance-valuations/batches/batch-1") {
      return {
        request_id: "batch-1",
        status: "completed",
        total: 1,
        processed: 1,
        estimated: 1,
        failed: 0,
        items: [{ item_id: "item-1", status: "estimated", estimate, error: null }],
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
});

describe("InsurancePage", () => {
  it("fills an editable AI estimate and exports reviewed values without applying them", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Estimate 1 with AI" }),
    );
    const amount = await screen.findByDisplayValue("45.00");
    await userEvent.clear(amount);
    await userEvent.type(amount, "50");
    // The per-unit value and the total for the owned quantity stay apart.
    expect(screen.getByText("€100")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continue to export" }));
    const exportStep = screen.getByRole("region", { name: "Export" });
    expect(within(exportStep).getByText("1 (2 owned units)")).toBeVisible();
    expect(within(exportStep).getByText("Value per unit × owned quantity")).toBeVisible();
    expect(within(exportStep).getByText("€100")).toBeVisible();
    expect(within(exportStep).getByText("Every included item has a value.", { exact: false })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Generate insurance list" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/insurance-lists", expect.anything()));
    const payload = vi.mocked(api.post).mock.calls.find(([path]) => path === "/insurance-lists")![1] as any;
    expect(payload.values).toEqual([
      {
        item_id: "item-1",
        estimate_id: "estimate-1",
        expected_fingerprint: "a".repeat(64),
        amount_cents: 5000,
      },
    ]);
    expect(payload.currency).toBe("EUR");
    expect(api.post).not.toHaveBeenCalledWith(
      "/items/item-1/valuation/apply",
      expect.anything(),
    );
    expect(await screen.findByRole("link", { name: "Download PDF" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Download CSV" })).toBeVisible();
  });

  it("keeps unknown values out of the override list and accepts an explicit zero", async () => {
    renderPage();
    const amount = await screen.findByLabelText("Replacement value for Camera");
    expect(amount).toHaveValue(null);
    await userEvent.type(amount, "0");
    await userEvent.click(screen.getByRole("button", { name: "Continue to export" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate insurance list" }));
    const payload = vi.mocked(api.post).mock.calls.find(([path]) => path === "/insurance-lists")![1] as any;
    expect(payload.values[0]).toMatchObject({ amount_cents: 0, estimate_id: null });
  });

  it("walks Scope, Review and Export in order and says what is unknown before exporting", async () => {
    renderPage();
    // A deep link loads its items, so the page opens on Review with the scope on one line.
    const review = await screen.findByRole("button", { name: /Review$/ });
    expect(review).toHaveAttribute("aria-current", "step");
    expect(screen.queryByLabelText("Insurance scope")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scope" })).toHaveTextContent("1 selected item · 1 item · EUR");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 item included · 0 valued · 1 unknown");

    await userEvent.click(screen.getByRole("button", { name: "Continue to export" }));
    const exportStep = screen.getByRole("region", { name: "Export" });
    expect(screen.getByRole("button", { name: /Export$/ })).toHaveAttribute("aria-current", "step");
    expect(exportStep).toHaveTextContent("Value unknown1");
    expect(exportStep).toHaveTextContent("Total in EUR");
    expect(exportStep).toHaveTextContent(
      "1 item with no value is listed as unknown and is not in the total.",
    );
    expect(api.post).not.toHaveBeenCalledWith("/insurance-lists", expect.anything());

    await userEvent.click(screen.getByRole("button", { name: "Back to review" }));
    expect(screen.getByLabelText("Replacement value for Camera")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Change scope" }));
    expect(screen.getByLabelText("Insurance scope")).toHaveValue("items");
    // The loaded review is kept until the scope itself is changed.
    await userEvent.selectOptions(screen.getByLabelText("Insurance scope"), "household");
    expect(screen.getByRole("button", { name: /Review$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Export$/ })).toBeDisabled();
  });

  it("offers the household evidence export here", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "Export evidence" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "evidence export" })).not.toBeInTheDocument();
  });
});
