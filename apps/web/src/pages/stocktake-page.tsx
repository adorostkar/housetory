import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
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
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

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
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useCanWrite, useStocktakeSession } from "@/lib/queries";
import type {
  StocktakeItem,
  StocktakeObservationStatus,
  StocktakeSession,
} from "@/lib/types";
import { cn, formatDate, pluralize } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";

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

// Present is one tap on the row. These open a dialog, because each needs a
// count, a place, a note or a second look before it is saved.
const OTHER_ACTIONS: Array<{
  status: ItemObservationStatus;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { status: "quantity_discrepancy", label: "Count differs", icon: Hash },
  { status: "missing", label: "Missing", icon: XCircle },
  { status: "moved", label: "Moved", icon: MoveRight },
  { status: "unknown", label: "Couldn't check", icon: HelpCircle },
  { status: "present", label: "Present, with a note", icon: CheckCircle2 },
];

const STALE_CODES = ["item_changed", "loans_changed", "item_deleted"];

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const [savingPresent, setSavingPresent] = React.useState<Set<string>>(new Set());
  const [observationTarget, setObservationTarget] = React.useState<{
    row: StocktakeItem;
    status: ItemObservationStatus;
  } | null>(null);
  const [unexpectedOpen, setUnexpectedOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [finishMode, setFinishMode] = React.useState<"complete" | "abandon" | null>(null);
  const session = query.data;
  const location = useLocation();
  // Opened from the stocktake list, Back returns there and not to the room.
  const fromIndex = Boolean(
    (location.state as { fromStocktakeIndex?: boolean } | null)?.fromStocktakeIndex,
  );
  const back = fromIndex
    ? { to: "/stocktake", label: "Back to stocktakes" }
    : session
      ? sessionBack(session)
      : { to: "/items", label: "Back to items" };
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.stocktake });
    void queryClient.invalidateQueries({ queryKey: queryKeys.items });
    void queryClient.invalidateQueries({ queryKey: queryKeys.itemAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
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
  // While counting, the list starts with what is still to do.
  const defaultFilter = inProgress && canWrite ? "unchecked" : "all";
  const filter = searchParams.get("status") ?? defaultFilter;
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
    if (nextFilter !== defaultFilter) params.set("status", nextFilter);
    else params.delete("status");
    setSearchParams(params, { replace: true, state: location.state });
  };

  // One tap records that every expected at-home unit was counted. It sends the
  // same observation as the dialog, with the current item version and loans.
  const markPresent = async (row: StocktakeItem) => {
    if (savingPresent.has(row.snapshot_item_id)) return;
    setSavingPresent((current) => new Set(current).add(row.snapshot_item_id));
    try {
      await api.post(`/stocktake/sessions/${session.id}/observations`, {
        request_id: newRequestId(),
        status: "present",
        snapshot_item_id: row.snapshot_item_id,
        counted_quantity: row.current.at_home_quantity,
        room_id: null,
        container_id: null,
        notes: null,
        expected_item_updated_at: row.current.updated_at,
        expected_on_loan_quantity: row.current.on_loan_quantity,
      });
      toast.success(`${row.item_name}: present saved`);
      refresh();
    } catch (caught) {
      toast.error(getApiErrorMessage(caught));
      if (caught instanceof ApiError && STALE_CODES.includes(caught.code)) refresh();
    } finally {
      setSavingPresent((current) => {
        const next = new Set(current);
        next.delete(row.snapshot_item_id);
        return next;
      });
    }
  };
  const allChecked =
    inProgress && filter === "unchecked" && !search.trim() && (statusCounts.unchecked ?? 0) === 0;
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
              <Button variant="outline" className="h-11" onClick={() => setReviewOpen(true)}>
                <ClipboardCheck />
                Review changes
              </Button>
              <Button className="h-11" onClick={() => setFinishMode("complete")}>
                <Check />
                Finish
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-11" aria-label="Stocktake options">
                    <AlertTriangle />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{session.scope_label}</DropdownMenuLabel>
                  <DropdownMenuItem destructive className="min-h-11" onSelect={() => setFinishMode("abandon")}>
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

      {inProgress ? (
        <div
          data-testid="stocktake-progress"
          className="sticky top-[env(safe-area-inset-top,0px)] z-20 -mx-1 mb-3 rounded-b-xl bg-background/95 px-1 pb-2 pt-2 backdrop-blur"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
            <p role="status">
              <span className="font-medium text-foreground">
                {checked} of {pluralize(expected, "item")} checked
              </span>
              <span className="text-muted-foreground"> · {unchecked} left</span>
            </p>
            <p className="text-2xs text-muted-foreground">
              {session.checked_unit_count} at-home units counted
              {session.unexpected_count > 0 ? ` · ${session.unexpected_count} unexpected` : ""}
            </p>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary"
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
        </div>
      ) : (
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
      )}

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
                onClick={() => updateQuery(search, entry.value)}
                className={cn(
                  "min-h-11 shrink-0 rounded-full border px-3.5 py-1.5 text-2xs font-medium transition-colors",
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
          title={
            session.items.length === 0
              ? "No expected items"
              : allChecked
                ? "Everything is checked"
                : "Nothing matches this view"
          }
          description={
            session.items.length === 0
              ? "This stocktake has no active expected items."
              : allChecked
                ? "Review changes if something moved or a count differs. Then finish the stocktake. Nothing in your inventory changes until you do."
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
              saving={savingPresent.has(row.snapshot_item_id)}
              onPresent={() => void markPresent(row)}
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
            <Button size="sm" variant="outline" className="h-11" onClick={() => setUnexpectedOpen(true)}>
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

      <details className="mt-5 rounded-2xl border border-border/60 bg-card/40 px-4 text-2xs leading-relaxed text-muted-foreground">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-foreground/80">
          How this stocktake behaves
        </summary>
        <p>
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
        <div className="h-3" />
      </details>

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
  saving,
  onPresent,
  onAction,
}: {
  row: StocktakeItem;
  canWrite: boolean;
  saving: boolean;
  onPresent: () => void;
  onAction: (status: ItemObservationStatus) => void;
}) {
  const observation = row.latest_observation;
  const status = observation?.status;
  const actionsDisabled =
    !canWrite || saving || row.deleted || row.current.is_archived || !row.current.updated_at;
  const atHome = row.current.at_home_quantity;
  // A changed item, or one with nothing at home, needs a look at the numbers
  // first, so Present opens the dialog instead of saving at once.
  const needsLook =
    atHome < 1 || (row.changed_since_snapshot && !row.deleted && !row.correction_applied);
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
                className="min-w-0 break-words text-sm font-medium leading-snug underline-offset-4 hover:underline coarse:inline-flex coarse:min-h-11 coarse:items-center"
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
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {status !== "present" && (
                <Button
                  type="button"
                  variant={status ? "outline" : "default"}
                  className="h-11 min-w-28 flex-1 px-4 sm:flex-none"
                  disabled={actionsDisabled}
                  aria-label={`Mark ${row.item_name} present`}
                  onClick={() => (needsLook ? onAction("present") : onPresent())}
                >
                  {saving ? <Spinner /> : <CheckCircle2 />}
                  {atHome > 1 ? `All ${atHome} present` : "Present"}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 px-4"
                    disabled={actionsDisabled}
                    aria-label={`${status ? "Change the result" : "Other results"} for ${row.item_name}`}
                  >
                    {status ? "Change" : "Other"}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>{row.item_name}</DropdownMenuLabel>
                  {OTHER_ACTIONS.map((action) => (
                    <DropdownMenuItem
                      key={action.status}
                      className="min-h-11"
                      onSelect={() => onAction(action.status)}
                    >
                      <action.icon className="size-4" />
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
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
