
import type {
  CandidateItem,
  ExtractionLine,
  ExtractionLineAction,
  ExtractionReview,
  ItemListEntry,
} from "@/lib/types";

export type WarrantyDraft = {
  enabled: boolean;
  provider: string;
  startDate: string;
  endDate: string;
  months: string;
};

export type NewItemDraft = {
  name: string;
  brand: string;
  model: string;
  serialNumber: string;
  roomId: string;
  locationId: string;
};

export type UpdateDraft = {
  name: string;
  brand: string;
  model: string;
  serialNumber: string;
  roomId: string;
  locationId: string;
};

export type LineDraft = {
  line: ExtractionLine;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  /** What this line would do: add an item, update one or link to one. Never a selection. */
  action: ExtractionLineAction;
  /** Selected for the bulk Apply. Nothing is selected to begin with. */
  selected: boolean;
  itemId: string;
  addQuantity: boolean;
  newItem: NewItemDraft;
  updates: UpdateDraft;
  warranty: WarrantyDraft;
};

export function centsInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function parseMoney(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parseQuantity(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function fieldValue(value: string | null | undefined): string {
  return value ?? "";
}

export function lineDraft(
  line: ExtractionLine,
  candidate: CandidateItem | undefined,
  fields: ExtractionReview["fields"],
  onlyLine: boolean,
): LineDraft {
  const strong = candidate && ["exact_identifier", "strong"].includes(candidate.match_quality);
  return {
    line,
    description: line.description,
    quantity: line.quantity == null ? "" : String(line.quantity),
    unitPrice: centsInput(line.unit_price_cents),
    lineTotal: centsInput(line.line_total_cents),
    // A strong match is only the suggestion. It selects nothing by itself.
    action: strong ? "link" : "create",
    selected: false,
    itemId: strong && candidate ? candidate.id : "",
    addQuantity: false,
    newItem: {
      name: line.description,
      brand: onlyLine ? fields.brand ?? "" : "",
      model: onlyLine ? fields.model ?? "" : "",
      serialNumber: onlyLine ? fields.serial_numbers[0] ?? "" : "",
      roomId: "",
      locationId: "",
    },
    updates: {
      name: "",
      brand: "",
      model: "",
      serialNumber: "",
      roomId: "",
      locationId: "",
    },
    warranty: {
      enabled: false,
      provider: fields.warranty_provider ?? "",
      startDate: fields.warranty_start ?? "",
      endDate: fields.warranty_end ?? "",
      months: fields.warranty_months == null ? "" : String(fields.warranty_months),
    },
  };
}

export function candidateFromItem(item: ItemListEntry): CandidateItem {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    model: item.model,
    serial_number: null,
    quantity: item.quantity,
    on_loan_quantity: item.on_loan_quantity ?? 0,
    room_name: item.room?.name ?? null,
    location_name: item.location?.name ?? null,
    purchase: item.purchase
      ? {
          id: item.purchase.id,
          merchant: item.purchase.merchant,
          purchase_date: item.purchase.purchase_date,
          price_cents: item.purchase.price_cents,
          currency: item.purchase.currency,
        }
      : null,
    warranty: item.warranty
      ? {
          provider: item.warranty.provider,
          start_date: item.warranty.start_date,
          end_date: item.warranty.end_date,
          duration_months: item.warranty.duration_months,
        }
      : null,
    reasons: ["selected manually from the household inventory"],
    match_quality: "possible",
    exact_identifier: false,
  };
}

export function qualityLabel(quality: string): string {
  if (quality === "exact_identifier") return "Exact identifier";
  if (quality === "strong") return "Strong match";
  if (quality === "possible") return "Possible match";
  return "No likely match";
}

export function buildApplyPayload({
  extractionVersion,
  drafts,
  merchant,
  purchaseDate,
  documentDate,
  currency,
  total,
  orderNumber,
  purchaseAction,
  purchaseId,
  updatePurchaseFields,
  attachAsReceipt,
  linkDocument,
  allowReapply,
  requestId,
}: {
  extractionVersion: string;
  drafts: LineDraft[];
  merchant: string;
  purchaseDate: string;
  documentDate: string;
  currency: string;
  total: string;
  orderNumber: string;
  purchaseAction: "none" | "create" | "existing";
  purchaseId: string;
  updatePurchaseFields: boolean;
  attachAsReceipt: boolean;
  linkDocument: boolean;
  allowReapply: boolean;
  requestId: string;
}) {
  const lines = drafts.map((draft) => {
    const base: Record<string, unknown> = {
      line_id: draft.line.id,
      action: draft.action,
      quantity: parseQuantity(draft.quantity),
      line_total_cents: parseMoney(draft.lineTotal),
    };
    if (draft.action === "create") {
      base.new_item = {
        name: draft.newItem.name.trim() || draft.description.trim() || "New item",
        quantity: parseQuantity(draft.quantity) ?? 1,
        brand: draft.newItem.brand.trim() || null,
        model: draft.newItem.model.trim() || null,
        serial_number: draft.newItem.serialNumber.trim() || null,
        room_id: draft.newItem.roomId,
        storage_location_id: draft.newItem.locationId || null,
      };
    } else if (draft.action === "link" || draft.action === "update") {
      base.item_id = draft.itemId;
      base.add_quantity = draft.addQuantity;
      if (draft.action === "update") {
        const updates: Record<string, unknown> = {};
        if (draft.updates.name.trim()) updates.name = draft.updates.name.trim();
        if (draft.updates.brand.trim()) updates.brand = draft.updates.brand.trim();
        if (draft.updates.model.trim()) updates.model = draft.updates.model.trim();
        if (draft.updates.serialNumber.trim()) {
          updates.serial_number = draft.updates.serialNumber.trim();
        }
        if (draft.updates.roomId) {
          updates.room_id = draft.updates.roomId;
          updates.storage_location_id = draft.updates.locationId || null;
        }
        base.updates = updates;
      }
    }
    if (draft.warranty.enabled) {
      base.warranty = {
        provider: draft.warranty.provider.trim() || null,
        start_date: draft.warranty.startDate || null,
        duration_months: draft.warranty.months ? Number(draft.warranty.months) : null,
        end_date: draft.warranty.endDate || null,
      };
    }
    return base;
  });

  const purchase =
    purchaseAction === "create" || (purchaseAction === "existing" && updatePurchaseFields)
      ? {
          merchant: merchant.trim() || null,
          purchase_date: purchaseDate || null,
          price_cents: parseMoney(total),
          currency,
          order_number: orderNumber.trim() || null,
        }
      : null;

  return {
    request_id: requestId,
    extraction_version: extractionVersion,
    document_fields: {
      merchant: merchant.trim() || null,
      document_date: documentDate || null,
    },
    purchase_action: purchaseAction,
    purchase_id: purchaseAction === "existing" ? purchaseId || null : null,
    purchase,
    attach_as_receipt: attachAsReceipt,
    link_document: linkDocument,
    allow_reapply: allowReapply,
    lines,
  };
}

/** How many details the reading found: the fields that have a value, and the product lines. */
export function countExtractedDetails(review: ExtractionReview): number {
  const fields = review.fields;
  const filled = [
    fields.merchant,
    fields.purchase_date ?? fields.document_date,
    fields.total_cents,
    fields.order_number,
    fields.brand,
    fields.model,
    fields.serial_numbers.length > 0 ? fields.serial_numbers[0] : null,
    fields.warranty_end ?? fields.warranty_months ?? fields.warranty_provider,
  ].filter((value) => value != null && value !== "").length;
  return filled + review.lines.filter((line) => line.kind === "product").length;
}

/** What the server remembers about one line. A line without a state is still pending. */
export interface ExtractionLineState {
  /** "pending" is a restored line: it waits again and still has its saved draft. */
  status: "applied" | "skipped" | "pending";
  /** The complete row draft that was saved with the skip. */
  draft?: Record<string, unknown> | null;
  action?: "create" | "update" | "link" | null;
  item?: { id: string; name: string } | null;
  at?: string | null;
  description?: string | null;
  quantity?: number | null;
  line_total_cents?: number | null;
  /** How often the kept correction of the line changed, and the device that kept it. */
  revision?: number;
  writer?: string | null;
  /** Written by this page before the server has confirmed it. Never from the server. */
  unconfirmed?: boolean;
}

/**
 * True for a waiting line that keeps no correction. The server still has a state
 * for it then, to remember the revision of its draft.
 */
export function keepsNothing(state: ExtractionLineState | null | undefined) {
  return !state || (state.status === "pending" && !state.draft &&
    state.description == null && state.quantity == null && state.line_total_cents == null);
}

export interface ExtractionLineStates {
  line_states: Record<string, ExtractionLineState>;
  applied_version: string | null;
}

/** The fields at the top of the review, as they are typed. Kept while the review waits. */
export interface ExtractionHeaderDraft {
  merchant?: string | null;
  purchase_date?: string | null;
  document_date?: string | null;
  currency?: string | null;
  total?: string | null;
  order_number?: string | null;
  purchase_action?: "none" | "create" | null;
}

export interface ExtractionHeaderDraftState {
  /** The kept fields, with the extraction version they were corrected for. */
  header_draft?: { version: string; draft: ExtractionHeaderDraft } | null;
  /** How often the kept fields changed, and the device that kept them. */
  header_revision?: number;
  header_writer?: string | null;
  /** Written by this page before the server has confirmed the fields. Never from the server. */
  header_unconfirmed?: boolean;
}

export type ExtractionReviewWithStates = ExtractionReview &
  Partial<ExtractionLineStates> & ExtractionHeaderDraftState;

/** Why a line cannot be applied yet. An empty list means it is ready. */
export function lineDraftErrors(draft: LineDraft): string[] {
  const errors: string[] = [];
  const invalid = (value: string) => value.trim() !== "" && parseMoney(value) == null;
  if (invalid(draft.unitPrice) || invalid(draft.lineTotal)) {
    errors.push("A selected line has a negative or invalid amount. Correct an editable line total or skip unsupported credit lines; source unit prices are evidence only.");
  }
  if (draft.action === "create") {
    if (!draft.newItem.name.trim()) errors.push("A new item needs a name.");
    if (!draft.newItem.roomId) errors.push("A new item needs a room.");
  }
  if (draft.action === "update" && !Object.values(draft.updates).some((value) => value.trim())) {
    errors.push("Choose at least one field to update on an existing item.");
  }
  if ((draft.action === "link" || draft.action === "update") && !draft.itemId) {
    errors.push("Choose an existing item, or add this line as a new item.");
  }
  if (draft.addQuantity && !parseQuantity(draft.quantity)) {
    errors.push("Added quantity must be a whole number of at least 1.");
  }
  return errors;
}

/**
 * The complete draft of a row, as it is kept with a skip: amounts, the chosen action
 * and its target, the new item, the updates, the stock choice and the warranty. The
 * chosen item goes with it, so that the target can be shown again after a reload.
 */
export function serializeLineDraft(draft: LineDraft, candidate?: CandidateItem): Record<string, unknown> {
  return {
    description: draft.description,
    quantity: draft.quantity,
    unitPrice: draft.unitPrice,
    lineTotal: draft.lineTotal,
    action: draft.action,
    itemId: draft.itemId,
    addQuantity: draft.addQuantity,
    newItem: draft.newItem,
    updates: draft.updates,
    warranty: draft.warranty,
    ...(candidate ? { candidate } : {}),
  };
}

/** Puts a kept draft back on a freshly built row. Unknown or broken parts are ignored. */
export function restoreLineDraft(base: LineDraft, state: ExtractionLineState | undefined): LineDraft {
  if (!state || state.status === "applied" || keepsNothing(state)) return base;
  const saved = (state.draft ?? {}) as Partial<LineDraft>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const part = <T extends object>(value: unknown, fallback: T): T =>
    value && typeof value === "object" ? { ...fallback, ...(value as Partial<T>) } : fallback;
  const description = text(saved.description, state.description ?? base.description);
  return {
    ...base,
    description,
    quantity: text(saved.quantity, state.quantity != null ? String(state.quantity) : base.quantity),
    lineTotal: text(
      saved.lineTotal,
      state.line_total_cents != null ? centsInput(state.line_total_cents) : base.lineTotal,
    ),
    action: saved.action === "create" || saved.action === "update" || saved.action === "link"
      ? saved.action : base.action,
    itemId: text(saved.itemId, base.itemId),
    addQuantity: typeof saved.addQuantity === "boolean" ? saved.addQuantity : base.addQuantity,
    newItem: part(saved.newItem, { ...base.newItem, name: state.draft ? base.newItem.name : description }),
    updates: part(saved.updates, base.updates),
    warranty: part(saved.warranty, base.warranty),
  };
}

/** The item a kept draft points to, when it was saved with the draft. */
export function savedCandidate(state: ExtractionLineState | undefined): CandidateItem | null {
  const candidate = state?.draft?.candidate as CandidateItem | undefined;
  return candidate && typeof candidate === "object" && typeof candidate.id === "string"
    ? candidate : null;
}
