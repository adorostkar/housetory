import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Link } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useCanWrite } from "@/lib/queries";
import type { DocumentProcessing } from "@/lib/types";
import { cn } from "@/lib/utils";

const activeStages = new Set<DocumentProcessing["stage"]>(["waiting", "reading", "interpreting"]);
const stageLabels: Record<DocumentProcessing["stage"], string> = {
  waiting: "Waiting for processing",
  reading: "Reading document",
  interpreting: "Interpreting document",
  ready: "Ready to review",
  needs_attention: "Review needs attention",
  failed: "Processing failed",
  cancelled: "Processing cancelled",
};

export function DocumentProcessingStatus({ documentId, onManualReview }: {
  documentId: string;
  onManualReview: () => void;
}) {
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const key = [...queryKeys.document(documentId), "processing"];
  const processing = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<DocumentProcessing>(`/documents/${documentId}/processing`, { signal }),
    refetchInterval: (query) => query.state.data && !activeStages.has(query.state.data.stage) ? false : 1000,
    retry: false,
  });
  const action = useMutation({
    mutationFn: async (command: "cancel" | "retry") => {
      await client.cancelQueries({ queryKey: key, exact: true });
      return api.post<DocumentProcessing>(`/documents/${documentId}/processing/${command}`);
    },
    onSuccess: (snapshot) => {
      client.setQueryData(key, snapshot);
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId), exact: true });
      void client.invalidateQueries({ queryKey: [...queryKeys.document(documentId), "extraction"] });
    },
  });
  const snapshot = processing.data;
  const previous = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!snapshot) return;
    const identity = `${snapshot.correlation_id}:${snapshot.stage}`;
    if (previous.current !== identity) {
      previous.current = identity;
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId), exact: true });
      void client.invalidateQueries({ queryKey: [...queryKeys.document(documentId), "extraction"] });
    }
  }, [snapshot, client, documentId]);

  if (!snapshot) {
    return (
      <section className="surface p-4 text-xs text-muted-foreground" aria-label="Document processing">
        <p role="status">{processing.isError
          ? "Processing status is unavailable. Your original document is kept; manual entry is available."
          : "Checking document processing status…"}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {processing.isError && <Button size="sm" variant="outline"
            onClick={() => void processing.refetch()}>Refresh status</Button>}
          {canWrite && <Button size="sm" variant="ghost" asChild><Link to="/items/new">Enter items manually</Link></Button>}
        </div>
      </section>
    );
  }
  const active = activeStages.has(snapshot.stage);
  const seconds = Math.floor(snapshot.elapsed_ms / 1000);
  return (
    <section className={cn("surface space-y-3 p-4 sm:p-5",
      active && seconds >= 60 && "border-brass/40 bg-brass-soft/25")} aria-label="Document processing">
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {active && snapshot.worker_available !== false && <Spinner />}
          {snapshot.worker_available === false && active ? "Processing worker unavailable" : stageLabels[snapshot.stage]}
        </h2>
        <p className={cn("text-xs text-muted-foreground", active && seconds >= 60 && "font-medium text-brass")}>
          {snapshot.worker_available === false && active
            ? "No healthy worker is available. You can cancel or use manual entry."
            : active && seconds >= 60
              ? "This is taking longer than expected. Use local/manual review now or cancel processing."
              : active && seconds >= 15
                ? "This stage is taking longer than usual. No completion estimate is available."
                : active ? "This page follows actual processing stages; no changes are saved automatically."
                  : "Review before applying. Your original file is preserved."}
        </p>
        {snapshot.reason && <p className="break-words text-xs text-muted-foreground">Reason: {snapshot.reason.replaceAll("_", " ")}</p>}
      </div>
      {active && <p aria-live="off" className="text-2xs tabular-nums text-muted-foreground">{seconds}s elapsed</p>}
      {processing.isError && <p role="alert" className="text-xs text-brass">Status updates interrupted. The last known state is shown.</p>}
      {action.error && <FormError message={getApiErrorMessage(action.error)} />}
      <div className="flex flex-wrap gap-2">
        {snapshot.local_available && (
          <Button size="sm" variant="outline" onClick={onManualReview}>Use local/manual review now</Button>
        )}
        {canWrite && snapshot.can_cancel && (
          <Button size="sm" variant="outline" disabled={action.isPending}
            onClick={() => action.mutate("cancel")}>Cancel processing</Button>
        )}
        {canWrite && snapshot.can_retry && (
          <Button size="sm" variant="outline" disabled={action.isPending}
            onClick={() => action.mutate("retry")}>Retry processing</Button>
        )}
        {canWrite && <Button size="sm" variant="ghost" asChild><Link to="/items/new">Enter items manually</Link></Button>}
      </div>
      {active && <p className="text-2xs text-muted-foreground">Cancellation keeps the file and available local evidence. It does not undo saved changes or promise to stop provider charges.</p>}
    </section>
  );
}
