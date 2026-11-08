import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  AiStatus,
  BorrowedRecord,
  ItemSummary,
  SearchQueryResponse,
} from "@/lib/types";
import { SearchPage } from "@/pages/search-page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

const aiStatus: AiStatus = {
  provider: "ollama",
  mode: "local",
  source: "database",
  task: "search",
  provider_id: null,
  provider_label: "Local Ollama",
  capabilities: ["text", "structured"],
  model: "local-model",
  configured: true,
  available: true,
  catalog_checked: true,
  catalog_count: 1,
  cloud_enabled: false,
  cloud_consent: false,
  data_leaves_server: false,
  error: null,
  privacy_note: "Local inference is used. Household content stays on this host.",
};

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
  location: {
    id: "box-1",
    name: "Power tools",
    kind: "box",
    parent_id: null,
    identifier: "BOX-006",
    container_type: "box",
    is_container: true,
  },
  location_path: [
    {
      id: "box-1",
      name: "Power tools",
      kind: "box",
      parent_id: null,
      identifier: "BOX-006",
      container_type: "box",
      is_container: true,
    },
  ],
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

const borrowedRecord: BorrowedRecord = {
  id: "borrowed-1",
  direction: "borrowed",
  item_name: "Cable crimper",
  brand: "Knipex",
  model: null,
  owner_name: "Ali",
  quantity: 2,
  returned_quantity: 0,
  outstanding_quantity: 2,
  physically_held_quantity: 2,
  status: "outstanding",
  borrowed_on: "2026-01-01",
  due_on: "2026-01-10",
  notes: null,
  overdue: false,
  days_past_due: null,
  latest_returned_on: null,
  property_id: null,
  property_name: null,
  room_id: "room-1",
  room_name: "Workshop",
  storage_location_id: null,
  storage_location_name: null,
  storage_location_identifier: null,
  photo: null,
  created_by_user_id: null,
  created_by_name: null,
  cancelled_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function searchResponse(
  overrides: Partial<SearchQueryResponse> = {},
): SearchQueryResponse {
  return {
    query: "PS5",
    mode: "direct",
    ai_used: false,
    ai_attempted: false,
    direct_match: true,
    ambiguous: false,
    needs_clarification: false,
    answer: null,
    answer_kind: "direct_lookup",
    interpretation: "direct inventory match: PS5",
    filters: {
      q: "PS5",
      household_id: null,
      property_id: null,
      room_id: null,
      room_name: null,
      exclude_room_id: null,
      location_id: null,
      location_name: null,
      category_id: null,
      category_name: null,
      tag: null,
      missing_purchase: false,
      missing_purchase_date: false,
      missing_purchase_price: false,
      purchase_info_status: null,
      missing_serial: false,
      warranty_status: null,
      purchased_after: null,
      purchased_before: null,
      min_purchase_cents: null,
      max_purchase_cents: null,
      sort: "relevance",
    },
    items: [item],
    quick_results: [
      {
        id: "item-drill",
        kind: "item",
        title: "Heavy drill",
        subtitle: "Makita · HP-2",
        context: "Home · Workshop · BOX-006 · Power tools",
        url: "/items/item-drill",
        loan: {
          on_loan_quantity: 1,
          borrower_names: ["Alex"],
          next_due_on: "2026-11-15",
        },
      },
    ],
    borrowed: [],
    borrowed_total: 0,
    total: 1,
    documents: [],
    locations: [],
    references: [
      {
        type: "item",
        id: "item-drill",
        title: "Heavy drill",
        subtitle: "Workshop",
        url: "/items/item-drill",
      },
    ],
    notices: [],
    facts: { total: 1 },
    tool: "direct_lookup",
    ai_status: aiStatus,
    context: {
      scope_key: "|",
      last_query: "PS5",
      resolved_items: [{ id: "item-drill", name: "Heavy drill" }],
      candidate_items: [{ id: "item-drill", name: "Heavy drill" }],
      loans: [],
    },
    scope_label: "All my places",
    households: [],
    property: null,
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function renderPage(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SearchPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.startsWith("/search/scopes")) return { items: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockResolvedValue(searchResponse());
});

describe("SearchPage unified entry", () => {
  it("shows direct inventory results from the shared submit endpoint", async () => {
    renderPage("/search?q=PS5");
    expect((await screen.findAllByText("Heavy drill"))[0]).toBeVisible();
    expect(screen.getByText("Direct inventory lookup")).toBeVisible();
    expect(screen.getByLabelText("Search scope")).toHaveValue("all");
    expect(api.post).toHaveBeenCalledWith(
      "/search/query",
      expect.objectContaining({
        query: "PS5",
        explicit_ask: false,
        history: [],
        limit: 40,
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("opens a grounded multilingual answer and does not require an assistant handoff", async () => {
    vi.mocked(api.post).mockResolvedValue(
      searchResponse({
        query: "دریل من کجاست؟",
        mode: "ai",
        ai_used: true,
        ai_attempted: true,
        answer:
          "دریل شما دست الکس است و در کارگاه نگهداری می‌شود.",
        interpretation: "item: heavy drill",
        facts: { total: 1, whereabouts: { item_id: "item-drill" } },
      }),
    );
    renderPage(
      `/search?q=${encodeURIComponent("دریل من کجاست؟")}&ask=1&r=1`,
    );
    expect(
      await screen.findByText(/دریل شما دست الکس است/),
    ).toBeVisible();
    expect(screen.getByText("AI-assisted answer")).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(
      "/search/query",
      expect.objectContaining({
        query: "دریل من کجاست؟",
        explicit_ask: true,
      }),
      expect.anything(),
    );
    expect(
      screen.queryByRole("link", { name: /Continue in Assistant/ }),
    ).not.toBeInTheDocument();
  });

  it("turns an example into the same submit flow without requiring Ask", async () => {
    renderPage("/search");
    const example = "Which items have no purchase information?";
    await userEvent.click(screen.getByRole("button", { name: example }));
    const params = () =>
      new URLSearchParams(
        (screen.getByTestId("location").textContent ?? "").split("?")[1] ?? "",
      );
    await waitFor(() => expect(params().get("q")).toBe(example));
    expect(params().get("ask")).toBeNull();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/search/query",
        expect.objectContaining({ query: example, explicit_ask: false }),
        expect.anything(),
      ),
    );
  });

  it("resets conversation and query with New search", async () => {
    renderPage("/search?q=PS5&r=1");
    await screen.findAllByText("Heavy drill");
    await userEvent.click(screen.getByRole("button", { name: "New search" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/search$/),
    );
    expect(screen.getByText("Search or ask in one box")).toBeVisible();
  });

  it("reports exact totals and separates borrowed records", async () => {
    vi.mocked(api.post).mockResolvedValue(
      searchResponse({
        query: "Cable",
        items: [item],
        total: 51,
        borrowed: [borrowedRecord],
        borrowed_total: 2,
      }),
    );
    renderPage("/search?q=Cable");
    expect(await screen.findByText("51 matching items")).toBeVisible();
    expect(screen.getByText("Borrowed from other owners")).toBeVisible();
    expect(screen.getByText(/belongs to Ali/)).toBeVisible();
    expect(screen.getByText("Cable crimper")).toBeVisible();
    expect(screen.getByText(/Showing the first 1 of 51/)).toBeVisible();
  });

  it("labels an AI-unavailable fallback honestly while keeping direct results", async () => {
    vi.mocked(api.post).mockResolvedValue(
      searchResponse({
        query: "دریل من کجاست؟",
        mode: "fallback",
        ai_used: false,
        ai_attempted: false,
        answer:
          "No direct inventory record matched, and no configured AI provider was available to interpret the question. This is not a conclusive no-result answer.",
        notices: [
          "No configured AI provider is available for this scope, so this question could not be interpreted beyond direct inventory matching.",
        ],
      }),
    );
    renderPage(`/search?q=${encodeURIComponent("دریل من کجاست؟")}`);
    expect(
      await screen.findByText("AI unavailable · direct results only"),
    ).toBeVisible();
    expect(
      screen.getByText(/not a conclusive no-result answer/),
    ).toBeVisible();
    expect(screen.getByText(/No configured AI provider/)).toBeVisible();
  });
});
