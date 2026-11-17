import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { onItemsMoved, onLoansChanged, onUndo } from "@/lib/cache-refresh";
import { queryKeys } from "@/lib/query-keys";

// Keys as the app's hooks actually build them, by the screen that shows them.
const shown: Record<string, QueryKey> = {
  "room counts": [...queryKeys.rooms, "all"],
  "location counts": queryKeys.locations("room-1"),
  "container": queryKeys.container("container-1"),
  "item list": [...queryKeys.items, "summary", {}, 24],
  "item detail": queryKeys.item("item-1"),
  "item loans": queryKeys.itemLoans("item-1"),
  "loan options": queryKeys.itemLoanOptions("item-1"),
  "loan list": [...queryKeys.loans, {}, 24],
  "borrowed record": queryKeys.borrowedRecord("borrowed-1"),
  "overview": [...queryKeys.overview, false],
  "search": queryKeys.quickSearch,
};
const unrelated: QueryKey[] = [queryKeys.session, queryKeys.aiSettings, queryKeys.captureReviewsAll];

function refreshed(change: (client: QueryClient) => void) {
  const client = new QueryClient();
  for (const key of [...Object.values(shown), ...unrelated]) client.setQueryData(key, {});
  change(client);
  const invalidated = (key: QueryKey) => client.getQueryState(key)?.isInvalidated === true;
  expect(unrelated.filter(invalidated)).toEqual([]);
  return Object.keys(shown).filter((name) => invalidated(shown[name]!));
}

describe("named cache refreshes", () => {
  it.each([
    ["undo or restore", onUndo],
    ["a move", onItemsMoved],
    ["a loan or return", onLoansChanged],
  ])("after %s, room counts, locations, items, loans and search all refresh", (_name, change) => {
    expect(refreshed(change)).toEqual(expect.arrayContaining([
      "room counts", "location counts", "container", "item list", "item detail",
      "item loans", "loan options", "loan list", "overview", "search",
    ]));
  });

  it("refreshes borrowed records with loans and after undo", () => {
    expect(refreshed(onLoansChanged)).toContain("borrowed record");
    expect(refreshed(onUndo)).toContain("borrowed record");
  });
});
