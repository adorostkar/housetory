import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  ItemList,
  ItemSummary,
  NaturalSearchResponse,
  QuickSearchResponse,
} from "@/lib/types";
import { SearchPage } from "@/pages/search-page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

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
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const itemList: ItemList = {
  items: [item],
  total: 1,
  limit: 30,
  offset: 0,
};

const quickResponse: QuickSearchResponse = {
  query: "PS5",
  effective_query: null,
  question_like: false,
  results: [],
};

const naturalResponse: NaturalSearchResponse = {
  question: "where is my heavy drill",
  interpretation: "item: heavy drill",
  filters: {
    q: "heavy drill",
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
  total: 1,
  mode: "deterministic",
  ai_available: false,
  answer:
    "Alex has 1 of your 2 units of Makita Heavy drill. Due 15 Nov 2026. The other 1 is at home in Workshop → BOX-006 · Power tools.",
  answer_kind: "locate_item",
  tool: "locate_item",
  facts: {
    total: 1,
    whereabouts: {
      item_id: "item-drill",
      on_loan_quantity: 1,
      at_home_quantity: 1,
    },
  },
  notices: [],
  references: [
    {
      type: "item",
      id: "item-drill",
      title: "Heavy drill",
      subtitle: "Workshop",
      url: "/items/item-drill",
    },
  ],
  needs_assistant: false,
  suggested_question: "where is my heavy drill",
};

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
    if (path.startsWith("/search/quick")) return quickResponse;
    if (path.startsWith("/search/items")) return itemList;
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockResolvedValue(naturalResponse);
});

describe("SearchPage unified entry", () => {
  it("shows ordinary keyword results without calling natural search", async () => {
    renderPage("/search?q=PS5");
    expect(
      await screen.findByRole("textbox", {
        name: "Search or ask about your inventory",
      }),
    ).toHaveValue("PS5");
    expect(await screen.findByText("Heavy drill")).toBeVisible();
    expect(screen.getByLabelText("Search scope")).toHaveValue("all");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("opens a grounded answer for a question URL and keeps assistant handoff context", async () => {
    renderPage(
      `/search?q=${encodeURIComponent("where is my heavy drill")}&ask=1`,
    );
    expect(
      await screen.findByText(/Alex has 1 of your 2 units/),
    ).toBeVisible();
    expect(screen.getByLabelText("Search scope")).toHaveValue("all");
    expect(screen.queryByText("Grounded answer")).not.toBeInTheDocument();
    expect(screen.queryByText(/item: heavy drill/)).not.toBeInTheDocument();
    expect(screen.getByText(/Due 15 Nov 2026/)).toBeVisible();
    expect(screen.getByText(/at home in Workshop/)).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(
      "/search/natural",
      { question: "where is my heavy drill", limit: 40 },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getAllByText("Heavy drill")[0]).toBeVisible();
    expect(screen.getByText("1 on loan")).toBeVisible();
    const assistantLink = screen.getByRole("link", {
      name: /Continue in Assistant/,
    });
    expect(assistantLink).toHaveAttribute(
      "href",
      `/assistant?q=${encodeURIComponent("where is my heavy drill")}`,
    );
  });

  it("asks explicitly for a keyword query and then returns to keyword results when edited", async () => {
    renderPage("/search?q=PS5");
    await screen.findByText("Heavy drill");
    const askButtons = screen.getAllByRole("button", { name: "Ask Housetory" });
    await userEvent.click(askButtons[askButtons.length - 1]!);
    expect(await screen.findByText(/Alex has 1 of your 2 units/)).toBeVisible();
    expect(api.post).toHaveBeenCalledTimes(1);

    const input = screen.getByRole("textbox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.clear(input);
    await userEvent.type(input, "PS5");
    await waitFor(() =>
      expect(screen.queryByText(/Alex has 1 of your 2 units/)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("ask=1");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
