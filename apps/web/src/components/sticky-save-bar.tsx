import { Check, Undo2 } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Appears only while a form has unsaved changes. It sticks to the bottom of
 * whatever scrolls the form (the window, or a side panel), above the app's
 * bottom bar and above the software keyboard. Put it after the form's fields.
 */
export function StickySaveBar({
  dirty,
  saving = false,
  canSave = true,
  statusText = "You have unsaved changes",
  saveLabel = "Save changes",
  onSave,
  onDiscard,
  className,
}: {
  dirty: boolean;
  saving?: boolean;
  canSave?: boolean;
  statusText?: string;
  saveLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  if (!dirty) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid="sticky-save-bar"
      className={cn(
        "glass sticky z-30 mt-6 flex items-center justify-between gap-3 rounded-2xl border border-border/70 px-4 py-2.5 shadow-lg",
        "bottom-[calc(var(--shell-bar-height,0px)+var(--keyboard-inset,0px)+0.5rem)]",
        className,
      )}
    >
      <p role="status" className="min-w-0 truncate text-2xs text-muted-foreground">
        {statusText}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-11" disabled={saving} onClick={onDiscard}>
          <Undo2 />
          Discard
        </Button>
        <Button type="button" size="sm" className="h-11" disabled={saving || !canSave} onClick={onSave}>
          {saving ? <Spinner /> : <Check />}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
