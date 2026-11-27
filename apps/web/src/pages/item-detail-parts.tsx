import { ChevronLeft, X } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * The one control at the top of an item page or form. It goes back to where the
 * item was opened from. In the desktop side panel it reads "Close".
 */
export function ItemPageClose({
  to,
  label,
  presentation = "page",
}: {
  to: string;
  label: string;
  presentation?: "page" | "panel";
}) {
  return (
    <Link
      to={to}
      className="-ml-2 inline-flex min-h-11 min-w-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {presentation === "panel" ? (
        <>
          <X className="size-4 shrink-0" aria-hidden="true" />
          Close
        </>
      ) : (
        <>
          <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </>
      )}
    </Link>
  );
}

export function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3 text-xs leading-relaxed">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" strokeWidth={1.7} />
        {label}
      </dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function LoanQuantity({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "muted" | "sage" | "brass";
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/30 px-2 py-2.5">
      <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-display text-[1.45rem] leading-none tabular-nums",
          tone === "sage" && "text-accent-foreground",
          tone === "brass" && "text-brass",
        )}
      >
        {value}
      </p>
    </div>
  );
}
