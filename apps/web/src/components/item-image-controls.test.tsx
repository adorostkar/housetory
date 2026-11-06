import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemImageControls } from "@/components/item-image-controls";
import { api } from "@/lib/api";
import type { ItemImage, ItemImageState } from "@/lib/types";

const baseImage: ItemImage = {
  id: "image-1",
  source_type: "reference",
  label: "Reference image",
  status: "active",
  illustration_key: null,
  url: "/api/v1/item-images/image-1/file",
  thumbnail_url: "/api/v1/item-images/image-1/thumbnail",
  width: 1200,
  height: 800,
  source_name: "lg.com",
  source_url: "https://media.lg.com/tv.png",
  source_page_url: "https://www.lg.com/tv",
  license_note: "Manufacturer-hosted image; reuse rights not independently verified.",
  retrieved_at: "2026-01-01T00:00:00Z",
  exact_model_confirmed: false,
  model_label: null,
  provider_label: null,
  automatic: false,
  created_at: "2026-01-01T00:00:00Z",
};

const state: ItemImageState = {
  item_id: "item-1",
  actual_photo_count: 0,
  image: baseImage,
  selected: baseImage,
  automatic_builtin: null,
  pending: [],
  builtin_options: [{ key: "tv", label: "Television" }],
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
  automatic: false,
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
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
      <ItemImageControls itemId="item-1" />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe("ItemImageControls", () => {
  it("shows reference provenance and automatically calls Find image", async () => {
    vi.mocked(api.post).mockResolvedValue(state);
    renderControls();
    expect(screen.getAllByText(/Reference image/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/exact model not confirmed/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /Change image/ }));
    expect(api.post).toHaveBeenCalledWith("/items/item-1/image/find", { force: true });
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
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(api.post).toHaveBeenCalledWith("/items/item-1/images/image-ai/accept");
  });
});
