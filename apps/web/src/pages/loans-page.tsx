import { AlertTriangle, HandCoins, Package, Search } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LOAN_STATUS_LABELS, LOAN_STATUS_TONE } from "@/lib/labels";
import { useLoans } from "@/lib/queries";
import type { Loan, LoanFilterStatus } from "@/lib/types";
import { cn, formatDate, pluralize } from "@/lib/utils";

const FILTERS: Array<{ value: LoanFilterStatus; label: string }> = [
  { value: "open", label: "Outstanding" },
  { value: "returned", label: "Returned" },
  { value: "all", label: "All" },
];

export function LoansPage() {
  const [searchParams] = useSearchParams();
  const itemId = searchParams.get("item_id") ?? undefined;
  const [status, setStatus] = React.useState<LoanFilterStatus>("open");
  const [overdue, setOverdue] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const deferredSearch = React.useDeferredValue(search);
  const loansQuery = useLoans({
    status,
    item_id: itemId,
    overdue,
    q: deferredSearch.trim() || undefined,
  });

  if (loansQuery.isPending) return <LoansSkeleton />;
  if (loansQuery.isError) {
    return (
      <ErrorState
        title="Loans are out of reach"
        message="We couldn't load the lending record just now."
        onRetry={() => void loansQuery.refetch()}
      />
    );
  }
  const data = loansQuery.data;
  const hasFilters =
    Boolean(deferredSearch.trim()) || Boolean(itemId) || overdue || status !== "open";

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Inventory · Lending"
        title="Loans"
        description="Who has what, what is still outstanding and what has come home. Lending preserves each item's normal home location."
        actions={
          <Button variant="outline" asChild>
            <Link to="/items">Inventory</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3.5 sm:gap-4 xl:grid-cols-3">
        <StatCard
          label="Open loans"
          value={data.outstanding_count}
          detail={pluralize(data.on_loan_quantity, "unit") + " on loan"}
          icon={HandCoins}
          accent
        />
        <StatCard
          label="Past due"
          value={data.overdue_count}
          detail="Based on your local date"
          icon={AlertTriangle}
        />
        <StatCard
          label="Units on loan"
          value={data.on_loan_quantity}
          detail="Owned totals still include loaned stock"
          icon={Package}
          className="col-span-2 xl:col-span-1"
        />
      </div>

      <section className="mt-6 surface p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {itemId && (
            <p className="text-[0.7rem] text-muted-foreground">
              Showing loans for one item.{" "}
              <Link to="/loans" className="underline underline-offset-4 hover:text-foreground">
                Clear
              </Link>
            </p>
          )}
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Loan filters">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={status === filter.value}
                onClick={() => setStatus(filter.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[0.72rem] font-medium transition-colors",
                  status === filter.value
                    ? "border-foreground/15 bg-foreground text-background"
                    : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex items-center gap-2 text-[0.72rem] text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={overdue}
                onChange={(event) => setOverdue(event.target.checked)}
              />
              Past due only
            </label>
            <div className="relative min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 pl-8 text-[0.78rem]"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Borrower or item"
                aria-label="Search loans"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2.5">
          {data.items.length === 0 ? (
            hasFilters ? (
              <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-[0.8rem] text-muted-foreground">
                No loans match these filters.
              </p>
            ) : (
              <EmptyState
                title="Everything is at home."
                description="Open an item and use Lend to record who borrowed it, when it is due and how many units are out."
                actionLabel="Browse inventory"
                actionTo="/items"
              />
            )
          ) : (
            data.items.map((loan) => <LoanRow key={loan.id} loan={loan} />)
          )}
        </div>
        {data.total > data.items.length && (
          <p className="mt-4 text-[0.7rem] text-muted-foreground">
            Showing the first {data.items.length} of {data.total} matching loans. Narrow the
            filters to find an older record.
          </p>
        )}
      </section>
    </div>
  );
}

export function LoanRow({ loan }: { loan: Loan }) {
  const itemLabel = loan.item_name || loan.item_name_snapshot;
  const home =
    [loan.home_room_name_snapshot, loan.home_location_name_snapshot]
      .filter(Boolean)
      .join(" / ") || "Home location not recorded";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/35 px-4 py-3.5 transition-colors hover:bg-secondary/30 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/loans/${loan.id}`}
            className="text-[0.86rem] font-medium underline-offset-4 hover:underline"
          >
            {loan.borrower_name}
          </Link>
          <Badge variant={LOAN_STATUS_TONE[loan.status]}>
            {LOAN_STATUS_LABELS[loan.status]}
          </Badge>
          {loan.overdue && <Badge variant="destructive">Past due</Badge>}
        </div>
        <p className="mt-1 text-[0.76rem] text-foreground/80">
          {loan.item_id ? (
            <Link
              to={`/items/${loan.item_id}`}
              className="underline-offset-4 hover:underline"
            >
              {itemLabel}
            </Link>
          ) : (
            itemLabel
          )}
          <span className="text-muted-foreground"> · {home}</span>
        </p>
        <p className="mt-1 text-[0.67rem] text-muted-foreground">
          Lent {formatDate(loan.lent_on)}
          {loan.due_on ? ` · due ${formatDate(loan.due_on)}` : " · no due date"}
        </p>
      </div>
      <Link
        to={`/loans/${loan.id}`}
        className="shrink-0 text-left sm:text-right"
        aria-label={`Open loan for ${loan.borrower_name}`}
      >
        <p className="font-display text-[1.4rem] leading-none tracking-[-0.02em] tabular-nums">
          {loan.status === "cancelled" ? "—" : loan.outstanding_quantity}
          <span className="ml-1 font-sans text-[0.68rem] font-normal text-muted-foreground">
            of {loan.quantity} out
          </span>
        </p>
        <p className="mt-1 text-[0.66rem] text-muted-foreground">
          {loan.returned_quantity > 0 ? `${loan.returned_quantity} returned` : "No returns"}
        </p>
      </Link>
    </div>
  );
}

function LoansSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-4 h-12 w-48" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <Skeleton className="mt-6 h-72 rounded-2xl" />
    </div>
  );
}
