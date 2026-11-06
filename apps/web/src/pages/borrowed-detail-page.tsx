import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  HandCoins,
  MapPin,
  Pencil,
  RotateCcw,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ActivityTimeline } from "@/components/activity-timeline";
import {
  BorrowedPhotoPanel,
  CancelBorrowedDialog,
  CorrectBorrowedDialog,
  ReturnBorrowedDialog,
} from "@/components/borrowed-dialogs";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LOAN_STATUS_LABELS, LOAN_STATUS_TONE } from "@/lib/labels";
import { queryKeys, useBorrowedRecord, useCanWrite } from "@/lib/queries";
import {
  borrowedLocationHeading,
  borrowedPlaceLabel,
  borrowedWhereLabel,
} from "@/lib/borrowed";
import { formatDate } from "@/lib/utils";

export function BorrowedDetailPage() {
  const { borrowedId = "" } = useParams();
  const recordQuery = useBorrowedRecord(borrowedId);
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [returnOpen, setReturnOpen] = React.useState(false);
  const [correctOpen, setCorrectOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);

  const refresh = () => {
    void recordQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.borrowed });
    void queryClient.invalidateQueries({ queryKey: ["loans"] });
  };

  if (recordQuery.isPending) return <BorrowedDetailSkeleton />;
  if (recordQuery.isError) {
    return (
      <ErrorState
        title="This borrowed record is out of reach"
        message="It may have been removed, or the link may be out of date."
        onRetry={() => void recordQuery.refetch()}
      />
    );
  }
  const record = recordQuery.data;
  const open =
    record.status === "outstanding" || record.status === "partially_returned";
  const place = borrowedPlaceLabel(record);
  const canCancel = canWrite && open && record.returned_quantity === 0;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Loans · Borrowed"
        title={record.item_name}
        description={`Belongs to ${record.owner_name} · ${borrowedWhereLabel(record)}`}
        backTo="/loans"
        backLabel="All loans"
        actions={
          <>
            {canWrite && open && (
              <Button variant="outline" onClick={() => setReturnOpen(true)}>
                <RotateCcw />
                Return to owner
              </Button>
            )}
            {canWrite && record.status !== "cancelled" && (
              <Button variant="outline" onClick={() => setCorrectOpen(true)}>
                <Pencil />
                Correct
              </Button>
            )}
            {canCancel && (
              <Button variant="ghost" onClick={() => setCancelOpen(true)}>
                <XCircle />
                Cancel record
              </Button>
            )}
          </>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
        <div className="space-y-5">
          <section className="surface border-brass/20 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="brass" data-testid="direction-badge">
                    <HandCoins className="size-3" /> Borrowed
                  </Badge>
                  <Badge variant={LOAN_STATUS_TONE[record.status]}>
                    {LOAN_STATUS_LABELS[record.status]}
                  </Badge>
                  {record.overdue && <Badge variant="destructive">Past due</Badge>}
                </div>
                <h2 className="mt-3 font-display text-[1.7rem] tracking-[-0.025em]">
                  {record.outstanding_quantity} of {record.quantity} held from{" "}
                  {record.owner_name}
                </h2>
                <p className="mt-1 text-[0.76rem] text-muted-foreground">
                  {record.returned_quantity > 0
                    ? `${record.returned_quantity} already returned to the owner · ${record.outstanding_quantity} still held`
                    : "No units have been returned to the owner yet."}{" "}
                  Borrowed goods are not household-owned stock.
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-brass/25 bg-brass-soft/35 px-3 py-2 text-[0.72rem] text-muted-foreground">
                <HandCoins className="size-4 text-brass" />
                <span>
                  Owner:{" "}
                  <strong className="font-medium text-foreground">
                    {record.owner_name}
                  </strong>
                </span>
              </div>
            </div>

            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <Detail icon={CalendarDays} label="Borrowed">
                {formatDate(record.borrowed_on)}
              </Detail>
              <Detail icon={CalendarDays} label="Due back">
                {record.due_on ? formatDate(record.due_on) : "No due date"}
              </Detail>
              <Detail icon={MapPin} label={borrowedLocationHeading(record)}>
                {place}
              </Detail>
              <Detail icon={CalendarDays} label="Last return">
                {record.latest_returned_on
                  ? formatDate(record.latest_returned_on)
                  : "No returns yet"}
              </Detail>
            </dl>

            {(record.brand || record.model) && (
              <p className="mt-4 text-[0.76rem] text-muted-foreground">
                {[record.brand, record.model].filter(Boolean).join(" ")}
              </p>
            )}
            {record.notes && (
              <div className="mt-5 border-t border-border/60 pt-4">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Private notes
                </p>
                <p className="mt-2 whitespace-pre-line text-[0.8rem] leading-relaxed text-muted-foreground">
                  {record.notes}
                </p>
              </div>
            )}
            {record.overdue && (
              <p className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
                Past the recorded due date by {record.days_past_due} day
                {record.days_past_due === 1 ? "" : "s"}. This is a private household
                record, not an automatic reminder to the owner.
              </p>
            )}
          </section>

          <section className="surface p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                  Returns to owner
                </h2>
                <p className="mt-1 text-[0.72rem] text-muted-foreground">
                  Partial returns stay attached to this borrowed record and its history.
                </p>
              </div>
              {canWrite && open && record.outstanding_quantity > 0 && (
                <Button size="sm" variant="outline" onClick={() => setReturnOpen(true)}>
                  <RotateCcw />
                  Return to owner
                </Button>
              )}
            </div>
            {record.returns.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border/70 px-4 py-5 text-[0.76rem] text-muted-foreground">
                No returns recorded.
              </p>
            ) : (
              <ul className="mt-4 space-y-2">
                {record.returns.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-border/60 bg-background/30 px-3.5 py-3 text-[0.76rem]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong className="font-medium">{entry.quantity}</strong> returned{" "}
                        {formatDate(entry.returned_on)}
                      </span>
                      <span className="text-[0.68rem] text-muted-foreground">
                        {entry.created_by_name ?? "Household"} · recorded{" "}
                        {formatDate(entry.created_at)}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="mt-1 whitespace-pre-line text-[0.7rem] leading-relaxed text-muted-foreground">
                        {entry.notes}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <BorrowedPhotoPanel record={record} />
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Borrowed-record history
            </h2>
            <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
              Creation, partial returns, corrections, cancellation and photo changes are
              preserved as separate events. Returns are never silently deleted.
            </p>
            <div className="mt-4">
              <ActivityTimeline
                events={record.history}
                compact
                onChanged={() => void recordQuery.refetch()}
              />
            </div>
          </section>
        </aside>
      </div>

      <ReturnBorrowedDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        record={record}
        onReturned={refresh}
      />
      <CorrectBorrowedDialog
        open={correctOpen}
        onOpenChange={setCorrectOpen}
        record={record}
        onCorrected={refresh}
      />
      <CancelBorrowedDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        record={record}
        onCancelled={() => {
          refresh();
          navigate("/loans", { replace: true });
        }}
      />
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 text-[0.8rem]">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div>
        <dt className="text-[0.66rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </dt>
        <dd className="mt-1">{children}</dd>
      </div>
    </div>
  );
}

function BorrowedDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-4 h-12 w-48" />
      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
        <div className="space-y-5">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    </div>
  );
}
