import type { ContainerType, LocationKind, UUID } from "@/lib/types/core";
import type { ItemReference } from "@/lib/types/documents";

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
