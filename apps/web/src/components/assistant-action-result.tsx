import { Button } from "@/components/ui/button";
import type { AssistantActionState } from "@/lib/assistant-conversation";

/**
 * What happened to a change: applied, cancelled or undone. An applied change that can
 * be put back has Undo. When Undo is refused, the reason is shown and nothing changes.
 */
export function AssistantActionResult({
  action,
  onUndo,
}: {
  action: AssistantActionState;
  onUndo: () => void;
}) {
  return (
    <div className="space-y-2">
      <p role="status" className="break-words text-sm">{action.result}</p>
      {action.undoConflict && (
        <p role="alert" className="break-words text-sm text-destructive">{action.undoConflict}</p>
      )}
      {action.proposal.undo?.available && (
        <Button type="button" variant="outline" className="min-h-11" disabled={action.pending}
          aria-label="Undo this change" onClick={onUndo}>
          Undo
        </Button>
      )}
    </div>
  );
}
