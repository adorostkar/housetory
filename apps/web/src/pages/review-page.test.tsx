import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  ItemSummary,
  ReviewSuggestion,
  ReviewSummary,
} from "@/lib/types";
import { ReviewPage } from "@/pages/review-page";

function item(overrides: Partial<ItemSummary> & { id: string; name: string }): ItemSummary {
  return {
    description: null,
    brand: null,
    model: null,
    quantity: 1,
    on_loan_quantity: 0,
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const drill = item({ id: "item-drill", name: "Cordless drill" });
const duplicate = item({ id: "item-copy", name: "Cordless drill" });

const categorySuggestion: ReviewSuggestion = {
  id: "suggestion-category",
  run_id: "run-1",
  type: "category",
  action_kind: "apply_category",
  status: "pending",
  source: "rules",
  priority: 70,
  title: "Assign category “Tools”",
  explanation: "Exact-name items already use Tools.",
  scope_type: "household",
  scope_id: null,
  item_id: drill.id,
  secondary_item_id: null,
  category_id: "category-tools",
  before: { category_id: null, category_name: null },
  after: { category_id: "category-tools", category_name: "Tools" },
  evidence: { category_name: "Tools" },
  fingerprint: "fingerprint-category",
  created_at: "2026-11-06T12:00:00Z",
  updated_at: "2026-11-06T12:00:00Z",
  accepted_at: null,
  applied_at: null,
  dismissed_at: null,
  reverted_at: null,
  can_undo: false,
  undo_blocked_reason: null,
  item: drill,
  secondary_item: null,
};

const duplicateSuggestion: ReviewSuggestion = {
  ...categorySuggestion,
  id: "suggestion-duplicate",
  type: "possible_duplicate",
  action_kind: "advisory",
  status: "pending",
  title: "Possible duplicate: Cordless drill",
  explanation: "These records share a name, brand and model.",
  item_id: drill.id,
  secondary_item_id: duplicate.id,
  category_id: null,
  before: {},
  after: {},
  evidence: { serial_match: true },
  fingerprint: "fingerprint-duplicate",
  secondary_item: duplicate,
};

const summary: ReviewSummary = {
  pending_count: 2,
  status_counts: { pending: 2 },
  type_counts: { category: 1, possible_duplicate: 1 },
  last_run: null,
  schedule: null,
};

let canWrite = true;
let owner = true;
let suggestions = [categorySuggestion, duplicateSuggestion];

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => canWrite,
    useSession: () => ({
      data: { role: owner ? "owner" : "member" },
      isPending: false,
    }),
    useAiStatus: () => ({
      data: {
        provider: "openai",
        provider_label: "OpenAI household",
        model: "gpt-test",
        configured: true,
        mode: "cloud",
        data_leaves_server: true,
        error: null,
      },
      isPending: false,
    }),
    useProperties: () => ({ data: { items: [] }, isPending: false }),
    useRooms: () => ({ data: { items: [] }, isPending: false }),
    useLocations: () => ({ data: { items: [] }, isPending: false }),
    useCategories: () => ({ data: { items: [] }, isPending: false }),
    useReviewSummary: () => ({ data: summary, isPending: false }),
    useReviewSchedule: () => ({
      data: null,
      isPending: false,
      isError: false,
      error: null,
    }),
    useReviewSuggestions: () => ({
      data: {
        items: suggestions,
        total: suggestions.length,
        pending_count: suggestions.length,
        status_counts: { pending: suggestions.length },
        type_counts: {},
      },
      isPending: false,
      isError: false,
      error: null,
    }),
    useReviewScopeItems: () => ({ data: { items: [] }, isPending: false }),
    useInvalidateInventory: () => vi.fn(),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      put: vi.fn(async (path: string) => {
        if (path === "/inventory-review/schedule") {
          return {
            id: "schedule-1",
            household_id: "household-1",
            enabled: true,
            state: "scheduled",
            state_detail: "Next run 2026-11-09 09:00 UTC.",
            scope_type: "household",
            scope_id: null,
            scope_label: "Whole household",
            frequency: "weekly",
            timezone: "UTC",
            weekday: 0,
            monthly_day: 1,
            local_hour: 9,
            max_items: 200,
            max_runs_per_day: 1,
            provider_request_cap: 1,
            include_ai: false,
            ai_consent: false,
            ai_consent_at: null,
            ai_consent_valid: false,
            ai_consent_reason: null,
            ai_consent_provider_label: null,
            ai_consent_model: null,
            assistant_task: "assistant",
            assistant_configured: true,
            assistant_provider_label: "OpenAI household",
            assistant_model: "gpt-test",
            assistant_mode: "cloud",
            assistant_error: null,
            last_run_at: null,
            last_run_status: "never",
            last_run_detail: null,
            last_run_id: null,
            last_run_job_id: null,
            last_dispatch_at: null,
            next_due_at: "2026-11-09T09:00:00Z",
            created_at: "2026-11-06T12:00:00Z",
            updated_at: "2026-11-06T12:00:00Z",
          };
        }
        throw new Error(`Unexpected PUT ${path}`);
      }),
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/accept")) {
          return {
            suggestion_id: categorySuggestion.id,
            status: "applied",
            message: "Suggestion applied to the item.",
            suggestion: {
              ...categorySuggestion,
              status: "accepted",
              can_undo: true,
            },
          };
        }
        if (path.endsWith("/dismiss")) {
          return {
            suggestion_id: duplicateSuggestion.id,
            status: "skipped",
            message: "Suggestion dismissed.",
            suggestion: {
              ...duplicateSuggestion,
              status: "dismissed",
            },
          };
        }
        if (path.endsWith("/undo")) {
          return {
            suggestion_id: categorySuggestion.id,
            status: "applied",
            message: "Applied review change reverted.",
            suggestion: {
              ...categorySuggestion,
              status: "reverted",
            },
          };
        }
        if (path === "/inventory-review/runs") {
          return {
            id: "run-new",
            request_id: "request-new",
            scope_type: "household",
            scope_id: null,
            scope_label: "Whole household",
            include_ai: true,
            status: "completed",
            total_item_count: 2,
            item_count_scanned: 2,
            created_suggestion_count: 0,
            existing_suggestion_count: 2,
            stale_suggestion_count: 0,
            suppressed_suggestion_count: 0,
            ai_used: true,
            ai_provider_label: "OpenAI household",
            ai_model: "gpt-test",
            ai_error: null,
            partial_reason: null,
            created_at: "2026-11-06T12:10:00Z",
            completed_at: "2026-11-06T12:10:01Z",
          };
        }
        return {};
      }),
    },
  };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderPage(initialEntry = "/review") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ReviewPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function originFromHref(href: string) {
  const from = new URL(href, "http://test").searchParams.get("from");
  expect(from).toBeTruthy();
  return new URL(from!, "http://test").searchParams;
}

beforeEach(() => {
  canWrite = true;
  owner = true;
  suggestions = [categorySuggestion, duplicateSuggestion];
  vi.mocked(api.post).mockClear();
});

describe("ReviewPage", () => {
  it("renders persisted suggestions without making AI calls on open", () => {
    renderPage();
    expect(screen.getByText("Assign category “Tools”")).toBeVisible();
    expect(screen.getByText("Possible duplicate: Cordless drill")).toBeVisible();
    expect(screen.getByText("2 pending")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("accepts a category suggestion and exposes undo on accepted results", async () => {
    renderPage();
    const card = screen.getByText("Assign category “Tools”").closest("li");
    expect(card).not.toBeNull();
    await userEvent.click(within(card!).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/inventory-review/suggestions/suggestion-category/accept",
        {},
      ),
    );
  });

  it("keeps duplicate findings advisory and opens a comparison", async () => {
    renderPage();
    const card = screen.getByText("Possible duplicate: Cordless drill").closest("li");
    expect(card).not.toBeNull();
    expect(within(card!).queryByRole("button", { name: "Accept" })).toBeNull();
    await userEvent.click(within(card!).getByRole("button", { name: "Compare" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/does not merge inventory/i)).toBeVisible();
    expect(within(dialog).getAllByText("Cordless drill").length).toBeGreaterThan(1);
  });

  it("requires confirmation before the optional AI pass and sends the selected scope", async () => {
    renderPage();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /Include optional AI-assisted category suggestions/,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review with AI" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/may charge usage/i)).toBeVisible();
    expect(within(dialog).getByText(/never sends photos, receipts, loans, prices/i)).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Run review with AI" }),
    );
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/inventory-review/runs",
        expect.objectContaining({
          scope_type: "household",
          scope_id: null,
          item_ids: null,
          include_ai: true,
        }),
      ),
    );
  });

  it("round-trips URL-backed pending status, type and search through item origins", async () => {
    renderPage(
      "/review?scope_type=household&status=pending&suggestion_type=category&q=Tools",
    );
    expect(screen.getByLabelText("Filter suggestions by status")).toHaveValue(
      "pending",
    );
    expect(screen.getByLabelText("Filter suggestions by type")).toHaveValue(
      "category",
    );
    expect(screen.getByLabelText("Search suggestions")).toHaveValue("Tools");

    const itemLink = screen.getAllByRole("link", { name: "Cordless drill" })[0]!;
    const from = originFromHref(itemLink.getAttribute("href")!);
    expect(from.get("scope_type")).toBe("household");
    expect(from.get("status")).toBe("pending");
    expect(from.get("suggestion_type")).toBe("category");
    expect(from.get("q")).toBe("Tools");

    await userEvent.selectOptions(
      screen.getByLabelText("Filter suggestions by status"),
      "accepted",
    );
    await waitFor(() =>
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "status=accepted",
      ),
    );
    const acceptedLink = screen.getAllByRole("link", { name: "Cordless drill" })[0]!;
    expect(originFromHref(acceptedLink.getAttribute("href")!).get("status")).toBe(
      "accepted",
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Filter suggestions by type"),
      "name",
    );
    await waitFor(() =>
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "suggestion_type=name",
      ),
    );
    await userEvent.clear(screen.getByLabelText("Search suggestions"));
    await userEvent.type(screen.getByLabelText("Search suggestions"), "Bench");
    await waitFor(
      () =>
        expect(screen.getByTestId("location-search")).toHaveTextContent("q=Bench"),
      { timeout: 1500 },
    );
  });

  it("resets filters to validated defaults without losing scope", async () => {
    renderPage(
      "/review?scope_type=room&scope_id=room-1&status=not-a-status&suggestion_type=not-a-type&q=stale",
    );
    expect(screen.getByLabelText("Filter suggestions by status")).toHaveValue(
      "pending",
    );
    expect(screen.getByLabelText("Filter suggestions by type")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-search")).not.toHaveTextContent("status="),
    );
    const search = screen.getByTestId("location-search").textContent ?? "";
    expect(search).not.toContain("suggestion_type=");
    expect(search).not.toContain("q=");
    expect(search).toContain("scope_type=room");
    expect(search).toContain("scope_id=room-1");
    expect(screen.getByLabelText("Search suggestions")).toHaveValue("");
  });

  it("preserves selected-item scope and queue filters in comparison links", async () => {
    suggestions = [duplicateSuggestion];
    renderPage(
      "/review?scope_type=items&item_ids=item-drill,item-copy&status=pending&suggestion_type=possible_duplicate&q=Cordless",
    );
    expect(screen.getByLabelText("Review scope type")).toHaveValue("items");
    const duplicateCard = screen
      .getByText("Possible duplicate: Cordless drill")
      .closest("li");
    expect(duplicateCard).not.toBeNull();
    await userEvent.click(
      within(duplicateCard!).getByRole("button", { name: "Compare" }),
    );
    const dialog = screen.getByRole("dialog");
    const comparisonLinks = within(dialog).getAllByRole("link", {
      name: "Open item",
    });
    expect(comparisonLinks).toHaveLength(2);
    for (const link of comparisonLinks) {
      const from = originFromHref(link.getAttribute("href")!);
      expect(from.get("scope_type")).toBe("items");
      expect(from.get("item_ids")).toBe("item-drill,item-copy");
      expect(from.get("status")).toBe("pending");
      expect(from.get("suggestion_type")).toBe("possible_duplicate");
      expect(from.get("q")).toBe("Cordless");
    }
  });

  it("keeps viewers read-only while still showing the queue", () => {
    canWrite = false;
    owner = false;
    renderPage();
    expect(screen.getByText("Assign category “Tools”")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Find suggestions" })).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: /Include optional AI-assisted category suggestions/,
      }),
    ).toBeDisabled();
  });
});
