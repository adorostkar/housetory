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

export interface User {
  id: UUID;
  name: string;
  email: string;
  created_at: string;
}

export interface Household {
  id: UUID;
  name: string;
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
}

export interface Purchase {
  vendor: string | null;
  purchase_date: string | null;
  price_cents: number | null;
  currency: string;
  order_number: string | null;
  notes: string | null;
}

export interface Warranty {
  provider: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
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

export interface ItemDocument {
  id: UUID;
  original_filename: string;
  content_type: string;
  byte_size: number;
  title: string;
  created_at: string;
  url: string;
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
  created_at: string;
  updated_at: string;
}

export interface ItemDetail extends ItemSummary {
  serial_number: string | null;
  photos: Photo[];
  documents: ItemDocument[];
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
  items: ItemDocument[];
}

export interface CurrencyTotal {
  currency: string;
  total_cents: number;
}

export interface Overview {
  room_count: number;
  location_count: number;
  item_count: number;
  total_quantity: number;
  value_by_currency: CurrencyTotal[];
  document_count: number;
  warranties_expiring_soon: number;
  photo_bytes: number;
  document_bytes: number;
  recent_items: ItemSummary[];
}

export interface PurchaseInput {
  vendor?: string | null;
  purchase_date?: string | null;
  price_cents?: number | null;
  currency: string;
  order_number?: string | null;
  notes?: string | null;
}

export interface WarrantyInput {
  provider?: string | null;
  start_date?: string | null;
  end_date?: string | null;
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
  purchase?: PurchaseInput | null;
  warranty?: WarrantyInput | null;
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

export interface ApiFieldErrors {
  [field: string]: string;
}
