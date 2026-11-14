import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAssistantDocuments } from "@/lib/assistant-documents";

export function CaptureReviewQueue() {
  const { pendingReviews, reviewsError, select, selectImport, selectPhoto } = useAssistantDocuments();
  const location = useLocation();
  const navigate = useNavigate();
  if (reviewsError) return <p role="alert" className="text-xs">Pending captures could not be loaded. Refresh or retry when online.</p>;
  if (!pendingReviews.length) return null;
  return (
    <section aria-label="Pending captures" className="surface space-y-2 p-3">
      <h2 className="text-sm font-medium">Pending captures · {pendingReviews.length}</h2>
      {pendingReviews.map((review) => (
        <div key={`${review.kind}:${review.id}`} className="flex items-center justify-between gap-2">
          <p className="min-w-0 break-words text-xs">{review.title} · {review.status.replaceAll("_", " ")}</p>
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
        </div>
      ))}
    </section>
  );
}
