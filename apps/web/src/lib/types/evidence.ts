import type { DocumentType, UUID } from "@/lib/types/core";

export interface EvidenceScope {
  item_ids?: UUID[];
  room_ids?: UUID[];
  container_ids?: UUID[];
  include_home?: boolean;
}

export interface EvidenceOptions {
  include_photos: boolean;
  include_receipts: boolean;
  include_warranty_documents: boolean;
  include_manuals: boolean;
  include_other_documents: boolean;
  include_document_originals: boolean;
  include_csv: boolean;
  include_attachments: boolean;
  excluded_document_ids: UUID[];
}

export interface EvidenceItemPreview {
  id: UUID;
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  quantity: number;
  on_loan_quantity: number;
  at_home_quantity: number;
  condition: string;
  is_archived: boolean;
  category: string | null;
  property_id?: UUID | null;
  property_name?: string | null;
  full_location_path: string;
  purchase_info_status: string;
  purchase_currency: string | null;
  item_allocation_cents: number | null;
  current_value_unit_cents: number | null;
  current_value_quantity: number;
  current_value_total_cents: number | null;
  current_value_currency: string | null;
  current_value_basis: "per_unit" | "legacy_record_total" | null;
  current_value_estimated_at: string | null;
  photo_count: number;
  document_count: number;
}

export type EvidenceDocumentKind = "receipt" | "warranty" | "manual" | "other";

export interface EvidenceDocumentPreview {
  id: UUID;
  title: string;
  document_type: DocumentType;
  evidence_kind: EvidenceDocumentKind;
  merchant: string | null;
  document_date: string | null;
  byte_size: number;
  original_byte_size: number;
  scan_page_count: number;
  shared_with_unselected: boolean;
  category_included: boolean;
  excluded_by_user: boolean;
  included: boolean;
  selected_item_ids: UUID[];
}

export interface EvidenceCurrencyTotal {
  currency: string;
  selected_allocated_purchase_cents: number;
  current_value_total_cents: number;
  allocated_item_count: number;
  current_value_item_count: number;
}

export interface EvidencePurchaseReference {
  purchase_id: UUID;
  merchant: string | null;
  purchase_date: string | null;
  total_cents: number | null;
  currency: string;
  item_count_in_household: number;
  selected_item_count: number;
  allocated_total_cents: number;
  selected_allocated_cents: number;
  unallocated_cents: number | null;
  has_unselected_items: boolean;
  has_allocations: boolean;
  receipt_document_id: UUID | null;
}

export interface EvidencePreview {
  fingerprint: string;
  format_version: string;
  household_name: string;
  generated_at: string;
  timezone: string;
  scope_label: string;
  scope: EvidenceScope;
  include_archived: boolean;
  options: EvidenceOptions;
  item_count: number;
  unit_count: number;
  at_home_unit_count: number;
  on_loan_unit_count: number;
  archived_excluded_count: number;
  missing_purchase_count: number;
  photo_count: number;
  included_photo_count: number;
  photo_bytes: number;
  document_count: number;
  included_document_count: number;
  document_bytes: number;
  evidence_reference_count: number;
  bundle_estimated_bytes: number;
  max_bundle_bytes: number;
  bundle_within_limit: boolean;
  can_generate: boolean;
  items: EvidenceItemPreview[];
  documents: EvidenceDocumentPreview[];
  currency_totals: EvidenceCurrencyTotal[];
  purchase_references: EvidencePurchaseReference[];
  warnings: string[];
}

export type EvidenceExportStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface EvidenceExportRecord {
  id: UUID;
  status: EvidenceExportStatus;
  format_version: string;
  scope_label: string;
  scope: EvidenceScope;
  include_archived: boolean;
  options: EvidenceOptions;
  item_count: number;
  unit_count: number;
  evidence_counts: Record<string, unknown>;
  warnings: string[];
  error: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  pdf_available: boolean;
  csv_available: boolean;
  bundle_available: boolean;
  pdf_bytes: number | null;
  csv_bytes: number | null;
  bundle_bytes: number | null;
  pdf_sha256: string | null;
  csv_sha256: string | null;
  bundle_sha256: string | null;
  can_manage: boolean;
}

export interface EvidenceExportList {
  items: EvidenceExportRecord[];
}
