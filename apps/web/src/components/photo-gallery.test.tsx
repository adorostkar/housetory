import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { PhotoGallery } from "@/components/photo-gallery";
import type { ItemDetail } from "@/lib/types";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useInvalidateInventory: () => vi.fn(),
  };
});

const baseItem: ItemDetail = {
  id: "item-1",
  name: "Heavy drill",
  description: null,
  brand: "Makita",
  model: "HP-2",
  serial_number: null,
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
  photos: [],
  documents: [],
  import_source: null,
};

const photo = {
  id: "photo-1",
  original_filename: "drill.jpg",
  content_type: "image/jpeg",
  byte_size: 1000,
  width: 800,
  height: 600,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  url: "/api/v1/photos/photo-1/file",
  thumbnail_url: "/api/v1/photos/photo-1/thumbnail",
};

function renderGallery(item: ItemDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PhotoGallery item={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PhotoGallery", () => {
  it("uses one compact set of empty-photo upload controls", () => {
    renderGallery(baseItem);
    expect(screen.getByText("No photograph yet")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose photo" })).toHaveLength(1);
    expect(
      screen.queryAllByRole("button", { name: "Take a photo" }),
    ).toHaveLength(0);
    expect(
      screen.queryAllByRole("button", { name: "Choose a photo" }),
    ).toHaveLength(0);
    expect(screen.queryByLabelText("Add photographs")).not.toBeInTheDocument();
  });

  it("keeps one upload control pair for populated galleries", () => {
    renderGallery({
      ...baseItem,
      photos: [photo],
      primary_photo: photo,
    });
    expect(screen.getByAltText("Heavy drill photograph")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take a photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose a photo" })).toHaveLength(1);
    expect(
      screen.queryAllByRole("button", { name: "Take photo" }),
    ).toHaveLength(0);
    expect(
      screen.queryAllByRole("button", { name: "Choose photo" }),
    ).toHaveLength(0);
  });
});
