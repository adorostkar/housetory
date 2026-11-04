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
  | "other";

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

export interface ItemDetail extends ItemSummary {
  serial_number: string | null;
  photos: Photo[];
  documents: DocumentRecord[];
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
