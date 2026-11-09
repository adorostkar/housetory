import type { UUID } from "@/lib/types/core";
import type { ItemSummary } from "@/lib/types/items";

export type ReviewScopeType =
  | "items"
  | "room"
  | "container"
  | "property"
  | "household";

export type ReviewSuggestionType =
  | "category"
  | "name"
  | "organisation"
  | "possible_duplicate"
  | "missing_detail"
  | "location_conflict";

export type ReviewSuggestionStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "stale"
  | "reverted";

export type ReviewActionKind =
  | "apply_category"
  | "apply_name"
  | "apply_organisation"
  | "advisory";

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
  ai_item_count: number;
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
