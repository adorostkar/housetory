import * as React from "react";

import { useImportBatch } from "@/lib/queries";
import { dispatchAssistantTaskCompletion } from "@/lib/assistant-task-events";
import { ImportDetailPage } from "@/pages/import-detail-page";

export function AssistantImportReview({
  id,
  enabled,
  notifyOnReady = false,
}: {
  id: string;
  enabled: boolean;
  notifyOnReady?: boolean;
}) {
  const batchQuery = useImportBatch(enabled ? id : undefined);
  const announced = React.useRef(false);
  const batch = batchQuery.data;
  React.useEffect(() => {
    if (!notifyOnReady || !batch || announced.current) return;
    if (batch.status !== "review" && batch.status !== "failed") return;
    announced.current = true;
    const ready = batch.status === "review";
    const count = batch.entry_count;
    dispatchAssistantTaskCompletion({
      id,
      kind: "import",
      title: ready ? "Items ready for review" : "Item capture needs attention",
      description: ready
        ? `${count} ${count === 1 ? "item is" : "items are"} ready to review.`
        : "Item capture finished with an issue. Review the details or retry.",
    });
  }, [batch, id, notifyOnReady]);

  if (!enabled) return null;
  return (
    <section className="surface max-h-[60vh] overflow-y-auto p-4 sm:p-5" aria-label="Assistant item review">
      <ImportDetailPage batchId={id} embedded />
    </section>
  );
}
