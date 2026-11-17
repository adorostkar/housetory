import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ITEM_DRAFT_MAX_AGE_MS,
  clearAllItemDrafts,
  clearItemDraft,
  itemDraftFormId,
  itemDraftKey,
  itemFormFingerprint,
  readItemDraft,
  saveItemDraft,
  type ItemDraftScope,
  type ItemFormValues,
} from "@/lib/item-drafts";

const values: ItemFormValues = {
  name: "Espresso machine",
  description: "",
  brand: "",
  model: "",
  serialNumber: "",
  quantity: "1",
  condition: "good",
  propertyId: "",
  roomId: "",
  locationId: "",
  categoryId: "",
  tagIds: [],
  vendor: "",
  purchaseDate: "",
  totalPrice: "",
  editedUnitPrice: null,
  currency: "USD",
  currencyTouched: false,
  priceBasis: "total",
  orderNumber: "",
  purchaseNotes: "",
  receiptDocumentId: "",
  purchaseInfoStatus: "auto",
  warrantyProvider: "",
  warrantyStart: "",
  warrantyDuration: "",
  warrantyEnd: "",
  warrantyReminder: "",
  warrantyDocumentId: "",
  warrantyNotes: "",
};

const scope: ItemDraftScope = {
  userId: "user-1",
  householdId: "household-1",
  formId: itemDraftFormId({ itemId: "item-1" }),
};

const NOW = Date.UTC(2026, 10, 17, 8, 0, 0);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("item draft storage", () => {
  it("returns a saved draft only to the same account, household and form", () => {
    saveItemDraft(scope, values, "2026-02-01T00:00:00Z", NOW);

    expect(readItemDraft(scope, NOW)).toEqual({
      savedAt: NOW,
      itemUpdatedAt: "2026-02-01T00:00:00Z",
      values,
    });
    expect(readItemDraft({ ...scope, userId: "user-2" }, NOW)).toBeNull();
    expect(readItemDraft({ ...scope, householdId: "household-2" }, NOW)).toBeNull();
    expect(
      readItemDraft({ ...scope, formId: itemDraftFormId({ itemId: "item-2" }) }, NOW),
    ).toBeNull();
  });

  it("keeps new-item drafts apart by starting context, whatever the key order", () => {
    const shelf = itemDraftFormId({
      context: { room_id: "room-1", location_id: "location-1", name: undefined },
    });
    expect(
      itemDraftFormId({ context: { location_id: "location-1", room_id: "room-1" } }),
    ).toBe(shelf);
    expect(itemDraftFormId({ context: { room_id: "room-1" } })).not.toBe(shelf);
    expect(itemDraftFormId({ context: {} })).not.toBe(
      itemDraftFormId({ itemId: "" }),
    );
  });

  it("does not let ids containing the separator collide", () => {
    expect(itemDraftKey({ userId: "a:b", householdId: "c", formId: "new:" })).not.toBe(
      itemDraftKey({ userId: "a", householdId: "b:c", formId: "new:" }),
    );
  });

  it("expires drafts after the maximum age and prunes them from storage", () => {
    const other = { ...scope, formId: itemDraftFormId({ itemId: "item-2" }) };
    saveItemDraft(scope, values, null, NOW);
    saveItemDraft(other, values, null, NOW + 60_000);

    expect(readItemDraft(scope, NOW + ITEM_DRAFT_MAX_AGE_MS)).not.toBeNull();
    expect(readItemDraft(scope, NOW + ITEM_DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(localStorage.getItem(itemDraftKey(scope))).toBeNull();
    expect(localStorage.getItem(itemDraftKey(other))).not.toBeNull();

    readItemDraft(scope, NOW + ITEM_DRAFT_MAX_AGE_MS + 60_001);
    expect(localStorage.getItem(itemDraftKey(other))).toBeNull();
  });

  it("drops unreadable or malformed drafts instead of returning them", () => {
    localStorage.setItem(itemDraftKey(scope), "{not json");
    expect(readItemDraft(scope, NOW)).toBeNull();
    expect(localStorage.getItem(itemDraftKey(scope))).toBeNull();

    localStorage.setItem(
      itemDraftKey(scope),
      JSON.stringify({ ...scope, savedAt: NOW, itemUpdatedAt: null, values: { name: 5 } }),
    );
    expect(readItemDraft(scope, NOW)).toBeNull();
  });

  it("clears one draft, or every account's drafts on sign-out, and nothing else", () => {
    const other = { ...scope, userId: "user-2" };
    saveItemDraft(scope, values, null, NOW);
    saveItemDraft(other, values, null, NOW);
    localStorage.setItem("housetory:theme", "dark");

    clearItemDraft(scope);
    expect(readItemDraft(scope, NOW)).toBeNull();
    expect(readItemDraft(other, NOW)).not.toBeNull();

    saveItemDraft(scope, values, null, NOW);
    clearAllItemDrafts();
    expect(readItemDraft(scope, NOW)).toBeNull();
    expect(readItemDraft(other, NOW)).toBeNull();
    expect(localStorage.getItem("housetory:theme")).toBe("dark");
  });

  it("survives storage that is full or unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(saveItemDraft(scope, values, null, NOW)).toBe(false);
    expect(readItemDraft(scope, NOW)).toBeNull();
    expect(() => clearItemDraft(scope)).not.toThrow();
    expect(() => clearAllItemDrafts()).not.toThrow();
  });
});

describe("itemFormFingerprint", () => {
  it("ignores the property filter and an untouched default currency", () => {
    const opened = itemFormFingerprint(values);
    expect(itemFormFingerprint({ ...values, propertyId: "property-1" })).toBe(opened);
    expect(itemFormFingerprint({ ...values, currency: "EUR" })).toBe(opened);
    expect(
      itemFormFingerprint({ ...values, currency: "EUR", currencyTouched: true }),
    ).not.toBe(opened);
    expect(itemFormFingerprint({ ...values, name: "Kettle" })).not.toBe(opened);
  });
});
