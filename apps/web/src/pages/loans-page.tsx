import {
  ChevronDown,
  HandCoins,
  Package,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import {
  NewLoanDialog,
  type NewLoanDirection,
  ReturnBorrowedDialog,
} from "@/components/borrowed-dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ReturnLoanDialog } from "@/components/loan-dialogs";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
import { PersonNameInput } from "@/components/person-name-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { LOAN_STATUS_LABELS, LOAN_STATUS_TONE } from "@/lib/labels";
import { useBorrowedList, useCanWrite, useLoans } from "@/lib/queries";
import type { BorrowedRecord, Loan, LoanFilterStatus } from "@/lib/types";
import { borrowedLocationPrefix, borrowedPlaceLabel } from "@/lib/borrowed";
import { cn, formatDate } from "@/lib/utils";

const FILTERS: Array<{ value: LoanFilterStatus; label: string }> = [
  { value: "open", label: "Outstanding" },
  { value: "returned", label: "Returned" },
  { value: "all", label: "All" },
];

type Direction = "all" | "lent_out" | "borrowed";

/** Two chips. With neither pressed, both directions are shown. */
const DIRECTIONS: Array<{ value: Exclude<Direction, "all">; label: string }> = [
  { value: "lent_out", label: "Lent out" },
  { value: "borrowed", label: "Borrowed" },
];

const LOAN_STATUS_VALUES = new Set<string>([
  "all",
  "open",
  "outstanding",
  "partially_returned",
  "returned",
  "cancelled",
]);

function parseStatus(value: string | null): LoanFilterStatus {
  return value && LOAN_STATUS_VALUES.has(value)
    ? (value as LoanFilterStatus)
    : "open";
}

function parseDirection(value: string | null): Direction {
  return value === "lent_out" || value === "borrowed" ? value : "all";
}

function parseOverdue(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function LoansPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const itemId = searchParams.get("item_id") ?? undefined;
  const status = parseStatus(searchParams.get("status"));
  const direction: Direction = itemId
    ? "lent_out"
    : parseDirection(searchParams.get("direction"));
  const overdue = parseOverdue(searchParams.get("overdue"));
  const qParam = searchParams.get("q") ?? "";
  const personParam = searchParams.get("person") ?? "";
  const canWrite = useCanWrite();
  const [search, setSearch] = React.useState(qParam);
  const [person, setPerson] = React.useState(personParam);
  const [newLoan, setNewLoan] = React.useState<NewLoanDirection | null>(null);
  const [newLoanDirection, setNewLoanDirection] = React.useState<NewLoanDirection>("lend");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [returnLoan, setReturnLoan] = React.useState<Loan | null>(null);
  const [returnBorrowed, setReturnBorrowed] = React.useState<BorrowedRecord | null>(
    null,
  );
  const newLoanButtonRef = React.useRef<HTMLButtonElement>(null);
  const debouncedSearch = useDebouncedValue(search, 300);
  const debouncedPerson = useDebouncedValue(person, 250);

  const updateFilters = React.useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(updates)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  React.useEffect(() => {
    const trimmed = debouncedSearch.trim();
    if (trimmed === qParam) return;
    updateFilters({ q: trimmed || null });
  }, [debouncedSearch, qParam, updateFilters]);

  React.useEffect(() => {
    const trimmed = debouncedPerson.trim();
    if (trimmed === personParam) return;
    updateFilters({ person: trimmed || null });
  }, [debouncedPerson, personParam, updateFilters]);

  const clearPerson = () => setPerson("");

  const loansQuery = useLoans({
    status,
    item_id: itemId,
    person: personParam.trim() || undefined,
    overdue,
    q: qParam.trim() || undefined,
  });
  const borrowedQuery = useBorrowedList(
    {
      status,
      person: personParam.trim() || undefined,
      overdue,
      q: qParam.trim() || undefined,
    },
    50,
    !itemId,
  );

  if (loansQuery.isPending || (!itemId && borrowedQuery.isPending)) {
    return <PageSkeleton variant="list" />;
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
    Boolean(qParam.trim()) ||
    Boolean(personParam.trim()) ||
    Boolean(itemId) ||
    overdue ||
    status !== "open";

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
  const borrowedOpenCount = borrowedData?.open_count ?? 0;
  const overdueCount = itemId
    ? (loanData?.overdue_count ?? 0)
    : (loanData?.overdue_count ?? 0) + (borrowedData?.overdue_count ?? 0);
  // A link can ask for a status that is not one of the three usual choices.
  const statusOptions = FILTERS.some((filter) => filter.value === status)
    ? FILTERS
    : [
        ...FILTERS,
        {
          value: status,
          label: LOAN_STATUS_LABELS[status as keyof typeof LOAN_STATUS_LABELS] ?? status,
        },
      ];
  const statusLabel =
    statusOptions.find((filter) => filter.value === status)?.label ?? "Outstanding";
  // The direction chips and the search stay in view, so they are not counted.
  const filterChips = [
    status !== "open"
      ? { key: "status", label: statusLabel, remove: () => updateFilters({ status: null }) }
      : null,
    overdue
      ? { key: "overdue", label: "Past due", remove: () => updateFilters({ overdue: null }) }
      : null,
    personParam.trim()
      ? { key: "person", label: `Person: ${personParam.trim()}`, remove: clearPerson }
      : null,
    itemId
      ? { key: "item", label: "One item", remove: () => updateFilters({ item_id: null }) }
      : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);
  const visibleTotal =
    (direction === "borrowed" ? 0 : loans.length) +
    (direction === "lent_out" ? 0 : borrowed.length);
  const fullTotal =
    (direction === "borrowed" ? 0 : (loanData?.total ?? 0)) +
    (direction === "lent_out" ? 0 : (borrowedData?.total ?? 0));

  const restoreNewLoanFocus = () => {
    window.requestAnimationFrame(() => newLoanButtonRef.current?.focus());
  };
  const beginNewLoan = (direction: NewLoanDirection = "lend") => {
    setNewLoanDirection(direction);
    setNewLoan(direction);
  };
  const refetchBoth = () => {
    void loansQuery.refetch();
    void borrowedQuery.refetch();
  };

  return (
    <PageLayout
      header={{
        title: "Loans",
        titleAddon: (
          <div className="mt-0.5 flex items-center justify-between gap-3">
            <p className="min-w-0 text-xs text-muted-foreground" data-testid="loans-summary">
              {lentOpenCount} out ·{" "}
              {overdueCount > 0 ? (
                <button
                  type="button"
                  aria-pressed={overdue}
                  onClick={() => updateFilters({ overdue: overdue ? null : "1" })}
                  className="inline-flex min-h-9 items-center font-medium text-destructive underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
                >
                  {overdueCount} past due
                </button>
              ) : (
                "0 past due"
              )}
              {itemId ? "" : ` · ${borrowedOpenCount} borrowed`}
            </p>
            {canWrite && (
              <Button ref={newLoanButtonRef} className="shrink-0" onClick={() => beginNewLoan()}>
                <HandCoins />
                New loan
              </Button>
            )}
          </div>
        ),
      }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!itemId && (
          <div className="flex shrink-0 gap-1.5" role="group" aria-label="Loan direction">
            {DIRECTIONS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={direction === entry.value}
                onClick={() =>
                  updateFilters({
                    direction: direction === entry.value ? null : entry.value,
                  })
                }
                className={cn(
                  "min-h-9 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring coarse:min-h-11",
                  direction === entry.value
                    ? entry.value === "borrowed"
                      ? "border-brass/30 bg-brass-soft text-brass"
                      : "border-sage/30 bg-sage-soft text-accent-foreground"
                    : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-10"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Person or item"
            aria-label="Search loans"
          />
        </div>
        <button
          type="button"
          className="flex h-11 shrink-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={filtersOpen}
          aria-controls="loan-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>Filters</span>
          {filterChips.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
              <span className="sr-only">Active filters: </span>
              {filterChips.length}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              filtersOpen && "rotate-180",
            )}
          />
        </button>
      </div>

      {(filtersOpen || filterChips.length > 0) && (
        <div className="surface mb-3 p-3.5">
          {filtersOpen && (
            <div
              id="loan-filters"
              className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-center gap-2"
            >
              <Select
                aria-label="Loan status"
                value={status}
                onChange={(event) =>
                  updateFilters({
                    status: event.target.value === "open" ? null : event.target.value,
                  })
                }
                className="rounded-lg text-sm"
              >
                {statusOptions.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </Select>
              <div className="relative min-w-0">
                <PersonNameInput
                  id="loans-person-filter"
                  ariaLabel="Filter loans by person"
                  value={person}
                  onChange={setPerson}
                  placeholder="Person"
                  className={cn("rounded-lg text-sm", person.trim() && "pr-11")}
                />
                {person.trim() && (
                  <button
                    type="button"
                    aria-label="Clear person filter"
                    className="absolute right-0 top-0 z-10 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                    onClick={clearPerson}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={overdue}
                  onChange={(event) =>
                    updateFilters({ overdue: event.target.checked ? "1" : null })
                  }
                />
                Past due only
              </label>
            </div>
          )}
          {filterChips.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5",
                filtersOpen && "mt-3 border-t border-border/60 pt-3",
              )}
            >
              {filterChips.map((chip) => (
                <Badge key={chip.key} variant="secondary" className="gap-1 py-0 pl-2.5 pr-0 text-2xs">
                  <span className="max-w-56 truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.remove}
                    className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:size-7"
                    aria-label={`Remove ${chip.label}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <section aria-label="Loans list">
        <div className="space-y-2.5">
          {rows.length === 0 ? (
            hasFilters ? (
              <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
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
                onAction={canWrite ? () => beginNewLoan("lend") : undefined}
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
                onAction={canWrite ? () => beginNewLoan("borrow") : undefined}
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
                onAction={canWrite ? () => beginNewLoan("lend") : undefined}
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
          <div className="mt-4 space-y-1 text-2xs text-muted-foreground">
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

      <NewLoanDialog
        open={newLoan !== null}
        initialDirection={newLoanDirection}
        onOpenChange={(open) => {
          if (open) return;
          setNewLoan(null);
          restoreNewLoanFocus();
        }}
        onLent={() => {
          updateFilters({ status: null });
          refetchBoth();
        }}
        onBorrowed={() => {
          updateFilters({ direction: null, status: null });
          refetchBoth();
        }}
      />

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
    </PageLayout>
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
  const location = useLocation();
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
          <span className="text-sm font-medium">to {loan.borrower_name}</span>
          <Badge variant={LOAN_STATUS_TONE[loan.status]}>
            {LOAN_STATUS_LABELS[loan.status]}
          </Badge>
          {loan.includes_contents && <Badge variant="brass">With contents</Badge>}
          {loan.parent_loan_id && <Badge variant="outline">Content loan</Badge>}
          {loan.overdue && <Badge variant="destructive">Past due</Badge>}
        </div>
        <p className="mt-1 text-xs text-foreground/80">
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
        <p className="mt-1 text-2xs text-muted-foreground">
          Lent {formatDate(loan.lent_on)}
          {loan.due_on ? ` · due ${formatDate(loan.due_on)}` : " · no return date set"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        <div className="text-left sm:text-right">
          <p className="font-display text-[1.4rem] leading-none tracking-[-0.02em] tabular-nums">
            {loan.status === "cancelled" ? "—" : loan.outstanding_quantity}
            <span className="ml-1 font-sans text-2xs font-normal text-muted-foreground">
              of {loan.quantity} out
            </span>
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {loan.returned_quantity > 0
              ? `${loan.returned_quantity} returned`
              : "No returns"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button variant="ghost" size="sm" asChild>
            <Link
              to={`/loans/${loan.id}`}
              state={{ loansOrigin: `${location.pathname}${location.search}` }}
            >
              View details
            </Link>
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
  const location = useLocation();
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
          <span className="text-sm font-medium">from {record.owner_name}</span>
          <Badge variant={LOAN_STATUS_TONE[record.status]}>
            {LOAN_STATUS_LABELS[record.status]}
          </Badge>
          {record.overdue && <Badge variant="destructive">Past due</Badge>}
        </div>
        <p className="mt-1 text-xs text-foreground/80">
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
        <p className="mt-1 text-2xs text-muted-foreground">
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
            <span className="ml-1 font-sans text-2xs font-normal text-muted-foreground">
              of {record.quantity} held
            </span>
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {record.returned_quantity > 0
              ? `${record.returned_quantity} returned to owner`
              : "No returns yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button variant="ghost" size="sm" asChild>
            <Link
              to={`/borrowed/${record.id}`}
              state={{ loansOrigin: `${location.pathname}${location.search}` }}
            >
              View details
            </Link>
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
