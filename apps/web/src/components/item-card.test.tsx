import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ItemCard } from "@/components/item-card";
import type { ItemSummary } from "@/lib/types";

const item: ItemSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Espresso Machine",
  description: "A small daily ritual.",
  brand: "La Marzocco",
  model: "Linea Mini",
  quantity: 1,
  condition: "excellent",
  is_archived: false,
  room: { id: "room-1", name: "Kitchen" },
  location: {
    id: "location-1",
    name: "Coffee Shelf",
    kind: "shelf",
    parent_id: null,
    identifier: "SHELF-001",
    container_type: null,
    is_container: false,
  },
  location_path: [
    {
      id: "location-1",
      name: "Coffee Shelf",
      kind: "shelf",
      parent_id: null,
      identifier: "SHELF-001",
      container_type: null,
      is_container: false,
    },
  ],
  category: { id: "category-1", name: "Kitchenware", color: "#8A9A82" },
  tags: [{ id: "tag-1", name: "daily" }],
  primary_photo: {
    id: "photo-1",
    original_filename: "machine.jpg",
    content_type: "image/jpeg",
    byte_size: 1200,
    width: 800,
    height: 600,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    url: "/api/v1/photos/photo-1/file",
    thumbnail_url: "/api/v1/photos/photo-1/thumbnail",
  },
  purchase: {
    id: "purchase-1",
    merchant: "Local dealer",
    vendor: "Local dealer",
    purchase_date: "2026-01-01",
    price_cents: 250000,
    currency: "USD",
    order_number: null,
    notes: null,
    receipt_document_id: null,
    receipt: null,
    items: [{ id: "item-1", name: "Espresso Machine" }],
    allocations: [],
    allocated_total_cents: 0,
    unallocated_cents: 250000,
    item_count: 1,
    is_shared: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  purchase_info_status: "recorded",
  purchase_info_missing_fields: [],
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("ItemCard", () => {
  it("links to the item and exposes its key details", () => {
    render(
      <MemoryRouter>
        <ItemCard item={item} />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `/items/${item.id}`);
    expect(screen.getByText("Espresso Machine")).toBeInTheDocument();
    expect(screen.getByText("La Marzocco · Linea Mini")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
    expect(screen.getByText("SHELF-001 · Coffee Shelf")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Espresso Machine" })).toHaveAttribute(
      "src",
      item.primary_photo?.thumbnail_url,
    );
  });

  it("shows an arch placeholder when no photograph exists", () => {
    render(
      <MemoryRouter>
        <ItemCard item={{ ...item, primary_photo: null, purchase: null }} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Kitchenware")).toBeInTheDocument();
  });
});

describe("ItemCard image sources", () => {
  it("shows a reference image and source label when no actual photo exists", () => {
    render(
      <MemoryRouter>
        <ItemCard
          item={{
            ...item,
            primary_photo: null,
            representative_image: {
              id: "image-ref",
              source_type: "reference",
              label: "Reference image",
              status: "active",
              illustration_key: null,
              url: "/api/v1/item-images/image-ref/file",
              thumbnail_url: "/api/v1/item-images/image-ref/thumbnail",
              width: 1200,
              height: 800,
              source_name: "lg.com",
              source_url: "https://media.lg.com/tv.png",
              source_page_url: "https://www.lg.com/tv",
              license_note: "Source page recorded.",
              retrieved_at: "2026-01-01T00:00:00Z",
              exact_model_confirmed: false,
              model_label: null,
              provider_label: null,
              automatic: false,
              created_at: "2026-01-01T00:00:00Z",
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: /Reference image/i })).toHaveAttribute(
      "src",
      "/api/v1/item-images/image-ref/thumbnail",
    );
    expect(screen.getByText("Reference")).toBeVisible();
  });

  it("shows a built-in illustration instead of an empty placeholder", () => {
    render(
      <MemoryRouter>
        <ItemCard
          item={{
            ...item,
            primary_photo: null,
            representative_image: {
              id: null,
              source_type: "builtin",
              label: "Generic illustration",
              status: "active",
              illustration_key: "drill",
              url: null,
              thumbnail_url: null,
              width: null,
              height: null,
              source_name: null,
              source_url: null,
              source_page_url: null,
              license_note: null,
              retrieved_at: null,
              exact_model_confirmed: false,
              model_label: null,
              provider_label: null,
              automatic: true,
              created_at: null,
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "Generic illustration" })).toBeVisible();
    expect(screen.getByText("Illustration")).toBeVisible();
  });

  it("keeps the actual photo ahead of a stored reference image", () => {
    render(
      <MemoryRouter>
        <ItemCard
          item={{
            ...item,
            representative_image: {
              id: "image-ai",
              source_type: "ai",
              label: "AI illustration",
              status: "active",
              illustration_key: null,
              url: "/api/v1/item-images/ai/file",
              thumbnail_url: "/api/v1/item-images/ai/thumbnail",
              width: 800,
              height: 600,
              source_name: "OpenAI",
              source_url: null,
              source_page_url: null,
              license_note: null,
              retrieved_at: null,
              exact_model_confirmed: false,
              model_label: null,
              provider_label: "OpenAI",
              automatic: false,
              created_at: "2026-01-01T00:00:00Z",
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "Espresso Machine" })).toHaveAttribute(
      "src",
      item.primary_photo?.thumbnail_url,
    );
    expect(screen.queryByText("AI illustration")).not.toBeInTheDocument();
  });
});
