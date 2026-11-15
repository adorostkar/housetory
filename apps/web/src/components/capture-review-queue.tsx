import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import { useCanWrite } from "@/lib/queries";

export function CaptureReviewQueue() {
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
                if (location.hash !== "#assistant") navigate({ pathname: location.pathname, search: location.search, hash: "#assistant" });
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
