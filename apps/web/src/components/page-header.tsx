import { ChevronDown, ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { useShell } from "@/components/shell/shell-context";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  titleAddon,
  description,
  actions,
  backTo,
  backLabel,
  className,
  actionsPlacement = "bottom",
  actionsClassName,
  size = "compact",
}: {
  eyebrow?: string;
  title: string;
  titleAddon?: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
  className?: string;
  actionsPlacement?: "bottom" | "title";
  /** Extra classes for the actions wrapper, e.g. to hide it on phones. */
  actionsClassName?: string;
  size?: "compact" | "large";
}) {
  const shell = useShell();
  // With the rooms hidden on the phone, the title is the way back to them.
  const opensRooms = Boolean(shell?.compact && !shell.railOpen && !backTo);
  const titleClass = size === "large" ? "display-title" : "display-title-compact";
  return (
    <header className={cn(size === "large" ? "mb-9" : "mb-4 sm:mb-6", className)}>
      {backTo && (
        <Link
          to={backTo}
          className="mb-5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground coarse:-my-2 coarse:mb-3 coarse:min-h-11"
        >
          <ChevronLeft className="size-3.5" />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div
        className={cn(
          "flex flex-col gap-3 sm:gap-5 sm:flex-row sm:flex-wrap sm:justify-between",
          actionsPlacement === "title" ? "sm:items-start" : "sm:items-end",
        )}
      >
        <div className="min-w-0 sm:min-w-[14rem] sm:flex-1">
          {eyebrow && <p className="eyebrow mb-2.5 hidden sm:block">{eyebrow}</p>}
          {opensRooms ? (
            <h1 className={titleClass}>
              <button
                type="button"
                // No largest width in per cent here: Safari then sizes the button too narrow
                // and breaks a short title into two lines. The button never grows wider than
                // its line by itself, and a long title still wraps inside it.
                className="-mx-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`${title}. Show rooms`}
                onClick={() => shell?.setRailOpen(true)}
              >
                <span className="min-w-0">{title}</span>
                <ChevronDown aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              </button>
            </h1>
          ) : (
            <h1 className={titleClass}>{title}</h1>
          )}
          {titleAddon}
          {description && (
            <p className="mt-3 max-w-2xl text-pretty text-[0.95rem] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div
            className={cn(
              "flex min-w-0 max-w-full flex-wrap items-center gap-2.5 sm:justify-end sm:max-w-[70%]",
              actionsPlacement === "title" && "sm:mt-6",
              actionsClassName,
            )}
          >
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
