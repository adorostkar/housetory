import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import { api } from "@/lib/api";
import type { AiStatus, AssistantResponse, ItemSummary } from "@/lib/types";
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
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const firstAnswer: AssistantResponse = {
  answer:
    "Alex has 1 of your 2 units of Makita Heavy drill. Due 15 Nov 2026. The other 1 is at home in Workshop → BOX-006 · Power tools.",
  mode: "deterministic",
  tool: "locate_item",
  filters: { q: "heavy drill" },
  items: [item],
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
  ai_status: aiStatus,
};

const secondAnswer: AssistantResponse = {
  ...firstAnswer,
  answer: "That loan is recorded as due on 2026-11-15.",
  tool: "list_outstanding_loans",
};

function renderPage(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AddItemsProvider>
          <AssistantPage />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockResolvedValue(aiStatus);
  vi.mocked(api.post)
    .mockResolvedValueOnce(firstAnswer)
    .mockResolvedValueOnce(secondAnswer);
});

describe("AssistantPage", () => {
  it("answers a handed-off whereabouts question and keeps privacy details secondary", async () => {
    renderPage(
      `/assistant?q=${encodeURIComponent("where is my heavy drill")}`,
    );
    expect(
      await screen.findByText(/Alex has 1 of your 2 units/),
    ).toBeVisible();
    expect(api.post).toHaveBeenCalledWith("/assistant/query", {
      question: "where is my heavy drill",
      history: [],
    });
    expect(screen.getByText("Privacy & model details")).toBeVisible();
    expect(screen.getByText("Local AI")).toBeVisible();
    expect(screen.queryByText("Grounded answer")).not.toBeInTheDocument();
    expect(screen.getByText("Heavy drill loan to Alex")).toBeVisible();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("continues the conversation with prior messages as history", async () => {
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
      { question: string; history: Array<{ role: string; content: string }> },
    ];
    expect(secondCall[0]).toBe("/assistant/query");
    expect(secondCall[1].question).toBe("when is it due?");
    expect(secondCall[1].history).toEqual([
      { role: "user", content: "where is my heavy drill" },
      {
        role: "assistant",
        content: firstAnswer.answer,
      },
    ]);
    expect(
      await screen.findByText("That loan is recorded as due on 2026-11-15."),
    ).toBeVisible();
  });
});
