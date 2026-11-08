import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SearchSessionProvider, useSearchSession } from "@/lib/search-session";
import type { SearchQueryResponse } from "@/lib/types";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: { user: { id: "session-user" } } }),
  };
});

function response(answer: string): SearchQueryResponse {
  return {
    query: "Heavy drill",
    mode: "direct",
    ai_used: false,
    ai_attempted: false,
    direct_match: true,
    ambiguous: false,
    needs_clarification: false,
    answer,
    answer_kind: "direct_lookup",
    interpretation: "direct",
    filters: {} as SearchQueryResponse["filters"],
    items: [],
    quick_results: [],
    borrowed: [],
    borrowed_total: 0,
    total: 0,
    documents: [],
    locations: [],
    references: [],
    notices: [],
    facts: {},
    tool: "direct_lookup",
    ai_status: {} as SearchQueryResponse["ai_status"],
    context: {
      scope_key: "|",
      last_query: "Heavy drill",
      resolved_items: [],
      candidate_items: [],
      loans: [],
    },
  };
}

function Probe() {
  const session = useSearchSession();
  return (
    <div>
      <output data-testid="turn-count">{session.turns.length}</output>
      <output data-testid="last-context">
        {session.context?.last_query ?? "none"}
      </output>
      <button
        type="button"
        onClick={() => session.record("Heavy drill", response("First result"))}
      >
        record
      </button>
      <button type="button" onClick={() => session.reset()}>
        reset
      </button>
    </div>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("SearchSessionProvider", () => {
  it("does not append the same submitted query twice", async () => {
    render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchSessionProvider>
          <Probe />
        </SearchSessionProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "record" }));
    await waitFor(() =>
      expect(screen.getByTestId("turn-count")).toHaveTextContent("2"),
    );
    await userEvent.click(screen.getByRole("button", { name: "record" }));
    await waitFor(() =>
      expect(screen.getByTestId("turn-count")).toHaveTextContent("2"),
    );
    const raw = window.sessionStorage.getItem("housetory-search-session:session-user");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? "{}").turns).toHaveLength(2);
  });

  it("clears turns and context on reset", async () => {
    render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchSessionProvider>
          <Probe />
        </SearchSessionProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "record" }));
    await waitFor(() =>
      expect(screen.getByTestId("turn-count")).toHaveTextContent("2"),
    );
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    await waitFor(() =>
      expect(screen.getByTestId("turn-count")).toHaveTextContent("0"),
    );
    expect(
      window.sessionStorage.getItem("housetory-search-session:session-user"),
    ).toBeNull();
  });
});
