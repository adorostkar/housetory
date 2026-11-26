import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

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

beforeEach(() => {
  sessionStorage.clear();
});

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
    expect(result.current.notice).toBe(
      "1 selected item is no longer in the loaded list and was taken out of the selection.",
    );
  });

  it("keeps the selection when the list is left and opened again in the same view", () => {
    const options = { items: [active, second], enabled: true, scopeKey: "kept" };
    const first = renderHook(() => useBulkSelection(options));
    act(() => first.result.current.toggleItem("second"));
    first.unmount();

    // On the way back the list is still loading, then its rows arrive.
    const back = renderHook(({ items }) => useBulkSelection({ ...options, items }), {
      initialProps: { items: [] as ItemSummary[] },
    });
    expect([...back.result.current.selected]).toEqual(["second"]);
    back.rerender({ items: [active, second] });
    expect(back.result.current.selectedItems.map((entry) => entry.id)).toEqual(["second"]);
    expect(back.result.current.notice).toBeNull();
    back.unmount();

    // Another view, or a cleared selection, starts empty.
    const other = renderHook(() => useBulkSelection({ ...options, scopeKey: "other" }));
    expect(other.result.current.selected.size).toBe(0);
    other.unmount();
    const again = renderHook(() => useBulkSelection(options));
    act(() => again.result.current.clearSelection());
    again.unmount();
    expect(renderHook(() => useBulkSelection(options)).result.current.selected.size).toBe(0);
  });

  it("always offers checkboxes unless the page asks for selection on request", () => {
    const always = renderHook(() =>
      useBulkSelection({ items: [active], enabled: true, scopeKey: "always" }),
    );
    expect(always.result.current.selecting).toBe(true);
    expect(always.result.current.itemSelection(active)).toMatchObject({ selected: false });
    // Clearing keeps the checkboxes on such a page, as before.
    act(() => always.result.current.toggleItem("active"));
    act(() => always.result.current.stopSelecting());
    expect(always.result.current.selected.size).toBe(0);
    expect(always.result.current.selecting).toBe(true);

    const options = { items: [active, second], enabled: true, scopeKey: "asked", onRequest: true };
    const asked = renderHook(() => useBulkSelection(options));
    expect(asked.result.current.selecting).toBe(false);
    expect(asked.result.current.itemSelection(active)).toBeUndefined();
    act(() => asked.result.current.startSelecting());
    act(() => asked.result.current.itemSelection(second)?.onToggle());
    expect(asked.result.current.itemSelection(second)).toMatchObject({ selected: true });
    asked.unmount();

    // Back from an item: the kept selection is shown, so selection is on.
    const back = renderHook(() => useBulkSelection(options));
    expect(back.result.current.selecting).toBe(true);
    act(() => back.result.current.stopSelecting());
    expect(back.result.current.selecting).toBe(false);
    expect(back.result.current.selected.size).toBe(0);
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
