import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useBulkSelection } from "@/components/bulk-item-selection";
import type { ItemSummary } from "@/lib/types";

function item(overrides: Partial<ItemSummary> & { id: string }): ItemSummary {
  return {
    name: overrides.id,
    description: null,
    brand: null,
    model: null,
    quantity: 1,
    on_loan_quantity: 0,
    condition: "good",
    is_archived: false,
    room: null,
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
    ...overrides,
  };
}

const active = item({ id: "active", quantity: 3, on_loan_quantity: 1 });
const second = item({ id: "second", quantity: 2 });
const archived = item({ id: "archived", is_archived: true });

describe("useBulkSelection", () => {
  it("selects only loaded, non-archived items and reports units/loans", () => {
    const { result } = renderHook(() =>
      useBulkSelection({
        items: [active, second, archived],
        enabled: true,
        scopeKey: "one",
      }),
    );
    act(() => result.current.toggleAllLoaded());
    expect([...result.current.selected].sort()).toEqual(["active", "second"]);
    expect(result.current.selectedUnits).toBe(5);
    expect(result.current.selectedOnLoan).toBe(1);

    act(() => result.current.toggleItem("archived"));
    expect(result.current.selected.has("archived")).toBe(false);
  });

  it("clears the selection when the scoped view changes", () => {
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useBulkSelection({
          items: [active, second],
          enabled: true,
          scopeKey: scope,
        }),
      { initialProps: { scope: "room:one" } },
    );
    act(() => result.current.toggleItem("active"));
    expect(result.current.selected.has("active")).toBe(true);
    rerender({ scope: "room:two" });
    expect(result.current.selected.size).toBe(0);
    expect(result.current.notice).toMatch(/view changed/i);
  });

  it("prunes selected ids that are no longer loaded", () => {
    const { result, rerender } = renderHook(
      ({ items }) =>
        useBulkSelection({
          items,
          enabled: true,
          scopeKey: "same",
        }),
      { initialProps: { items: [active, second] } },
    );
    act(() => result.current.toggleAllLoaded());
    expect(result.current.selected.size).toBe(2);
    rerender({ items: [active] });
    expect([...result.current.selected]).toEqual(["active"]);
  });

  it("cannot select when the caller is read-only", () => {
    const { result } = renderHook(() =>
      useBulkSelection({
        items: [active],
        enabled: false,
        scopeKey: "readonly",
      }),
    );
    act(() => result.current.toggleAllLoaded());
    expect(result.current.selected.size).toBe(0);
  });
});
