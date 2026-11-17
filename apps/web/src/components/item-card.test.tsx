import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderWithoutProviders, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ItemCard, ItemRow } from "@/components/item-card";
import { queryKeys } from "@/lib/query-keys";
import type { HouseholdMembership, ItemSummary, SearchScopeHousehold } from "@/lib/types";

function membership(id: string, name: string, propertyCount = 1): HouseholdMembership {
  return {
    id,
    name,
    default_currency: "USD",
    warranty_reminder_days: 30,
    role: "owner",
    property_count: propertyCount,
    is_current: id === "household-1",
  };
}

function render(
  ui: ReactElement,
  households: HouseholdMembership[] = [membership("household-1", "Home")],
  scopes: SearchScopeHousehold[] = [],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.session, {
    authenticated: true,
    setup_required: false,
    user: null,
    household: households[0],
    role: "owner",
    households,
  });
  client.setQueryData(queryKeys.searchScopes, { items: scopes });
  return renderWithoutProviders(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
  current_value_basis: null,
  current_value_total_cents: null,
  current_value_estimated_at: null,
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
    const photo = screen.getByRole("img", { name: "Espresso Machine" });
    expect(photo).toHaveAttribute("src", item.primary_photo?.thumbnail_url);
    expect(photo).toHaveClass("object-contain");
    expect(photo).not.toHaveClass("object-cover");
  });

  it("shows a simple category icon when no photograph exists", () => {
    render(
      <MemoryRouter>
        <ItemCard item={{ ...item, primary_photo: null, purchase: null }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "Category icon" })).toBeVisible();
    expect(screen.getByText("Kitchenware")).toBeInTheDocument();
  });
});

describe("item location breadcrumb", () => {
  const placed: ItemSummary = {
    ...item,
    household: { id: "household-1", name: "Home" },
    property: { id: "property-1", name: "Flat", is_archived: false },
  };
  const fullPath = "Home / Flat / Kitchen / SHELF-001 · Coffee Shelf";
  const hallwayPlace = { ...item.location!, name: "hallway ", identifier: "HAL-001" };
  const hallway: ItemSummary = {
    ...placed,
    room: { id: "room-2", name: "Hallway" },
    location: hallwayPlace,
    location_path: [hallwayPlace],
  };

  function renderBoth(
    entry: ItemSummary,
    households?: HouseholdMembership[],
    scopes?: SearchScopeHousehold[],
  ) {
    const shownBy = (Component: typeof ItemCard | typeof ItemRow) => {
      const view = render(
        <MemoryRouter>
          <Component item={entry} />
        </MemoryRouter>,
        households,
        scopes,
      );
      const crumb = screen.getByTitle(/Kitchen|Hallway/);
      const shown = {
        visible: crumb.querySelector("[aria-hidden]")?.textContent,
        title: crumb.getAttribute("title"),
        accessible: crumb.querySelector(".sr-only")?.textContent,
      };
      expect(screen.getByRole("link")).toContainElement(crumb);
      view.unmount();
      return shown;
    };
    const card = shownBy(ItemCard);
    const row = shownBy(ItemRow);
    expect(card.title).toBe(row.title);
    expect(card.accessible).toBe(card.title);
    expect(row.accessible).toBe(row.title);
    return { cardText: card.visible, rowText: row.visible, title: card.title };
  }

  it("omits the household and property when there is only one of each", () => {
    const shown = renderBoth(placed);
    expect(shown.cardText).toBe("Kitchen/SHELF-001 · Coffee Shelf");
    expect(shown.rowText).toBe("Kitchen / SHELF-001 · Coffee Shelf");
    expect(shown.title).toBe(fullPath);
  });

  it("keeps the household when the user belongs to several", () => {
    const shown = renderBoth(placed, [
      membership("household-1", "Home"),
      membership("household-2", "Cabin"),
    ]);
    expect(shown.cardText).toBe("Home/Kitchen/SHELF-001 · Coffee Shelf");
    expect(shown.rowText).toBe("Home / Kitchen / SHELF-001 · Coffee Shelf");
    expect(shown.title).toBe(fullPath);
  });

  it("keeps the property when its household has several active ones", () => {
    const shown = renderBoth(
      placed,
      [membership("household-1", "Home", 2)],
      [
        {
          id: "household-1",
          name: "Home",
          role: "owner",
          properties: [
            { id: "property-1", name: "Flat", is_archived: false },
            { id: "property-2", name: "Cabin", is_archived: false },
          ],
        },
      ],
    );
    expect(shown.cardText).toBe("Flat/Kitchen/SHELF-001 · Coffee Shelf");
    expect(shown.rowText).toBe("Flat / Kitchen / SHELF-001 · Coffee Shelf");
    expect(shown.title).toBe(fullPath);
  });

  it("does not count archived properties, but still names an archived one", () => {
    const households = [membership("household-1", "Home", 2)];
    const scopes: SearchScopeHousehold[] = [
      {
        id: "household-1",
        name: "Home",
        role: "owner",
        properties: [{ id: "property-1", name: "Flat", is_archived: false }],
      },
    ];
    expect(renderBoth(placed, households, scopes).rowText).toBe(
      "Kitchen / SHELF-001 · Coffee Shelf",
    );
    const archived = {
      ...placed,
      property: { id: "property-2", name: "Old flat", is_archived: true },
    };
    expect(renderBoth(archived, households, scopes).rowText).toBe(
      "Old flat / Kitchen / SHELF-001 · Coffee Shelf",
    );
  });

  it("shows a place named like its room once, with an identifier hint", () => {
    const shown = renderBoth(hallway);
    expect(shown.cardText).toBe("Hallway · HAL-001");
    expect(shown.rowText).toBe("Hallway · HAL-001");
    expect(shown.title).toBe("Home / Flat / Hallway / HAL-001 · hallway ");
  });

  it("falls back to the place type when the same-named place has no identifier", () => {
    const place = { ...hallway.location!, name: "Hallway", identifier: null };
    const shown = renderBoth({ ...hallway, location: place, location_path: [place] });
    expect(shown.cardText).toBe("Hallway · shelf");
    expect(shown.rowText).toBe("Hallway · shelf");
    expect(shown.title).toBe("Home / Flat / Hallway / Hallway");
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
              created_at: "2026-01-01T00:00:00Z",
            },
          }}
        />
      </MemoryRouter>,
    );
    const image = screen.getByRole("img", { name: /Reference image/i });
    expect(image).toHaveAttribute("src", "/api/v1/item-images/image-ref/thumbnail");
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
    expect(image.parentElement).toHaveClass("bg-white");
    expect(screen.getByText("Reference")).toBeVisible();
  });

  it("fits actual photos inside compact list thumbnails without cropping", () => {
    render(
      <MemoryRouter>
        <ItemRow item={item} />
      </MemoryRouter>,
    );
    const image = screen.getByRole("link").querySelector("img");
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
  });

  it("fits representative images inside compact list thumbnails without cropping", () => {
    render(
      <MemoryRouter>
        <ItemRow
          item={{
            ...item,
            primary_photo: null,
            representative_image: {
              id: "image-list",
              source_type: "reference",
              label: "Reference image",
              status: "active",
              url: "/api/v1/item-images/image-list/file",
              thumbnail_url: "/api/v1/item-images/image-list/thumbnail",
              width: 1600,
              height: 900,
              source_name: "Example",
              source_url: null,
              source_page_url: null,
              license_note: null,
              retrieved_at: null,
              exact_model_confirmed: false,
              model_label: null,
              provider_label: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          }}
        />
      </MemoryRouter>,
    );
    const image = screen.getByRole("link").querySelector("img");
    expect(image).toHaveClass("object-contain", "bg-white");
    expect(image).not.toHaveClass("object-cover");
  });

  it("uses the category icon instead of any built-in artwork", () => {
    render(
      <MemoryRouter>
        <ItemCard
          item={{
            ...item,
            primary_photo: null,
            representative_image: null,
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "Category icon" })).toBeVisible();
    expect(screen.queryByText("Illustration")).not.toBeInTheDocument();
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
