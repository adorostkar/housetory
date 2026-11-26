import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { useId } from "react";

import { useRememberedOpen } from "@/components/purchase-totals";
import { Badge } from "@/components/ui/badge";
import { WARRANTY_STATUS_TONE, warrantyRemainingLabel } from "@/lib/labels";
import { useOverview } from "@/lib/queries";
import type { Warranty, WarrantyStatus } from "@/lib/types";
import { cn, formatDate, pluralize } from "@/lib/utils";

/**
 * The warranties that need attention first. It is one short line until it is
 * opened, so it does not push the full list down.
 */
export function WarrantyWatch({ className }: { className?: string }) {
  const overview = useOverview();
  const detailsId = useId();
  const [open, toggleOpen] = useRememberedOpen("housetory.warranty-watch");
  const warranties = overview.data?.warranties;
  if (!warranties) return null;
  const total =
    warranties.active_count +
    warranties.expiring_count +
    warranties.expired_count +
    warranties.unknown_count;
  if (total === 0) return null;

  return (
    <section
      aria-label="Warranty watch"
      data-testid="warranty-watch"
      className={cn("surface mb-5 px-4 py-2", className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={toggleOpen}
        className="-ml-1 flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
        <span className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Warranty watch</span>
          {" · "}
          <span className={cn(warranties.expiring_count > 0 && "font-medium text-brass")}>
            {warranties.expiring_count} expiring soon
          </span>
          {" · "}
          {warranties.active_count} active · {warranties.expired_count} expired
        </span>
      </button>

      {open && (
        <div id={detailsId} className="border-t border-border/60 pb-2 pt-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <WarrantyGroup
              title="Expiring soon"
              status="expiring"
              warranties={warranties.expiring_soon}
              total={warranties.expiring_count}
            />
            <WarrantyGroup
              title="Active"
              status="active"
              warranties={warranties.active}
              total={warranties.active_count}
            />
            <WarrantyGroup
              title="Expired"
              status="expired"
              warranties={warranties.expired}
              total={warranties.expired_count}
            />
          </div>
          <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
            "Expiring soon" means within {pluralize(warranties.reminder_days, "day")}.
          </p>
        </div>
      )}
    </section>
  );
}

function WarrantyGroup({
  title,
  status,
  warranties,
  total,
}: {
  title: string;
  status: WarrantyStatus;
  warranties: Warranty[];
  total: number;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-border/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={WARRANTY_STATUS_TONE[status]}>{title}</Badge>
          <span className="text-2xs tabular-nums text-muted-foreground">{total}</span>
        </div>
        {total > 0 && (
          <Link
            to={`/warranties?status=${status}`}
            className="text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View all
          </Link>
        )}
      </div>
      <div className="mt-3 flex-1 space-y-1.5">
        {warranties.length === 0 ? (
          <p className="py-4 text-center text-2xs text-muted-foreground">Nothing here.</p>
        ) : (
          warranties.map((warranty) => (
            <Link
              key={warranty.id}
              to={warranty.item ? `/items/${warranty.item.id}` : "/warranties"}
              className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">
                  {warranty.item?.name ?? "Warranty"}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {warranty.provider || "Provider not set"}
                  {warranty.end_date ? ` · ${formatDate(warranty.end_date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {warrantyRemainingLabel(warranty.days_remaining, warranty.status)}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
