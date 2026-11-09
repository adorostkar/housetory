import { CalendarDays, Download, Pencil, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WARRANTY_STATUS_LABELS,
  WARRANTY_STATUS_TONE,
  warrantyRemainingLabel,
} from "@/lib/labels";
import { useCanWrite, useWarranties } from "@/lib/queries";
import type { WarrantyStatus } from "@/lib/types";
import { formatDate, pluralize } from "@/lib/utils";

const FILTERS: Array<{ value: WarrantyStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "expiring", label: "Expiring soon" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "unknown", label: "Unknown" },
];

export function WarrantiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("status");
  const status = FILTERS.some((filter) => filter.value === requested)
    ? (requested as WarrantyStatus | "all")
    : "all";
  const warrantiesQuery = useWarranties(status);
  const canWrite = useCanWrite();
  const data = warrantiesQuery.data;
  const warranties = data?.items ?? [];

  const counts: Record<WarrantyStatus | "all", number> = {
    all:
      (data?.active_count ?? 0) +
      (data?.expiring_count ?? 0) +
      (data?.expired_count ?? 0) +
      (data?.unknown_count ?? 0),
    active: data?.active_count ?? 0,
    expiring: data?.expiring_count ?? 0,
    expired: data?.expired_count ?? 0,
    unknown: data?.unknown_count ?? 0,
  };

  return (
    <PageLayout
      header={{
        eyebrow: "Ownership",
        title: "Warranties",
        description: "Active coverage, upcoming expirations and what has already run out.",
        actions: (
          <Button variant="outline" asChild>
            <a href="/api/v1/exports/warranties.csv">
              <Download />
              Export
            </a>
          </Button>
        ),
      }}
    >
      <div className="surface p-3 sm:p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Warranty status">
          {FILTERS.map((filter) => {
            const active = filter.value === status;
            return (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() =>
                  setSearchParams(
                    filter.value === "all" ? {} : { status: filter.value },
                    { replace: true },
                  )
                }
                className={
                  active
                    ? "rounded-full bg-primary px-3.5 py-2 text-2xs font-medium text-primary-foreground"
                    : "rounded-full px-3.5 py-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                }
              >
                {filter.label}
                <span className="ml-1.5 tabular-nums opacity-70">
                  {counts[filter.value]}
                </span>
              </button>
            );
          })}
        </div>
        {data && (
          <p className="mt-2 px-2 text-2xs text-muted-foreground">
            Reminders use the household window of {pluralize(data.reminder_days, "day")}, unless
            an individual warranty overrides it.
          </p>
        )}
      </div>

      <div className="mt-7">
        {warrantiesQuery.isPending ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : warrantiesQuery.isError ? (
          <ErrorState
            title="Warranties are out of reach"
            message="We couldn't load your warranty records just now."
            onRetry={() => void warrantiesQuery.refetch()}
          />
        ) : warranties.length === 0 ? (
          <EmptyState
            title={status === "all" ? "No warranties recorded yet." : "Nothing in this view."}
            description={
              status === "all"
                ? "Add a provider, start date and duration to an item. Housetory calculates the expiry and keeps the certificate with it."
                : "Switch to another warranty state, or add warranty details while editing an item."
            }
            actionLabel="Browse items"
            actionTo="/items"
          />
        ) : (
          <div className="stagger space-y-3">
            {warranties.map((warranty) => (
              <article key={warranty.id} className="surface p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldCheck className="size-4 text-muted-foreground" strokeWidth={1.7} />
                      <h2 className="truncate font-display text-[1.25rem] tracking-[-0.02em]">
                        {warranty.item?.name ?? "Item warranty"}
                      </h2>
                      <Badge variant={WARRANTY_STATUS_TONE[warranty.status]}>
                        {WARRANTY_STATUS_LABELS[warranty.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-2xs text-muted-foreground">
                      {warranty.provider || "Provider not recorded"} ·{" "}
                      {warrantyRemainingLabel(warranty.days_remaining, warranty.status)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {canWrite && warranty.item && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/items/${warranty.item.id}/edit`}>
                          <Pencil />
                          Edit warranty
                        </Link>
                      </Button>
                    )}
                    {warranty.item && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/items/${warranty.item.id}`}>Open item</Link>
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 text-xs sm:grid-cols-4">
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Starts
                    </p>
                    <p className="mt-1">{warranty.start_date ? formatDate(warranty.start_date) : "—"}</p>
                  </div>
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Duration
                    </p>
                    <p className="mt-1">
                      {warranty.duration_months != null
                        ? pluralize(warranty.duration_months, "month")
                        : "Not set"}
                    </p>
                  </div>
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Expires
                    </p>
                    <p className="mt-1">{warranty.end_date ? formatDate(warranty.end_date) : "No end date"}</p>
                  </div>
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Reminder
                    </p>
                    <p className="mt-1">{pluralize(warranty.effective_reminder_days, "day")} before</p>
                  </div>
                </div>

                {(warranty.notes || warranty.document) && (
                  <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-3 text-2xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    {warranty.notes ? (
                      <p className="min-w-0 flex-1 whitespace-pre-line leading-relaxed">
                        {warranty.notes}
                      </p>
                    ) : (
                      <span />
                    )}
                    {warranty.document && (
                      <Link
                        to={`/documents/${warranty.document.id}`}
                        className="inline-flex shrink-0 items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
                      >
                        <CalendarDays className="size-3.5" />
                        {warranty.document.title}
                      </Link>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
