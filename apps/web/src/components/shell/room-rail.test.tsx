import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoomRail, useRailModel } from "@/components/shell/room-rail";
import { api } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const room = (id: string, name: string, parent_id: string | null = null) => ({
  id,
  name,
  parent_id,
  description: null,
  sort_order: 0,
  item_count: 1,
  location_count: 0,
  total_item_count: 2,
  total_location_count: 0,
  created_at: "",
  updated_at: "",
});

function Rail() {
  return <RoomRail model={useRailModel()} />;
}

function renderRail(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Rail />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith("/properties")) return { items: [] };
    if (path.startsWith("/rooms")) {
      return { items: [room("garage", "Garage"), room("bench", "Bench corner", "garage"), room("attic", "Attic")] };
    }
    if (path.startsWith("/loans")) {
      return { items: [], total: 0, limit: 1, offset: 0, outstanding_count: 3, overdue_count: 1, on_loan_quantity: 3 };
    }
    throw new Error(`Unexpected request ${path}`);
  });
});

describe("RoomRail", () => {
  it("lists top-level rooms and marks the room an item was opened from", async () => {
    renderRail("/items/item-1?from=%2Frooms%2Fbench&from_label=Bench");
    const rail = screen.getByRole("navigation", { name: "Rooms" });

    // The nested room is not a tile; its top-level room is the current place.
    expect(await within(rail).findByRole("link", { name: "Garage" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryByRole("link", { name: "Bench corner" })).not.toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
    expect(await within(rail).findByRole("link", { name: /On loan.*1.*overdue/ })).toBeInTheDocument();
  });

  it("rolls the other destinations up over the rooms and back down", async () => {
    renderRail("/items");
    const rail = screen.getByRole("navigation", { name: "Rooms" });
    await within(rail).findByRole("link", { name: "Attic" });

    await userEvent.click(within(rail).getByRole("button", { name: "More" }));
    const choices = within(rail).getByTestId("rail-more");
    expect(within(choices).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/rooms", "/documents", "/purchases", "/insurance", "/stocktake", "/review", "/settings",
    ]);
    // The rooms under the choices cannot be reached.
    expect(within(rail).getByRole("link", { name: "Attic", hidden: true }).closest("[inert]")).not.toBeNull();

    await userEvent.click(within(rail).getByRole("button", { name: "Close" }));
    expect(within(rail).getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  });
});
