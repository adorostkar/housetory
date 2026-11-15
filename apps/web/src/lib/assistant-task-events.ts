export interface CaptureReview {
  id: string;
  kind: "document" | "import" | "photo";
  title: string;
  status: string;
  generation: string;
  dismissal_id?: string | null;
  notify?: boolean;
  retry?: "processing" | "enhancement" | null;
}

export interface AssistantTaskCompletion {
  id: string;
  kind: CaptureReview["kind"];
  title: string;
  description: string;
  generation: string;
  householdId: string;
}

export const ASSISTANT_TASK_COMPLETED_EVENT = "housetory:assistant-task-completed";

export function assistantTaskKey(task: Pick<AssistantTaskCompletion, "householdId" | "kind" | "id" | "generation">) {
  return `${task.householdId}:${task.kind}:${task.id}:${task.generation}`;
}

export function dispatchAssistantTaskCompletion(detail: AssistantTaskCompletion) {
  window.dispatchEvent(
    new CustomEvent<AssistantTaskCompletion>(ASSISTANT_TASK_COMPLETED_EVENT, { detail }),
  );
}
