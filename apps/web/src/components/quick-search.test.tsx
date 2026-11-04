import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
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
    ...overrides,
  };
}

function response(query: string, results: QuickSearchResult[]): QuickSearchResponse {
  return { query, results };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderSearch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <QuickSearch />
        <LocationProbe />
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
    const input = screen.getByRole("combobox", { name: "Search your home" });
    await userEvent.type(input, "Camera");
    const panel = await screen.findByRole("listbox", { name: "Quick search results" });
    expect(within(panel).getByText("Items")).toBeVisible();
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
    const input = screen.getByRole("combobox", { name: "Search your home" });
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
    const input = screen.getByRole("combobox", { name: "Search your home" });
    await userEvent.type(input, "Camera");
    await screen.findByRole("option", { name: /Camera Body/ });
    await userEvent.click(screen.getByRole("button", { name: /View all results/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/search?q=Camera"),
    );
  });

  it("opens all results with Enter before selecting a result and preserves the query", async () => {
    const pending = new Promise<QuickSearchResponse>(() => undefined);
    vi.mocked(api.get).mockReturnValue(pending);
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search your home" });
    await userEvent.type(input, "Blue box");
    expect(await screen.findByText("Searching your home…")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/search?q=${encodeURIComponent("Blue box")}`,
      ),
    );
  });

  it("closes on Escape, clears stale state and handles empty and error states", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const query = queryFromPath(path);
      if (query === "Broken") throw new Error("Search failed");
      if (query === "Nothing") return response(query, []);
      return response(query, [result({})]);
    });
    renderSearch();
    const input = screen.getByRole("combobox", { name: "Search your home" });
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
    expect(await screen.findByText(/No matches for “Nothing”/)).toBeVisible();
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
    const input = screen.getByRole("combobox", { name: "Search your home" });
    await userEvent.type(input, "Cam");
    expect(await screen.findByRole("option", { name: /Old camera/ })).toBeVisible();
    await userEvent.type(input, "era");
    await waitFor(() =>
      expect(screen.getByText("Searching your home…")).toBeVisible(),
    );
    expect(screen.queryByRole("option", { name: /Old camera/ })).not.toBeInTheDocument();
    await waitFor(() => expect(resolveCamera).toBeDefined());
    resolveCamera?.(response("Camera", [result({ title: "Fresh camera" })]));
    expect(await screen.findByRole("option", { name: /Fresh camera/ })).toBeVisible();
  });
});
