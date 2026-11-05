import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PropertiesSettings } from "@/components/properties-settings";
import { api } from "@/lib/api";
import type { Property } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const properties: Property[] = [
  {
    id: "property-home",
    name: "Home",
    description: null,
    is_archived: false,
    sort_order: 0,
    room_count: 2,
    container_count: 1,
    location_count: 1,
    item_count: 3,
    total_quantity: 5,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "property-empty",
    name: "Storage unit",
    description: "Empty for now",
    is_archived: false,
    sort_order: 1,
    room_count: 0,
    container_count: 0,
    location_count: 0,
    item_count: 0,
    total_quantity: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useProperties: () => ({ data: { items: properties }, isPending: false, isError: false }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(async () => properties[0]),
      patch: vi.fn(async () => properties[0]),
      delete: vi.fn(async () => undefined),
    },
  };
});

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PropertiesSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.post).mockClear();
  vi.mocked(api.patch).mockClear();
  vi.mocked(api.delete).mockClear();
});

describe("PropertiesSettings", () => {
  it("lists properties and guards populated archive and delete actions", () => {
    renderSettings();
    expect(screen.getByText("Home")).toBeVisible();
    expect(screen.getByText("Storage unit")).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive Storage unit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete Storage unit" })).toBeEnabled();
  });

  it("opens the add-property form and submits a name with an optional description", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await userEvent.type(screen.getByLabelText("Property name"), "Cabin");
    await userEvent.type(screen.getByLabelText(/Description/), "Quiet place");
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith("/properties", {
        name: "Cabin",
        description: "Quiet place",
      }),
    );
  });
});
