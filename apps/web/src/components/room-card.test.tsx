import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RoomCard } from "@/components/room-card";
import type { Room } from "@/lib/types";

const home: Room = {
  id: "home",
  name: "Home",
  description: null,
  parent_id: null,
  sort_order: 0,
  item_count: 0,
  location_count: 0,
  total_item_count: 3,
  total_location_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const kitchen: Room = {
  ...home,
  id: "kitchen",
  name: "Kitchen",
  parent_id: "home",
  item_count: 2,
  location_count: 2,
  total_item_count: 3,
  total_location_count: 2,
};

const pantry: Room = {
  ...home,
  id: "pantry",
  name: "Pantry",
  parent_id: "kitchen",
  item_count: 1,
  location_count: 0,
  total_item_count: 1,
  total_location_count: 0,
};

describe("RoomCard", () => {
  it("shows aggregate counts and the full nested room list", () => {
    render(
      <MemoryRouter>
        <RoomCard
          room={home}
          nestedRooms={[
            { room: kitchen, depth: 1 },
            { room: pantry, depth: 2 },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("3 items · 2 places")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kitchen/ })).toHaveAttribute(
      "href",
      "/rooms/kitchen",
    );
    expect(screen.getByRole("link", { name: /Pantry/ })).toHaveAttribute(
      "href",
      "/rooms/pantry",
    );
  });
});
