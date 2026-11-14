export interface AssistantTaskCompletion {
  id: string;
  kind: "document" | "import";
  title: string;
  description: string;
}

export const ASSISTANT_TASK_COMPLETED_EVENT = "housetory:assistant-task-completed";

export function dispatchAssistantTaskCompletion(detail: AssistantTaskCompletion) {
  window.dispatchEvent(
    new CustomEvent<AssistantTaskCompletion>(ASSISTANT_TASK_COMPLETED_EVENT, { detail }),
  );
}
