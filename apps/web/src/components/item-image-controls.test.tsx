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
  pending: [],
  settings: {
    auto_reference: false,
    auto_generate: false,
    daily_generation_cap: 10,
    daily_generations_used: 0,
    daily_generations_remaining: 10,
  },
  search_configured: true,
  search_provider_label: "Brave Image Search API",
  search_reason: null,
  generation_configured: true,
  generation_provider_label: "OpenAI",
  generation_reason: null,
};

let state = baseState;

const permissions = vi.hoisted(() => ({ canWrite: true }));

const aiPending: ItemImage = {
  ...baseImage,
  id: "image-ai",
  source_type: "ai",
  label: "AI illustration",
  status: "pending",
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
  it("shows reference provenance and automatically calls Find online image", async () => {
    vi.mocked(api.post).mockResolvedValue(state);
    renderControls();
    expect(screen.getAllByText(/Reference image/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/exact model not confirmed/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "cc-by" }),
    ).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
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

  it("keeps Find online image and Generate visible with clear setup states", async () => {
    state = {
      ...baseState,
      image: null,
      selected: null,
      search_configured: false,
      search_provider_label: null,
      search_reason:
        "Reference-image search is not configured. Set BRAVE_SEARCH_API_KEY and ITEM_IMAGE_PERMITTED_SOURCE_DOMAINS.",
      generation_configured: false,
      generation_provider_label: null,
      generation_reason:
        "Item illustration generation is not configured. Choose an image-output model.",
    };
    renderControls();
    expect(
      screen.getByRole("button", { name: /Find online image/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Generate illustration/ }),
    ).toBeVisible();
    expect(screen.getAllByText("Setup required")).toHaveLength(2);

    await userEvent.click(
      screen.getByRole("button", { name: /Find online image/ }),
    );
    expect(
      screen.getByText("Online image lookup setup required"),
    ).toBeVisible();
    expect(screen.getAllByText(/BRAVE_SEARCH_API_KEY/).length).toBeGreaterThan(0);
    expect(screen.getByText(/AI provider key does not enable online lookup/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open image settings" }),
    ).toHaveAttribute("href", "/settings#item-images");
    expect(api.post).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: /Generate illustration/ }),
    );
    const generationPanel = screen
      .getByText("AI illustration setup required")
      .closest("div.mt-3");
    expect(generationPanel).toHaveTextContent(
      /An online image-search key does not enable AI generation/,
    );
    expect(
      screen.getByRole("link", { name: "Open AI provider settings" }),
    ).toHaveAttribute("href", "/settings/ai");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not expose review or image actions to viewers", () => {
    permissions.canWrite = false;
    state = { ...baseState, image: null, selected: null, pending: [aiPending] };
    renderControls();
    expect(screen.getByText("AI illustration preview")).toBeVisible();
    expect(screen.getByText("Awaiting review")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole("button", { name: /Generate illustration/ }),
    ).not.toBeInTheDocument();
  });

  it("generates a pending AI preview and accepts it explicitly", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({ ...state, pending: [aiPending] })
      .mockResolvedValueOnce({ ...state, image: aiPending, selected: aiPending, pending: [] });
    const { client } = renderControls();
    await userEvent.click(screen.getByRole("button", { name: /Generate/ }));
    expect(api.post).toHaveBeenCalledWith("/items/item-1/illustration");
    await vi.waitFor(() => {
      expect(client.getQueryData(["items", "item-1", "image"])).toMatchObject({
        pending: [{ id: "image-ai" }],
      });
    });
    expect(await screen.findByText("AI illustration preview")).toBeVisible();
    expect(
      screen.getByRole("img", { name: "Pending AI illustration preview" }),
    ).toHaveClass("object-contain");
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(api.post).toHaveBeenCalledWith("/items/item-1/images/image-ai/accept");
  });
});
