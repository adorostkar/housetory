import type { UUID } from "@/lib/types/core";
import type { RestoreAssistedUndo } from "@/lib/types/loans";

export interface ActivityEvent {
  id: UUID;
  action: string;
  entity_type: "item" | "container" | "loan" | "batch" | "borrowed";
  entity_id: UUID | null;
  item_id: UUID | null;
  container_id: UUID | null;
  loan_id: UUID | null;
  borrowed_item_id?: UUID | null;
  actor_user_id: UUID | null;
  actor_name: string;
  summary: string;
  details: Record<string, unknown>;
  created_at: string;
  undoes_event_id: UUID | null;
  undo_event_id: UUID | null;
  can_undo: boolean;
  undo_blocked_reason: string | null;
  restore_assisted?: RestoreAssistedUndo | null;
}

export interface ActivityHistory {
  items: ActivityEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface UndoResult {
  event: ActivityEvent;
  undone_event_id: UUID;
  message: string;
  restored_container_id?: UUID | null;
}
