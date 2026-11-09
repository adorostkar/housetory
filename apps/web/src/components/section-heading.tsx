import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

export function SectionHeading({
  title,
  description,
  actionLabel,
  actionTo,
  className,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  actionTo?: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex items-end justify-between gap-4", className)}>
      <div>
        <h2 className="section-title">{title}</h2>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actionLabel && actionTo && (
        <Link
          to={actionTo}
          className="group inline-flex shrink-0 items-center gap-1.5 pb-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {actionLabel}
          <ArrowRight className="size-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}
