import { beforeEach, describe, expect, it } from "vitest";

import { clearAllItemDrafts } from "@/lib/item-drafts";
import {
  RECENT_ITEMS_LIMIT,
  holdRecentItemsSnapshot,
  keepRecentItemsSnapshot,
  mergeRecentItems,
  readRecentItems,
  recentItemsSnapshot,
  recordItemOpened,
} from "@/lib/recent-items";

const scope = { userId: "user-1", householdId: "household-1" };
const at = (minute: number) => Date.UTC(2026, 10, 20, 8, minute);
const item = (id: string, minute: number) => ({
  id,
  created_at: new Date(at(minute)).toISOString(),
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("recently opened items", () => {
  it("keeps them per user and household, capped, and clears them with the drafts", () => {
    for (let index = 0; index < RECENT_ITEMS_LIMIT + 5; index += 1) {
      recordItemOpened(scope, `item-${index}`, at(index));
    }
    const stored = readRecentItems(scope);
    expect(Object.keys(stored)).toHaveLength(RECENT_ITEMS_LIMIT);
    expect(stored["item-0"]).toBeUndefined();
    expect(stored[`item-${RECENT_ITEMS_LIMIT + 4}`]).toBe(at(RECENT_ITEMS_LIMIT + 4));
    expect(readRecentItems({ ...scope, householdId: "household-2" })).toEqual({});
    expect(readRecentItems({ ...scope, userId: "user-2" })).toEqual({});
    expect(readRecentItems(null)).toEqual({});

    clearAllItemDrafts();
    expect(readRecentItems(scope)).toEqual({});
  });

  it("keeps the order of a list while an item opened from it is on screen", () => {
    recordItemOpened(scope, "a", at(1));
    const first = recentItemsSnapshot(scope, "view-1");
    keepRecentItemsSnapshot(scope, "view-1", first);

    holdRecentItemsSnapshot();
    recordItemOpened(scope, "b", at(2));
    expect(recentItemsSnapshot(scope, "view-1")).toEqual({ a: at(1) });
    expect(recentItemsSnapshot(scope, "view-2")).toEqual({ a: at(1), b: at(2) });

    // The hold is for the way back, not for much later.
    expect(recentItemsSnapshot(scope, "view-1", Date.now() + 31 * 60 * 1000)).toEqual({
      a: at(1),
      b: at(2),
    });

    // Back on the list: it is shown with the held times, and a later visit is fresh.
    keepRecentItemsSnapshot(scope, "view-1", { a: at(1) });
    expect(recentItemsSnapshot(scope, "view-1")).toEqual({ a: at(1), b: at(2) });
  });
});

describe("mergeRecentItems", () => {
  const loaded = [item("d", 40), item("c", 30), item("b", 20)];

  it("places an item by the later of its creation and its opening", () => {
    const old = item("a", 10);
    expect(
      mergeRecentItems(loaded, [old, loaded[2]!], { a: at(35), b: at(50), c: at(5) }, false).map(
        (entry) => entry.id,
      ),
    ).toEqual(["b", "d", "a", "c"]);
  });

  it("orders equal times by id and returns the same list when nothing was opened", () => {
    expect(mergeRecentItems(loaded, [], {}, true)).toBe(loaded);
    const first = item("0", 1);
    const second = item("z", 1);
    expect(
      mergeRecentItems(loaded, [second, first], { 0: at(30), z: at(30) }, false).map(
        (entry) => entry.id,
      ),
    ).toEqual(["d", "0", "c", "z", "b"]);
  });

  it("holds an opened item back until the page it belongs to is loaded", () => {
    const old = item("a", 10);
    const openedAt = { a: at(15) };
    expect(mergeRecentItems(loaded, [old], openedAt, true).map((entry) => entry.id)).toEqual([
      "d", "c", "b",
    ]);
    expect(
      mergeRecentItems([...loaded, item("9", 12)], [old], openedAt, true).map((entry) => entry.id),
    ).toEqual(["d", "c", "b", "a", "9"]);
    expect(mergeRecentItems(loaded, [old], openedAt, false).map((entry) => entry.id)).toEqual([
      "d", "c", "b", "a",
    ]);
  });
});
