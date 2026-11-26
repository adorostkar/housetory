import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  current_value_basis: null,
  current_value_total_cents: null,
  current_value_estimated_at: null,
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
  children?: React.ReactNode,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PhotoGallery item={item} representative={representative}>
          {children}
        </PhotoGallery>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PhotoGallery", () => {
  it("shows a small placeholder and one add tile when there is no photograph", () => {
    renderGallery(baseItem);
    expect(screen.getByText("No photograph yet")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take a photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose a photo" })).toHaveLength(1);
    expect(screen.queryByTestId("photo-gallery-frame")).not.toBeInTheDocument();
  });

  it("shows small thumbnails that open the whole photograph full screen", async () => {
    renderGallery({
      ...baseItem,
      photos: [photo, { ...photo, id: "photo-2", sort_order: 1 }],
      primary_photo: photo,
    });
    const first = screen.getByRole("button", { name: "View photograph 1" });
    expect(first).toHaveClass("size-24");
    expect(first.querySelector("img")).toHaveClass("object-contain");
    expect(first.querySelector("img")).toHaveAttribute("src", photo.thumbnail_url);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View photograph 2" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("keeps reordering, cover, delete and the image source behind Manage photos", async () => {
    renderGallery(
      {
        ...baseItem,
        photos: [photo, { ...photo, id: "photo-2", sort_order: 1 }],
        primary_photo: photo,
      },
      null,
      <p>image source</p>,
    );
    expect(screen.queryByText("image source")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete photograph" })).not.toBeInTheDocument();

    const manage = screen.getByRole("button", { name: "Manage photos" });
    await userEvent.click(manage);
    expect(manage).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("image source")).toBeVisible();
    expect(screen.getByText(/Photograph 1 of 2 · cover/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Move photograph earlier" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Set as cover photograph" })).not.toBeInTheDocument();

    // While managing, a tap chooses the photograph instead of opening it.
    await userEvent.click(screen.getByRole("button", { name: "Choose photograph 2" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Photograph 2 of 2/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Set as cover photograph" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete photograph" })).toBeEnabled();
  });

  it("fits a representative image inside a small tile without cropping", () => {
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
    const image = screen.getByRole("img", { name: /Reference image/i });
    expect(image).toHaveClass("object-contain");
    expect(image.parentElement).toHaveClass("bg-white", "size-24");
    expect(screen.getByText("Reference image")).toBeVisible();
    expect(screen.queryByText("No photograph yet")).not.toBeInTheDocument();
  });
});
