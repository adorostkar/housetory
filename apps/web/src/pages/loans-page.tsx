import {
  AlertTriangle,
  HandCoins,
  Package,
  RotateCcw,
  Search,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  BorrowRecordDialog,
  NewLoanChoiceDialog,
  ReturnBorrowedDialog,
} from "@/components/borrowed-dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { LendLoanDialog, ReturnLoanDialog } from "@/components/loan-dialogs";
import { LoanItemPickerDialog } from "@/components/loan-item-picker";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LOAN_STATUS_LABELS, LOAN_STATUS_TONE } from "@/lib/labels";
import { useBorrowedList, useCanWrite, useLoans } from "@/lib/queries";
import type {
  BorrowedRecord,
  ItemSummary,
  Loan,
  LoanFilterStatus,
} from "@/lib/types";
import { borrowedLocationPrefix, borrowedPlaceLabel } from "@/lib/borrowed";
import { cn, formatDate, pluralize } from "@/lib/utils";

const FILTERS: Array<{ value: LoanFilterStatus; label: string }> = [
  { value: "open", label: "Outstanding" },
  { value: "returned", label: "Returned" },
  { value: "all", label: "All" },
];

type Direction = "all" | "lent_out" | "borrowed";

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: "all", label: "All" },
  { value: "lent_out", label: "Lent out" },
  { value: "borrowed", label: "Borrowed" },
];

export function LoansPage() {
  const [searchParams] = useSearchParams();
  const itemId = searchParams.get("item_id") ?? undefined;
  const canWrite = useCanWrite();
  const [direction, setDirection] = React.useState<Direction>(
    itemId ? "lent_out" : "all",
  );
  const [status, setStatus] = React.useState<LoanFilterStatus>("open");
  const [overdue, setOverdue] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [choiceOpen, setChoiceOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [borrowOpen, setBorrowOpen] = React.useState(false);
  const [selectedItem, setSelectedItem] = React.useState<ItemSummary | null>(null);
  const [returnLoan, setReturnLoan] = React.useState<Loan | null>(null);
  const [returnBorrowed, setReturnBorrowed] = React.useState<BorrowedRecord | null>(
    null,
  );
  const newLoanButtonRef = React.useRef<HTMLButtonElement>(null);
  const deferredSearch = React.useDeferredValue(search);
  const loansQuery = useLoans({
    status,
    item_id: itemId,
    overdue,
    q: deferredSearch.trim() || undefined,
  });
  const borrowedQuery = useBorrowedList(
    {
      status,
      overdue,
      q: deferredSearch.trim() || undefined,
    },
    50,
    !itemId,
  );

  if (loansQuery.isPending || (!itemId && borrowedQuery.isPending)) {
    return <LoansSkeleton />;
  }
  if (loansQuery.isError || (!itemId && borrowedQuery.isError)) {
    return (
      <ErrorState
        title="Loans are out of reach"
        message="We couldn't load the lending and borrowed records just now."
        onRetry={() => {
          void loansQuery.refetch();
          void borrowedQuery.refetch();
        }}
      />
    );
  }
  const loanData = loansQuery.data;
  const borrowedData = borrowedQuery.data;
  const loans = loanData?.items ?? [];
  const borrowed = borrowedData?.items ?? [];
  const hasFilters =
    Boolean(deferredSearch.trim()) || Boolean(itemId) || overdue || status !== "open";

  const rows: Array<
    { kind: "loan"; loan: Loan } | { kind: "borrowed"; record: BorrowedRecord }
  > = [];
  if (direction !== "borrowed") {
    rows.push(...loans.map((loan) => ({ kind: "loan" as const, loan })));
  }
  if (direction !== "lent_out") {
    rows.push(...borrowed.map((record) => ({ kind: "borrowed" as const, record })));
  }
  rows.sort((left, right) => {
    const leftDue = left.kind === "loan" ? left.loan.due_on : left.record.due_on;
    const rightDue = right.kind === "loan" ? right.loan.due_on : right.record.due_on;
    if (leftDue && rightDue) return leftDue.localeCompare(rightDue);
    if (leftDue) return -1;
    if (rightDue) return 1;
    return 0;
  });

  const lentOpenCount = loanData?.outstanding_count ?? 0;
  const lentUnits = loanData?.on_loan_quantity ?? 0;
  const borrowedOpenCount = borrowedData?.open_count ?? 0;
  const borrowedHeld = borrowedData?.outstanding_quantity ?? 0;
  const overdueCount =
    (loanData?.overdue_count ?? 0) + (borrowedData?.overdue_count ?? 0);
  const visibleTotal =
    (direction === "borrowed" ? 0 : loans.length) +
    (direction === "lent_out" ? 0 : borrowed.length);
  const fullTotal =
    (direction === "borrowed" ? 0 : (loanData?.total ?? 0)) +
    (direction === "lent_out" ? 0 : (borrowedData?.total ?? 0));

  const restoreNewLoanFocus = () => {
    window.requestAnimationFrame(() => newLoanButtonRef.current?.focus());
  };
  const beginNewLoan = () => {
    if (itemId) {
      setPickerOpen(true);
      return;
    }
    setChoiceOpen(true);
  };
  const selectItem = (item: ItemSummary) => {
    setPickerOpen(false);
    setSelectedItem(item);
  };
  const closeSelectedItem = () => {
    setSelectedItem(null);
    restoreNewLoanFocus();
  };
  const refetchBoth = () => {
    void loansQuery.refetch();
    void borrowedQuery.refetch();
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Inventory · Lending"
        title="Loans"
        description={
          itemId
            ? "Owned-item lending history, with borrowed-from-others records kept separate."
            : "Who has your things and what you're keeping for someone else. Lent-out goods are household-owned; borrowed goods belong to another person and never become owned stock."
        }
        actions={
          <>
            {canWrite && (
              <Button ref={newLoanButtonRef} onClick={beginNewLoan}>
                <HandCoins />
                New loan
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to="/items">Inventory</Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3.5 sm:gap-4 xl:grid-cols-3">
        <StatCard
          label="Lent out"
          value={lentOpenCount}
          detail={pluralize(lentUnits, "owned unit") + " with others"}
          icon={Package}
          accent
        />
        <StatCard
          label="Borrowed"
          value={itemId ? 0 : borrowedOpenCount}
          detail={
            itemId
              ? "Not shown for an item-specific view"
              : pluralize(borrowedHeld, "unit") + " held here"
          }
          icon={HandCoins}
        />
        <StatCard
          label="Past due"
          value={itemId ? loanData?.overdue_count ?? 0 : overdueCount}
          detail="Based on your local date"
          icon={AlertTriangle}
          className="col-span-2 xl:col-span-1"
        />
      </div>

      <section className="mt-6 surface p-4 sm:p-5">
        <div className="flex flex-col gap-3">
          {itemId && (
            <p className="text-[0.7rem] text-muted-foreground">
              Showing loans for one owned item. Borrowed-from-others records are omitted.{" "}
              <Link to="/loans" className="underline underline-offset-4 hover:text-foreground">
                Clear
              </Link>
            </p>
          )}
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            {!itemId && (
              <div
                className="flex flex-wrap gap-1.5"
                role="tablist"
                aria-label="Loan direction"
              >
                {DIRECTIONS.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    role="tab"
                    aria-selected={direction === entry.value}
                    onClick={() => setDirection(entry.value)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-[0.72rem] font-medium transition-colors",
                      direction === entry.value
                        ? entry.value === "borrowed"
                          ? "border-brass/30 bg-brass-soft text-brass"
                          : entry.value === "lent_out"
                            ? "border-sage/30 bg-sage-soft text-accent-foreground"
                            : "border-foreground/15 bg-foreground text-background"
                        : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
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
                  placeholder="Person, owner or item"
                  aria-label="Search loans"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2.5">
          {rows.length === 0 ? (
            hasFilters ? (
              <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-[0.8rem] text-muted-foreground">
                No loans match these filters.
              </p>
            ) : direction === "lent_out" ? (
              <EmptyState
                title="No owned items are lent out."
                description={
                  canWrite
                    ? "Choose an owned item to lend, or switch direction to see borrowed goods."
                    : "This household has no open lent-out loans right now."
                }
                actionLabel={canWrite ? "New loan" : "Browse inventory"}
                onAction={canWrite ? beginNewLoan : undefined}
                actionTo={canWrite ? undefined : "/items"}
              />
            ) : direction === "borrowed" ? (
              <EmptyState
                title="No borrowed items are recorded."
                description={
                  canWrite
                    ? "Record a possession borrowed from someone without adding it as owned inventory."
                    : "This household has no borrowed-from-others records right now."
                }
                actionLabel={canWrite ? "Borrow from someone" : "Browse inventory"}
                onAction={canWrite ? () => setBorrowOpen(true) : undefined}
                actionTo={canWrite ? undefined : "/items"}
              />
            ) : (
              <EmptyState
                title="Nothing is lent or borrowed."
                description={
                  canWrite
                    ? "Lend an owned item, record something borrowed from someone else, or open an item to lend it directly."
                    : "This household has no open lending or borrowed records right now."
                }
                actionLabel={canWrite ? "New loan" : "Browse inventory"}
                onAction={canWrite ? beginNewLoan : undefined}
                actionTo={canWrite ? undefined : "/items"}
                secondary={
                  canWrite ? (
                    <Button variant="ghost" asChild>
                      <Link to="/items">Browse inventory</Link>
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            rows.map((row) =>
              row.kind === "loan" ? (
                <LoanRow
                  key={`loan-${row.loan.id}`}
                  loan={row.loan}
                  canWrite={canWrite}
                  onReturn={setReturnLoan}
                />
              ) : (
                <BorrowedRow
                  key={`borrowed-${row.record.id}`}
                  record={row.record}
                  canWrite={canWrite}
                  onReturn={setReturnBorrowed}
                />
              ),
            )
          )}
        </div>
        {fullTotal > visibleTotal && (
          <div className="mt-4 space-y-1 text-[0.7rem] text-muted-foreground">
            <p>
              Showing {visibleTotal} of {fullTotal} matching lending records. Narrow the
              filters to find an older record.
            </p>
            {direction === "all" && (
              <p>
                Lent out: first {loans.length} of {loanData?.total ?? 0}. Borrowed: first{" "}
                {borrowed.length} of {borrowedData?.total ?? 0}.
              </p>
            )}
          </div>
        )}
      </section>

      <NewLoanChoiceDialog
        open={choiceOpen}
        onOpenChange={(open) => {
          setChoiceOpen(open);
          if (!open) restoreNewLoanFocus();
        }}
        onLendOwned={() => {
          setChoiceOpen(false);
          setPickerOpen(true);
        }}
        onBorrow={() => {
          setChoiceOpen(false);
          setBorrowOpen(true);
        }}
      />

      <LoanItemPickerDialog
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) restoreNewLoanFocus();
        }}
        onSelect={selectItem}
      />

      <BorrowRecordDialog
        open={borrowOpen}
        onOpenChange={(open) => {
          setBorrowOpen(open);
          if (!open) restoreNewLoanFocus();
        }}
        onCreated={() => {
          setDirection("all");
          setStatus("open");
          refetchBoth();
          restoreNewLoanFocus();
        }}
      />

      {selectedItem && (
        <LendLoanDialog
          open={Boolean(selectedItem)}
          onOpenChange={(open) => {
            if (!open) closeSelectedItem();
          }}
          itemId={selectedItem.id}
          itemName={selectedItem.name}
          available={Math.max(
            0,
            selectedItem.quantity - (selectedItem.on_loan_quantity ?? 0),
          )}
          onCreated={() => {
            setStatus("open");
            setSelectedItem(null);
            refetchBoth();
            restoreNewLoanFocus();
          }}
        />
      )}

      {returnLoan && (
        <ReturnLoanDialog
          open={Boolean(returnLoan)}
          onOpenChange={(open) => {
            if (!open) setReturnLoan(null);
          }}
          loan={returnLoan}
          onReturned={() => {
            setReturnLoan(null);
            refetchBoth();
          }}
        />
      )}

      {returnBorrowed && (
        <ReturnBorrowedDialog
          open={Boolean(returnBorrowed)}
          onOpenChange={(open) => {
            if (!open) setReturnBorrowed(null);
          }}
          record={returnBorrowed}
          onReturned={() => {
            setReturnBorrowed(null);
            refetchBoth();
          }}
        />
      )}
    </div>
  );
}

function DirectionBadge({ direction }: { direction: "lent_out" | "borrowed" }) {
  return direction === "borrowed" ? (
    <Badge variant="brass" data-testid="direction-badge">
      <HandCoins className="size-3" /> Borrowed
    </Badge>
  ) : (
    <Badge variant="sage" data-testid="direction-badge">
      <Package className="size-3" /> Lent out
    </Badge>
  );
}

export function LoanRow({
  loan,
  canWrite,
  onReturn,
}: {
  loan: Loan;
  canWrite: boolean;
  onReturn: (loan: Loan) => void;
}) {
  const itemLabel = loan.item_name || loan.item_name_snapshot;
  const home =
    [loan.home_room_name_snapshot, loan.home_location_name_snapshot]
      .filter(Boolean)
      .join(" / ") || "Home location not recorded";
  const open =
    loan.status === "outstanding" || loan.status === "partially_returned";
  return (
    <div
      data-testid="loan-row"
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/35 px-4 py-3.5 transition-colors hover:bg-secondary/30 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <DirectionBadge direction="lent_out" />
          <span className="text-[0.86rem] font-medium">to {loan.borrower_name}</span>
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
          <span className="text-muted-foreground"> · from {home}</span>
        </p>
        <p className="mt-1 text-[0.67rem] text-muted-foreground">
          Lent {formatDate(loan.lent_on)}
          {loan.due_on ? ` · due ${formatDate(loan.due_on)}` : " · no return date set"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        <div className="text-left sm:text-right">
          <p className="font-display text-[1.4rem] leading-none tracking-[-0.02em] tabular-nums">
            {loan.status === "cancelled" ? "—" : loan.outstanding_quantity}
            <span className="ml-1 font-sans text-[0.68rem] font-normal text-muted-foreground">
              of {loan.quantity} out
            </span>
          </p>
          <p className="mt-1 text-[0.66rem] text-muted-foreground">
            {loan.returned_quantity > 0
              ? `${loan.returned_quantity} returned`
              : "No returns"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/loans/${loan.id}`}>View details</Link>
          </Button>
          {canWrite && open && loan.outstanding_quantity > 0 && (
            <Button variant="outline" size="sm" onClick={() => onReturn(loan)}>
              <RotateCcw />
              Record return
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BorrowedRow({
  record,
  canWrite,
  onReturn,
}: {
  record: BorrowedRecord;
  canWrite: boolean;
  onReturn: (record: BorrowedRecord) => void;
}) {
  const place = borrowedPlaceLabel(record);
  const open =
    record.status === "outstanding" || record.status === "partially_returned";
  return (
    <div
      data-testid="borrowed-row"
      className="flex flex-col gap-3 rounded-xl border border-brass/25 bg-brass-soft/[0.14] px-4 py-3.5 transition-colors hover:bg-brass-soft/25 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <DirectionBadge direction="borrowed" />
          <span className="text-[0.86rem] font-medium">from {record.owner_name}</span>
          <Badge variant={LOAN_STATUS_TONE[record.status]}>
            {LOAN_STATUS_LABELS[record.status]}
          </Badge>
          {record.overdue && <Badge variant="destructive">Past due</Badge>}
        </div>
        <p className="mt-1 text-[0.76rem] text-foreground/80">
          <Link
            to={`/borrowed/${record.id}`}
            className="underline-offset-4 hover:underline"
          >
            {record.item_name}
          </Link>
          {record.brand || record.model ? (
            <span className="text-muted-foreground">
              {" "}
              · {[record.brand, record.model].filter(Boolean).join(" ")}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {" "}
            · {borrowedLocationPrefix(record)} {place}
          </span>
        </p>
        <p className="mt-1 text-[0.67rem] text-muted-foreground">
          Borrowed {formatDate(record.borrowed_on)}
          {record.due_on
            ? ` · due ${formatDate(record.due_on)}`
            : " · no return date set"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        <div className="text-left sm:text-right">
          <p className="font-display text-[1.4rem] leading-none tracking-[-0.02em] tabular-nums">
            {record.status === "cancelled" ? "—" : record.outstanding_quantity}
            <span className="ml-1 font-sans text-[0.68rem] font-normal text-muted-foreground">
              of {record.quantity} held
            </span>
          </p>
          <p className="mt-1 text-[0.66rem] text-muted-foreground">
            {record.returned_quantity > 0
              ? `${record.returned_quantity} returned to owner`
              : "No returns yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/borrowed/${record.id}`}>View details</Link>
          </Button>
          {canWrite && open && record.outstanding_quantity > 0 && (
            <Button variant="outline" size="sm" onClick={() => onReturn(record)}>
              <RotateCcw />
              Return to owner
            </Button>
          )}
        </div>
      </div>
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
