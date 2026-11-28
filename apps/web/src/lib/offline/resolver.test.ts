import { describe, expect, it } from "vitest";

import { answerOffline } from "@/lib/offline/resolver";
import { testCopy } from "@/lib/offline/test-copy";
import type {
  ContainerDetail,
  ItemDetailResponse,
  ItemLoanSummary,
  ItemSummaryList,
  LoanList,
  QuickSearchResponse,
} from "@/lib/types";

const copy = testCopy();
const names = (path: string) =>
  (answerOffline(copy, path) as ItemSummaryList).items.map((item) => item.name);

describe("the item list from the offline copy", () => {
  it("leaves archived items out unless asked, newest first", () => {
    expect(names("/items?limit=24&representation=summary")).toEqual([
      "Cordless drill",
      "Kettle",
      "Axe",
    ]);
    expect(names("/items?include_archived=true")).toContain("Old kettle");
  });

  it("finds items by their own text and by the place they are in", () => {
    // The name, a serial number, a tag, the room, and a box two levels up.
    expect(names("/items?q=KETTLE")).toEqual(["Kettle"]);
    expect(names("/items?q=sn-42")).toEqual(["Cordless drill"]);
    expect(names("/items?q=power")).toEqual(["Cordless drill"]);
    expect(names("/items?q=kitchen")).toEqual(["Kettle"]);
    expect(names("/items?q=top%20shelf")).toEqual(["Cordless drill"]);
    expect(names("/items?q=box-001")).toEqual(["Cordless drill"]);
    expect(names("/items?q=nothing-like-this")).toEqual([]);
  });

  it("puts the best name match first in a search", () => {
    const both = testCopy();
    both.snapshot.items[0]!.description = "Not a kettle";
    const found = (answerOffline(both, "/items?q=kettle&sort=name_asc") as ItemSummaryList).items;
    expect(found.map((item) => item.name)).toEqual(["Kettle", "Cordless drill"]);
  });

  it("applies the same filters as the server", () => {
    expect(names("/items?property_id=cabin")).toEqual(["Axe"]);
    expect(names("/items?room_id=kitchen")).toEqual(["Kettle"]);
    // An item in a box on the shelf is on the shelf only when nested places are asked for.
    expect(names("/items?location_id=shelf")).toEqual([]);
    expect(names("/items?location_id=shelf&include_descendants=true")).toEqual(["Cordless drill"]);
    expect(names("/items?category_id=tools")).toEqual(["Cordless drill"]);
    expect(names("/items?tag_id=power")).toEqual(["Cordless drill"]);
    expect(names("/items?purchase_info=recorded")).toEqual(["Kettle"]);
    expect(names("/items?purchase_info=missing")).toEqual(["Cordless drill", "Axe"]);
    expect(names("/items?ids=axe&ids=kettle&sort=name_asc")).toEqual(["Axe", "Kettle"]);
  });

  it("pages the list and reports the full count", () => {
    const page = answerOffline(copy, "/items?sort=name_asc&limit=2&offset=2") as ItemSummaryList;
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page.items.map((item) => item.name)).toEqual(["Kettle"]);
  });
});

describe("one item from the offline copy", () => {
  it("answers the item page and says an unknown item is not in the copy", () => {
    const { item } = answerOffline(copy, "/items/drill") as ItemDetailResponse;
    expect(item.serial_number).toBe("SN-42");
    expect(() => answerOffline(copy, "/items/missing")).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("works out again whether a loan is overdue, for the day it is asked", () => {
    const before = answerOffline(copy, "/items/drill/loans?on_date=2026-11-10") as ItemLoanSummary;
    expect(before).toMatchObject({ on_loan_quantity: 1, available_quantity: 1, overdue_count: 0 });
    const after = answerOffline(copy, "/items/drill/loans?on_date=2026-11-23") as ItemLoanSummary;
    expect(after.overdue_count).toBe(1);
    expect(after.loans[0]).toMatchObject({ overdue: true, days_past_due: 3 });

    const rail = answerOffline(copy, "/loans?on_date=2026-11-23&limit=1") as LoanList;
    expect(rail).toMatchObject({ outstanding_count: 1, overdue_count: 1 });
    // Returned loans are not in the copy.
    expect(() => answerOffline(copy, "/loans?status=returned")).toThrowError(
      expect.objectContaining({ code: "offline_unavailable" }),
    );
  });
});

describe("storage places from the offline copy", () => {
  it("lists movable containers only, unless fixed places are asked for", () => {
    const list = answerOffline(copy, "/containers?limit=200") as { items: Array<{ id: string }> };
    expect(list.items.map((entry) => entry.id)).toEqual(["box"]);
    const all = answerOffline(copy, "/containers?include_fixed=true&q=shelf") as typeof list;
    expect(all.items.map((entry) => entry.id)).toEqual(["shelf"]);
  });

  it("builds the page of a place from the items and places below it", () => {
    const shelf = answerOffline(copy, "/containers/shelf") as ContainerDetail;
    expect(shelf.items.map((item) => item.name)).toEqual(["Cordless drill"]);
    expect(shelf.summary).toMatchObject({
      item_count: 1,
      total_quantity: 2,
      direct_item_count: 0,
      empty: false,
      categories: [{ name: "Tools", item_count: 1, total_quantity: 2 }],
    });
    expect(shelf.children).toEqual([
      expect.objectContaining({ id: "box", item_count: 1, total_item_count: 1, total_quantity: 2 }),
    ]);
    expect(shelf.room_path).toEqual([{ id: "garage", name: "Garage" }]);
  });
});

describe("quick search in the offline copy", () => {
  it("finds items and places, and says where they are and who has them", () => {
    const answer = answerOffline(copy, "/search/quick?q=drill&limit=4") as QuickSearchResponse;
    expect(answer.results).toEqual([
      expect.objectContaining({
        kind: "item",
        title: "Cordless drill",
        subtitle: "Bosch · Serial SN-42",
        context: "Home · Garage · Top shelf · BOX-001 · Tools",
        url: "/items/drill",
        loan: { on_loan_quantity: 1, borrower_names: ["Grace"], next_due_on: "2026-11-20" },
      }),
    ]);
    expect(answer.notices).toEqual([expect.stringContaining("Offline")]);

    const places = answerOffline(copy, "/search/quick?q=box-001") as QuickSearchResponse;
    expect(places.results.map((result) => [result.kind, result.title, result.url])).toEqual([
      ["item", "Cordless drill", "/items/drill"],
      ["container", "BOX-001", "/containers/box"],
    ]);
    expect(places.results[1]).toMatchObject({ subtitle: "Tools", context: "Home · Garage · Top shelf" });
  });
});

it("refuses what the copy does not hold", () => {
  for (const path of ["/documents?limit=100", "/items/drill/history", "/stocktake/sessions"]) {
    expect(() => answerOffline(copy, path)).toThrowError(
      expect.objectContaining({ code: "offline_unavailable", status: 0 }),
    );
  }
});
