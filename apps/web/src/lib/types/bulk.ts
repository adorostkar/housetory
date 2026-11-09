import type { UUID } from "@/lib/types/core";

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
