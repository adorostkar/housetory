export type UUID = string;

export type MemberRole = "owner" | "member" | "viewer";

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
  item_image_auto_reference?: boolean;
}

export interface HouseholdMembership extends Household {
  role: MemberRole;
  property_count: number;
  is_current: boolean;
}

export interface SessionState {
  authenticated: boolean;
  setup_required: boolean;
  user: User | null;
  household: Household | null;
  role: MemberRole | null;
  households?: HouseholdMembership[];
}

export interface SearchHousehold {
  id: UUID;
  name: string;
  role: MemberRole;
}

export interface SearchProperty {
  id: UUID;
  name: string;
  is_archived: boolean;
}

export interface SearchScopeHousehold extends SearchHousehold {
  properties: SearchProperty[];
}

export interface SearchScopeList {
  items: SearchScopeHousehold[];
}

export interface HouseholdMember {
  user_id: UUID;
  name: string;
  email: string;
  role: MemberRole;
  joined_at: string;
}

export interface MemberList {
  members: HouseholdMember[];
  email_configured: boolean;
}

export interface HouseholdInvitation {
  id: UUID;
  email: string;
  role: MemberRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  last_sent_at: string | null;
  created_at: string;
}

export interface InvitationList {
  items: HouseholdInvitation[];
  email_configured: boolean;
}

export interface InvitationPublic {
  household_name: string;
  email: string;
  role: MemberRole;
  expires_at: string;
  account_exists: boolean;
  authenticated_email_matches: boolean;
}

export interface PropertyBrief {
  id: UUID;
  name: string;
  is_archived: boolean;
}

export interface Property extends PropertyBrief {
  description: string | null;
  sort_order: number;
  room_count: number;
  container_count: number;
  location_count: number;
  item_count: number;
  total_quantity: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyList {
  items: Property[];
}

export interface Room {
  id: UUID;
  name: string;
  description: string | null;
  property_id?: UUID;
  property?: PropertyBrief;
  parent_id: UUID | null;
  sort_order: number;
  item_count: number;
  location_count: number;
  total_item_count: number;
  total_location_count: number;
  recoverable_deleted_location_count?: number;
  created_at: string;
  updated_at: string;
}

export interface RoomList {
  items: Room[];
}
export interface RoomPropertyMovePreview {
  room_id: UUID;
  room_name: string;
  current_property: PropertyBrief;
  destination_property: PropertyBrief;
  descendant_room_count: number;
  descendant_container_count: number;
  item_count: number;
  total_quantity: number;
  on_loan_quantity: number;
  fingerprint: string;
  can_move: boolean;
  warning: string | null;
}

export interface RoomPropertyMoveResult extends RoomPropertyMovePreview {
  history_event_id: UUID;
  affected_item_ids: UUID[];
}

export interface RoomPropertyMoveResponse {
  preview: RoomPropertyMovePreview;
  result: RoomPropertyMoveResult | null;
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
  label_generated_at: string | null;
  owner_item?: ItemReference | null;
  sort_order: number;
  item_count: number;
  total_item_count: number;
  recoverable_deleted_child_count?: number;
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
  pages: DocumentPage[];
  created_at: string;
  updated_at: string;
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
  pages: DocumentPage[];
  page_count: number;
  url: string;
  original_url: string;
}

export type ItemDocument = DocumentRecord;

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
  review?: boolean;
  review_reason?: string | null;
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
  processing_path?: "vision" | "ocr" | "none" | "failed" | "unavailable";
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
  type:
    | "item"
    | "document"
    | "room"
    | "location"
    | "purchase"
    | "warranty"
    | "loan";
  id: UUID;
  title: string;
  subtitle: string | null;
  url: string;
  household_id?: UUID | null;
  household_name?: string | null;
}

export interface AssistantResponse {
  answer: string;
  mode: "deterministic" | "ai";
  tool: string | null;
  filters: Record<string, unknown>;
  items: ItemSummary[];
  borrowed: BorrowedRecord[];
  documents: Array<{
    id: string;
    title: string;
    type: string;
    merchant: string | null;
    document_date: string | null;
    items: string[];
    url: string;
    household_id?: string;
    household_name?: string;
  }>;
  locations: Array<{
    id: string;
    type: "room" | "storage_location";
    name: string;
    url: string;
    room?: string | null;
    item_count?: number;
    household_id?: string;
    household_name?: string;
  }>;
  references: AssistantReference[];
  notices: string[];
  facts: Record<string, unknown>;
  ai_status: AiStatus;
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
}

export interface NaturalSearchFilters {
  q: string | null;
  household_id?: UUID | null;
  property_id?: UUID | null;
  room_id: UUID | null;
  room_name: string | null;
  exclude_room_id: UUID | null;
  location_id: UUID | null;
  location_name: string | null;
  category_id: UUID | null;
  category_name: string | null;
  tag: string | null;
  missing_purchase: boolean;
  missing_purchase_date: boolean;
  missing_purchase_price: boolean;
  purchase_info_status:
    | "missing"
    | "unknown"
    | "not_applicable"
    | "recorded"
    | "missing_date"
    | "missing_price"
    | null;
  missing_serial: boolean;
  warranty_status: "active" | "expiring" | "expired" | null;
  purchased_after: string | null;
  purchased_before: string | null;
  min_purchase_cents: number | null;
  max_purchase_cents: number | null;
  sort: "relevance" | "purchase_desc" | "purchase_asc" | "name_asc";
}

export interface SearchContextItemRef {
  id: UUID;
  name: string;
}

export interface SearchContextLoanRef {
  id: UUID;
  item_id: UUID | null;
  item_name: string | null;
  borrower_name: string | null;
}

export interface SearchConversationContext {
  scope_key: string | null;
  last_query: string | null;
  resolved_items: SearchContextItemRef[];
  candidate_items: SearchContextItemRef[];
  loans: SearchContextLoanRef[];
}

export interface SearchQueryResponse {
  query: string;
  mode: "direct" | "ai" | "fallback";
  ai_used: boolean;
  ai_attempted: boolean;
  direct_match: boolean;
  ambiguous: boolean;
  needs_clarification: boolean;
  answer: string | null;
  answer_kind: string | null;
  interpretation: string;
  filters: NaturalSearchFilters;
  items: ItemSummary[];
  quick_results: QuickSearchResult[];
  borrowed: BorrowedRecord[];
  borrowed_total: number;
  total: number;
  documents: Array<{
    id: string;
    title: string;
    type: string;
    merchant: string | null;
    document_date: string | null;
    items: string[];
    url: string;
    household_id?: string;
    household_name?: string;
  }>;
  locations: Array<{
    id: string;
    type: "room" | "storage_location";
    name: string;
    url: string;
    room?: string | null;
    item_count?: number;
    household_id?: string;
    household_name?: string;
  }>;
  references: AssistantReference[];
  notices: string[];
  facts: Record<string, unknown>;
  tool: string | null;
  ai_status: AiStatus;
  context: SearchConversationContext;
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
}

export interface NaturalSearchResponse {
  question: string;
  interpretation: string;
  filters: NaturalSearchFilters;
  items: ItemSummary[];
  borrowed: BorrowedRecord[];
  borrowed_total: number;
  total: number;
  mode: "deterministic" | "ai";
  ai_available: boolean;
  answer: string | null;
  answer_kind: string | null;
  tool: string | null;
  facts: Record<string, unknown>;
  notices: string[];
  references: AssistantReference[];
  needs_assistant: boolean;
  suggested_question: string | null;
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
}

export type QuickSearchKind = "item" | "container" | "location" | "borrowed";

export interface QuickSearchLoan {
  on_loan_quantity: number;
  borrower_names: string[];
  next_due_on: string | null;
}

export interface QuickSearchResult {
  id: UUID;
  kind: QuickSearchKind;
  title: string;
  subtitle: string | null;
  context: string | null;
  url: string;
  household?: SearchHousehold | null;
  loan: QuickSearchLoan | null;
}

export interface QuickSearchResponse {
  query: string;
  effective_query: string | null;
  question_like: boolean;
  results: QuickSearchResult[];
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
  notices?: string[];
}

export interface SearchItemList {
  items: ItemSummary[];
  total: number;
  limit: number;
  offset: number;
  borrowed: BorrowedRecord[];
  borrowed_total: number;
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
  notices?: string[];
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


export interface ContainerCategoryCount {
  name: string;
  item_count: number;
  total_quantity: number;
}

export interface ContainerSummary {
  item_count: number;
  total_quantity: number;
  direct_item_count: number;
  direct_total_quantity: number;
  empty: boolean;
  categories: ContainerCategoryCount[];
  label_generated_at: string | null;
}

export interface Container {
  id: UUID;
  property?: PropertyBrief;
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
  recoverable_deleted_child_count?: number;
  owner_item?: ItemReference | null;
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
  owner_item_detail?: ItemSummary | null;
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

export interface PlaceDestination {
  property_id: UUID | null;
  property_name: string | null;
  room_id: UUID;
  room_name: string;
  location_id: UUID | null;
  location_name: string | null;
  location_identifier: string | null;
  path: string[];
}

export interface PlacePreviewItem {
  id: UUID;
  name: string;
  quantity: number;
  is_archived: boolean;
  place_label: string;
  on_loan_quantity: number;
}

export interface PlacePreviewLocation {
  id: UUID;
  name: string;
  identifier: string | null;
  kind: LocationKind;
  is_container: boolean;
  total_item_count: number;
  total_quantity: number;
}

export interface PlacePreviewRoom {
  id: UUID;
  name: string;
  total_item_count: number;
}

export interface PlaceTransferPreview {
  source_kind: "location" | "room";
  source_id: UUID;
  source_label: string;
  source_path: string[];
  destination: PlaceDestination | null;
  direct_item_count: number;
  nested_item_count: number;
  total_item_count: number;
  total_quantity: number;
  archived_item_count: number;
  on_loan_quantity: number;
  nested_place_count: number;
  child_room_count: number;
  borrowed_record_count: number;
  source_photo_count: number;
  items_preview: PlacePreviewItem[];
  nested_places_preview: PlacePreviewLocation[];
  child_rooms_preview: PlacePreviewRoom[];
  blockers: string[];
  warnings: string[];
  can_proceed: boolean;
  fingerprint: string;
}

export interface PlaceTransferResult {
  request_id: UUID;
  history_event_id: UUID;
  source_kind: "location" | "room";
  source_id: UUID;
  source_label: string;
  deleted: boolean;
  direct_items_moved: number;
  nested_items_moved: number;
  total_items_preserved: number;
  total_quantity: number;
  nested_places_moved: number;
  child_rooms_moved: number;
  borrowed_records_moved: number;
  on_loan_quantity: number;
  destination: PlaceDestination;
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

export type AiTaskCompatibility =
  | "compatible"
  | "unverified"
  | "incompatible"
  | "adapter_unavailable"
  | "not_configured";

export interface AiTaskSetting {
  task: string;
  provider_id: UUID | null;
  provider_label: string | null;
  model: string | null;
  model_label?: string | null;
  model_listed?: boolean;
  compatibility?: AiTaskCompatibility;
  enabled: boolean;
  capabilities: string[];
  last_test_status?: "passed" | "failed" | "unsupported" | null;
  last_test_at?: string | null;
  last_test_error?: string | null;
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

export interface AiTaskTestResult {
  task: string;
  status: "passed" | "failed" | "unsupported";
  message: string;
  tested_at: string;
  model: string | null;
  provider_label: string | null;
}

export interface SystemReadinessComponent {
  name: string;
  status: "ok" | "degraded" | "unknown";
  detail: string | null;
}

export interface SystemFailedJob {
  id: UUID;
  task: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface SystemTaskStatus {
  task: string;
  label: string;
  provider_label: string | null;
  model: string | null;
  model_label: string | null;
  model_listed: boolean;
  enabled: boolean;
  configured: boolean;
  compatibility: AiTaskCompatibility;
  capabilities: string[];
  live_tested: boolean;
  last_test_status: "passed" | "failed" | "unsupported" | null;
  last_test_at: string | null;
  last_test_error: string | null;
  error: string | null;
}

export interface SystemExternalService {
  name: string;
  configured: boolean;
  status: "configured" | "partial" | "not_configured" | "unknown";
  detail: string;
  source?: string | null;
  settings_path?: string | null;
}

export type ReviewScopeType =
  | "items"
  | "room"
  | "container"
  | "property"
  | "household";
export type ReviewSuggestionType =
  | "category"
  | "name"
  | "possible_duplicate"
  | "missing_detail"
  | "location_conflict";
export type ReviewSuggestionStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "stale"
  | "reverted";
export type ReviewActionKind = "apply_category" | "apply_name" | "advisory";

export type ReviewRunTrigger = "manual" | "scheduled";
export type ReviewScheduleScope = "household" | "property" | "room" | "container";
export type ReviewScheduleFrequency = "weekly" | "monthly";
export type ReviewScheduleState =
  | "disabled"
  | "not_configured"
  | "consent_needed"
  | "ai_not_configured"
  | "scheduled"
  | "attention";
export type ReviewScheduleLastStatus =
  | "never"
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "disabled";

export interface ReviewRun {
  id: UUID;
  request_id: UUID;
  trigger_type: ReviewRunTrigger;
  schedule_id: UUID | null;
  scope_type: ReviewScopeType;
  scope_id: UUID | null;
  scope_label: string;
  include_ai: boolean;
  status: "completed" | "partial" | "failed";
  total_item_count: number;
  item_count_scanned: number;
  created_suggestion_count: number;
  existing_suggestion_count: number;
  stale_suggestion_count: number;
  suppressed_suggestion_count: number;
  ai_used: boolean;
  ai_provider_label: string | null;
  ai_model: string | null;
  ai_error: string | null;
  partial_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ReviewSuggestion {
  id: UUID;
  run_id: UUID | null;
  type: ReviewSuggestionType;
  action_kind: ReviewActionKind;
  status: ReviewSuggestionStatus;
  source: string;
  priority: number;
  title: string;
  explanation: string;
  scope_type: ReviewScopeType;
  scope_id: UUID | null;
  item_id: UUID | null;
  secondary_item_id: UUID | null;
  category_id: UUID | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  evidence: Record<string, unknown>;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  applied_at: string | null;
  dismissed_at: string | null;
  reverted_at: string | null;
  can_undo: boolean;
  undo_blocked_reason: string | null;
  item: ItemSummary | null;
  secondary_item: ItemSummary | null;
}

export interface ReviewSuggestionList {
  items: ReviewSuggestion[];
  total: number;
  pending_count: number;
  status_counts: Record<string, number>;
  type_counts: Record<string, number>;
}

export interface ReviewScheduleSummary {
  configured: boolean;
  enabled: boolean;
  state: ReviewScheduleState;
  state_detail: string;
  scope_type: ReviewScheduleScope;
  scope_label: string;
  frequency: ReviewScheduleFrequency;
  timezone: string;
  weekday: number;
  monthly_day: number;
  local_hour: number;
  max_items: number;
  max_runs_per_day: number;
  provider_request_cap: number;
  include_ai: boolean;
  ai_consent_valid: boolean;
  assistant_configured: boolean;
  assistant_provider_label: string | null;
  assistant_model: string | null;
  last_run_at: string | null;
  last_run_status: ReviewScheduleLastStatus;
  last_run_detail: string | null;
  next_due_at: string | null;
}

export interface ReviewSchedule extends ReviewScheduleSummary {
  id: UUID;
  household_id: UUID;
  scope_id: UUID | null;
  ai_consent: boolean;
  ai_consent_at: string | null;
  ai_consent_reason: string | null;
  ai_consent_provider_label: string | null;
  ai_consent_model: string | null;
  assistant_task: string;
  assistant_mode: string;
  assistant_error: string | null;
  last_run_id: UUID | null;
  last_run_job_id: UUID | null;
  last_dispatch_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewSummary {
  pending_count: number;
  status_counts: Record<string, number>;
  type_counts: Record<string, number>;
  last_run: ReviewRun | null;
  schedule: ReviewScheduleSummary | null;
}

export interface ReviewDecision {
  suggestion_id: UUID;
  status: "applied" | "stale" | "skipped" | "unsupported";
  message: string;
  suggestion: ReviewSuggestion | null;
}

export interface ReviewBulkAcceptResult {
  applied_count: number;
  skipped_count: number;
  stale_count: number;
  unsupported_count: number;
  results: ReviewDecision[];
}

export interface SystemStatusIssue {
  kind: "core" | "configured_feature";
  label: string;
  detail: string;
  settings_path: string | null;
}

export interface SystemStatusSummary {
  status: "healthy" | "attention";
  attention_count: number;
  core_issue_count: number;
  configured_feature_issue_count: number;
  optional_not_configured: string[];
  issues: SystemStatusIssue[];
  generated_at: string;
}

export interface SystemScheduledReview {
  configured: boolean;
  enabled: boolean;
  state: string;
  state_detail: string;
  scope_label: string;
  frequency: string;
  timezone: string;
  include_ai: boolean;
  ai_consent_valid: boolean;
  assistant_configured: boolean;
  assistant_provider_label: string | null;
  assistant_model: string | null;
  last_run_at: string | null;
  last_run_status: string;
  last_run_detail: string | null;
  next_due_at: string | null;
  max_items: number;
  max_runs_per_day: number;
  provider_request_cap: number;
}

export interface SystemStatus {
  release: {
    version: string;
    commit: string;
    build_time: string;
    channel: string;
    environment: string;
    identity: string;
  };
  readiness: SystemReadinessComponent[];
  jobs: {
    counts: Record<string, number>;
    recent_failed: SystemFailedJob[];
  };
  tasks: SystemTaskStatus[];
  external_services: SystemExternalService[];
  scheduled_review: SystemScheduledReview;
  generated_at: string;
}

export type OnlineSearchSource = "household" | "environment" | "none";

export interface OnlineSearchChannel {
  enabled: boolean;
  configured: boolean;
  source: OnlineSearchSource;
  provider: string | null;
  provider_label: string | null;
  reason: string | null;
}

export interface OnlineSearchReferenceChannel extends OnlineSearchChannel {
  permitted_source_domains: string[];
  policy_configured: boolean;
}

export interface OnlineSearchSettings {
  provider: "brave";
  supported_providers: string[];
  manual_enabled: boolean;
  reference_enabled: boolean;
  has_api_key: boolean;
  environment_api_key_available: boolean;
  credential_source: OnlineSearchSource;
  api_key_version: number;
  credential_storage_ready: boolean;
  permitted_source_domains: string[];
  max_permitted_domains: number;
  manual: OnlineSearchChannel;
  reference: OnlineSearchReferenceChannel;
  environment_manual_available: boolean;
  environment_reference_available: boolean;
  updated_at: string | null;
  warning: string | null;
}

export interface OnlineSearchTestResult {
  ok: boolean;
  message: string;
  manual_ok: boolean | null;
  reference_ok: boolean | null;
  source: OnlineSearchSource;
  provider_label: string | null;
  tested_at: string;
}

export interface AiProviderModel {
  id: string;
  display_name: string | null;
  kind: "chat" | "embedding" | "speech" | "image" | "other";
  capabilities: string[];
  capability_source: "provider_metadata" | "heuristic";
  input_modalities?: string[];
  output_modalities?: string[];
  endpoints?: string[];
  task_states?: Record<string, AiTaskCompatibility>;
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

export type VoiceNoteStatus =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "interpreting"
  | "review"
  | "applying"
  | "confirmed"
  | "failed"
  | "cancelled";

export type VoiceSuggestionState =
  | "proposed"
  | "imported"
  | "skipped"
  | "rejected"
  | "failed";

export interface VoiceSourceSpan {
  text: string;
  start: number | null;
  end: number | null;
  role: "item" | "summary" | "correction";
  quantity: number | null;
  quantity_explicit: boolean;
}

export interface VoiceLocation extends LocationProposal {
  evidence: string | null;
  create: boolean;
  create_kind: ContainerType;
}

export interface VoiceSuggestionEdit {
  id: UUID;
  name: string;
  description: string | null;
  quantity: number;
  variant: string | null;
  category: NamedMatch | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  tags: string[];
  notes: string | null;
  room: VoiceLocation | null;
  storage_location: VoiceLocation | null;
  confidence: number | null;
  split_of: UUID | null;
}

export interface VoiceSuggestion extends VoiceSuggestionEdit {
  mention_count: number;
  quantity_explicit: boolean;
  sources: VoiceSourceSpan[];
  duplicate_candidates: DuplicateCandidate[];
  state: VoiceSuggestionState;
  imported_item_id: UUID | null;
  error: string | null;
  warnings: string[];
}

export interface VoiceWarning {
  type: string;
  message: string;
  text?: string;
}

export interface VoiceNote {
  id: UUID;
  status: VoiceNoteStatus;
  original_filename: string | null;
  content_type: string | null;
  byte_size: number | null;
  duration_seconds: number | null;
  audio_retained: boolean;
  default_property_id?: UUID | null;
  default_room_id: UUID | null;
  default_location_id: UUID | null;
  transcript: string | null;
  transcript_provider: string | null;
  transcript_model: string | null;
  transcript_mode: string | null;
  transcript_error: string | null;
  interpretation_provider: string | null;
  interpretation_model: string | null;
  interpretation_mode: string | null;
  interpretation_error: string | null;
  suggestions: VoiceSuggestion[];
  warnings: VoiceWarning[];
  applied_items: Array<Record<string, unknown>>;
  applied_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceApplyEntry extends VoiceSuggestionEdit {
  action: "import" | "skip" | "reject";
  duplicate_resolution: "new" | "add_quantity" | "skip" | null;
  merge_item_id: UUID | null;
}

export interface VoiceApplyResult {
  note: VoiceNote;
  created: number;
  added_quantity: number;
  skipped: number;
  rejected: number;
  failed: number;
  failures: Array<{ suggestion_id: UUID; message: string }>;
}

export interface VoiceConfig {
  transcription_configured: boolean;
  max_duration_seconds: number;
  max_upload_mb: number;
  supported_formats: string[];
  retention_note: string;
}

export type LoanStatus = "outstanding" | "partially_returned" | "returned" | "cancelled";
export type LoanFilterStatus =
  | "all"
  | "open"
  | "outstanding"
  | "partially_returned"
  | "returned"
  | "cancelled";

export interface Loan {
  id: UUID;
  item_id: UUID | null;
  parent_loan_id?: UUID | null;
  includes_contents?: boolean;
  item_name: string;
  item_name_snapshot: string;
  home_room_id: UUID | null;
  home_room_name_snapshot: string | null;
  home_location_id: UUID | null;
  home_location_name_snapshot: string | null;
  home_location_identifier_snapshot: string | null;
  borrower_name: string;
  quantity: number;
  returned_quantity: number;
  outstanding_quantity: number;
  status: LoanStatus;
  lent_on: string;
  due_on: string | null;
  notes: string | null;
  overdue: boolean;
  days_past_due: number | null;
  latest_returned_on: string | null;
  created_by_user_id: UUID | null;
  created_by_name: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoanReturn {
  id: UUID;
  quantity: number;
  returned_on: string;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  reversed_at: string | null;
  reversed_by_event_id: UUID | null;
}

export interface RestoreAssistedContainer {
  id: UUID;
  name: string | null;
  identifier: string | null;
  legacy_identifier: string | null;
  kind: string | null;
  container_type: string | null;
  is_container: boolean | null;
  room_id: UUID | null;
  room_name: string | null;
  property_id: UUID | null;
  property_name: string | null;
  parent_id: UUID | null;
  parent_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

export interface RestoreAssistedItem {
  id: UUID;
  name: string;
  quantity: number;
  current_room_id: UUID | null;
  current_room_name: string | null;
  current_location_id: UUID | null;
  current_location_name: string | null;
  current_location_identifier: string | null;
  target_room_id: UUID | null;
  target_room_name: string | null;
  target_location_id: UUID | null;
  target_location_name: string | null;
  target_location_identifier: string | null;
}

export interface RestoreAssistedUndo {
  available: boolean;
  reason: string | null;
  legacy_unrecoverable: boolean;
  will_restore_container: boolean;
  will_move_item: boolean;
  item_count: number;
  container: RestoreAssistedContainer | null;
  item: RestoreAssistedItem | null;
}

export interface ActivityEvent {
  id: UUID;
  action: string;
  entity_type: "item" | "container" | "loan" | "batch" | "borrowed";
  entity_id: UUID | null;
  item_id: UUID | null;
  container_id: UUID | null;
  loan_id: UUID | null;
  borrowed_item_id?: UUID | null;
  actor_user_id: UUID | null;
  actor_name: string;
  summary: string;
  details: Record<string, unknown>;
  created_at: string;
  undoes_event_id: UUID | null;
  undo_event_id: UUID | null;
  can_undo: boolean;
  undo_blocked_reason: string | null;
  restore_assisted?: RestoreAssistedUndo | null;
}

export interface ActivityHistory {
  items: ActivityEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface LoanDetail extends Loan {
  returns: LoanReturn[];
  history: ActivityEvent[];
  contents_loans?: Loan[];
}

export interface LoanList {
  items: Loan[];
  total: number;
  limit: number;
  offset: number;
  outstanding_count: number;
  overdue_count: number;
  on_loan_quantity: number;
}

export interface ItemLoanSummary {
  item_id: UUID;
  item_name: string;
  owned_quantity: number;
  on_loan_quantity: number;
  available_quantity: number;
  outstanding_loan_count: number;
  overdue_count: number;
  loans: Loan[];
}

export interface LoanContentsItem {
  item_id: UUID;
  item_name: string;
  owned_quantity: number;
  on_loan_quantity: number;
  available_quantity: number;
}

export interface LoanContentsExcluded {
  item_name: string;
  reason: string;
  quantity: number;
  owner_name: string | null;
}

export interface LoanOptions {
  item_id: UUID;
  item_name: string;
  owned_quantity: number;
  on_loan_quantity: number;
  available_quantity: number;
  has_contents: boolean;
  storage_location_id: UUID | null;
  storage_identifier: string | null;
  contents_available_quantity: number;
  contents_items: LoanContentsItem[];
  excluded_items: LoanContentsExcluded[];
}

export interface BorrowedPhoto {
  id: UUID;
  original_filename: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  created_at: string;
  url: string;
  thumbnail_url: string;
}

export interface BorrowedRecord {
  id: UUID;
  direction: "borrowed";
  household_id?: UUID | null;
  household_name?: string | null;
  item_name: string;
  brand: string | null;
  model: string | null;
  owner_name: string;
  quantity: number;
  returned_quantity: number;
  outstanding_quantity: number;
  physically_held_quantity: number;
  status: LoanStatus;
  borrowed_on: string;
  due_on: string | null;
  notes: string | null;
  overdue: boolean;
  days_past_due: number | null;
  latest_returned_on: string | null;
  property_id: UUID | null;
  property_name: string | null;
  room_id: UUID | null;
  room_name: string | null;
  storage_location_id: UUID | null;
  storage_location_name: string | null;
  storage_location_identifier: string | null;
  photo: BorrowedPhoto | null;
  created_by_user_id: UUID | null;
  created_by_name: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BorrowedReturn {
  id: UUID;
  quantity: number;
  returned_on: string;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface BorrowedDetail extends BorrowedRecord {
  returns: BorrowedReturn[];
  history: ActivityEvent[];
}

export interface BorrowedList {
  items: BorrowedRecord[];
  total: number;
  limit: number;
  offset: number;
  open_count: number;
  overdue_count: number;
  total_borrowed_quantity: number;
  outstanding_quantity: number;
  returned_quantity: number;
  physically_held_quantity: number;
}

export type BorrowedFilterStatus =
  | "all"
  | "open"
  | "outstanding"
  | "partially_returned"
  | "returned"
  | "cancelled";

export interface BorrowedFilters {
  status?: BorrowedFilterStatus;
  q?: string;
  overdue?: boolean;
  property_id?: string;
  room_id?: string;
  storage_location_id?: string;
  on_date?: string;
}

export interface LoanCreateInput {
  item_id: UUID;
  borrower_name: string;
  quantity: number;
  lent_on: string;
  due_on?: string | null;
  notes?: string | null;
  request_id: string;
}

export interface LoanReturnInput {
  quantity: number;
  returned_on: string;
  notes?: string | null;
  request_id: string;
}

export interface LoanCorrectInput {
  borrower_name?: string;
  quantity?: number;
  lent_on?: string;
  due_on?: string | null;
  notes?: string | null;
  request_id: string;
}

export interface UndoResult {
  event: ActivityEvent;
  undone_event_id: UUID;
  message: string;
  restored_container_id?: UUID | null;
}

export interface BulkDestination {
  room_id: UUID;
  room_name: string;
  storage_location_id: UUID | null;
  storage_location_name: string | null;
  storage_location_identifier: string | null;
  path: Array<{ id?: string | null; name?: string | null; identifier?: string | null }>;
}

export interface BulkMoveResult {
  request_id: UUID;
  batch_id: UUID;
  history_event_id: UUID;
  selected_count: number;
  moved_count: number;
  unchanged_count: number;
  selected_unit_count: number;
  moved_unit_count: number;
  on_loan_quantity: number;
  moved_item_ids: UUID[];
  destination: BulkDestination;
}

export interface BulkTagResult {
  request_id: UUID;
  batch_id: UUID;
  history_event_id: UUID;
  mode: "add" | "remove";
  selected_count: number;
  updated_count: number;
  unchanged_count: number;
  tag_ids: UUID[];
  tag_names: string[];
  updated_item_ids: UUID[];
}

export interface BulkCategoryResult {
  request_id: UUID;
  batch_id: UUID;
  history_event_id: UUID;
  mode: "set" | "clear";
  selected_count: number;
  updated_count: number;
  unchanged_count: number;
  category_id: UUID | null;
  category_name: string | null;
  updated_item_ids: UUID[];
}

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

export interface LastVerified {
  at: string;
  session_id: UUID | null;
  status: "present" | "missing" | "moved" | "quantity_discrepancy";
  quantity: number;
  owned_quantity: number;
  on_loan_quantity: number;
  location_path: string;
  room_id: UUID | null;
  location_id: UUID | null;
  stale: boolean;
  stale_reason: string | null;
}

export type StocktakeStatus = "in_progress" | "completed" | "abandoned";
export type StocktakeObservationStatus =
  | "present"
  | "missing"
  | "moved"
  | "quantity_discrepancy"
  | "unknown"
  | "unexpected";

export interface StocktakeScope {
  room_ids?: UUID[];
  container_ids?: UUID[];
  include_descendants?: boolean;
}

export interface StocktakeSession {
  id: UUID;
  status: StocktakeStatus;
  scope_label: string;
  scope: StocktakeScope;
  snapshot_fingerprint: string;
  expected_item_count: number;
  expected_unit_count: number;
  expected_at_home_unit_count: number;
  expected_on_loan_unit_count: number;
  checked_item_count: number;
  checked_unit_count: number;
  verified_item_count: number;
  missing_item_count: number;
  quantity_discrepancy_count: number;
  unknown_item_count: number;
  unexpected_count: number;
  coverage: Record<string, unknown>;
  partial: boolean;
  created_by_name: string;
  completed_by_name: string | null;
  started_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StocktakeCurrentItem {
  exists: boolean;
  name: string | null;
  quantity: number | null;
  on_loan_quantity: number;
  at_home_quantity: number;
  room_id: UUID | null;
  location_id: UUID | null;
  location_path: string;
  is_archived: boolean;
  updated_at: string | null;
  photo_thumbnail_url: string | null;
}

export interface StocktakeObservation {
  id: UUID;
  status: StocktakeObservationStatus;
  snapshot_item_id: UUID | null;
  item_id: UUID | null;
  linked_item_id: UUID | null;
  counted_quantity: number | null;
  observed_room_id: UUID | null;
  observed_location_id: UUID | null;
  observed_room_name: string | null;
  observed_location_name: string | null;
  observed_location_identifier: string | null;
  observed_location_path: string | null;
  unexpected_name: string | null;
  notes: string | null;
  owned_quantity_at_observation: number | null;
  on_loan_quantity_at_observation: number;
  at_home_quantity_at_observation: number;
  verifier_name: string;
  observed_at: string;
  applied: boolean;
}

export interface StocktakeItem {
  snapshot_item_id: UUID;
  item_id: UUID | null;
  item_name: string;
  expected_quantity: number;
  expected_at_home_quantity: number;
  expected_on_loan_quantity: number;
  expected_location_path: string;
  item_updated_at: string;
  changed_since_snapshot: boolean;
  deleted: boolean;
  latest_observation: StocktakeObservation | null;
  correction_applied: boolean;
  current: StocktakeCurrentItem;
}

export interface StocktakeSessionDetail extends StocktakeSession {
  items: StocktakeItem[];
  unexpected_findings: StocktakeObservation[];
}

export interface StocktakeSessionList {
  items: StocktakeSession[];
  total: number;
  limit: number;
  offset: number;
}

export interface StocktakeProposal {
  observation_id: UUID;
  snapshot_item_id: UUID;
  item_id: UUID | null;
  item_name: string;
  status: StocktakeObservationStatus;
  action: "none" | "move" | "set_quantity" | "move_and_quantity";
  current_quantity: number | null;
  proposed_quantity: number | null;
  current_room_id: UUID | null;
  current_room_name: string | null;
  current_location_id: UUID | null;
  current_location_name: string | null;
  current_location_path: string;
  proposed_room_id: UUID | null;
  proposed_room_name: string | null;
  proposed_location_id: UUID | null;
  proposed_location_name: string | null;
  proposed_location_path: string;
  on_loan_quantity: number;
  counted_quantity: number | null;
  conflict: string | null;
  warnings: string[];
}

export interface StocktakeReview {
  session_id: UUID;
  fingerprint: string;
  proposals: StocktakeProposal[];
  actionable_count: number;
  conflict_count: number;
  can_apply: boolean;
  checked_item_count: number;
  expected_item_count: number;
}

export interface StocktakeApplyResult {
  application_id: UUID;
  session: StocktakeSession;
  applied_count: number;
  skipped_count: number;
  proposals: StocktakeProposal[];
  message: string;
}

export interface StocktakeScopeSummary {
  scope_label: string;
  room_id: UUID | null;
  container_id: UUID | null;
  active_session: StocktakeSession | null;
  last_completed_session: StocktakeSession | null;
  last_checked_at: string | null;
}
