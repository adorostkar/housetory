import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import { useCanWrite, usePendingActions } from "@/lib/queries";

const ACTION_LABELS: Record<string, string> = {
  edit_item: "Edit", move_items: "Move", lend: "Lend", borrow: "Borrow",
  return_loan: "Return", return_borrowed: "Return",
};

function PreparedActions() {
  const actions = usePendingActions().data ?? [];
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  if (!actions.length) return null;
  return (
    <section aria-label="Prepared actions" className="surface space-y-2 p-3">
      <h2 className="text-sm font-medium">Prepared actions · {actions.length}</h2>
      {actions.map((action) => {
        const title = `${ACTION_LABELS[action.kind] ?? "Change"}: ${action.targets.map((target) => target.name).join(", ")}`;
        return (
          <div key={action.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 break-words text-xs">{title}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="min-h-11 shrink-0"
                aria-label={`Review ${title}`}
                onClick={() => navigate(
                  { pathname: location.pathname, search: location.search, hash: "#assistant" },
                  { replace: location.hash === "#assistant", state: { assistantCapture: { kind: "action", id: action.id } } },
                )}>Review</Button>
              <Button size="sm" variant="ghost" className="min-h-11 shrink-0"
                aria-label={`Cancel ${title}`}
                onClick={() => void api.post(`/assistant/actions/proposals/${action.id}/cancel`)
                  .then(() => {
                    toast.success("Prepared action cancelled. Nothing was changed.");
                    void queryClient.invalidateQueries({ queryKey: ["assistant-pending-actions"] });
                    void queryClient.invalidateQueries({ queryKey: ["assistant-runs"] });
                  })
                  .catch((error: unknown) => toast.error(getApiErrorMessage(error)))}>Cancel</Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function CaptureReviewQueue() {
  return <div className="mb-3 space-y-3 empty:hidden"><PreparedActions /><PendingCaptures /></div>;
}

function PendingCaptures() {
  const {
    pendingReviews, dismissedReviews, reviewsError, select, selectImport, selectPhoto,
    dismissReview, undoReview, retryReview, reviewMutationPending,
  } = useAssistantDocuments();
  const location = useLocation();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  if (reviewsError) return <p role="alert" className="text-xs">Pending captures could not be loaded. Refresh or retry when online.</p>;
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
