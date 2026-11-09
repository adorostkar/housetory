import type { UUID } from "@/lib/types/core";

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
