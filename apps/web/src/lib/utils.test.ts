import { describe, expect, it } from "vitest";

import type { Room } from "@/lib/types";
import {
  buildRoomTree,
  collectDescendantIds,
  flattenRoomTree,
  formatCurrency,
  formatFileSize,
  greetingForHour,
  initials,
  locationPath,
  pluralize,
  roomDescendantsWithDepth,
  roomPath,
} from "@/lib/utils";

function room(id: string, name: string, parentId: string | null = null): Room {
  return {
    id,
    name,
    description: null,
    parent_id: parentId,
    sort_order: 0,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("room hierarchy", () => {
  const rooms = [
    room("house", "House"),
    room("kitchen", "Kitchen", "house"),
    room("pantry", "Pantry", "kitchen"),
    room("garage", "Garage"),
  ];

  it("builds a nested tree and preserves root order", () => {
    const tree = buildRoomTree(rooms);
    expect(tree.map((node) => node.id)).toEqual(["house", "garage"]);
    expect(tree[0]?.children[0]?.id).toBe("kitchen");
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("pantry");
  });

  it("flattens the tree with depth markers", () => {
    const flat = flattenRoomTree(rooms);
    expect(flat.map((entry) => [entry.room.id, entry.depth])).toEqual([
      ["house", 0],
      ["kitchen", 1],
      ["pantry", 2],
      ["garage", 0],
    ]);
  });

  it("finds descendants without looping on bad data", () => {
    expect([...collectDescendantIds(rooms, "house")].sort()).toEqual([
      "kitchen",
      "pantry",
    ]);
    const cyclic = [room("a", "A", "b"), room("b", "B", "a")];
    expect(collectDescendantIds(cyclic, "a").size).toBeGreaterThanOrEqual(0);
  });

  it("returns the path from the root", () => {
    expect(roomPath(rooms, "pantry").map((entry) => entry.name)).toEqual([
      "House",
      "Kitchen",
      "Pantry",
    ]);
  });

  it("lists all nested rooms with relative depth", () => {
    expect(
      roomDescendantsWithDepth(rooms, "house").map((entry) => [
        entry.room.name,
        entry.depth,
      ]),
    ).toEqual([
      ["Kitchen", 1],
      ["Pantry", 2],
    ]);
  });

  it("keeps a location path from root to leaf", () => {
    const locations = [
      { id: "cabinet", parent_id: null, name: "Cabinet" },
      { id: "shelf", parent_id: "cabinet", name: "Top Shelf" },
      { id: "box", parent_id: "shelf", name: "Spice Box" },
    ];
    expect(locationPath(locations, "box").map((entry) => entry.name)).toEqual([
      "Cabinet",
      "Top Shelf",
      "Spice Box",
    ]);
  });
});

describe("formatting helpers", () => {
  it("formats currency from integer cents", () => {
    expect(formatCurrency(12345, "USD")).toMatch(/\$/);
    expect(formatCurrency(12345, "USD")).toContain("123.45");
    expect(formatCurrency(120000, "USD", { compact: true })).toContain("1.2");
  });

  it("formats file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("produces initials for one or more names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Housetory")).toBe("H");
    expect(initials("  ")).toBe("H");
  });

  it("pluralizes only when needed", () => {
    expect(pluralize(1, "item")).toBe("1 item");
    expect(pluralize(0, "item")).toBe("0 items");
    expect(pluralize(2, "shelf", "shelves")).toBe("2 shelves");
  });

  it("chooses a greeting for the hour", () => {
    expect(greetingForHour(3)).toBe("Good evening");
    expect(greetingForHour(9)).toBe("Good morning");
    expect(greetingForHour(14)).toBe("Good afternoon");
    expect(greetingForHour(20)).toBe("Good evening");
  });
});
