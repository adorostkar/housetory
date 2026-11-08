import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemValuationDialog } from "@/components/item-valuation-dialog";
import { api } from "@/lib/api";
import type {
  ItemDetail,
  ItemDetailResponse,
  ItemValuationPreview,
} from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
    },
  };
});

const item: ItemDetail = {
  id: "item-1",
  name: "Cordless drill",
  description: "Two batteries and a charger.",
  brand: "DeWalt",
  model: "DCD791",
  quantity: 2,
  condition: "good",
  is_archived: false,
  room: null,
  location: null,
  location_path: [],
  category: null,
  tags: [],
  primary_photo: null,
  purchase: null,
  purchase_info_status: "recorded",
  purchase_info_missing_fields: [],
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  current_value_basis: null,
  current_value_total_cents: null,
  current_value_estimated_at: null,
  current_value_estimate: null,
  valuation_fingerprint: "a".repeat(64),
  serial_number: null,
  photos: [],
  documents: [],
  import_source: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const preview: ItemValuationPreview = {
  estimate_id: "estimate-1",
  item_id: item.id,
  item_name: item.name,
  fingerprint: item.valuation_fingerprint!,
  purpose: "resale",
  source: "ai_web",
  currency: "USD",
  low_cents: 3500,
  suggested_cents: 4000,
  high_cents: 5000,
  owned_quantity: 2,
  low_total_cents: 7000,
  suggested_total_cents: 8000,
  high_total_cents: 10000,
  as_of: "2026-11-08",
  confidence: "medium",
  reasoning: "Comparable used drills support this range.",
  assumptions: ["Both batteries are included."],
  web_used: true,
  web_reason: null,
  web_query: "DeWalt DCD791 good used resale asking price",
  sources: [
    {
      title: "Used drill listing",
      url: "https://example.com/drill",
      snippet: "Asking USD 45.00",
      price_text: "USD 45.00",
      price_cents: 4500,
      currency: "USD",
      currency_inferred: false,
      price_kind: "asking",
      retrieved_on: "2026-11-08",
    },
  ],
  existing_value_cents: null,
  existing_value_basis: null,
  existing_value_currency: "USD",
  disclaimer:
    "Estimate only — not a professional appraisal, guaranteed resale price or guaranteed insurer payout.",
};

const appliedResponse = {
  item: {
    ...item,
    current_value_cents: 4000,
    current_value_basis: "per_unit",
    current_value_total_cents: 8000,
    current_value_estimated_at: "2026-11-08T12:00:00Z",
  },
} satisfies ItemDetailResponse;

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ItemValuationDialog
        open
        onOpenChange={onOpenChange}
        item={item}
      />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
});

describe("ItemValuationDialog", () => {
  it("saves a reviewed manual per-unit value without requesting AI", async () => {
    vi.mocked(api.post).mockResolvedValue(appliedResponse);
    renderDialog();
    const amount = screen.getByLabelText("Per-unit value");
    await userEvent.clear(amount);
    await userEvent.type(amount, "40");
    expect(screen.getByTestId("valuation-save-total")).toHaveTextContent(
      "$80 owned total",
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply value" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]).toEqual([
      "/items/item-1/valuation/apply",
      {
        estimate_id: null,
        purpose: "resale",
        amount_cents: 4000,
        currency: "USD",
        expected_fingerprint: item.valuation_fingerprint,
      },
    ]);
  });

  it("previews AI/web evidence and applies the reviewed amount", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(appliedResponse);
    renderDialog();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Try online comparisons/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Get AI estimate" }),
    );
    const previewPanel = await screen.findByTestId("valuation-preview");
    expect(previewPanel).toBeVisible();
    expect(previewPanel).toHaveTextContent("Range $35 – $50 per unit");
    expect(previewPanel).toHaveTextContent("2 owned units");
    expect(previewPanel).toHaveTextContent("$80 owned total");
    expect(screen.getByRole("link", { name: /Used drill listing/ })).toHaveAttribute(
      "href",
      "https://example.com/drill",
    );
    expect(previewPanel).toHaveTextContent("asking/listed price");
    expect(previewPanel).toHaveTextContent("Medium confidence");
    expect(previewPanel).toHaveTextContent("not a professional appraisal");

    await userEvent.click(screen.getByRole("button", { name: "Apply value" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[0]).toEqual([
      "/items/item-1/valuation/estimate",
      { purpose: "resale", currency: "USD", include_web: true },
    ]);
    expect(vi.mocked(api.post).mock.calls[1]).toEqual([
      "/items/item-1/valuation/apply",
      {
        estimate_id: "estimate-1",
        purpose: "resale",
        amount_cents: 4000,
        currency: "USD",
        expected_fingerprint: item.valuation_fingerprint,
      },
    ]);
  });

  it("clears an AI preview when purpose changes and saves any new amount manually", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(appliedResponse);
    renderDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Get AI estimate" }),
    );
    expect(await screen.findByTestId("valuation-preview")).toBeVisible();
    await userEvent.click(
      screen.getByRole("radio", { name: /Replacement value/ }),
    );
    expect(screen.queryByTestId("valuation-preview")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Per-unit value"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Apply value" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(api.post).mock.calls[1]?.[1] as Record<string, unknown>,
    ).toMatchObject({
      estimate_id: null,
      purpose: "replacement",
      amount_cents: 6000,
    });
  });

  it("keeps manual entry available after an AI failure", async () => {
    vi.mocked(api.post)
      .mockRejectedValueOnce(new Error("No Assistant provider is configured."))
      .mockResolvedValueOnce(appliedResponse);
    renderDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Get AI estimate" }),
    );
    expect(await screen.findByText("AI estimate unavailable")).toBeVisible();
    expect(screen.getByText(/No Assistant provider is configured/)).toBeVisible();
    await userEvent.type(screen.getByLabelText("Per-unit value"), "25");
    await userEvent.click(screen.getByRole("button", { name: "Apply value" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(api.post).mock.calls[1]?.[1] as Record<string, unknown>,
    ).toMatchObject({
      estimate_id: null,
      amount_cents: 2500,
    });
  });

  it("cancels without saving or writing", async () => {
    const onOpenChange = renderDialog();
    await userEvent.type(screen.getByLabelText("Per-unit value"), "40");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.post).not.toHaveBeenCalled();
  });
});
