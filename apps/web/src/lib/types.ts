export type UUID = string;

export type MemberRole = "owner" | "member";

export type LocationKind =
  | "room"
  | "closet"
  | "cabinet"
  | "shelf"
  | "drawer"
  | "box"
  | "bin"
  | "crate"
  | "suitcase"
  | "bag"
  | "other";

export type ContainerType = "box" | "bin" | "crate" | "suitcase" | "bag" | "other";

export type ItemCondition = "new" | "excellent" | "good" | "fair" | "poor" | "unknown";

export type DocumentType =
  | "receipt"
  | "invoice"
  | "warranty_certificate"
  | "manual"
  | "specification"
  | "other";

export type OcrStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed";

export type WarrantyStatus = "active" | "expiring" | "expired" | "unknown";

export interface User {
  id: UUID;
  name: string;
  email: string;
  created_at: string;
}

export interface Household {
  id: UUID;
  name: string;
  warranty_reminder_days: number;
}

export interface SessionState {
  authenticated: boolean;
  setup_required: boolean;
  user: User | null;
  household: Household | null;
  role: MemberRole | null;
}

export interface Room {
  id: UUID;
  name: string;
  description: string | null;
  parent_id: UUID | null;
  sort_order: number;
  item_count: number;
  location_count: number;
  total_item_count: number;
  total_location_count: number;
  created_at: string;
  updated_at: string;
}

export interface RoomList {
  items: Room[];
}

export interface StorageLocation {
  id: UUID;
  room_id: UUID;
  parent_id: UUID | null;
  name: string;
  description: string | null;
  kind: LocationKind;
  is_container: boolean;
  container_type: ContainerType | null;
  identifier: string | null;
  summary_headline: string | null;
  summary_short: string | null;
  label_generated_at: string | null;
  sort_order: number;
  item_count: number;
  total_item_count: number;
  created_at: string;
  updated_at: string;
}

export interface StorageLocationList {
  items: StorageLocation[];
}

export interface Category {
  id: UUID;
  name: string;
  parent_id: UUID | null;
  color: string | null;
  description: string | null;
  sort_order: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryList {
  items: Category[];
}

export interface Tag {
  id: UUID;
  name: string;
  created_at: string;
  item_count: number;
}

export interface TagList {
  items: Tag[];
}

export interface TagBrief {
  id: UUID;
  name: string;
}

export interface CategoryBrief {
  id: UUID;
  name: string;
  color: string | null;
}

export interface RoomBrief {
  id: UUID;
  name: string;
}

export interface LocationBrief {
  id: UUID;
  name: string;
  kind: LocationKind;
  parent_id: UUID | null;
  identifier: string | null;
  container_type: ContainerType | null;
  is_container: boolean;
}

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

export interface DocumentRecord {
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
  extracted_text: string | null;
  extracted_metadata: ExtractedMetadata;
  ocr_status: OcrStatus;
  ocr_error: string | null;
  ocr_confidence: number | null;
  ocr_processed_at: string | null;
  created_at: string;
  updated_at: string;
  items: ItemReference[];
  item_count: number;
  url: string;
  original_url: string;
}

export type ItemDocument = DocumentRecord;

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



export interface ItemSummary {
  id: UUID;
  name: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  quantity: number;
  condition: ItemCondition;
  is_archived: boolean;
  room: RoomBrief | null;
  location: LocationBrief | null;
  location_path: LocationBrief[];
  category: CategoryBrief | null;
  tags: TagBrief[];
  primary_photo: Photo | null;
  purchase: Purchase | null;
  warranty: Warranty | null;
  current_value_cents: number | null;
  current_value_currency: string;
  created_at: string;
  updated_at: string;
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

export interface ItemDetail extends ItemSummary {
  serial_number: string | null;
  photos: Photo[];
  documents: DocumentRecord[];
  import_source: ImportSourceBrief | null;
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
  current_value_cents: number;
  purchase_item_count: number;
  current_value_item_count: number;
}

export interface ValueBreakdownRow {
  name: string;
  currency: string;
  purchase_total_cents: number;
  current_value_cents: number;
  item_count: number;
}

export interface ValuableItem {
  item: ItemSummary;
  value_cents: number;
  currency: string;
  value_kind: "current" | "purchase";
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
  warranty?: WarrantyInput | null;
  current_value_cents?: number | null;
  current_value_currency?: string;
  is_archived?: boolean;
}

export interface RoomInput {
  name: string;
  description?: string | null;
  parent_id?: UUID | null;
  sort_order?: number;
}

export interface StorageLocationInput {
  room_id: UUID;
  parent_id?: UUID | null;
  name: string;
  description?: string | null;
  kind: LocationKind;
  sort_order?: number;
}

export interface CategoryInput {
  name: string;
  parent_id?: UUID | null;
  color?: string | null;
  description?: string | null;
}

export interface TagInput {
  name: string;
}

export interface DocumentUploadInput {
  file: File;
  title: string;
  document_type: DocumentType;
  item_ids: UUID[];
  merchant?: string | null;
  document_date?: string | null;
  notes?: string | null;
}

export interface DocumentUpdateInput {
  title?: string;
  document_type?: DocumentType;
  document_date?: string | null;
  merchant?: string | null;
  notes?: string | null;
  item_ids?: UUID[];
}

export interface OcrItemUpdateInput {
  item_id: UUID;
  name?: string | null;
  serial_number?: string | null;
}

export interface OcrApplyInput {
  item_ids: UUID[];
  create_purchase: boolean;
  merchant?: string | null;
  purchase_date?: string | null;
  price_cents?: number | null;
  currency: string;
  order_number?: string | null;
  notes?: string | null;
  document_date?: string | null;
  attach_as_receipt: boolean;
  item_updates: OcrItemUpdateInput[];
}

export interface OcrApplyResponse {
  document: DocumentRecord;
  purchase_id: UUID | null;
  updated_item_ids: UUID[];
}

export interface ApiFieldErrors {
  [field: string]: string;
}


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

export interface ImportApplyEntry {
  id: UUID;
  action: ImportEntryAction;
  entity_type?: ImportEntityType;
  parent_entry_id?: UUID | null;
  legacy_identifier?: string | null;
  allow_duplicate?: boolean;
  proposed?: ProposedItem;
  merge_item_id?: UUID | null;
  merge_fields?: ImportMergeField[];
}

export interface ImportApplyResult {
  batch: ImportBatchDetail;
  created: number;
  merged: number;
  skipped: number;
  rejected: number;
  failed: number;
  failures: Array<{ entry_id: UUID; message: string }>;
}

export interface AiStatus {
  provider: string;
  mode: "disabled" | "local" | "private" | "cloud";
  source?: "disabled" | "environment" | "database";
  task?: string;
  provider_id?: UUID | null;
  provider_label?: string | null;
  capabilities?: string[];
  model: string | null;
  configured: boolean;
  available: boolean;
  catalog_checked: boolean;
  catalog_count: number;
  cloud_enabled: boolean;
  cloud_consent: boolean;
  data_leaves_server: boolean;
  error: string | null;
  privacy_note: string;
}

export interface AiRecognitionSuggestion {
  name: string;
  quantity: number;
  description: string | null;
  category: string | null;
  brand: string | null;
  model: string | null;
  tags: string[];
  notes: string | null;
  confidence: number | null;
  source?: "vision" | "ocr";
  field_sources: Record<string, string>;
}

export interface AiRecognition {
  id: UUID;
  status: "queued" | "processing" | "succeeded" | "failed";
  original_filename: string;
  content_type: string;
  width: number;
  height: number;
  result: {
    suggestions?: AiRecognitionSuggestion[];
    warnings?: string[];
  };
  field_sources: Record<string, string>;
  confidence: number | null;
  error: string | null;
  model_provider: string | null;
  model_name: string | null;
  room_id?: UUID | null;
  location_id?: UUID | null;
  location_label?: string | null;
  suggestion_duplicates?: AiRecognitionDuplicateGroup[];
  processing_mode?: "deterministic" | "local" | "private" | "cloud" | "unavailable";
  applied_at?: string | null;
  applied_items?: Array<Record<string, unknown>>;
  created_at: string;
  completed_at: string | null;
  image_url: string;
  original_url: string;
}

export interface AiRecognitionList {
  items: AiRecognition[];
}

export interface AssistantReference {
  type: "item" | "document" | "room" | "location" | "purchase" | "warranty";
  id: UUID;
  title: string;
  subtitle: string | null;
  url: string;
}

export interface AssistantResponse {
  answer: string;
  mode: "deterministic" | "ai";
  tool: string | null;
  filters: Record<string, unknown>;
  items: ItemSummary[];
  documents: Array<{
    id: string;
    title: string;
    type: string;
    merchant: string | null;
    document_date: string | null;
    items: string[];
    url: string;
  }>;
  locations: Array<{
    id: string;
    type: "room" | "storage_location";
    name: string;
    url: string;
    room?: string | null;
    item_count?: number;
  }>;
  references: AssistantReference[];
  notices: string[];
  ai_status: AiStatus;
}

export interface NaturalSearchFilters {
  q: string | null;
  room_id: UUID | null;
  room_name: string | null;
  exclude_room_id: UUID | null;
  location_id: UUID | null;
  location_name: string | null;
  category_id: UUID | null;
  category_name: string | null;
  tag: string | null;
  missing_purchase: boolean;
  missing_serial: boolean;
  warranty_status: "active" | "expiring" | "expired" | null;
  purchased_after: string | null;
  purchased_before: string | null;
  min_purchase_cents: number | null;
  max_purchase_cents: number | null;
  sort: "relevance" | "purchase_desc" | "purchase_asc" | "name_asc";
}

export interface NaturalSearchResponse {
  question: string;
  interpretation: string;
  filters: NaturalSearchFilters;
  items: ItemSummary[];
  total: number;
  mode: "deterministic" | "ai";
  ai_available: boolean;
}

export type QuickSearchKind = "item" | "container" | "location";

export interface QuickSearchResult {
  id: UUID;
  kind: QuickSearchKind;
  title: string;
  subtitle: string | null;
  context: string | null;
  url: string;
}

export interface QuickSearchResponse {
  query: string;
  results: QuickSearchResult[];
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


export interface ContainerSummary {
  short: string;
  detailed: string;
  headline: string | null;
  lines: string[];
  detailed_lines: string[];
  item_count: number;
  total_quantity: number;
  empty: boolean;
  stale: boolean;
  needs_refresh: boolean;
  stored: boolean;
  source: "deterministic" | "ai" | "manual" | null;
  contents_hash: string;
  generated_at: string | null;
  label_generated_at: string | null;
  label_stale: boolean;
  contents_updated_at: string | null;
}

export interface Container {
  id: UUID;
  identifier: string | null;
  legacy_identifier?: string | null;
  aliases?: string[];
  name: string;
  description: string | null;
  kind: LocationKind;
  container_type: ContainerType | null;
  is_container: boolean;
  room_id: UUID;
  parent_id: UUID | null;
  room: RoomBrief;
  path: LocationBrief[];
  item_count: number;
  total_item_count: number;
  total_quantity: number;
  child_count: number;
  container_count: number;
  summary_short: string | null;
  summary_headline: string | null;
  qr_payload: string;
  qr_url: string;
  qr_warning: string | null;
  label_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContainerChild {
  id: UUID;
  identifier: string | null;
  legacy_identifier?: string | null;
  aliases?: string[];
  name: string;
  kind: LocationKind;
  container_type: ContainerType | null;
  is_container: boolean;
  room_id: UUID;
  parent_id: UUID | null;
  item_count: number;
  total_item_count: number;
  total_quantity: number;
  child_count: number;
}

export interface ContainerDetail extends Container {
  room_path: RoomBrief[];
  items: ItemSummary[];
  children: ContainerChild[];
  documents: DocumentBrief[];
  summary: ContainerSummary;
}

export interface ContainerList {
  items: Container[];
  total: number;
  qr_base_url: string;
  qr_warning: string | null;
}

export interface ContainerBulkResult {
  items: Container[];
  identifiers: string[];
}

export interface ContainerQrConfig {
  base_url: string;
  warning: string | null;
  local_only: boolean;
}

export interface LabelGeometry {
  paper_width_mm: number;
  paper_height_mm: number;
  label_width_mm: number;
  label_height_mm: number;
  columns: number;
  rows: number;
  top_margin_mm: number;
  left_margin_mm: number;
  horizontal_pitch_mm: number;
  vertical_pitch_mm: number;
}

export interface LabelPreset extends LabelGeometry {
  code: string;
  name: string;
  description: string;
  manufacturer_code: string | null;
  default_layout: "compact" | "standard" | "detailed";
}

export interface LabelTemplateList {
  items: LabelPreset[];
  default: string;
}

export type LabelLayout = "compact" | "standard" | "detailed";

export interface LabelPrintInput {
  location_ids: UUID[];
  template: string;
  layout: LabelLayout;
  copies: number;
  start_slot: number;
  offset_x_mm: number;
  offset_y_mm: number;
  record: boolean;
  custom?: LabelGeometry | null;
}


export interface AiProviderRecord {
  id: UUID;
  provider: string;
  display_name: string;
  base_url: string | null;
  default_model: string | null;
  has_api_key: boolean;
  api_key_version: number;
  enabled: boolean;
  cloud_consent: boolean;
  is_local: boolean;
  endpoint_scope: "local" | "private" | "remote";
  capabilities: string[];
  created_at: string;
  updated_at: string;
}

export interface AiTaskSetting {
  task: string;
  provider_id: UUID | null;
  provider_label: string | null;
  model: string | null;
  enabled: boolean;
  capabilities: string[];
  updated_at: string | null;
}

export interface AiSettings {
  providers: AiProviderRecord[];
  tasks: AiTaskSetting[];
  credential_key_configured: boolean;
  environment_provider: string;
  warning: string | null;
}

export interface AiProviderTest {
  ok: boolean;
  message: string;
  models: string[];
  selected_model_available: boolean | null;
}

export interface AiProviderModel {
  id: string;
  display_name: string | null;
  kind: "chat" | "embedding" | "speech" | "image" | "other";
  capabilities: string[];
  capability_source: "provider_metadata" | "heuristic";
}

export interface AiProviderModels {
  provider_id: UUID;
  models: AiProviderModel[];
  error: string | null;
  cached: boolean;
}

export interface AiRecognitionDuplicateGroup {
  suggestion_index: number;
  candidates: DuplicateCandidate[];
}

export interface AiRecognitionApplyInput {
  entries: Array<{
    suggestion_index: number;
    entry_key?: string;
    action: "create" | "update" | "reject";
    proposal?: AiRecognitionSuggestion | null;
    item_id?: UUID | null;
    category_id?: UUID | null;
    room_id?: UUID | null;
    location_id?: UUID | null;
    allow_duplicate?: boolean;
  }>;
}

export interface AiRecognitionApplyResult {
  recognition: AiRecognition;
  created: number;
  updated: number;
  rejected: number;
  skipped: number;
  failed: number;
  failures: Array<{ suggestion_index: number; message: string }>;
}
