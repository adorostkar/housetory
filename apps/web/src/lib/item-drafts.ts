const DRAFT_PREFIX = "housetory:item-draft:v1:";

export const ITEM_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STRING_FIELDS = [
  "name",
  "description",
  "brand",
  "model",
  "serialNumber",
  "quantity",
  "condition",
  "propertyId",
  "roomId",
  "locationId",
  "categoryId",
  "vendor",
  "purchaseDate",
  "totalPrice",
  "currency",
  "orderNumber",
  "purchaseNotes",
  "receiptDocumentId",
  "purchaseInfoStatus",
  "warrantyProvider",
  "warrantyStart",
  "warrantyDuration",
  "warrantyEnd",
  "warrantyReminder",
  "warrantyDocumentId",
  "warrantyNotes",
] as const;

type StringField = (typeof STRING_FIELDS)[number];

/** The item form's field values, exactly as held in its inputs. */
export type ItemFormValues = Record<StringField, string> & {
  tagIds: string[];
  editedUnitPrice: string | null;
  currencyTouched: boolean;
  priceBasis: "total" | "unit";
};

export interface ItemDraftScope {
  userId: string;
  householdId: string;
  formId: string;
}

export interface ItemDraft {
  savedAt: number;
  itemUpdatedAt: string | null;
  values: ItemFormValues;
}

interface StoredItemDraft extends ItemDraft, ItemDraftScope {}

/**
 * Identifies which form a draft belongs to: the item being edited, or a new
 * item together with the starting context the form was opened with.
 */
export function itemDraftFormId(
  form:
    | { itemId: string }
    | { context: Record<string, string | null | undefined> },
): string {
  if ("itemId" in form) return `edit:${form.itemId}`;
  const params = new URLSearchParams();
  for (const key of Object.keys(form.context).sort()) {
    const value = form.context[key];
    if (value) params.set(key, value);
  }
  return `new:${params.toString()}`;
}

export function itemDraftKey(scope: ItemDraftScope): string {
  return `${DRAFT_PREFIX}${[scope.userId, scope.householdId, scope.formId]
    .map(encodeURIComponent)
    .join(":")}`;
}

/**
 * The values that count as unsaved input. The property select only filters
 * rooms and is never sent, and the currency follows the household default
 * until the user picks one, so neither makes the form dirty on its own.
 */
export function itemFormFingerprint(values: ItemFormValues): string {
  const { propertyId: _propertyId, currencyTouched, currency, ...rest } = values;
  return JSON.stringify({ ...rest, currency: currencyTouched ? currency : null });
}

function isItemFormValues(value: unknown): value is ItemFormValues {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    STRING_FIELDS.every((field) => typeof record[field] === "string") &&
    Array.isArray(record.tagIds) &&
    record.tagIds.every((id) => typeof id === "string") &&
    (record.editedUnitPrice === null || typeof record.editedUnitPrice === "string") &&
    typeof record.currencyTouched === "boolean" &&
    (record.priceBasis === "total" || record.priceBasis === "unit")
  );
}

function parseStoredDraft(raw: string | null): StoredItemDraft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt) ||
      typeof record.userId !== "string" ||
      typeof record.householdId !== "string" ||
      typeof record.formId !== "string" ||
      (record.itemUpdatedAt !== null && typeof record.itemUpdatedAt !== "string") ||
      !isItemFormValues(record.values)
    ) {
      return null;
    }
    return record as unknown as StoredItemDraft;
  } catch {
    return null;
  }
}

function isExpired(draft: StoredItemDraft, now: number): boolean {
  return now - draft.savedAt > ITEM_DRAFT_MAX_AGE_MS || draft.savedAt - now > 60_000;
}

function draftKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Removes every expired or unreadable item draft on this device. */
export function pruneItemDrafts(now: number = Date.now()): void {
  try {
    for (const key of draftKeys()) {
      const draft = parseStoredDraft(localStorage.getItem(key));
      if (!draft || isExpired(draft, now)) localStorage.removeItem(key);
    }
  } catch {
    // Storage is optional; the form works without drafts.
  }
}

export function readItemDraft(
  scope: ItemDraftScope,
  now: number = Date.now(),
): ItemDraft | null {
  pruneItemDrafts(now);
  try {
    const draft = parseStoredDraft(localStorage.getItem(itemDraftKey(scope)));
    if (!draft || isExpired(draft, now)) return null;
    if (
      draft.userId !== scope.userId ||
      draft.householdId !== scope.householdId ||
      draft.formId !== scope.formId
    ) {
      return null;
    }
    return {
      savedAt: draft.savedAt,
      itemUpdatedAt: draft.itemUpdatedAt,
      values: draft.values,
    };
  } catch {
    return null;
  }
}

export function saveItemDraft(
  scope: ItemDraftScope,
  values: ItemFormValues,
  itemUpdatedAt: string | null,
  now: number = Date.now(),
): boolean {
  const stored: StoredItemDraft = { ...scope, savedAt: now, itemUpdatedAt, values };
  try {
    localStorage.setItem(itemDraftKey(scope), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function clearItemDraft(scope: ItemDraftScope): void {
  try {
    localStorage.removeItem(itemDraftKey(scope));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export const ITEM_DRAFTS_CLEARED_EVENT = "housetory:item-drafts-cleared";

/**
 * Removes every item draft on this device, for every account. Open forms are
 * told so they do not write their draft back afterwards.
 */
export function clearAllItemDrafts(): void {
  try {
    for (const key of draftKeys()) localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  window.dispatchEvent(new Event(ITEM_DRAFTS_CLEARED_EVENT));
}
