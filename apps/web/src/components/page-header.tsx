import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";

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
  size?: "compact" | "large";
}) {
  return (
    <header className={cn(size === "large" ? "mb-9" : "mb-6", className)}>
      {backTo && (
        <Link
          to={backTo}
          className="mb-5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div
        className={cn(
          "flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:justify-between",
          actionsPlacement === "title" ? "sm:items-start" : "sm:items-end",
        )}
      >
        <div className="min-w-0 sm:min-w-[14rem] sm:flex-1">
          {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
          <h1
            className={
              size === "large" ? "display-title" : "display-title-compact"
            }
          >
            {title}
          </h1>
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
            )}
          >
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
