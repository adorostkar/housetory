import type { AiStatus } from "@/lib/types/ai";
import type { DocumentType, OcrStatus, UUID } from "@/lib/types/core";
import type { ItemSummary } from "@/lib/types/items";

export interface ItemReference {
  id: UUID;
  name: string;
}

export interface DocumentBrief {
  id: UUID;
  title: string;
  document_type: DocumentType;
  content_type: string;
  url: string;
}

export interface ExtractedMetadata {
  merchant?: string | null;
  purchase_date?: string | null;
  total_cents?: number | null;
  currency?: string | null;
  product_names?: string[];
  invoice_number?: string | null;
  serial_numbers?: string[];
  source?: string;
  confidence?: number | null;
  applied_at?: string;
  applied_item_ids?: string[];
  [key: string]: unknown;
}

export interface DocumentPage {
  id: UUID;
  page_number: number;
  width: number;
  height: number;
  original_filename: string;
  original_content_type: string;
  original_byte_size: number;
  cleaned_content_type: string;
  cleaned_byte_size: number;
  original_url: string;
  cleaned_url: string;
  detection_status?: "detected" | "manual_required" | "manual";
  adjustments: {
    rotation: 0 | 90 | 180 | 270;
    corners: Array<{ x: number; y: number }>;
    color_mode: "color" | "grayscale" | "document";
    contrast: number;
  };
  updated_at: string;
}

export interface DocumentScan {
  id: UUID;
  status: "draft" | "committed";
  target_document_id?: UUID | null;
  pages: DocumentPage[];
  created_at: string;
  updated_at: string;
}

export interface DocumentSummary {
  id: UUID;
  title: string;
  document_type: DocumentType;
  original_filename: string;
  content_type: string;
  original_content_type: string;
  byte_size: number;
  original_byte_size: number;
  document_date: string | null;
  merchant: string | null;
  notes: string | null;
  ocr_status: OcrStatus;
  ocr_error: string | null;
  ocr_confidence: number | null;
  ocr_processed_at: string | null;
  created_at: string;
  updated_at: string;
  items: ItemReference[];
  item_count: number;
  page_count: number;
  url: string;
  original_url: string;
}

export interface DocumentRecord extends DocumentSummary {
  extracted_text: string | null;
  extracted_metadata: ExtractedMetadata;
  pages: DocumentPage[];
}

export interface ManualProfile {
  id: UUID;
  item_id: UUID;
  manufacturer: string;
  model_identifier: string;
  variant: string | null;
  confirmed_at: string;
  updated_at: string;
}

export interface ManualSearchStatus {
  configured: boolean;
  provider: "brave" | "gateway" | null;
  provider_label: string | null;
  reason: string | null;
  profile: ManualProfile | null;
  can_search: boolean;
}

export interface ItemManuals {
  item_id: UUID;
  manuals: DocumentRecord[];
  search: ManualSearchStatus;
}

export interface ManualReference {
  id: UUID;
  title: string;
  url: string;
  ocr_status: OcrStatus;
}

export interface ManualCitation {
  document_id: UUID;
  document_title: string;
  page: number | null;
  section: string | null;
  excerpt: string;
  url: string;
}

export type ManualAnswerMode = "ai" | "extractive" | "no_evidence";

export interface ManualAnswer {
  item_id: UUID;
  item_name: string;
  answer: string;
  mode: ManualAnswerMode;
  citations: ManualCitation[];
  manuals: ManualReference[];
  notices: string[];
  ai_status: AiStatus;
  source_kind: "attached_manual";
}

export interface WebCitation {
  title: string;
  url: string;
  publisher: string | null;
  language: string | null;
  source_type: string;
  excerpt: string;
}

export interface ManualOnlineAnswer {
  item_id: UUID;
  answer: string;
  mode: ManualAnswerMode;
  citations: WebCitation[];
  notices: string[];
  ai_status: AiStatus;
  source_kind: "online";
}

export interface ManualSearchCandidate {
  id: UUID;
  item_id: UUID;
  title: string;
  source_url: string;
  file_url: string;
  publisher: string | null;
  language: string | null;
  source_type: "manufacturer" | "official" | "other";
  model_coverage: string[];
  snippet: string | null;
  retrieved_at: string;
  document_id: UUID | null;
  direct_file: boolean;
  created_at: string;
}

export interface ManualCandidateList {
  item_id: UUID;
  candidates: ManualSearchCandidate[];
  notices: string[];
}

export interface ManualDownloadResult {
  document: DocumentRecord;
  candidate: ManualSearchCandidate;
  duplicate_documents: Array<{
    id: UUID;
    title: string;
    reused?: boolean;
  }>;
}

export type ExtractionLineKind =
  | "product"
  | "discount"
  | "tax"
  | "shipping"
  | "payment"
  | "change"
  | "other";

export type ExtractionMatchQuality =
  | "exact_identifier"
  | "strong"
  | "possible"
  | "none";

export type ExtractionLineAction = "skip" | "link" | "update" | "create";

export interface ExtractionSourceEvidence {
  page: number | null;
  line_number: number | null;
  text: string;
}

export interface ExtractionFields {
  merchant: string | null;
  purchase_date: string | null;
  document_date: string | null;
  currency: string | null;
  total_cents: number | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  order_number: string | null;
  brand: string | null;
  model: string | null;
  serial_numbers: string[];
  warranty_provider: string | null;
  warranty_start: string | null;
  warranty_end: string | null;
  warranty_months: number | null;
  field_sources: Record<string, string>;
  uncertain_fields: string[];
}

export interface ExtractionLine {
  id: string;
  line_number: number;
  kind: ExtractionLineKind;
  description: string;
  quantity: number | null;
  unit_price_cents: number | null;
  line_total_cents: number | null;
  evidence: ExtractionSourceEvidence;
  warnings: string[];
  purchase_eligible: boolean;
}

export interface CandidatePurchase {
  id: UUID;
  merchant: string | null;
  purchase_date: string | null;
  price_cents: number | null;
  currency: string;
}

export interface CandidateItem {
  id: UUID;
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  quantity: number;
  on_loan_quantity: number;
  room_name: string | null;
  location_name: string | null;
  purchase: CandidatePurchase | null;
  warranty: {
    provider: string | null;
    start_date: string | null;
    end_date: string | null;
    duration_months: number | null;
  } | null;
  reasons: string[];
  match_quality: ExtractionMatchQuality;
  exact_identifier: boolean;
}

export interface ExtractionLineMatch {
  line_id: string;
  candidates: CandidateItem[];
  quality: ExtractionMatchQuality;
  reasons: string[];
}

export interface ExtractionDuplicateDocument extends DocumentBrief {
  created_at: string;
}

export interface ExtractionApplySummary {
  request_id: UUID;
  applied_at: string;
  created_item_ids: UUID[];
  updated_item_ids: UUID[];
  linked_item_ids: UUID[];
  skipped_line_ids: string[];
  purchase_id: UUID | null;
}

export interface ExtractionReview {
  enhancement?: import("@/lib/types/enrichment").EnhancementState | null;
  suggested_refinement?: ExtractionRefinement | null;
  document_id: UUID;
  version: string;
  source_artifact: string;
  document_type: DocumentType;
  generated_at: string;
  purchase_eligible: boolean;
  fields: ExtractionFields;
  lines: ExtractionLine[];
  warnings: string[];
  matches: ExtractionLineMatch[];
  duplicate_documents: ExtractionDuplicateDocument[];
  applied: ExtractionApplySummary[];
  ai_status: AiStatus;
}

export interface ExtractionRefinement {
  document_id: UUID;
  base_version: string;
  version: string;
  source_artifact: string;
  generated_at: string;
  fields: ExtractionFields;
  lines: ExtractionLine[];
  warnings: string[];
  matches: ExtractionLineMatch[];
  ai_status: AiStatus;
  ai_used: boolean;
}

export interface ExtractionMatchResponse {
  document_id: UUID;
  version: string;
  matches: ExtractionLineMatch[];
  ai_status: AiStatus;
  ai_used: boolean;
  warnings: string[];
}

export interface ExtractionApplyResponse {
  document: DocumentRecord;
  request_id: UUID;
  created_item_ids: UUID[];
  updated_item_ids: UUID[];
  linked_item_ids: UUID[];
  skipped_line_ids: string[];
  purchase_id: UUID | null;
  warranty_item_ids: UUID[];
  warnings: string[];
  applied_at: string;
  items: ItemReference[];
}

export interface DocumentRelationSuggestion {
  item: ItemSummary;
  score: number;
  reasons: string[];
}

export interface DocumentRelations {
  items: DocumentRelationSuggestion[];
  suggested_item_ids: UUID[];
}
