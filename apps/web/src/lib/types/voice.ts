import type { ContainerType, UUID } from "@/lib/types/core";
import type { DuplicateCandidate, LocationProposal, NamedMatch } from "@/lib/types/imports";

export type VoiceNoteStatus =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "interpreting"
  | "review"
  | "applying"
  | "confirmed"
  | "failed"
  | "cancelled";

export type VoiceSuggestionState =
  | "proposed"
  | "imported"
  | "skipped"
  | "rejected"
  | "failed";

export interface VoiceSourceSpan {
  text: string;
  start: number | null;
  end: number | null;
  role: "item" | "summary" | "correction";
  quantity: number | null;
  quantity_explicit: boolean;
}

export interface VoiceLocation extends LocationProposal {
  evidence: string | null;
  create: boolean;
  create_kind: ContainerType;
}

export interface VoiceSuggestionEdit {
  id: UUID;
  name: string;
  description: string | null;
  quantity: number;
  variant: string | null;
  category: NamedMatch | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  tags: string[];
  notes: string | null;
  room: VoiceLocation | null;
  storage_location: VoiceLocation | null;
  confidence: number | null;
  split_of: UUID | null;
}

export interface VoiceSuggestion extends VoiceSuggestionEdit {
  mention_count: number;
  quantity_explicit: boolean;
  sources: VoiceSourceSpan[];
  duplicate_candidates: DuplicateCandidate[];
  state: VoiceSuggestionState;
  imported_item_id: UUID | null;
  error: string | null;
  warnings: string[];
}

export interface VoiceWarning {
  type: string;
  message: string;
  text?: string;
}

export interface VoiceNote {
  id: UUID;
  status: VoiceNoteStatus;
  original_filename: string | null;
  content_type: string | null;
  byte_size: number | null;
  duration_seconds: number | null;
  audio_retained: boolean;
  default_property_id?: UUID | null;
  default_room_id: UUID | null;
  default_location_id: UUID | null;
  transcript: string | null;
  transcript_provider: string | null;
  transcript_model: string | null;
  transcript_mode: string | null;
  transcript_error: string | null;
  interpretation_provider: string | null;
  interpretation_model: string | null;
  interpretation_mode: string | null;
  interpretation_error: string | null;
  suggestions: VoiceSuggestion[];
  warnings: VoiceWarning[];
  applied_items: Array<Record<string, unknown>>;
  applied_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceConfig {
  transcription_configured: boolean;
  max_duration_seconds: number;
  max_upload_mb: number;
  supported_formats: string[];
  retention_note: string;
}
