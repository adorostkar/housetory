import { Check, Undo2 } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useSoftwareKeyboardOpen } from "@/hooks/use-software-keyboard-open";
import { cn } from "@/lib/utils";

/**
 * Appears only while a form has unsaved changes. Fixed above the mobile bottom
 * nav (pinned to the bottom while the software keyboard is open), sticky at
 * the bottom of the content column on desktop.
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
  const keyboardOpen = useSoftwareKeyboardOpen();
  if (!dirty) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid="sticky-save-bar"
      className={cn(
        "glass fixed inset-x-3 z-30 flex items-center justify-between gap-3 rounded-2xl border border-border/70 px-4 py-2.5 shadow-lg",
        keyboardOpen
          ? "bottom-2"
          : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))]",
        "lg:sticky lg:inset-x-auto lg:bottom-4 lg:mt-6",
        className,
      )}
    >
      <p role="status" className="min-w-0 truncate text-2xs text-muted-foreground">
        {statusText}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
          <Undo2 />
          Discard
        </Button>
        <Button type="button" size="sm" disabled={saving || !canSave} onClick={onSave}>
          {saving ? <Spinner /> : <Check />}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
