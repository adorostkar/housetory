import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Hash,
  HelpCircle,
  MapPin,
  MoveRight,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { StocktakeFinishDialog } from "@/components/stocktake-finish-dialog";
import {
  StocktakeObservationDialog,
  type ItemObservationStatus,
} from "@/components/stocktake-observation-dialog";
import { StocktakeReviewDialog } from "@/components/stocktake-review-dialog";
import { StocktakeUnexpectedDialog } from "@/components/stocktake-unexpected-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCanWrite, useStocktakeSession } from "@/lib/queries";
import type {
  StocktakeItem,
  StocktakeObservationStatus,
  StocktakeSession,
} from "@/lib/types";
import { cn, formatDate, pluralize } from "@/lib/utils";

const STATUS_LABELS: Record<StocktakeObservationStatus, string> = {
  present: "Present",
  missing: "Missing",
  moved: "Moved",
  quantity_discrepancy: "Quantity differs",
  unknown: "Couldn't check",
  unexpected: "Unexpected",
};

const STATUS_TONES: Record<
  StocktakeObservationStatus,
  "sage" | "destructive" | "brass" | "outline" | "secondary"
> = {
  present: "sage",
  missing: "destructive",
  moved: "brass",
  quantity_discrepancy: "brass",
  unknown: "secondary",
  unexpected: "outline",
};

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "unchecked", label: "Unchecked" },
  { value: "present", label: "Present" },
  { value: "missing", label: "Missing" },
  { value: "moved", label: "Moved" },
  { value: "quantity_discrepancy", label: "Quantity" },
  { value: "unknown", label: "Couldn't check" },
];

const ACTIONS: Array<{
  status: ItemObservationStatus;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { status: "present", label: "Present", icon: CheckCircle2 },
  { status: "missing", label: "Missing", icon: XCircle },
  { status: "moved", label: "Moved", icon: MoveRight },
  { status: "quantity_discrepancy", label: "Count differs", icon: Hash },
  { status: "unknown", label: "Couldn't check", icon: HelpCircle },
];

function sessionBack(session: StocktakeSession) {
  const roomId = session.scope.room_ids?.[0];
  if (roomId) return { to: `/rooms/${roomId}`, label: "Back to room" };
  const containerId = session.scope.container_ids?.[0];
  if (containerId) return { to: `/containers/${containerId}`, label: "Back to container" };
  return { to: "/items", label: "Back to items" };
}

function expectedSummary(row: StocktakeItem) {
  return `${pluralize(row.expected_quantity, "owned unit")} · ${pluralize(
    row.expected_at_home_quantity,
    "at-home unit",
  )} · ${pluralize(row.expected_on_loan_quantity, "unit")} on loan`;
}

export function StocktakePage() {
  const { sessionId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useStocktakeSession(sessionId);
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState(searchParams.get("q") ?? "");
  const [filter, setFilter] = React.useState(searchParams.get("status") ?? "all");
  const [observationTarget, setObservationTarget] = React.useState<{
    row: StocktakeItem;
    status: ItemObservationStatus;
  } | null>(null);
  const [unexpectedOpen, setUnexpectedOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [finishMode, setFinishMode] = React.useState<"complete" | "abandon" | null>(null);
  const session = query.data;
  const back = session ? sessionBack(session) : { to: "/items", label: "Back to items" };
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["stocktake"] });
    void queryClient.invalidateQueries({ queryKey: ["items"] });
    void queryClient.invalidateQueries({ queryKey: ["item"] });
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    void queryClient.invalidateQueries({ queryKey: ["containers"] });
    void query.refetch();
  }, [queryClient, query]);

  if (query.isPending) return <StocktakeSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        title="This stocktake is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!session) return null;

  const inProgress = session.status === "in_progress";
  const expected = session.expected_item_count;
  const checked = session.checked_item_count;
  const percent = expected ? Math.min(100, Math.round((checked / expected) * 100)) : 0;
  const unchecked = Math.max(0, expected - checked);
  const visibleItems = session.items.filter((row) => {
    const status = row.latest_observation?.status ?? "unchecked";
    if (filter === "unchecked" && status !== "unchecked") return false;
    if (filter !== "all" && filter !== "unchecked" && status !== filter) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [row.item_name, row.current.name, row.expected_location_path, row.current.location_path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });
  const statusCounts: Record<string, number> = {
    all: session.items.length,
    unchecked: 0,
  };
  for (const row of session.items) {
    const rowStatus = row.latest_observation?.status ?? "unchecked";
    statusCounts[rowStatus] = (statusCounts[rowStatus] ?? 0) + 1;
  }
  const updateQuery = (nextSearch: string, nextFilter: string) => {
    const params = new URLSearchParams(searchParams);
    if (nextSearch.trim()) params.set("q", nextSearch);
    else params.delete("q");
    if (nextFilter !== "all") params.set("status", nextFilter);
    else params.delete("status");
    setSearchParams(params, { replace: true });
  };
  const defaultRoomId = session.scope.room_ids?.[0];
  const defaultContainerId = session.scope.container_ids?.[0];
  const coverage = session.coverage as Record<string, unknown>;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Stocktake"
        title={session.scope_label}
        backTo={back.to}
        backLabel={back.label}
        description={
          inProgress
            ? `${pluralize(expected, "expected item")} · ${checked} checked · ${pluralize(
                session.expected_on_loan_unit_count,
                "unit",
              )} on loan remain separately owned.`
            : session.status === "completed"
              ? `Checked by ${session.completed_by_name ?? session.created_by_name} on ${formatDate(
                  session.completed_at,
                )}. ${String(coverage.note ?? "")}`
              : `Abandoned ${formatDate(session.abandoned_at)}. Observations remain in history; no last-checked claim was made.`
        }
        actions={
          inProgress && canWrite ? (
            <>
              <Button variant="outline" onClick={() => setReviewOpen(true)}>
                <ClipboardCheck />
                Review changes
              </Button>
              <Button onClick={() => setFinishMode("complete")}>
                <Check />
                Finish
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Stocktake options">
                    <AlertTriangle />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{session.scope_label}</DropdownMenuLabel>
                  <DropdownMenuItem destructive onSelect={() => setFinishMode("abandon")}>
                    <XCircle />
                    Abandon stocktake
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Badge variant={session.status === "completed" ? "sage" : "secondary"}>
              {session.status === "completed"
                ? session.partial
                  ? "Completed · partial"
                  : "Completed"
                : "Abandoned"}
            </Badge>
          )
        }
      />

      <section className="surface mb-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-2xs">
            <Badge variant={inProgress ? "brass" : session.status === "completed" ? "sage" : "secondary"}>
              {inProgress ? "In progress" : session.status === "completed" ? "Completed" : "Abandoned"}
            </Badge>
            {session.partial && session.status === "completed" && <Badge variant="outline">Partial coverage</Badge>}
            {session.expected_on_loan_unit_count > 0 && (
              <Badge variant="outline">
                {session.expected_on_loan_unit_count} on loan excluded from at-home counts
              </Badge>
            )}
          </div>
          <p className="text-2xs text-muted-foreground">
            {session.checked_item_count} of {pluralize(expected, "item")} checked ·{" "}
            {session.checked_unit_count} at-home units counted
          </p>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={expected}
          aria-valuenow={Math.min(checked, expected)}
          aria-label="Stocktake items checked"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-2xs sm:grid-cols-4">
          <CoverageMetric label="Present" value={statusCounts.present ?? 0} />
          <CoverageMetric label="Missing" value={statusCounts.missing ?? 0} tone="destructive" />
          <CoverageMetric label="Quantity differs" value={statusCounts.quantity_discrepancy ?? 0} tone="brass" />
          <CoverageMetric label="Unexpected" value={session.unexpected_count} />
        </div>
        {session.status === "completed" && (
          <div className="mt-3 grid gap-2 rounded-xl border border-border/60 bg-secondary/15 px-3 py-2.5 text-2xs text-muted-foreground sm:grid-cols-2">
            <p>
              Verified items: {session.verified_item_count} · Missing: {session.missing_item_count} ·
              Couldn't check: {session.unknown_item_count}
            </p>
            <p>
              Applied corrections: {String(coverage.applied_corrections ?? 0)} · Missing units:{" "}
              {String(coverage.missing_units ?? 0)} · Unchecked items: {unchecked}
            </p>
          </div>
        )}
      </section>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              updateQuery(event.target.value, filter);
            }}
            className="pl-9"
            placeholder="Find an item or place"
            aria-label="Search this stocktake"
          />
        </div>
        <div className="flex max-w-full gap-1.5 overflow-x-auto overflow-y-hidden pb-1 sm:flex-wrap sm:justify-end sm:overflow-visible">
          {FILTERS.map((entry) => {
            const count = statusCounts[entry.value] ?? 0;
            return (
              <button
                key={entry.value}
                type="button"
                aria-pressed={filter === entry.value}
                onClick={() => {
                  setFilter(entry.value);
                  updateQuery(search, entry.value);
                }}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-2xs font-medium transition-colors",
                  filter === entry.value
                    ? "border-primary/25 bg-primary text-primary-foreground"
                    : "border-border/70 bg-card/60 text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
                )}
              >
                {entry.label} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visibleItems.length === 0 ? (
        <EmptyState
          title={session.items.length === 0 ? "No expected items" : "Nothing matches this view"}
          description={
            session.items.length === 0
              ? "This stocktake has no active expected items."
              : "Clear the search or choose another status filter."
          }
        />
      ) : (
        <div className="space-y-3">
          {visibleItems.map((row) => (
            <StocktakeItemCard
              key={row.snapshot_item_id}
              row={row}
              canWrite={canWrite && inProgress}
              onAction={(status) => setObservationTarget({ row, status })}
            />
          ))}
        </div>
      )}

      <section className="surface mt-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Unexpected findings
            </h2>
            <p className="mt-1 text-2xs text-muted-foreground">
              Recorded separately. Nothing is created automatically.
            </p>
          </div>
          {inProgress && canWrite && (
            <Button size="sm" variant="outline" onClick={() => setUnexpectedOpen(true)}>
              <Plus />
              Add finding
            </Button>
          )}
        </div>
        {session.unexpected_findings.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border/70 px-3 py-3 text-2xs text-muted-foreground">
            No unexpected items recorded for this stocktake.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border/50">
            {session.unexpected_findings.map((finding) => (
              <li key={finding.id} className="py-2.5 text-2xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{finding.unexpected_name}</span>
                  <Badge variant="outline">{finding.counted_quantity} found</Badge>
                  {finding.linked_item_id && (
                    <Link
                      to={`/items/${finding.linked_item_id}`}
                      className="text-2xs text-muted-foreground underline underline-offset-4"
                    >
                      Linked existing item
                    </Link>
                  )}
                </div>
                <p className="mt-1 break-words text-2xs text-muted-foreground">
                  {finding.observed_location_path || "No location recorded"} · {finding.verifier_name} ·{" "}
                  {formatDate(finding.observed_at)}
                  {finding.notes ? ` · ${finding.notes}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground/80">How this stocktake behaves</p>
        <p className="mt-1">
          Unchecked items are never marked present by opening this page. Present, missing and
          couldn't-check observations are evidence only. Moves and quantity corrections require
          the separate review step. Loaned units remain owned and are excluded from expected
          at-home counts.
        </p>
        <p className="mt-1">
          Finish permits explicit partial coverage. Completed checks update an item's last-checked
          state; later item or loan changes mark that state as changed rather than silently
          remaining “verified here”.
        </p>
      </section>

      {observationTarget && (
        <StocktakeObservationDialog
          open
          onOpenChange={(open) => {
            if (!open) setObservationTarget(null);
          }}
          sessionId={session.id}
          row={observationTarget.row}
          status={observationTarget.status}
          onSaved={refresh}
          onStale={refresh}
        />
      )}
      <StocktakeUnexpectedDialog
        open={unexpectedOpen}
        onOpenChange={setUnexpectedOpen}
        sessionId={session.id}
        defaultRoomId={defaultRoomId}
        defaultContainerId={defaultContainerId}
        onSaved={refresh}
      />
      <StocktakeReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        sessionId={session.id}
        onApplied={() => refresh()}
      />
      {finishMode && (
        <StocktakeFinishDialog
          open
          onOpenChange={(open) => {
            if (!open) setFinishMode(null);
          }}
          session={session}
          mode={finishMode}
          onCompleted={() => refresh()}
        />
      )}
    </div>
  );
}

function CoverageMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "destructive" | "brass";
}) {
  return (
    <div className="rounded-lg border border-border/55 bg-secondary/10 px-2.5 py-1.5">
      <p className="text-2xs uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-display text-[1.05rem] tabular-nums",
          tone === "destructive" && value > 0 && "text-destructive",
          tone === "brass" && value > 0 && "text-brass",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function StocktakeItemCard({
  row,
  canWrite,
  onAction,
}: {
  row: StocktakeItem;
  canWrite: boolean;
  onAction: (status: ItemObservationStatus) => void;
}) {
  const observation = row.latest_observation;
  const status = observation?.status;
  const actionsDisabled = !canWrite || row.deleted || row.current.is_archived || !row.current.updated_at;
  return (
    <article className="surface px-3.5 py-3.5 sm:px-4">
      <div className="flex gap-3">
        <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-secondary/55 sm:size-16">
          {row.current.photo_thumbnail_url ? (
            <img
              src={row.current.photo_thumbnail_url}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <ClipboardCheck className="size-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {row.item_id && !row.deleted ? (
              <Link
                to={`/items/${row.item_id}`}
                className="min-w-0 break-words text-sm font-medium leading-snug underline-offset-4 hover:underline"
              >
                {row.current.name ?? row.item_name}
              </Link>
            ) : (
              <span className="min-w-0 break-words text-sm font-medium leading-snug">
                {row.item_name}
              </span>
            )}
            {status && <Badge variant={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>}
            {row.correction_applied && <Badge variant="sage">Correction applied</Badge>}
            {row.deleted && <Badge variant="destructive">Deleted</Badge>}
            {row.changed_since_snapshot &&
              !row.deleted &&
              !row.correction_applied && (
                <Badge variant="brass">Changed since start</Badge>
              )}
            {row.current.is_archived && <Badge variant="secondary">Archived</Badge>}
          </div>
          <p className="mt-1 break-words text-2xs text-muted-foreground">
            Expected {expectedSummary(row)}
          </p>
          <p className="mt-0.5 flex items-start gap-1 break-words text-2xs text-muted-foreground">
            <MapPin className="mt-0.5 size-3 shrink-0" />
            {row.expected_location_path}
          </p>
          {row.changed_since_snapshot && !row.deleted && !row.correction_applied && (
            <p className="mt-1 break-words rounded-lg border border-brass/20 bg-brass-soft/20 px-2 py-1.5 text-2xs leading-relaxed text-brass">
              Current inventory: {row.current.quantity ?? "?"} owned · {row.current.at_home_quantity} at
              home · {row.current.on_loan_quantity} on loan ·{" "}
              {row.current.location_path || "no recorded location"}. Reload before recording if this
              differs from what you see.
            </p>
          )}
          {observation ? (
            <div className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
              {observation.status === "moved" && observation.observed_location_path
                ? `Found at ${observation.observed_location_path}. `
                : observation.status === "missing"
                  ? "Reported missing; no inventory deletion or write-off. "
                  : observation.status === "unknown"
                    ? "Marked as not checked; excluded from verified coverage. "
                    : observation.counted_quantity != null
                      ? `${observation.counted_quantity} counted at home. `
                      : ""}
              {observation.notes ? `${observation.notes} ` : ""}
              <span className="whitespace-nowrap">
                {observation.verifier_name} · {formatDate(observation.observed_at)}
              </span>
            </div>
          ) : (
            <p className="mt-1 text-2xs text-muted-foreground">
              Not checked yet. Opening this page does not mark it present.
            </p>
          )}
          {canWrite && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ACTIONS.map((action) => {
                const active = status === action.status;
                return (
                  <Button
                    key={action.status}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className="h-7 px-2.5 text-2xs"
                    disabled={actionsDisabled}
                    aria-label={`Mark ${row.item_name} ${action.label.toLowerCase()}`}
                    onClick={() => onAction(action.status)}
                  >
                    <action.icon className="size-3.5" />
                    {action.label}
                  </Button>
                );
              })}
            </div>
          )}
          {row.deleted && (
            <p className="mt-2 flex items-start gap-1.5 text-2xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This item was deleted during the stocktake and cannot be marked. Its historical
              observation remains.
            </p>
          )}
          {row.current.is_archived && (
            <p className="mt-2 flex items-start gap-1.5 text-2xs text-brass">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This item was archived during the stocktake. Reload the session or review the item
              before marking it.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function StocktakeSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-12 w-2/3 max-w-xl" />
      <Skeleton className="mt-6 h-28 rounded-2xl" />
      <div className="mt-5 space-y-3">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-32 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
