import type { UUID } from "@/lib/types/core";
import type { DuplicateCandidate } from "@/lib/types/imports";

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
  inherits_text_default?: boolean;
  enabled: boolean;
  capabilities: string[];
  last_test_status?: "passed" | "failed" | "unsupported" | null;
  last_test_at?: string | null;
  last_test_error?: string | null;
  updated_at: string | null;
}

export interface AiDefaultText {
  provider_id: UUID | null;
  provider_label: string | null;
  model: string | null;
  model_label: string | null;
  model_listed: boolean;
  compatibility: AiTaskCompatibility;
  configured: boolean;
  inherited_tasks: string[];
  override_tasks: string[];
  derived_from: "common" | "assistant" | "single" | "saved" | "none";
}

export interface AiSettings {
  providers: AiProviderRecord[];
  tasks: AiTaskSetting[];
  default_text: AiDefaultText;
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

export interface AiRecognitionDuplicateGroup {
  suggestion_index: number;
  candidates: DuplicateCandidate[];
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
