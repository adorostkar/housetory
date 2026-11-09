import type { ActivityEvent } from "@/lib/types/activity";
import type { UUID } from "@/lib/types/core";

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

export interface LoanPerson {
  name: string;
  lent_open: number;
  borrowed_open: number;
  lent_total: number;
  borrowed_total: number;
  last_activity_on: string | null;
}

export interface LoanPersonList {
  items: LoanPerson[];
  total: number;
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
  person?: string;
  overdue?: boolean;
  property_id?: string;
  room_id?: string;
  storage_location_id?: string;
  on_date?: string;
}
