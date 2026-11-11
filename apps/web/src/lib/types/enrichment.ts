import type { UUID } from "@/lib/types/core";

export interface EnhancementState {
  status: "off" | "queued" | "running" | "ready" | "failed" | "skipped" | "accepted";
  job_id: UUID | null;
  version: string | null;
  reason: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  ai_attempted: boolean;
  ai_succeeded: boolean;
}
