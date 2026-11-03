import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  backTo,
  backLabel,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    <header className={cn("mb-9", className)}>
      {backTo && (
        <Link
          to={backTo}
          className="mb-5 inline-flex items-center gap-1 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
          <h1 className="display-title">{title}</h1>
          {description && (
            <p className="mt-3 max-w-2xl text-pretty text-[0.95rem] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
    </header>
  );
}
