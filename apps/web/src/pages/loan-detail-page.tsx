import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarDays,
  HandCoins,
  MapPin,
  Pencil,
  RotateCcw,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ActivityTimeline } from "@/components/activity-timeline";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import {
  CorrectLoanDialog,
  ReturnLoanDialog,
} from "@/components/loan-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getApiErrorMessage } from "@/lib/api";
import { LOAN_STATUS_LABELS, LOAN_STATUS_TONE } from "@/lib/labels";
import { useCanWrite, useLoan } from "@/lib/queries";
import { formatDate } from "@/lib/utils";

export function LoanDetailPage() {
  const { loanId = "" } = useParams();
  const loanQuery = useLoan(loanId);
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const loansOrigin =
    typeof (location.state as { loansOrigin?: unknown } | null)?.loansOrigin ===
    "string"
      ? ((location.state as { loansOrigin: string }).loansOrigin)
      : "/loans";
  const [returnOpen, setReturnOpen] = React.useState(false);
  const [correctOpen, setCorrectOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelRequestId, setCancelRequestId] = React.useState(() =>
    crypto.randomUUID(),
  );

  const cancel = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/cancel`, {
        request_id: cancelRequestId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["loans"] });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      void queryClient.invalidateQueries({ queryKey: ["item"] });
      setCancelOpen(false);
      toast.success("Loan cancelled and recorded in history");
    },
  });

  if (loanQuery.isPending) return <LoanDetailSkeleton />;
  if (loanQuery.isError) {
    return (
      <ErrorState
        title="This loan is out of reach"
        message="It may have been removed, or the link may be out of date."
        onRetry={() => void loanQuery.refetch()}
      />
    );
  }
  const loan = loanQuery.data;
  const open = loan.status === "outstanding" || loan.status === "partially_returned";
  const canCancel =
    canWrite &&
    open &&
    loan.returned_quantity === 0 &&
    loan.returns.length === 0 &&
    loan.status !== "cancelled";

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Lending · Loan"
        title={loan.borrower_name}
        description={`${loan.item_name} · ${loan.home_room_name_snapshot ?? "home location not recorded"}${
          loan.home_location_name_snapshot
            ? ` / ${loan.home_location_name_snapshot}`
            : ""
        }`}
        backTo={loansOrigin}
        backLabel="All loans"
        actions={
          <>
            {canWrite && open && (
              <Button variant="outline" onClick={() => setReturnOpen(true)}>
                <RotateCcw />
                Record return
              </Button>
            )}
            {canWrite && loan.status !== "cancelled" && (
              <Button variant="outline" onClick={() => setCorrectOpen(true)}>
                <Pencil />
                Correct
              </Button>
            )}
            {canCancel && (
              <Button
                variant="ghost"
                onClick={() => {
                  setCancelRequestId(crypto.randomUUID());
                  setCancelOpen(true);
                }}
              >
                <XCircle />
                Cancel loan
              </Button>
            )}
          </>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
        <div className="space-y-5">
          <section className="surface p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={LOAN_STATUS_TONE[loan.status]}>
                    {LOAN_STATUS_LABELS[loan.status]}
                  </Badge>
                  {loan.overdue && <Badge variant="destructive">Past due</Badge>}
                  {loan.includes_contents && (
                    <Badge variant="brass">Includes contents</Badge>
                  )}
                  {loan.parent_loan_id && (
                    <Link
                      to={`/loans/${loan.parent_loan_id}`}
                      className="text-[0.7rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Contents of parent loan
                    </Link>
                  )}
                </div>
                <h2 className="mt-3 font-display text-[1.7rem] tracking-[-0.025em]">
                  {loan.outstanding_quantity} of {loan.quantity} still out
                </h2>
                {loan.returned_quantity > 0 && (
                  <p className="mt-1 text-[0.76rem] text-muted-foreground">
                    {loan.returned_quantity} already returned ·{" "}
                    {loan.quantity - loan.returned_quantity} outstanding
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2 text-[0.72rem] text-muted-foreground">
                <HandCoins className="size-4 text-brass" />
                {loan.item_id ? (
                  <Link
                    to={`/items/${loan.item_id}`}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {loan.item_name}
                  </Link>
                ) : (
                  <span>{loan.item_name_snapshot} (deleted)</span>
                )}
              </div>
            </div>

            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <Detail icon={CalendarDays} label="Lent">
                {formatDate(loan.lent_on)}
              </Detail>
              <Detail icon={CalendarDays} label="Due back">
                {loan.due_on ? formatDate(loan.due_on) : "No due date"}
              </Detail>
              <Detail icon={MapPin} label="Home at lending time">
                {[loan.home_room_name_snapshot, loan.home_location_name_snapshot]
                  .filter(Boolean)
                  .join(" / ") || "Not recorded"}
              </Detail>
              <Detail icon={CalendarDays} label="Last return">
                {loan.latest_returned_on
                  ? formatDate(loan.latest_returned_on)
                  : "No returns yet"}
              </Detail>
            </dl>

            {loan.notes && (
              <div className="mt-5 border-t border-border/60 pt-4">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Private notes
                </p>
                <p className="mt-2 whitespace-pre-line text-[0.8rem] leading-relaxed text-muted-foreground">
                  {loan.notes}
                </p>
              </div>
            )}
            {loan.overdue && (
              <p className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
                Past the recorded due date by {loan.days_past_due} day
                {loan.days_past_due === 1 ? "" : "s"}. This is a household record, not an
                accusation or an automatic message to the borrower.
              </p>
            )}
          </section>

          {(loan.contents_loans?.length ?? 0) > 0 && (
            <section className="surface p-5 sm:p-6">
              <div>
                <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                  Contents on this loan
                </h2>
                <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
                  Each child item has its own loan record, return history and availability.
                  Returning this parent alone does not mark any child returned.
                </p>
              </div>
              <ul className="mt-4 space-y-2">
                {loan.contents_loans?.map((child) => (
                  <li
                    key={child.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/30 px-3.5 py-3 text-[0.76rem]"
                  >
                    <span className="min-w-0">
                      <Link
                        to={`/loans/${child.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {child.item_name}
                      </Link>
                      <span className="ml-2 text-muted-foreground">
                        {child.outstanding_quantity} of {child.quantity} still out
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant={LOAN_STATUS_TONE[child.status]}>
                        {LOAN_STATUS_LABELS[child.status]}
                      </Badge>
                      <span className="text-[0.68rem] text-muted-foreground">
                        {child.outstanding_quantity === 0
                          ? "Returned"
                          : child.due_on
                            ? `due ${formatDate(child.due_on)}`
                            : "no due date"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="surface p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                  Returns
                </h2>
                <p className="mt-1 text-[0.72rem] text-muted-foreground">
                  Partial returns stay attached to this loan and its history.
                </p>
              </div>
              {loan.item_id && (
                <Link
                  to={`/items/${loan.item_id}`}
                  className="text-[0.72rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <ArrowLeft className="mr-1 inline size-3" />
                  Item
                </Link>
              )}
            </div>
            {loan.returns.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border/70 px-4 py-5 text-[0.76rem] text-muted-foreground">
                No returns recorded.
              </p>
            ) : (
              <ul className="mt-4 space-y-2">
                {loan.returns.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/30 px-3.5 py-3 text-[0.76rem]"
                  >
                    <span>
                      <strong className="font-medium">{entry.quantity}</strong> returned{" "}
                      {formatDate(entry.returned_on)}
                      {entry.reversed_at && (
                        <Badge variant="secondary" className="ml-2">
                          Reversed by undo
                        </Badge>
                      )}
                    </span>
                    <span className="text-[0.68rem] text-muted-foreground">
                      {entry.created_by_name ?? "Household"} · recorded{" "}
                      {formatDate(entry.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Loan history
            </h2>
            <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
              Undo is a new compensating event and is only offered when current state still
              permits it.
            </p>
            <div className="mt-4">
              <ActivityTimeline
                events={loan.history}
                compact
                onChanged={() => void loanQuery.refetch()}
              />
            </div>
          </section>
        </aside>
      </div>

      <ReturnLoanDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        loan={loan}
        onReturned={() => void loanQuery.refetch()}
      />
      <CorrectLoanDialog
        open={correctOpen}
        onOpenChange={setCorrectOpen}
        loan={loan}
        onCorrected={() => void loanQuery.refetch()}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this loan?"
        description="This releases the outstanding quantity and records a cancellation event. It is only available before any returns. The history is kept."
        confirmLabel="Cancel loan"
        onConfirm={async () => {
          try {
            await cancel.mutateAsync();
            navigate(loansOrigin, { replace: true });
          } catch (error) {
            toast.error(getApiErrorMessage(error));
            throw error;
          }
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

function LoanDetailSkeleton() {
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
