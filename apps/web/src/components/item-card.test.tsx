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
  },
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
    item_count: 1,
    is_shared: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
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
    expect(screen.getByText("Coffee Shelf")).toBeInTheDocument();
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
