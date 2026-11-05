import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";

import { FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useStocktakeReview } from "@/lib/queries";
import type { StocktakeApplyResult } from "@/lib/types";
import { pluralize } from "@/lib/utils";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StocktakeReviewDialog({
  open,
  onOpenChange,
  sessionId,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onApplied: (result: StocktakeApplyResult) => void;
}) {
  const queryClient = useQueryClient();
  const reviewQuery = useStocktakeReview(sessionId, open);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    requestId.current = newRequestId();
    void reviewQuery.refetch();
    // Only reset when the dialog opens; review mutations invalidate explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  const review = reviewQuery.data;
  const apply = async () => {
    if (!review) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.post<StocktakeApplyResult>(
        `/stocktake/sessions/${sessionId}/apply`,
        {
          request_id: requestId.current,
          review_fingerprint: review.fingerprint,
        },
      );
      requestId.current = newRequestId();
      await queryClient.invalidateQueries({ queryKey: ["stocktake"] });
      onApplied(result);
      onOpenChange(false);
    } catch (caught) {
      setError(getApiErrorMessage(caught));
      if (
        caught instanceof ApiError &&
        ["stocktake_review_stale", "stocktake_conflict"].includes(caught.code)
      ) {
        void reviewQuery.refetch();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review proposed corrections</DialogTitle>
          <DialogDescription>
            Observations are already saved. Inventory changes only when you apply this reviewed
            list. Missing observations never delete, archive or write off an item.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[62vh] space-y-3 overflow-y-auto overscroll-contain pr-1">
          {reviewQuery.isPending ? (
            <div className="flex items-center gap-2 rounded-xl border border-border/65 px-3 py-6 text-[0.78rem] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Comparing observations with current inventory…
            </div>
          ) : reviewQuery.error ? (
            <FormError message={getApiErrorMessage(reviewQuery.error)} />
          ) : review && review.proposals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-[0.78rem] leading-relaxed text-muted-foreground">
              Nothing to change. Present, missing and couldn’t-check observations are saved as
              evidence without editing inventory.
            </div>
          ) : review ? (
            review.proposals.map((proposal) => {
              const locationChanged =
                proposal.proposed_location_path &&
                proposal.proposed_location_path !== proposal.current_location_path;
              return (
                <section
                  key={proposal.observation_id}
                  className="rounded-xl border border-border/70 px-3.5 py-3 text-[0.74rem]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{proposal.item_name}</span>
                    <Badge variant="outline">
                      {proposal.action === "move"
                        ? "Move"
                        : proposal.action === "set_quantity"
                          ? "Quantity"
                          : proposal.action === "move_and_quantity"
                            ? "Move + quantity"
                            : "No change"}
                    </Badge>
                    {proposal.conflict && <Badge variant="destructive">Conflict</Badge>}
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/50 bg-secondary/15 px-2.5 py-2">
                      <p className="text-[0.62rem] uppercase tracking-[0.08em] text-muted-foreground">
                        Current
                      </p>
                      <p className="mt-0.5">
                        {proposal.current_quantity != null
                          ? `${pluralize(proposal.current_quantity, "owned unit")}`
                          : "Item unavailable"}
                      </p>
                      <p className="mt-0.5 break-words text-[0.66rem] text-muted-foreground">
                        {proposal.current_location_path || "No location recorded"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-sage/20 bg-sage-soft/30 px-2.5 py-2">
                      <p className="text-[0.62rem] uppercase tracking-[0.08em] text-muted-foreground">
                        After apply
                      </p>
                      <p className="mt-0.5">
                        {proposal.proposed_quantity != null
                          ? `${pluralize(proposal.proposed_quantity, "owned unit")}`
                          : "No quantity change"}
                      </p>
                      <p className="mt-0.5 break-words text-[0.66rem] text-muted-foreground">
                        {proposal.proposed_location_path || "No location change"}
                      </p>
                    </div>
                  </div>
                  {proposal.counted_quantity != null && (
                    <p className="mt-2 text-[0.68rem] text-muted-foreground">
                      Counted at home: {proposal.counted_quantity} · on loan:{" "}
                      {proposal.on_loan_quantity} (still owned)
                    </p>
                  )}
                  {locationChanged && (
                    <p className="mt-1 flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
                      <ArrowRight className="size-3" />
                      <span className="break-words">
                        {proposal.current_location_path} → {proposal.proposed_location_path}
                      </span>
                    </p>
                  )}
                  {proposal.conflict && (
                    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/[0.05] px-2.5 py-2 text-[0.68rem] leading-relaxed text-destructive">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      {proposal.conflict}
                    </p>
                  )}
                  {proposal.warnings.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[0.66rem] leading-relaxed text-muted-foreground">
                      {proposal.warnings.map((warning, index) => (
                        <li key={`${proposal.observation_id}-${index}`}>• {warning}</li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })
          ) : null}

          {review && review.conflict_count > 0 && (
            <p className="rounded-xl border border-brass/20 bg-brass-soft/25 px-3 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
              Conflicts must be re-observed against current values. Nothing will be applied while a
              conflict is present.
            </p>
          )}
        </div>

        {(error || reviewQuery.error) && (
          <FormError message={error ?? getApiErrorMessage(reviewQuery.error)} />
        )}

        <DialogFooter>
          <div className="mr-auto flex items-center gap-2 text-[0.68rem] text-muted-foreground">
            <Check className="size-3.5" />
            Atomic apply · {review?.actionable_count ?? 0} proposed change
            {(review?.actionable_count ?? 0) === 1 ? "" : "s"}
          </div>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Close
          </Button>
          {review && review.conflict_count > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void reviewQuery.refetch()}
              disabled={reviewQuery.isFetching}
            >
              {reviewQuery.isFetching ? <Spinner /> : <RefreshCw />}
              Recheck
            </Button>
          )}
          <Button
            type="button"
            onClick={() => void apply()}
            disabled={pending || !review?.can_apply || reviewQuery.isFetching}
          >
            {pending ? <Spinner /> : <Check />}
            Apply corrections
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
