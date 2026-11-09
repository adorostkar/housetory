import type { ItemCondition, UUID, WarrantyStatus } from "@/lib/types/core";
import type { DocumentBrief, DocumentRecord, ItemReference } from "@/lib/types/documents";
import type {
  CategoryBrief,
  LocationBrief,
  PropertyBrief,
  RoomBrief,
  TagBrief,
} from "@/lib/types/places";
import type { LastVerified } from "@/lib/types/stocktake";

export interface PurchaseAllocation {
  id: UUID;
  item_id: UUID;
  item: ItemReference;
  document_id: UUID | null;
  extraction_version: string | null;
  source_line_id: string | null;
  description: string;
  quantity: number;
  unit_price_cents: number | null;
  line_total_cents: number | null;
  allocated_cents: number | null;
  currency: string;
  source_evidence: string | null;
  created_at: string;
}

export interface Purchase {
  id: UUID;
  merchant: string | null;
  vendor: string | null;
  purchase_date: string | null;
  price_cents: number | null;
  currency: string;
  order_number: string | null;
  notes: string | null;
  receipt_document_id: UUID | null;
  receipt: DocumentBrief | null;
  items: ItemReference[];
  allocations: PurchaseAllocation[];
  allocated_total_cents: number;
  unallocated_cents: number | null;
  item_count: number;
  is_shared: boolean;
  created_at: string;
  updated_at: string;
}

export interface Warranty {
  id: UUID;
  provider: string | null;
  start_date: string | null;
  duration_months: number | null;
  end_date: string | null;
  reminder_days: number | null;
  effective_reminder_days: number;
  notes: string | null;
  coverage_notes: string | null;
  status: WarrantyStatus;
  days_remaining: number | null;
  document_id: UUID | null;
  document: DocumentBrief | null;
  item: ItemReference | null;
  created_at: string | null;
  updated_at: string | null;
}

export type ItemImageSource = "reference" | "ai";

export interface ItemImage {
  id: UUID | null;
  source_type: ItemImageSource;
  label: string;
  status: string;
  url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  source_name: string | null;
  source_url: string | null;
  source_page_url: string | null;
  license_note: string | null;
  license_name?: string | null;
  license_url?: string | null;
  permission_basis?:
    | "public_web"
    | "configured_source_policy"
    | "provider_license"
    | null;
  retrieved_at: string | null;
  exact_model_confirmed: boolean;
  model_label: string | null;
  provider_label: string | null;
  created_at: string | null;
}

export interface ItemImageSettings {
  auto_reference: boolean;
}

export interface ItemImageState {
  item_id: UUID;
  actual_photo_count: number;
  image: ItemImage | null;
  selected: ItemImage | null;
  settings: ItemImageSettings;
  search_configured: boolean;
  search_provider_label: string | null;
  search_reason: string | null;
}

export interface ItemImageBatchPreview {
  action: "reference";
  selected_count: number;
  eligible_count: number;
  skipped_has_photo: number;
  skipped_unavailable: number;
  notices: string[];
}

export interface ItemImageBatchJob {
  job_id: UUID;
  status: string;
  action: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface Photo {
  id: UUID;
  original_filename: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  sort_order: number;
  created_at: string;
  url: string;
  thumbnail_url: string;
}

export type ItemDisposition =
  | "sold"
  | "given_away"
  | "donated"
  | "discarded"
  | "lost"
  | "consumed"
  | "other";

export interface ItemSummary {
  id: UUID;
  name: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  quantity: number;
  on_loan_quantity?: number;
  condition: ItemCondition;
  is_archived: boolean;
  disposition?: ItemDisposition | null;
  disposed_on?: string | null;
  disposition_note?: string | null;
  room: RoomBrief | null;
  household?: { id: UUID; name: string } | null;
  property?: PropertyBrief | null;
  location: LocationBrief | null;
  location_path: LocationBrief[];
  category: CategoryBrief | null;
  tags: TagBrief[];
  primary_photo: Photo | null;
  representative_image?: ItemImage | null;
  purchase: Purchase | null;
  purchase_info_status:
    | "recorded"
    | "unrecorded"
    | "unknown"
    | "not_applicable";
  purchase_info_missing_fields: Array<"date" | "price">;
  warranty: Warranty | null;
  current_value_cents: number | null;
  current_value_currency: string;
  current_value_basis: "per_unit" | "legacy_record_total" | null;
  current_value_total_cents: number | null;
  current_value_estimated_at: string | null;
  current_value_estimate?: ItemValueEstimate | null;
  created_at: string;
  updated_at: string;
  last_verified?: LastVerified | null;
}

export interface ImportSourceBrief {
  batch_id: UUID;
  title: string;
  source_path: string | null;
  note_title: string | null;
  source_excerpt: string | null;
  created_at: string;
  url: string;
}

export interface StorageCategoryCount {
  name: string;
  item_count: number;
  total_quantity: number;
}

export interface ItemStorage {
  location_id: UUID;
  identifier: string | null;
  name: string;
  active: boolean;
  room_id: UUID | null;
  parent_id: UUID | null;
  path: LocationBrief[];
  item_count: number;
  total_quantity: number;
  direct_item_count: number;
  direct_total_quantity: number;
  empty: boolean;
  categories: StorageCategoryCount[];
  qr_url: string | null;
  qr_payload: string | null;
  qr_warning: string | null;
}

export interface ItemDetail extends ItemSummary {
  serial_number: string | null;
  valuation_fingerprint?: string;
  photos: Photo[];
  documents: DocumentRecord[];
  import_source: ImportSourceBrief | null;
  storage?: ItemStorage | null;
}

export interface ItemList {
  items: ItemSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ItemDetailResponse {
  item: ItemDetail;
}

export interface InsuranceScopeItem {
  item_id: UUID;
  name: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  quantity: number;
  condition: ItemCondition;
  is_archived: boolean;
  valuation_fingerprint: string;
  ai_eligible: boolean;
  ai_ineligible_reason: string | null;
}

export interface InsuranceScopePreview {
  items: InsuranceScopeItem[];
  scope_label: string;
  archived_excluded_count: number;
  max_items: number;
}

export interface InsuranceBatchEntry {
  item_id: UUID;
  status: "queued" | "running" | "estimated" | "failed" | "cancelled";
  estimate: ItemValuationPreview | null;
  error: string | null;
}

export interface InsuranceBatch {
  request_id: UUID;
  status: "queued" | "running" | "completed" | "partial" | "cancelled";
  total: number;
  processed: number;
  estimated: number;
  failed: number;
  items: InsuranceBatchEntry[];
}

export interface InsuranceJob {
  id: UUID;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  pdf_url: string | null;
  csv_url: string | null;
}

export type ValuationPurpose = "resale" | "replacement";

export type ValuationSourceKind = "ai" | "ai_web" | "manual";

export type ValuationConfidence = "low" | "medium" | "high";

export interface ValuationSource {
  title: string;
  url: string;
  snippet: string | null;
  price_text: string | null;
  price_cents: number | null;
  currency: string | null;
  currency_inferred: boolean;
  price_kind: "asking";
  retrieved_on: string;
}

export interface ItemValueEstimate {
  purpose: ValuationPurpose;
  source: ValuationSourceKind;
  currency: string;
  low_cents: number | null;
  high_cents: number | null;
  as_of: string;
  confidence: ValuationConfidence | null;
  reasoning: string | null;
  assumptions: string[];
  web_used: boolean;
  web_reason: string | null;
  sources: ValuationSource[];
}

export interface ItemValuationPreview {
  estimate_id: UUID;
  item_id: UUID;
  item_name: string;
  fingerprint: string;
  purpose: ValuationPurpose;
  source: ValuationSourceKind;
  currency: string;
  low_cents: number;
  suggested_cents: number;
  high_cents: number;
  owned_quantity: number;
  low_total_cents: number;
  suggested_total_cents: number;
  high_total_cents: number;
  as_of: string;
  confidence: ValuationConfidence;
  reasoning: string;
  assumptions: string[];
  web_used: boolean;
  web_reason: string | null;
  web_query: string | null;
  sources: ValuationSource[];
  existing_value_cents: number | null;
  existing_value_basis: "per_unit" | "legacy_record_total" | null;
  existing_value_currency: string | null;
  disclaimer: string;
}

export interface PhotoList {
  items: Photo[];
}

export interface DocumentList {
  items: DocumentRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface PurchaseList {
  items: Purchase[];
  total: number;
  limit: number;
  offset: number;
}

export interface WarrantyList {
  items: Warranty[];
  active_count: number;
  expiring_count: number;
  expired_count: number;
  unknown_count: number;
  reminder_days: number;
}

export interface WarrantyDashboard {
  active: Warranty[];
  expiring_soon: Warranty[];
  expired: Warranty[];
  active_count: number;
  expiring_count: number;
  expired_count: number;
  unknown_count: number;
  reminder_days: number;
}

export interface CurrencyTotal {
  currency: string;
  total_cents: number;
}

export interface CurrencyOwnership {
  currency: string;
  purchase_total_cents: number;
  current_value_total_cents: number;
  purchase_item_count: number;
  current_value_item_count: number;
}

export interface ValueBreakdownRow {
  name: string;
  currency: string;
  purchase_total_cents: number;
  current_value_total_cents: number;
  item_count: number;
}

export interface ValuableItem {
  item: ItemSummary;
  value_cents: number;
  currency: string;
  value_kind: "current" | "purchase";
  value_basis: "per_unit" | "legacy_record_total" | null;
}

export interface FinancialOverview {
  item_count: number;
  items_with_purchase_count: number;
  items_missing_purchase_count: number;
  currency_totals: CurrencyOwnership[];
  value_by_category: ValueBreakdownRow[];
  value_by_room: ValueBreakdownRow[];
  most_valuable_items: ValuableItem[];
  missing_purchase_items: ItemSummary[];
  exchange_rates_configured: boolean;
  conversion_note: string;
}

export interface Overview {
  room_count: number;
  location_count: number;
  item_count: number;
  total_quantity: number;
  value_by_currency: CurrencyTotal[];
  current_value_by_currency: CurrencyTotal[];
  document_count: number;
  warranties_expiring_soon: number;
  warranties: WarrantyDashboard;
  items_missing_purchase_count: number;
  photo_bytes: number;
  document_bytes: number;
  outstanding_loan_count: number;
  overdue_loan_count: number;
  on_loan_quantity: number;
  recent_items: ItemSummary[];
}

export interface PurchaseInput {
  merchant?: string | null;
  vendor?: string | null;
  purchase_date?: string | null;
  price_cents?: number | null;
  currency: string;
  order_number?: string | null;
  notes?: string | null;
  receipt_document_id?: UUID | null;
}

export interface PurchaseFormInput extends PurchaseInput {
  item_ids: UUID[];
}

export interface WarrantyInput {
  provider?: string | null;
  start_date?: string | null;
  duration_months?: number | null;
  end_date?: string | null;
  reminder_days?: number | null;
  document_id?: UUID | null;
  notes?: string | null;
}

export interface ItemInput {
  name: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  serial_number?: string | null;
  quantity: number;
  condition: ItemCondition;
  room_id?: UUID | null;
  storage_location_id?: UUID | null;
  category_id?: UUID | null;
  tag_ids: UUID[];
  purchase_id?: UUID | null;
  purchase?: PurchaseInput | null;
  purchase_info_status?: "auto" | "unknown" | "not_applicable" | null;
  warranty?: WarrantyInput | null;
  current_value_cents?: number | null;
  current_value_currency?: string;
  current_value_basis?: "per_unit" | "legacy_record_total" | null;
  is_archived?: boolean;
}

export interface ApiFieldErrors {
  [field: string]: string;
}
