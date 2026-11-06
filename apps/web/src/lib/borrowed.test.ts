import { describe, expect, it } from "vitest";

import {
  borrowedLocationHeading,
  borrowedLocationPrefix,
  borrowedWhereLabel,
} from "@/lib/borrowed";
import type { BorrowedRecord } from "@/lib/types";

function record(overrides: Partial<BorrowedRecord> = {}): BorrowedRecord {
  return {
    id: "borrowed-1",
    direction: "borrowed",
    item_name: "Tile cutter",
    brand: null,
    model: null,
    owner_name: "Ali",
    quantity: 3,
    returned_quantity: 1,
    outstanding_quantity: 2,
    physically_held_quantity: 2,
    status: "partially_returned",
    borrowed_on: "2026-01-01",
    due_on: "2026-01-10",
    notes: null,
    overdue: false,
    days_past_due: null,
    latest_returned_on: null,
    property_id: null,
    property_name: "Home",
    room_id: null,
    room_name: "Workshop",
    storage_location_id: null,
    storage_location_name: null,
    storage_location_identifier: null,
    photo: null,
    created_by_user_id: null,
    created_by_name: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("borrowed location wording", () => {
  it("uses current wording only while borrowed stock is held", () => {
    const held = record();
    expect(borrowedLocationPrefix(held)).toBe("kept at");
    expect(borrowedLocationHeading(held)).toBe("Kept at");
    expect(borrowedWhereLabel(held)).toBe("kept at Home / Workshop");
  });

  it("uses historical wording after everything is returned", () => {
    const returned = record({
      status: "returned",
      returned_quantity: 3,
      outstanding_quantity: 0,
      physically_held_quantity: 0,
    });
    expect(borrowedLocationPrefix(returned)).toBe("previously kept at");
    expect(borrowedLocationHeading(returned)).toBe("Previously kept at");
    expect(borrowedWhereLabel(returned)).toBe(
      "previously kept at Home / Workshop",
    );
  });

  it("calls a cancelled record's place its last recorded location", () => {
    const cancelled = record({
      status: "cancelled",
      returned_quantity: 0,
      outstanding_quantity: 0,
      physically_held_quantity: 0,
      cancelled_at: "2026-01-02T00:00:00Z",
    });
    expect(borrowedLocationPrefix(cancelled)).toBe("last recorded location");
    expect(borrowedLocationHeading(cancelled)).toBe("Last recorded location");
    expect(borrowedWhereLabel(cancelled)).toBe(
      "last recorded location Home / Workshop",
    );
  });
});
