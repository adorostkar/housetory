
import type {
  CandidateItem,
  ExtractionLine,
  ExtractionLineAction,
  ExtractionReview,
  ItemSummary,
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
  action: ExtractionLineAction;
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
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
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
    action: strong ? "link" : "skip",
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

export function candidateFromItem(item: ItemSummary): CandidateItem {
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
