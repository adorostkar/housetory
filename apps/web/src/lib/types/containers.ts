import type { ContainerType, LocationKind, UUID } from "@/lib/types/core";
import type { DocumentBrief, ItemReference } from "@/lib/types/documents";
import type { ItemSummary } from "@/lib/types/items";
import type { LocationBrief, PropertyBrief, RoomBrief } from "@/lib/types/places";

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
