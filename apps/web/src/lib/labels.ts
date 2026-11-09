import type {
  DocumentType,
  ItemDisposition,
  LoanStatus,
  OcrStatus,
  WarrantyStatus,
} from "@/lib/types";

export const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "JPY",
  "CHF",
  "SEK",
  "NZD",
  "SGD",
  "INR",
  "NOK",
  "DKK",
  "PLN",
] as const;

export const ITEM_DISPOSITION_LABELS: Record<ItemDisposition, string> = {
  sold: "Sold",
  given_away: "Given away",
  donated: "Donated",
  discarded: "Discarded",
  lost: "Lost",
  consumed: "Consumed",
  other: "No longer owned",
};

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  receipt: "Receipt",
  invoice: "Invoice",
  warranty_certificate: "Warranty certificate",
  manual: "Manual",
  specification: "Specification",
  other: "Other",
};

export const DOCUMENT_TYPE_OPTIONS = (
  Object.entries(DOCUMENT_TYPE_LABELS) as Array<[DocumentType, string]>
).sort((a, b) => a[1].localeCompare(b[1]));

export const OCR_STATUS_LABELS: Record<OcrStatus, string> = {
  not_requested: "Not requested",
  queued: "Queued",
  processing: "Reading…",
  succeeded: "Extracted",
  failed: "Failed",
};

export const WARRANTY_STATUS_LABELS: Record<WarrantyStatus, string> = {
  active: "Active",
  expiring: "Expiring soon",
  expired: "Expired",
  unknown: "Unknown",
};

export const WARRANTY_STATUS_TONE: Record<
  WarrantyStatus,
  "sage" | "brass" | "destructive" | "outline"
> = {
  active: "sage",
  expiring: "brass",
  expired: "destructive",
  unknown: "outline",
};

export function warrantyRemainingLabel(
  daysRemaining: number | null,
  status: WarrantyStatus,
): string {
  if (daysRemaining == null) return "No end date";
  if (status === "expired") {
    const days = Math.abs(daysRemaining);
    return days === 0 ? "Expired today" : `Expired ${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (daysRemaining === 0) return "Ends today";
  return `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining`;
}

export function isImageContentType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export const IMPORT_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  processing: "Processing",
  review: "Ready for review",
  applying: "Applying",
  completed: "Completed",
  failed: "Failed",
};

export const IMPORT_STATUS_TONE: Record<
  string,
  "sage" | "brass" | "destructive" | "outline" | "secondary"
> = {
  queued: "brass",
  processing: "brass",
  review: "outline",
  applying: "brass",
  completed: "sage",
  failed: "destructive",
};

export const IMPORT_SOURCE_LABELS: Record<string, string> = {
  text: "Pasted notes",
  file: "File",
  vault: "Obsidian vault",
  image: "Image",
};

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  outstanding: "Outstanding",
  partially_returned: "Partially returned",
  returned: "Returned",
  cancelled: "Cancelled",
};

export const LOAN_STATUS_TONE: Record<
  LoanStatus,
  "sage" | "brass" | "destructive" | "outline" | "secondary"
> = {
  outstanding: "brass",
  partially_returned: "sage",
  returned: "outline",
  cancelled: "secondary",
};

export const IMPORT_ENTRY_STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
  imported: "Imported",
  skipped: "Skipped",
  merged: "Merged",
  failed: "Failed",
};
