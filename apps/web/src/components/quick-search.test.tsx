import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuickSearch } from "@/components/quick-search";
import { api } from "@/lib/api";
import type { QuickSearchResponse, QuickSearchResult } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

function result(overrides: Partial<QuickSearchResult>): QuickSearchResult {
  return {
    id: "item-1",
    kind: "item",
    title: "Camera Body",
    subtitle: "Acme · C-1",
    context: "Office · BOX-001",
    url: "/items/item-1",
    loan: null,
    ...overrides,
  };
}

function response(query: string, results: QuickSearchResult[]): QuickSearchResponse {
  return {
    query,
    effective_query: null,
    question_like: false,
    results,
  };
}

function LocationProbe({ maxChanges = Infinity }: { maxChanges?: number }) {
  const location = useLocation();
  const changes = useRef(0);
  useEffect(() => {
    changes.current += 1;
    if (changes.current > maxChanges) {
      throw new Error("Responsive search repeatedly rewrote the URL");
    }
  }, [location.search, maxChanges]);
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function BookmarkedSearchButton() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/items?q=Bookmarked&sort=name_asc")}>
      Open bookmarked search
    </button>
  );
}

function renderSearch(
  initialEntry = "/",
  responsive = false,
  callbacks: {
    onAsk?: (query: string, trigger: HTMLElement) => void;
    onAttach?: (file: File, trigger: HTMLElement) => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <div hidden={responsive}><QuickSearch {...callbacks} /></div>
        {responsive && <QuickSearch variant="mobile" {...callbacks} />}
        {responsive && <BookmarkedSearchButton />}
        <LocationProbe maxChanges={responsive ? 10 : Infinity} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function queryFromPath(path: string) {
  return new URL(path, "http://localhost").searchParams.get("q") ?? "";
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe("QuickSearch", () => {
  it("shows grouped item, container and location results and opens a result", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return response(query, [
        result({}),
        result({
          id: "box-1",
          kind: "container",
          title: "BOX-001",
          subtitle: "Cables",
          context: "Office",
          url: "/containers/box-1",
        }),
        result({
          id: "shelf-1",
          kind: "location",
          title: "Top shelf",
          subtitle: "shelf",
          context: "Office",
          url: "/rooms/room-1?location_id=shelf-1",
        }),
      ]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Camera");
    const panel = await screen.findByRole("listbox", { name: "Quick search results" });
    expect(within(panel).getByText("Owned items")).toBeVisible();
    expect(within(panel).getByText("Boxes & containers")).toBeVisible();
    expect(within(panel).getByText("Locations")).toBeVisible();
    expect(within(panel).getByRole("option", { name: /Camera Body/ })).toBeVisible();
    expect(within(panel).getByRole("option", { name: /^BOX-001/ })).toBeVisible();
    expect(within(panel).getByRole("option", { name: /Top shelf/ })).toBeVisible();

    await userEvent.click(within(panel).getByRole("option", { name: /^BOX-001/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/containers/box-1"),
    );
  });

  it("supports arrow-key selection, Enter and View all results", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return response(query, [result({})]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Camera");
    await screen.findByRole("option", { name: /Camera Body/ });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/items/item-1"),
    );
  });

  it("opens all results with the same query", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return response(query, [result({})]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Camera");
    await screen.findByRole("option", { name: /Camera Body/ });
    await userEvent.click(screen.getByRole("button", { name: /View all results/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/search?q=Camera"),
    );
  });

  it("does not call natural-language search while typing", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return response(query, [result({ title: "PS5" })]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "PS5");
    expect(await screen.findByRole("option", { name: /^PS5/ })).toBeVisible();
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/search/natural"),
      expect.anything(),
    );
  });

  it("sends every query to the same submit-time result flow", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return {
        query,
        effective_query: "heavy drill",
        question_like: true,
        results: [
          result({
            title: "Heavy drill",
            loan: {
              on_loan_quantity: 1,
              borrower_names: ["Alex"],
              next_due_on: "2026-11-15",
            },
          }),
        ],
      };
    });
    renderSearch();
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "where is my heavy drill");
    const panel = await screen.findByRole("listbox", {
      name: "Quick search results",
    });
    expect(within(panel).getByText(/On loan to Alex/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Ask Housetory" }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      const url = new URL(
        screen.getByTestId("location").textContent ?? "/",
        "http://localhost",
      );
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("where is my heavy drill");
      expect(url.searchParams.get("ask")).toBeNull();
    });
  });

  it("offers an explicit Ask path that bypasses heuristics", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      return response(query, [result({ title: "Heavy drill" })]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "where is my heavy drill");
    const ask = await screen.findByRole("button", { name: "Ask Housetory" });
    await userEvent.click(ask);
    await waitFor(() => {
      const url = new URL(
        screen.getByTestId("location").textContent ?? "/",
        "http://localhost",
      );
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("where is my heavy drill");
      expect(url.searchParams.get("ask")).toBe("1");
    });
  });

  it("adds a final keyboard-reachable ask-the-assistant row", async () => {
    vi.mocked(api.get).mockImplementation(async (path) =>
      response(queryFromPath(path), [result({ title: "Heavy drill" })]),
    );
    renderSearch();
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "heavy drill?");
    const row = await screen.findByRole("option", {
      name: /Ask the assistant: “heavy drill\?”/,
    });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(row).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/assistant?q=heavy%20drill%3F",
      ),
    );
  });

  it("hands an assistant submission to the conversational panel when provided", async () => {
    const onAsk = vi.fn();
    vi.mocked(api.get).mockImplementation(async (path) =>
      response(queryFromPath(path), []),
    );
    renderSearch("/", false, { onAsk });
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "Where is my camera?");
    await userEvent.click(
      await screen.findByRole("option", { name: /Ask the assistant:/ }),
    );
    expect(onAsk).toHaveBeenCalledWith("Where is my camera?", input);
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("hands a validated attachment to the capture panel", async () => {
    const onAttach = vi.fn();
    renderSearch("/", false, { onAttach });
    const button = screen.getByRole("button", { name: "Attach a file" });
    await userEvent.click(button);
    const file = new File(["invoice"], "invoice.pdf", { type: "application/pdf" });
    await userEvent.upload(document.querySelector('input[type="file"]')!, file);
    expect(onAttach).toHaveBeenCalledWith(file, button);
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("rejects unsupported attachments before opening capture", async () => {
    const onAttach = vi.fn();
    renderSearch("/", false, { onAttach });
    const button = screen.getByRole("button", { name: "Attach a file" });
    await userEvent.click(button);
    await userEvent.upload(
      document.querySelector('input[type="file"]')!,
      new File(["script"], "payload.exe", { type: "application/octet-stream" }),
      { applyAccept: false },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF");
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("opens all results with Enter before selecting a result and preserves the query", async () => {
    const pending = new Promise<QuickSearchResponse>(() => undefined);
    vi.mocked(api.get).mockReturnValue(pending);
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Blue box");
    expect(await screen.findByText("Searching your places…")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      const url = new URL(
        screen.getByTestId("location").textContent ?? "/",
        "http://localhost",
      );
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("Blue box");
    });
  });

  it("closes on Escape, clears stale state and handles empty and error states", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      if (query === "Broken") throw new Error("Search failed");
      if (query === "Nothing") return response(query, []);
      return response(query, [result({})]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Camera");
    await screen.findByRole("option", { name: /Camera Body/ });
    await userEvent.click(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).not.toHaveFocus();

    await userEvent.click(input);
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await userEvent.type(input, "Nothing");
    expect(await screen.findByText(/No quick matches for “Nothing”/)).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, "Broken");
    expect(await screen.findByText("Search is unavailable just now.")).toBeVisible();
  });

  it("does not show old results while a newer query is loading", async () => {
    let resolveCamera: ((value: QuickSearchResponse) => void) | undefined;
    vi.mocked(api.get).mockImplementation((path) => {
      const query = queryFromPath(path);
      if (query === "Cam") {
        return Promise.resolve(response(query, [result({ title: "Old camera" })]));
      }
      return new Promise<QuickSearchResponse>((resolve) => {
        resolveCamera = resolve;
      });
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search or ask about your inventory" });
    await userEvent.type(input, "Cam");
    expect(await screen.findByRole("option", { name: /Old camera/ })).toBeVisible();
    await userEvent.type(input, "era");
    await waitFor(() =>
      expect(screen.getByText("Searching your places…")).toBeVisible(),
    );
    expect(screen.queryByRole("option", { name: /Old camera/ })).not.toBeInTheDocument();
    await waitFor(() => expect(resolveCamera).toBeDefined());
    resolveCamera?.(response("Camera", [result({ title: "Fresh camera" })]));
    expect(await screen.findByRole("option", { name: /Fresh camera/ })).toBeVisible();
  });

  it("uses the global input as the Items filter while preserving other filters", async () => {
    vi.mocked(api.get).mockImplementation(async (path) =>
      response(queryFromPath(path), []),
    );
    renderSearch("/items?q=Old&sort=name_asc");
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    expect(input).toHaveValue("Old");
    await userEvent.clear(input);
    await userEvent.type(input, "Camera");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/items?q=Camera&sort=name_asc",
      ),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("/search");
  });

  it("settles and clears Items filtering with both responsive inputs mounted", async () => {
    vi.mocked(api.get).mockImplementation(async (path) =>
      response(queryFromPath(path), []),
    );
    renderSearch("/items?sort=name_asc", true);
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.type(input, "Headphones");
    await userEvent.click(document.body);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/items?sort=name_asc&q=Headphones",
      ),
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    for (const field of screen.getAllByRole("combobox", { hidden: true })) {
      expect(field).toHaveValue("Headphones");
    }
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/items?sort=name_asc"),
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    for (const field of screen.getAllByRole("combobox", { hidden: true })) {
      expect(field).toHaveValue("");
    }
  });

  it("does not overwrite navigation with pending responsive edits", async () => {
    vi.mocked(api.get).mockImplementation(async (path) =>
      response(queryFromPath(path), []),
    );
    renderSearch("/items?q=Old", true);
    const input = screen.getByRole("combobox", {
      name: "Search or ask about your inventory",
    });
    await userEvent.clear(input);
    await userEvent.type(input, "Draft");
    await userEvent.click(screen.getByRole("button", { name: "Open bookmarked search" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(screen.getByTestId("location").textContent).toBe("/items?q=Bookmarked&sort=name_asc");
    for (const field of screen.getAllByRole("combobox", { hidden: true })) {
      expect(field).toHaveValue("Bookmarked");
    }
  });
});
