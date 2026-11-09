
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
      <dd className="min-w-0">{children}</dd>
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

export function ItemDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-12 w-1/2 max-w-md" />
      <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,1fr)]">
        <div className="space-y-6">
          <Skeleton className="aspect-[4/3] rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
