import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useId } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  to,
  className,
  accent = false,
  action,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon: LucideIcon;
  to?: string;
  className?: string;
  accent?: boolean;
  action?: React.ReactNode;
}) {
  const labelId = useId();
  const valueId = useId();
  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p id={labelId} className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </p>
      <span
        className={cn(
          "ml-auto flex size-8 shrink-0 items-center justify-center rounded-full",
          accent ? "bg-sage-soft text-accent-foreground" : "bg-secondary/80 text-foreground/55",
        )}
      >
        <Icon className="size-[0.95rem]" strokeWidth={1.7} />
      </span>
    </div>
  );
  const metric = (
    <>
      <div id={valueId} className="mt-3 font-display text-[2rem] sm:mt-6 sm:text-[2.35rem] font-normal leading-none tracking-[-0.035em] tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="mt-2.5 flex items-center gap-1 text-2xs leading-relaxed text-muted-foreground">
          {detail}
          {to && (
            <ArrowUpRight className="size-3 opacity-0 transition-opacity duration-200 group-hover:opacity-70" />
          )}
        </div>
      )}
    </>
  );
  const content = <>{heading}{metric}</>;

  const classes = cn(
    "surface group block p-4 sm:p-5 transition-[border-color,box-shadow,transform] duration-300",
    to && "hover:-translate-y-0.5 hover:border-border hover:shadow-lift",
    className,
  );

  if (to) {
    if (action) {
      return (
        <div className={cn(classes, "min-w-0")}>
          <div className="flex flex-wrap items-center justify-between gap-1">
            <p id={labelId} className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              {label}
            </p>
            <div className="ml-auto">{action}</div>
          </div>
          <Link to={to} aria-labelledby={`${labelId} ${valueId}`} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {metric}
          </Link>
        </div>
      );
    }
    return (
      <Link to={to} className={classes}>
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}
