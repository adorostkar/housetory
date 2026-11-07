import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemImageControls } from "@/components/item-image-controls";
import { api } from "@/lib/api";
import type { ItemImage, ItemImageState } from "@/lib/types";

const baseImage: ItemImage = {
  id: "image-1",
  source_type: "reference",
  label: "Reference image",
  status: "active",
  url: "/api/v1/item-images/image-1/file",
  thumbnail_url: "/api/v1/item-images/image-1/thumbnail",
  width: 1200,
  height: 800,
  source_name: "lg.com",
  source_url: "https://media.lg.com/tv.png",
  source_page_url: "https://www.lg.com/tv",
  license_note:
    "Provider metadata records the license cc-by. This is recorded evidence, not an independent legal determination.",
  license_name: "cc-by",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  permission_basis: "provider_license",
  retrieved_at: "2026-01-01T00:00:00Z",
  exact_model_confirmed: false,
  model_label: null,
  provider_label: null,
  created_at: "2026-01-01T00:00:00Z",
};

const baseState: ItemImageState = {
  item_id: "item-1",
  actual_photo_count: 0,
  image: baseImage,
  selected: baseImage,
  settings: { auto_reference: false },
  search_configured: true,
  search_provider_label: "Brave Image Search API",
  search_reason: null,
};

let state = baseState;

const permissions = vi.hoisted(() => ({ canWrite: true }));

const aiImage: ItemImage = {
  ...baseImage,
  id: "image-ai",
  source_type: "ai",
  label: "AI illustration",
  status: "active",
  source_name: "OpenAI",
  source_page_url: null,
  exact_model_confirmed: false,
  provider_label: "OpenAI",
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => permissions.canWrite,
    useItemImage: (itemId: string) =>
      useQuery({
        queryKey: actual.queryKeys.itemImage(itemId),
        queryFn: async () => state,
        staleTime: Infinity,
      }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
      delete: vi.fn(),
    },
  };
});

function renderControls() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["items", "item-1", "image"], state);
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ItemImageControls itemId="item-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

beforeEach(() => {
  state = baseState;
  permissions.canWrite = true;
  vi.mocked(api.post).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe("ItemImageControls", () => {
  it("shows concise reference attribution and expands technical details", async () => {
    vi.mocked(api.post).mockResolvedValue(state);
    renderControls();
    expect(screen.getAllByText(/Reference image/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/exact model not confirmed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/retrieved 2026-01-01/)).toBeVisible();
    expect(screen.queryByText(/not an independent legal determination/)).not.toBeVisible();
    await userEvent.click(screen.getByText("Image details"));
    expect(screen.getByRole("link", { name: "cc-by" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/",
    );
    expect(screen.getByText(/not an independent legal determination/)).toBeVisible();
    expect(screen.getByText("1200 × 800")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Change online image/ }));
    expect(api.post).toHaveBeenCalledWith("/items/item-1/image/find", { force: true });
  });

  it("resets a selected reference or AI image to the category icon", async () => {
    vi.mocked(api.delete).mockResolvedValue({
      ...state,
      image: null,
      selected: null,
    });
    renderControls();
    await userEvent.click(screen.getByRole("button", { name: /Use icon/ }));
    expect(api.delete).toHaveBeenCalledWith("/items/item-1/image");
  });

  it("keeps Find online image with a clear setup state and no generation control", async () => {
    state = {
      ...baseState,
      image: null,
      selected: null,
      search_configured: false,
      search_provider_label: null,
      search_reason:
        "Reference-image search is disabled in Settings → Online search.",
    };
    renderControls();
    expect(screen.getByRole("button", { name: /Find online image/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Generate illustration/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Setup required")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /Find online image/ }));
    expect(screen.getByText("Online image lookup setup required")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open online search settings" }),
    ).toHaveAttribute("href", "/settings#online-search");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not expose image actions to viewers", () => {
    permissions.canWrite = false;
    state = { ...baseState, image: null, selected: null };
    renderControls();
    expect(
      screen.queryByRole("button", { name: /Find online image/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Generate illustration/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps controls hidden when an actual photo takes priority", () => {
    state = {
      ...baseState,
      actual_photo_count: 1,
      image: null,
      selected: null,
    };
    renderControls();
    expect(screen.getByText("Actual photo is used")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Find online image/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps an existing AI illustration readable, honestly labelled and removable", async () => {
    state = {
      ...baseState,
      image: aiImage,
      selected: aiImage,
    };
    renderControls();
    expect(screen.getAllByText("AI illustration").length).toBeGreaterThan(0);
    expect(screen.getByText(/not a photo/)).toBeVisible();
    await userEvent.click(screen.getByText("Image details"));
    expect(screen.getByText(/not evidence of the item's condition/)).toBeVisible();
    expect(screen.getByText(/new illustrations are no longer generated/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Find online image/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Use icon/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Generate illustration/ }),
    ).not.toBeInTheDocument();
  });
});
