import type { AiTaskCompatibility } from "@/lib/types/ai";
import type { UUID } from "@/lib/types/core";

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
