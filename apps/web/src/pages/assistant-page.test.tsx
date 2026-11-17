import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddItemsProvider } from "@/components/add-items";
import { api, ApiError } from "@/lib/api";
import { createToolRun } from "@/lib/assistant-tools";
import { SearchSessionProvider, useSearchSession } from "@/lib/search-session";
import { AssistantConversationProvider } from "@/lib/assistant-conversation";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import type { AiStatus, ItemSummary, SearchQueryResponse } from "@/lib/types";
import { AssistantPage } from "@/pages/assistant-page";
import { toast } from "sonner";

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/queries")>(),
  useCaptureReviews: () => ({ data: [], isError: false }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      postForm: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock("@/lib/assistant-tools", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/assistant-tools")>(),
  createToolRun: vi.fn(),
}));

vi.mock("@/components/assistant-document-review", () => ({
  AssistantDocumentReview: ({ id }: { id: string }) => <div>Document review {id}</div>,
}));

vi.mock("@/components/assistant-import-review", () => ({
  AssistantImportReview: ({ id }: { id: string }) => <div>Item review {id}</div>,
}));

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
  privacy_note:
    "Local inference is used. Household content stays on this host.",
};

const unconfiguredAiStatus: AiStatus = {
  ...aiStatus, configured: false, available: false, model: null,
  error: "Configure an Assistant model to use AI for typed requests.",
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
    default_currency: "USD",
    warranty_reminder_days: 30,
  },
  role: "owner",
  households: [],
};

function renderPage(
  entry: string,
  initialRequest?: NonNullable<React.ComponentProps<typeof AssistantPage>>["initialRequest"],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SearchSessionProvider>
          <AssistantConversationProvider>
            <AddItemsProvider>
              <AssistantPage
                embedded={Boolean(initialRequest)}
                initialRequest={initialRequest}
                onInitialRequestHandled={() => undefined}
              />
            </AddItemsProvider>
          </AssistantConversationProvider>
        </SearchSessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // These existing journeys exercise the retained local/offline conversation flow.
  vi.mocked(createToolRun).mockReset().mockRejectedValue(
    new ApiError(409, "assistant_tools_unavailable", "AI is unavailable; use local controls."),
  );
  window.sessionStorage.clear();
  window.localStorage.removeItem("housetory-search-scope");
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.startsWith("/assistant/runs")) return [];
    if (path.startsWith("/search/scopes")) return { items: [] };
    if (path.startsWith("/auth/session")) return sessionState;
    return aiStatus;
  });
  vi.mocked(api.post)
    .mockResolvedValueOnce(firstAnswer)
    .mockResolvedValueOnce(secondAnswer);
  vi.mocked(api.postForm).mockReset();
});

describe("AssistantPage", () => {
  it("reopens a prepared action from the proposal itself when its conversation is not loaded", async () => {
    const proposal = {
      id: "old-proposal", kind: "edit_item", state: "ready", scope_label: "Home",
      targets: [{ id: "item-drill", name: "Heavy drill" }], before: { name: "Heavy drill" },
      changes: { name: "Cordless drill" }, destination: null,
    };
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === "/assistant/actions/proposals/old-proposal") return proposal;
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    vi.mocked(api.post).mockReset().mockResolvedValue({ message: "Item updated." });
    renderPage("/assistant", {
      id: "reopen-old", text: "", capture: { kind: "action", id: "old-proposal" },
    });
    const card = await screen.findByLabelText("Action review");
    expect(card).toHaveTextContent("Heavy drill");
    expect(createToolRun).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/assistant/actions/proposals/old-proposal/apply",
      { request_id: "old-proposal" }, expect.anything(),
    ));
    expect(await within(card).findByText("Item updated.")).toBeVisible();
  });

  it("opens a notification's exact capture inline without submitting another request or showing the capture queue", async () => {
    renderPage("/assistant", {
      id: "notification-older", text: "", capture: { kind: "items", id: "older-import" },
    });
    expect(await screen.findByText("Item review older-import")).toBeVisible();
    expect(screen.getByLabelText("Assistant capture status")).toContainElement(
      screen.getByText("Item review older-import"),
    );
    expect(screen.queryByText("Pending captures", { exact: true })).not.toBeInTheDocument();
    expect(createToolRun).not.toHaveBeenCalled();
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("uses durable tools directly, retains panel context and isolates fresh header topics", async () => {
    const user = userEvent.setup();
    const toolRun = {
      id: "run-1", parent_id: null, household_id: "house-1", property_id: null,
      query: "Where is my drill?", state: "completed", generation: 1,
      message: "The drill is in Workshop.", steps: [],
      model_calls: 2, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    vi.mocked(createToolRun).mockResolvedValue(toolRun);
    renderPage("/assistant", { id: "tools-header", text: toolRun.query });
    expect(await screen.findByText("The drill is in Workshop.")).toBeVisible();
    expect(createToolRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ parent_id: expect.anything() }), expect.any(AbortSignal),
    );
    expect(api.post).not.toHaveBeenCalled();
    expect(createToolRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ capture_context: expect.anything() }), expect.any(AbortSignal),
    );
    vi.mocked(createToolRun).mockResolvedValue({ ...toolRun, id: "run-2", query: "What about its history?" });
    const input = screen.getByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "What about its history?");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(createToolRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ parent_id: "run-1", query: "What about its history?" }), expect.any(AbortSignal),
    ));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("restores a queued tool task without submitting it again and exposes cancellation", async () => {
    const run = {
      id: "restored-run", parent_id: null, household_id: "house-1", property_id: null,
      query: "Review these items", state: "queued", generation: 1, steps: [],
      message: "Waiting for the AI worker.", model_calls: 0, max_model_calls: 8,
      can_retry: false, worker_available: false,
    };
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [run];
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    renderPage("/assistant");
    expect(await screen.findByText("Review these items")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Stop assistant" })).toBeVisible();
    expect(screen.getByText(/AI worker is unavailable/)).toBeVisible();
    expect(createToolRun).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps polling a just-submitted task when initial history predates the submission", async () => {
    const queued = {
      id: "new-run", parent_id: null, household_id: "house-1", property_id: null,
      query: "Where is my drill?", state: "queued", generation: 1, steps: [],
      message: "New task waiting.", model_calls: 0, max_model_calls: 8,
      can_retry: false, worker_available: true,
    };
    let resolveHistory!: (runs: unknown[]) => void;
    let historyCalls = 0;
    vi.mocked(createToolRun).mockResolvedValue(queued);
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) {
        historyCalls++;
        if (historyCalls === 1) return new Promise((resolve) => { resolveHistory = resolve; });
        return [{ ...queued, state: "completed", model_calls: 3, message: "New task finished." }];
      }
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    renderPage("/assistant", { id: "late-history", text: queued.query });
    expect(await screen.findByText("Working on your request…")).toBeVisible();
    await act(async () => resolveHistory([]));
    expect(await screen.findByText("New task finished.", {}, { timeout: 3000 })).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Ask the Housetory assistant" });
    await userEvent.type(input, "And its history?");
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
  });

  it("replaces header capture buttons with composer attachments and previews", async () => {
    const user = userEvent.setup();
    renderPage("/assistant");

    expect(screen.queryByRole("button", { name: "Add items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add document" })).not.toBeInTheDocument();
    await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    const file = new File(["invoice"], "invoice.pdf", { type: "application/pdf" });
    await user.upload(document.querySelector('input[type="file"]')!, file);

    expect(screen.getByText("invoice.pdf")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByText("invoice.pdf")).not.toBeInTheDocument();
  });

  it("asks the image intent before sending and attaches typed context to the photo", async () => {
    const user = userEvent.setup();
    vi.mocked(api.postForm).mockResolvedValue({ id: "recognition-1" });
    renderPage("/assistant");
    await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    const file = new File(["photo"], "shelf.jpg", { type: "image/jpeg" });
    await user.upload(document.querySelector('input[type="file"]')!, file);
    await user.type(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }), "Add these to inventory");
    await user.click(screen.getByRole("button", { name: "Send question" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("inventory photo or a document");
    expect(api.postForm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "Inventory photo" }));
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledWith("/ai/recognitions", expect.any(FormData)));
    const form = vi.mocked(api.postForm).mock.calls[0]?.[1] as FormData;
    expect(form.get("text")).toBe("Add these to inventory");
    expect(await screen.findByText("Interpreting the inventory photo. Review the item proposal here before applying it.")).toBeVisible();
  });

  it.each([
    "I bought three Ethernet cables; put them in box 2.",
    "Move the drill to the garage",
    "Lend the drill to Sam",
    "Delete the old lamp",
    "Review my inventory",
  ])("only searches typed text when no assistant model is configured: %s", async (text) => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return unconfiguredAiStatus;
    });
    renderPage("/assistant");
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, text);
    await user.click(screen.getByRole("button", { name: "Send question" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/search/query", expect.objectContaining({ query: text }), expect.anything(),
    ));
    expect(await screen.findByText(firstAnswer.answer ?? "")).toBeVisible();
    // Nothing is interpreted, proposed, imported or reviewed on the user's behalf.
    expect(vi.mocked(api.post).mock.calls.map(([path]) => path)).toEqual(["/search/query"]);
    expect(api.postForm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Apply|Approve/ })).not.toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Local search mode" })).toHaveTextContent(
      "Local search mode. Typed actions need the AI assistant; use the item's buttons, or set up AI in Settings.",
    );
  });

  it("shows the local-search-mode notice from configuration alone, before anything is typed", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return unconfiguredAiStatus;
    });
    renderPage("/assistant");
    const notice = await screen.findByRole("note", { name: "Local search mode" });
    expect(within(notice).getByRole("link", { name: "set up AI in Settings" })).toHaveAttribute(
      "href", "/settings/ai",
    );
  });

  it("refreshes captures and prepared actions as soon as an assistant task changes", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const run = {
      id: "run-capture", parent_id: null, household_id: "house-1", property_id: null,
      query: "Add a lamp", state: "completed", generation: 1, steps: [],
      message: "Prepared.", model_calls: 1, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [run];
      if (path.startsWith("/search/scopes")) return { items: [] };
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    renderPage("/assistant");
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(keys).toContain(JSON.stringify(["inventory-review", "captures"]));
      expect(keys).toContain(JSON.stringify(["assistant-pending-actions"]));
    });
  });

  it("uses the tool engine unchanged, with no notice, when the assistant model is configured", async () => {
    const user = userEvent.setup();
    vi.mocked(createToolRun).mockReset().mockResolvedValue({
      id: "run-configured", parent_id: null, household_id: "house-1", property_id: null,
      query: "Move the drill to the garage", state: "completed", generation: 1, steps: [],
      message: "I prepared the move for your review.", model_calls: 1, max_model_calls: 8,
      can_retry: false, worker_available: null,
    });
    renderPage("/assistant");
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "Move the drill to the garage");
    await user.click(screen.getByRole("button", { name: "Send question" }));

    await waitFor(() => expect(createToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Move the drill to the garage" }), expect.any(AbortSignal),
    ));
    expect(await screen.findByText("I prepared the move for your review.")).toBeVisible();
    expect(api.post).not.toHaveBeenCalledWith("/search/query", expect.anything(), expect.anything());
    expect(screen.queryByRole("note", { name: "Local search mode" })).not.toBeInTheDocument();
  });

  it("submits a header assistant request through the existing conversation service", async () => {
    renderPage("/assistant", { id: "header-question", text: "Where is my drill?" });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/search/query",
        expect.objectContaining({ query: "Where is my drill?" }),
        expect.anything(),
      ),
    );
    expect(await screen.findByText("Where is my drill?")).toBeVisible();
  });

  it("answers with the all-places search when an assistant task needs one household", async () => {
    vi.mocked(createToolRun).mockReset().mockRejectedValue(new ApiError(
      409, "assistant_household_required", "Choose one household for this tool conversation.",
    ));
    const info = vi.spyOn(toast, "info");
    const error = vi.spyOn(toast, "error");
    renderPage("/assistant", { id: "header-question", text: "Where is my drill?" });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/search/query",
      expect.objectContaining({ query: "Where is my drill?" }),
      expect.anything(),
    ));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).not.toHaveProperty("household_id");
    expect(await screen.findByText(firstAnswer.answer ?? "")).toBeVisible();
    await waitFor(() => expect(info).toHaveBeenCalledWith(
      "Searched all your places.", expect.objectContaining({ description: expect.stringContaining("one household") }),
    ));
    expect(error).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("hands a header attachment to the existing assistant composer without sending it", async () => {
    const file = new File(["invoice"], "invoice.pdf", { type: "application/pdf" });
    renderPage("/assistant", { id: "header-file", text: "Check this invoice", file });
    expect(await screen.findByText("invoice.pdf")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Ask the Housetory assistant" }),
    ).toHaveValue("Check this invoice");
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("requires an explicit household when a capture starts in All my places", async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) {
        return {
          items: [
            { id: "house-1", name: "Home", properties: [] },
            { id: "house-2", name: "Cabin", properties: [] },
          ],
        };
      }
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    vi.mocked(api.postForm).mockResolvedValue({ id: "doc-1", title: "invoice" });
    renderPage("/assistant");
    await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.upload(
      document.querySelector('input[type="file"]')!,
      new File(["invoice"], "invoice.pdf", { type: "application/pdf" }),
    );
    const send = screen.getByRole("button", { name: "Send question" });
    await user.selectOptions(screen.getByLabelText("Document type"), "invoice");
    await user.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the household");
    expect(api.postForm).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByRole("combobox", { name: "Destination household" }), "house-1");
    await user.click(send);
    await waitFor(() => expect(api.postForm).toHaveBeenCalledWith("/documents", expect.any(FormData)));
  });

  it("explains the selection limit and allows clearing it without submitting a partial selection", async () => {
    function LargeSelection() {
      useRegisterAssistantPageContext(
        Array.from({ length: 13 }, (_, index) => ({
          kind: "item", id: `item-${index}`, name: `Item ${index}`,
        })),
      );
      return <AssistantPage embedded />;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/items"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><LargeSelection /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await userEvent.type(input, "Where are these?");
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 12");
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Where is my heavy drill?" })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Clear assistant context" }));
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).not.toHaveProperty("page_context");
  });

  it("sends the visible page target by ID and retains it across a full-page handoff", async () => {
    function ContextFixture() {
      const navigate = useNavigate();
      const [target, setTarget] = React.useState(item);
      useRegisterAssistantPageContext([{ kind: "item", id: target.id, name: target.name }]);
      return (
        <>
          <button onClick={() => setTarget({ ...item, id: "item-ladder", name: "Ladder" })}>
            Change page target
          </button>
          <button onClick={() => navigate("/assistant")}>Full page</button>
          <AssistantPage embedded />
        </>
      );
    }
    let resolveAnswer!: (response: SearchQueryResponse) => void;
    vi.mocked(api.post).mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAnswer = resolve; }))
      .mockResolvedValueOnce(secondAnswer);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/items/item-drill"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><ContextFixture /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Current assistant context")).toHaveTextContent("item: Heavy drill");
    const input = screen.getByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "Where is it?");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      page_context: [{ kind: "item", id: "item-drill" }],
    }));
    await user.click(screen.getByRole("button", { name: "Change page target" }));
    expect(screen.getByLabelText("Current assistant context")).toHaveTextContent("Ladder");
    await act(async () => resolveAnswer(firstAnswer));
    await user.click(screen.getByRole("button", { name: "Full page" }));
    expect(screen.getByLabelText("Current assistant context")).toHaveTextContent("Ladder");
    await user.click(screen.getByRole("button", { name: /Regenerate/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      page_context: [{ kind: "item", id: "item-drill" }],
    }));
  });

  it("keeps a pending request and edited draft when the view is reopened", async () => {
    let resolveAnswer!: (response: SearchQueryResponse) => void;
    vi.mocked(api.post).mockReset().mockImplementation(
      () => new Promise((resolve) => { resolveAnswer = resolve; }),
    );
    function SwitchView() {
      const [visible, setVisible] = React.useState(true);
      return (
        <>
          <button onClick={() => setVisible((current) => !current)}>Toggle view</button>
          {visible && <AssistantPage />}
        </>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/assistant"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><SwitchView /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "where is my heavy drill");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await user.clear(input);
    await user.type(input, "A new draft");
    await user.click(screen.getByRole("button", { name: "Toggle view" }));
    await user.click(screen.getByRole("button", { name: "Toggle view" }));
    expect(screen.getByText(/Retrieving current records/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    await act(async () => resolveAnswer(firstAnswer));
    expect(await screen.findByText(/Alex has 1 of your 2 units/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }))
      .toHaveValue("A new draft");
  });

  it("keeps a late answer in its original scope and sends its own history on return", async () => {
    let resolveAnswer!: (response: SearchQueryResponse) => void;
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) {
        return { items: [{ id: "house-1", name: "Home", properties: [] }] };
      }
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    vi.mocked(api.post).mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAnswer = resolve; }))
      .mockResolvedValueOnce(secondAnswer);
    renderPage("/assistant");
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await screen.findByRole("option", { name: "Home — all properties" });
    await user.type(input, "where is my heavy drill");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await user.selectOptions(screen.getByLabelText("Search scope"), "household:house-1");
    await act(async () => resolveAnswer(firstAnswer));
    expect(screen.queryByText(/Alex has 1 of your 2 units/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("Search scope"), "all");
    expect(await screen.findByText(/Alex has 1 of your 2 units/)).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }), "when is it due?");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("That loan is recorded as due on 2026-11-15.");
    expect(vi.mocked(api.post).mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      history: [
        { role: "user", content: "where is my heavy drill" },
        { role: "assistant", content: firstAnswer.answer },
      ],
      context: firstAnswer.context,
    }));
  });

  it("does not record an assistant answer into a different page search scope", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) {
        return { items: [
          { id: "house-1", name: "Home", properties: [] },
          { id: "house-2", name: "Cabin", properties: [] },
        ] };
      }
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    function SearchSessionProbe() {
      const session = useSearchSession();
      return <>
        <button onClick={() => session.record("page A lookup", firstAnswer)}>Record page search</button>
        <output aria-label="Page search history">{session.turns.map((turn) => turn.content).join(" / ")}</output>
      </>;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/search?household_id=house-1"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><SearchSessionProbe /><AssistantPage embedded /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Cabin — all properties" });
    await user.click(screen.getByRole("button", { name: "Record page search" }));
    const pageHistory = screen.getByLabelText("Page search history").textContent;
    expect(pageHistory).toContain("page A lookup");
    await user.selectOptions(screen.getByLabelText("Search scope"), "household:house-2");
    await user.type(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }), "where is my heavy drill");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText(/Alex has 1 of your 2 units/, { selector: "p" });
    expect(screen.getByLabelText("Page search history").textContent).toBe(pageHistory);
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByLabelText("Page search history").textContent).toBe(pageHistory);
  });

  it("initializes scope from the current page when first opened after navigation", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) {
        return { items: [{ id: "house-1", name: "Home", properties: [] }] };
      }
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    function OpenAfterNavigation() {
      const navigate = useNavigate();
      const [open, setOpen] = React.useState(false);
      return <>
        <button onClick={() => navigate("/search?household_id=house-1")}>Navigate</button>
        <button onClick={() => setOpen(true)}>Open assistant</button>
        {open && <AssistantPage embedded />}
      </>;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/items"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><OpenAfterNavigation /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Navigate" }));
    await user.click(screen.getByRole("button", { name: "Open assistant" }));
    await screen.findByRole("option", { name: "Home — all properties" });
    expect(screen.getByLabelText("Search scope")).toHaveValue("household:house-1");
  });

  it("revalidates a retained property scope when available scopes change", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) {
        return { items: [{ id: "house-1", name: "Home", properties: [{ id: "property-1", name: "Cabin" }] }] };
      }
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/search?household_id=house-1&property_id=property-1"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><AssistantPage embedded /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const scope = await screen.findByLabelText("Search scope");
    await screen.findByRole("option", { name: "Home · Cabin" });
    expect(scope).toHaveValue("household:house-1|property:property-1");
    act(() => {
      client.setQueryData(["search", "scopes"], {
        items: [{ id: "house-1", name: "Home", properties: [] }],
      });
    });
    await waitFor(() => expect(scope).toHaveValue("household:house-1"));
    await userEvent.type(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }), "where is my heavy drill");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).toEqual(expect.objectContaining({ household_id: "house-1" }));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).not.toHaveProperty("property_id");
  });

  it("keeps the question editable after a network failure", async () => {
    vi.mocked(api.post).mockReset().mockRejectedValueOnce(new Error("offline"));
    renderPage("/assistant");
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "where is my drill");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
    expect(input).toHaveValue("where is my drill");
  });

  it("does not silently widen a saved scope when scope loading fails", async () => {
    window.localStorage.setItem("housetory-search-scope", JSON.stringify({
      householdId: "house-1", propertyId: "",
    }));
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/assistant/runs")) return [];
      if (path.startsWith("/search/scopes")) throw new Error("offline");
      if (path.startsWith("/auth/session")) return sessionState;
      return aiStatus;
    });
    renderPage("/assistant");
    const select = await screen.findByLabelText("Search scope");
    await screen.findByRole("option", { name: "Selected household (unavailable)" });
    expect(select).toHaveValue("household:house-1");
    const input = screen.getByRole("textbox", { name: "Ask the Housetory assistant" });
    await userEvent.type(input, "Where is my drill?");
    expect(input).toHaveValue("Where is my drill?");
    window.localStorage.removeItem("housetory-search-scope");
  });

  it("preserves the visible answer and unsent draft when the view is remounted", async () => {
    function SwitchView() {
      const [visible, setVisible] = React.useState(true);
      return (
        <>
          <button onClick={() => setVisible((current) => !current)}>Toggle view</button>
          {visible && <AssistantPage />}
        </>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/assistant"]}>
          <SearchSessionProvider>
            <AssistantConversationProvider>
              <AddItemsProvider><SwitchView /></AddItemsProvider>
            </AssistantConversationProvider>
          </SearchSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: "Ask the Housetory assistant" });
    await user.type(input, "where is my heavy drill");
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText(/Alex has 1 of your 2 units/);
    await user.type(input, "Unsent follow-up");
    await user.click(screen.getByRole("button", { name: "Toggle view" }));
    await user.click(screen.getByRole("button", { name: "Toggle view" }));
    expect(screen.getByText(/Alex has 1 of your 2 units/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask the Housetory assistant" }))
      .toHaveValue("Unsent follow-up");
  });

  it("answers a handed-off question through the shared submit endpoint", async () => {
    renderPage(`/assistant?q=${encodeURIComponent("where is my heavy drill")}`);
    expect(await screen.findByText(/Alex has 1 of your 2 units/)).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(
      "/search/query",
      expect.objectContaining({
        query: "where is my heavy drill",
        explicit_ask: true,
        history: [],
        limit: 40,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      screen.getByRole("button", { name: /Privacy & model/ }),
    ).toBeVisible();
    expect(screen.getByText("Direct lookup")).toBeVisible();
    expect(screen.getByText("Heavy drill loan to Alex")).toBeVisible();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("continues the conversation with bounded prior turns and context", async () => {
    renderPage(`/assistant?q=${encodeURIComponent("where is my heavy drill")}`);
    await screen.findByText(/Alex has 1 of your 2 units/);
    const input = screen.getByRole("textbox", {
      name: "Ask the Housetory assistant",
    });
    await userEvent.type(input, "when is it due?");
    await userEvent.click(
      screen.getByRole("button", { name: "Send question" }),
    );
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

  it("keeps the composer outside the scrolling log and shows privacy info on demand", async () => {
    const user = userEvent.setup();
    renderPage("/assistant");
    const log = await screen.findByRole("log", { name: "Conversation" });
    const composer = screen.getByLabelText("Ask the Housetory assistant");
    expect(log).not.toContainElement(composer);
    expect(
      screen.getByRole("button", { name: "Where is my heavy drill?" }),
    ).toBeVisible();
    expect(screen.queryByText(/Changes require your review and explicit Apply/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Privacy & model/ }));
    expect(screen.getByText(/Changes require your review and explicit Apply/)).toBeVisible();
  });

  it("copies an answer to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPage(`/assistant?q=${encodeURIComponent("where is my heavy drill")}`);
    await screen.findByText(/Alex has 1 of your 2 units/);
    await userEvent.click(screen.getByRole("button", { name: /Copy answer/ }));
    expect(writeText).toHaveBeenCalledWith(firstAnswer.answer);
  });

  it("offers follow-up chips that ask a new question", async () => {
    renderPage(`/assistant?q=${encodeURIComponent("where is my heavy drill")}`);
    await screen.findByText(/Alex has 1 of your 2 units/);
    await userEvent.click(screen.getByRole("button", { name: "Who owns it?" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ query: "Who owns it?" }),
    );
  });

  it("regenerates the latest answer in place without duplicating it", async () => {
    renderPage(`/assistant?q=${encodeURIComponent("where is my heavy drill")}`);
    await screen.findByText(/Alex has 1 of your 2 units/);
    await userEvent.click(screen.getByRole("button", { name: /Regenerate/ }));
    expect(
      await screen.findByText("That loan is recorded as due on 2026-11-15."),
    ).toBeVisible();
    expect(screen.queryByText(/Alex has 1 of your 2 units/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /Regenerate/ })).toHaveLength(1);
    expect(vi.mocked(api.post).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ query: "where is my heavy drill", history: [] }),
    );
  });
});
