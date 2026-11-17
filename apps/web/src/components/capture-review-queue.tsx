import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import * as React from "react";
import { PENDING_ACTIONS_PAGE, useCanWrite, useCaptureReviews, usePendingActions } from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";

const ACTION_LABELS: Record<string, string> = {
  edit_item: "Edit", move_items: "Move", lend: "Lend", borrow: "Borrow",
  return_loan: "Return", return_borrowed: "Return",
};

function PreparedActions() {
  const [offset, setOffset] = React.useState(0);
  const section = React.useRef<HTMLElement>(null);
  // A shorter page must not leave the reader below the list they are paging.
  const showPage = (next: number) => {
    setOffset(next);
    section.current?.scrollIntoView?.({ block: "start" });
  };
  const pending = usePendingActions(offset);
  const actions = pending.data?.items ?? [];
  const total = pending.data?.total ?? 0;
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  // Resolving the last action on a page steps back instead of showing an empty page.
  React.useEffect(() => {
    if (pending.data && offset > 0 && offset >= total) {
      setOffset(Math.max(0, Math.floor((total - 1) / PENDING_ACTIONS_PAGE) * PENDING_ACTIONS_PAGE));
    }
  }, [pending.data, offset, total]);
  if (pending.isError) return <p role="alert" className="text-xs">Prepared actions could not be loaded. Refresh or retry when online.</p>;
  if (!total) return null;
  return (
    <section ref={section} aria-label="Prepared actions" className="surface scroll-mt-32 space-y-2 p-3">
      <h2 className="text-sm font-medium">Prepared actions · {total}</h2>
      {actions.map((action) => {
        const stale = action.state !== "ready";
        const title = `${ACTION_LABELS[action.kind] ?? "Change"}: ${action.targets.map((target) => target.name).join(", ") || "details unavailable"}`;
        return (
          <div key={action.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 break-words text-xs">{title}
              {stale && <span className="block text-2xs text-muted-foreground">
                Can no longer be applied as prepared. Cancel it and ask again.
              </span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {!stale && <Button size="sm" variant="outline" className="min-h-11 shrink-0"
                aria-label={`Review ${title}`}
                onClick={() => navigate(
                  { pathname: location.pathname, search: location.search, hash: "#assistant" },
                  { replace: location.hash === "#assistant", state: { assistantCapture: { kind: "action", id: action.id } } },
                )}>Review</Button>}
              <Button size="sm" variant="ghost" className="min-h-11 shrink-0"
                aria-label={`Cancel ${title}`}
                onClick={() => void api.post(`/assistant/actions/proposals/${action.id}/cancel`)
                  .then(() => {
                    toast.success("Prepared action cancelled. Nothing was changed.");
                    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingActionsAll });
                    void queryClient.invalidateQueries({ queryKey: queryKeys.assistantRunsAll });
                  })
                  .catch((error: unknown) => toast.error(getApiErrorMessage(error)))}>Cancel</Button>
            </div>
          </div>
        );
      })}
      {total > PENDING_ACTIONS_PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
          <span>{offset + 1}–{Math.min(offset + PENDING_ACTIONS_PAGE, total)} of {total}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="min-h-11" disabled={offset === 0}
              onClick={() => showPage(Math.max(0, offset - PENDING_ACTIONS_PAGE))}>Previous actions</Button>
            <Button size="sm" variant="outline" className="min-h-11"
              disabled={offset + PENDING_ACTIONS_PAGE >= total}
              onClick={() => showPage(offset + PENDING_ACTIONS_PAGE)}>Next actions</Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function CaptureReviewQueue() {
  return <div className="mb-3 space-y-3 empty:hidden"><PreparedActions /><PendingCaptures /></div>;
}

function PendingCaptures() {
  const {
    pendingReviews, reviewsError, select, selectImport, selectPhoto,
    dismissReview, undoReview, retryReview, reviewMutationPending,
  } = useAssistantDocuments();
  // Loaded only here, where the dismissed list is shown; it does not poll.
  const dismissed = useCaptureReviews(true);
  const dismissedReviews = dismissed.data ?? [];
  const location = useLocation();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  if (reviewsError || dismissed.isError) return <p role="alert" className="text-xs">Pending captures could not be loaded. Refresh or retry when online.</p>;
  if (!pendingReviews.length && !dismissedReviews.length) return null;
  return (
    <section aria-label="Pending captures" className="surface space-y-2 p-3">
      <h2 className="text-sm font-medium">Pending captures · {pendingReviews.length}</h2>
      {pendingReviews.map((review) => (
        <div key={`${review.kind}:${review.id}`} className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-words text-xs">{review.title} · {review.status.replaceAll("_", " ")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="min-h-11 shrink-0"
              aria-label={`Review ${review.title}`}
              onClick={() => {
                if (review.kind === "document") select(review.id);
                else if (review.kind === "import") selectImport(review.id);
                else selectPhoto(review.id);
                navigate({ pathname: location.pathname, search: location.search, hash: "#assistant" }, {
                  replace: location.hash === "#assistant",
                  state: { assistantCapture: { kind: review.kind === "import" ? "items" : review.kind, id: review.id } },
                });
              }}>
              Review
            </Button>
            {canWrite && <Button size="sm" variant="ghost" className="min-h-11 shrink-0"
              aria-label={`Dismiss review ${review.title}`}
              disabled={reviewMutationPending}
              onClick={() => void dismissReview(review)}>Dismiss review</Button>}
          </div>
        </div>
      ))}
      {dismissedReviews.length > 0 && (
        <details className="text-xs">
          <summary className="min-h-11 cursor-pointer py-3">Dismissed reviews · {dismissedReviews.length}</summary>
          <p className="text-muted-foreground">Sources and history are kept. Undo restores the review; retry starts a new attempt.</p>
          {dismissedReviews.map((review) => (
            <div key={`${review.kind}:${review.id}`} className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 break-words">{review.title} · {review.status.replaceAll("_", " ")}</p>
              {canWrite && <div className="flex gap-2">
                <Button size="sm" variant="outline" className="min-h-11"
                  aria-label={`Undo dismissal ${review.title}`} disabled={reviewMutationPending}
                  onClick={() => void undoReview(review)}>Undo</Button>
                {review.retry && (
                  <Button size="sm" variant="outline" className="min-h-11"
                    aria-label={`Retry ${review.title}`} disabled={reviewMutationPending}
                    onClick={() => void retryReview(review)}>Retry</Button>
                )}
              </div>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
