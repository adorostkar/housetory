import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A quiet "show more" row: one button that opens the content below it.
 * Use it for optional fields and for explanations that are not needed every time.
 */
export function Disclosure({
  label,
  hint,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
  buttonClassName,
  contentClassName,
}: {
  label: React.ReactNode;
  /** Short muted text after the label, for example a count. */
  hint?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  buttonClassName?: string;
  contentClassName?: string;
}) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const contentId = React.useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          setLocalOpen(!open);
          onOpenChange?.(!open);
        }}
        className={cn(
          "-ml-1 flex min-h-9 max-w-full items-center gap-1.5 rounded-lg px-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11",
          buttonClassName,
        )}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
        <span className="min-w-0">
          {label}
          {hint ? <span className="font-normal"> · {hint}</span> : null}
        </span>
      </button>
      {open && (
        <div id={contentId} className={contentClassName}>
          {children}
        </div>
      )}
    </div>
  );
}
