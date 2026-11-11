import type { UUID } from "@/lib/types/core";
import type { EnhancementState } from "@/lib/types/enrichment";

export type ImportStatus =
  | "queued"
  | "processing"
  | "review"
  | "applying"
  | "completed"
  | "failed";

export type ImportSourceType = "text" | "file" | "vault" | "image";

export type ImportEntryStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "imported"
  | "skipped"
  | "merged"
  | "failed";

export type DuplicateResolution = "new" | "skip" | "merge";

export interface LocationCandidate {
  id: UUID;
  name: string;
  identifier?: string | null;
  kind: string | null;
  room_id: UUID | null;
  parent_id: UUID | null;
  score: number;
}

export interface LocationProposal {
  text: string;
  entity_type: "room" | "storage_location";
  identifier?: string | null;
  status: "matched" | "ambiguous" | "missing" | "none";
  matched_id: UUID | null;
  name: string | null;
  room_id: UUID | null;
  parent_id: UUID | null;
  suggested_parent_id: UUID | null;
  candidates: LocationCandidate[];
}

export interface NamedMatch {
  text: string;
  status: "matched" | "ambiguous" | "missing" | "none";
  matched_id: UUID | null;
  name: string | null;
  candidates: LocationCandidate[];
}

export interface ProposedPurchase {
  purchase_date: string | null;
  price_cents: number | null;
  currency: string | null;
  merchant: string | null;
  order_number: string | null;
  notes: string | null;
}

export interface ProposedWarranty {
  provider: string | null;
  start_date: string | null;
  duration_months: number | null;
  end_date: string | null;
  notes: string | null;
}

export interface ProposedItem {
  name: string;
  description: string | null;
  quantity: number;
  category: NamedMatch | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  room: LocationProposal | null;
  storage_location: LocationProposal | null;
  purchase: ProposedPurchase | null;
  warranty: ProposedWarranty | null;
  tags: string[];
  notes: string | null;
  collection: string | null;
  relationships: Record<string, unknown>;
  field_sources: Record<string, string>;
  confidence: number | null;
}

export interface DuplicateCandidate {
  item_id: UUID;
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  room_name: string | null;
  location_name: string | null;
  purchase_date: string | null;
  score: number;
  reasons: string[];
}

export interface ImportEntry {
  id: UUID;
  source_file_id: UUID | null;
  source_path: string | null;
  source_excerpt: string | null;
  note_title: string | null;
  proposed: ProposedItem;
  field_sources: Record<string, string>;
  confidence: number | null;
  status: ImportEntryStatus;
  duplicate_candidates: DuplicateCandidate[];
  duplicate_resolution: DuplicateResolution | null;
  matched_item_id: UUID | null;
  imported_item_id: UUID | null;
  entity_type?: "item" | "room" | "container" | "location";
  parent_entry_id?: UUID | null;
  created_room_id?: UUID | null;
  created_location_id?: UUID | null;
  legacy_identifier?: string | null;
  error: string | null;
  position: number;
}

export interface ImportSourceFile {
  id: UUID;
  relative_path: string;
  kind: "note" | "attachment";
  content_type: string;
  byte_size: number;
  is_referenced: boolean;
  url: string;
}

export interface ImportBatch {
  id: UUID;
  title: string;
  source_type: ImportSourceType;
  status: ImportStatus;
  original_filename: string | null;
  content_type: string | null;
  byte_size: number | null;
  error: string | null;
  warnings: Array<Record<string, unknown>>;
  total_entries: number;
  imported_entries: number;
  skipped_entries: number;
  failed_entries: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  source_url: string | null;
  entry_count: number;
}

export interface ImportBatchDetail extends ImportBatch {
  enhancement?: EnhancementState & {
    proposals: Array<{
      entry_id: UUID | null;
      proposed: ProposedItem;
      entity_type: "item" | "room" | "container" | "location";
      legacy_identifier: string | null;
      source_excerpt: string | null;
    }>;
  } | null;
  entries: ImportEntry[];
  files: ImportSourceFile[];
  vault_tree: Array<{
    name: string;
    path: string;
    type: "file" | "folder";
    children?: Array<{
      name: string;
      path: string;
      type: "file" | "folder";
      children?: unknown[];
    }>;
  }>;
  ignored_notes: Array<{ path: string; title: string; reason: string }>;
  broken_links: Array<{ note: string; target: string }>;
  metadata: Record<string, unknown>;
}

export interface ImportBatchList {
  items: ImportBatch[];
  total: number;
  limit: number;
  offset: number;
}

export type ImportEntryAction = "import" | "skip" | "reject" | "merge";

export type ImportMergeField =
  | "name"
  | "description"
  | "brand"
  | "model"
  | "serial_number"
  | "quantity"
  | "category"
  | "room"
  | "storage_location"
  | "purchase"
  | "warranty"
  | "tags"
  | "notes";

export interface ImportApplyResult {
  batch: ImportBatchDetail;
  created: number;
  merged: number;
  skipped: number;
  rejected: number;
  failed: number;
  failures: Array<{ entry_id: UUID; message: string }>;
}

export type ImportEntityType = "item" | "room" | "container" | "location";

export interface ImportDecision {
  include: boolean;
  action: ImportEntryAction;
  mergeItemId: string;
  mergeFields: ImportMergeField[];
  entityType?: ImportEntityType;
  parentEntryId?: UUID | null;
  legacyIdentifier?: string | null;
  allowDuplicate?: boolean;
}
