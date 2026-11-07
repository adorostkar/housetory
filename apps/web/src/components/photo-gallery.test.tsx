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

function renderGallery(
  item: ItemDetail,
  representative: ItemDetail["representative_image"] = null,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PhotoGallery item={item} representative={representative} />
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

  it("bounds the actual-photo gallery and shows the whole image without cropping", () => {
    renderGallery({
      ...baseItem,
      photos: [photo],
      primary_photo: photo,
    });
    const frame = screen.getByTestId("photo-gallery-frame");
    expect(frame).toHaveClass("h-[240px]", "sm:h-[320px]", "xl:h-[340px]");
    const image = screen.getByAltText("Heavy drill photograph");
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
    expect(image).not.toHaveClass("size-full");
    expect(screen.getByRole("button", { name: /View Heavy drill photograph full screen/ })).toBeVisible();
  });

  it("fits a representative image inside a padded frame without cropping", () => {
    renderGallery(baseItem, {
      id: "image-ref",
      source_type: "reference",
      label: "Reference image",
      status: "active",
      url: "/api/v1/item-images/image-ref/file",
      thumbnail_url: "/api/v1/item-images/image-ref/thumbnail",
      width: 1600,
      height: 900,
      source_name: "Example",
      source_url: null,
      source_page_url: null,
      license_note: null,
      retrieved_at: "2026-01-01T00:00:00Z",
      exact_model_confirmed: false,
      model_label: null,
      provider_label: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    const frame = screen.getByTestId("photo-gallery-frame");
    expect(frame).toHaveClass("h-[240px]", "sm:h-[320px]", "xl:h-[340px]");
    expect(frame).not.toHaveClass("min-h-[150px]");
    const image = screen.getByRole("img", { name: /Reference image/i });
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
    expect(image.parentElement).toHaveClass("bg-secondary/30", "p-3", "sm:p-4");
    expect(screen.queryByText("No photograph yet")).not.toBeInTheDocument();
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
