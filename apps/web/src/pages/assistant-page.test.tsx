import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import { api } from "@/lib/api";
import { SearchSessionProvider } from "@/lib/search-session";
import type {
  AiStatus,
  ItemSummary,
  SearchQueryResponse,
} from "@/lib/types";
import { AssistantPage } from "@/pages/assistant-page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const aiStatus: AiStatus = {
  provider: "ollama",
  mode: "local",
  source: "database",
  task: "assistant",
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

const firstAnswer: SearchQueryResponse = {
  query: "where is my heavy drill",
  mode: "direct",
  ai_used: false,
  ai_attempted: false,
  direct_match: true,
  ambiguous: false,
  needs_clarification: false,
  answer:
    "Alex has 1 of your 2 units of Makita Heavy drill. Due 15 Nov 2026. The other 1 is at home in Workshop → BOX-006 · Power tools.",
  answer_kind: "locate_item",
  interpretation: "item: heavy drill",
  filters: {
    q: "heavy drill",
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
  quick_results: [],
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
    {
      type: "loan",
      id: "loan-1",
      title: "Heavy drill loan to Alex",
      subtitle: "1 on loan",
      url: "/loans/loan-1",
    },
  ],
  notices: [],
  facts: { total: 1 },
  tool: "locate_item",
  ai_status: aiStatus,
  context: {
    scope_key: "|",
    last_query: "where is my heavy drill",
    resolved_items: [{ id: "item-drill", name: "Heavy drill" }],
    candidate_items: [{ id: "item-drill", name: "Heavy drill" }],
    loans: [
      {
        id: "loan-1",
        item_id: "item-drill",
        item_name: "Heavy drill",
        borrower_name: "Alex",
      },
    ],
  },
  scope_label: "All my places",
  households: [],
  property: null,
};

const secondAnswer: SearchQueryResponse = {
  ...firstAnswer,
  query: "when is it due?",
  answer: "That loan is recorded as due on 2026-11-15.",
  mode: "ai",
  ai_used: true,
  ai_attempted: true,
  tool: "locate_item",
};

const sessionState = {
  authenticated: true,
  setup_required: false,
  user: {
    id: "user-1",
    name: "Owner",
    email: "owner@example.com",
    created_at: "2026-01-01T00:00:00Z",
  },
  household: {
    id: "house-1",
    name: "Home",
    warranty_reminder_days: 30,
  },
  role: "owner",
  households: [],
};

function renderPage(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SearchSessionProvider>
          <AddItemsProvider>
            <AssistantPage />
          </AddItemsProvider>
        </SearchSessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.startsWith("/search/scopes")) return { items: [] };
    if (path.startsWith("/auth/session")) return sessionState;
    return aiStatus;
  });
  vi.mocked(api.post)
    .mockResolvedValueOnce(firstAnswer)
    .mockResolvedValueOnce(secondAnswer);
});

describe("AssistantPage", () => {
  it("answers a handed-off question through the shared submit endpoint", async () => {
    renderPage(
      `/assistant?q=${encodeURIComponent("where is my heavy drill")}`,
    );
    expect(
      await screen.findByText(/Alex has 1 of your 2 units/),
    ).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(
      "/search/query",
      expect.objectContaining({
        query: "where is my heavy drill",
        explicit_ask: true,
        history: [],
        limit: 40,
      }),
    );
    expect(screen.getByText("Privacy & model details")).toBeVisible();
    expect(screen.getByText("Direct lookup")).toBeVisible();
    expect(screen.getByText("Heavy drill loan to Alex")).toBeVisible();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("continues the conversation with bounded prior turns and context", async () => {
    renderPage(
      `/assistant?q=${encodeURIComponent("where is my heavy drill")}`,
    );
    await screen.findByText(/Alex has 1 of your 2 units/);
    const input = screen.getByRole("textbox", {
      name: "Ask the Housetory assistant",
    });
    await userEvent.type(input, "when is it due?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    const secondCall = vi.mocked(api.post).mock.calls[1] as [
      string,
      {
        query: string;
        explicit_ask: boolean;
        history: Array<{ role: string; content: string }>;
        context?: { resolved_items: Array<{ id: string }> };
      },
    ];
    expect(secondCall[0]).toBe("/search/query");
    expect(secondCall[1].query).toBe("when is it due?");
    expect(secondCall[1].explicit_ask).toBe(true);
    expect(secondCall[1].history).toEqual([
      { role: "user", content: "where is my heavy drill" },
      {
        role: "assistant",
        content: firstAnswer.answer,
      },
    ]);
    expect(secondCall[1].context?.resolved_items[0]?.id).toBe("item-drill");
    expect(
      await screen.findByText("That loan is recorded as due on 2026-11-15."),
    ).toBeVisible();
    expect(screen.getByText("AI-assisted")).toBeVisible();
  });
});
