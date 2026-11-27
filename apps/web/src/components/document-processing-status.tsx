import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Link } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useCanWrite } from "@/lib/queries";
import type { DocumentProcessing, DocumentType } from "@/lib/types";
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

// A manual has no purchase review, so its finished states do not ask for one.
const manualStageLabels: Partial<Record<DocumentProcessing["stage"], string>> = {
  ready: "Saved and read",
  needs_attention: "Saved. Some pages could not be read",
};

export function DocumentProcessingStatus({
  documentId, onManualReview, onTaskComplete, enabled = true, compact = false, documentType,
}: {
  documentId: string;
  onManualReview: () => void;
  onTaskComplete?: (snapshot: DocumentProcessing) => void;
  enabled?: boolean;
  /** A short status line with Cancel and Retry only, for use inside another surface. */
  compact?: boolean;
  documentType?: DocumentType;
}) {
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const key = [...queryKeys.document(documentId), "processing"];
  const processing = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<DocumentProcessing>(`/documents/${documentId}/processing`, { signal }),
    enabled,
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
  const announcedCorrelation = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!snapshot) return;
    const identity = `${snapshot.correlation_id}:${snapshot.stage}`;
    if (previous.current !== identity) {
      previous.current = identity;
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId), exact: true });
      void client.invalidateQueries({ queryKey: [...queryKeys.document(documentId), "extraction"] });
    }
  }, [snapshot, client, documentId]);
  React.useEffect(() => {
    if (!snapshot || !onTaskComplete || activeStages.has(snapshot.stage)) return;
    if (announcedCorrelation.current === snapshot.correlation_id) return;
    announcedCorrelation.current = snapshot.correlation_id;
    onTaskComplete(snapshot);
  }, [onTaskComplete, snapshot?.correlation_id, snapshot?.stage]);

  const manual = documentType === "manual";
  if (!snapshot && compact) {
    return (
      <p role="status" className="text-xs text-muted-foreground" aria-label="Document processing">
        {processing.isError
          ? "The reading status cannot be loaded. Your original file is kept."
          : "Checking the reading status…"}
      </p>
    );
  }
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
  const label = snapshot.worker_available === false && active
    ? "Processing worker unavailable"
    : (manual ? manualStageLabels[snapshot.stage] : undefined) ?? stageLabels[snapshot.stage];
  if (compact) {
    return (
      <div className="space-y-2" aria-label="Document processing">
        <p role="status" aria-live="polite" aria-atomic="true"
          className="flex flex-wrap items-center gap-2 text-xs">
          {active && snapshot.worker_available !== false && <Spinner />}
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground">
            {snapshot.stage === "failed" || snapshot.stage === "cancelled"
              ? "Your original file is kept and can be opened."
              : active && seconds >= 15
                ? "This takes longer than usual. You can close this; reading goes on."
                : active ? "You can close this; reading goes on." : "Your original file is kept."}
          </span>
        </p>
        {action.error && <FormError message={getApiErrorMessage(action.error)} />}
        {canWrite && (snapshot.can_cancel || snapshot.can_retry) && (
          <div className="flex flex-wrap gap-2">
            {snapshot.can_cancel && (
              <Button size="sm" variant="outline" className="min-h-11" disabled={action.isPending}
                onClick={() => action.mutate("cancel")}>Cancel processing</Button>
            )}
            {snapshot.can_retry && (
              <Button size="sm" variant="outline" className="min-h-11" disabled={action.isPending}
                onClick={() => action.mutate("retry")}>Retry processing</Button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <section className={cn("surface space-y-3 p-4 sm:p-5",
      active && seconds >= 60 && "border-brass/40 bg-brass-soft/25")} aria-label="Document processing">
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {active && snapshot.worker_available !== false && <Spinner />}
          {label}
        </h2>
        <p className={cn("text-xs text-muted-foreground", active && seconds >= 60 && "font-medium text-brass")}>
          {snapshot.worker_available === false && active
            ? "No healthy worker is available. You can cancel or use manual entry."
            : active && seconds >= 60
              ? "This is taking longer than expected. Use local/manual review now or cancel processing."
              : active && seconds >= 15
                ? "This stage is taking longer than usual. No completion estimate is available."
                : active ? "This page follows actual processing stages; no changes are saved automatically."
                  : manual ? "Your original file is preserved. Nothing else needs to be done."
                    : "Review before applying. Your original file is preserved."}
        </p>
        {snapshot.reason && <p className="break-words text-xs text-muted-foreground">Reason: {snapshot.reason.replaceAll("_", " ")}</p>}
      </div>
      {active && <p aria-live="off" className="text-2xs tabular-nums text-muted-foreground">{seconds}s elapsed</p>}
      {processing.isError && <p role="alert" className="text-xs text-brass">Status updates interrupted. The last known state is shown.</p>}
      {action.error && <FormError message={getApiErrorMessage(action.error)} />}
      <div className="flex flex-wrap gap-2">
        {snapshot.local_available && !manual && (
          <Button size="sm" variant="outline" onClick={onManualReview}
            className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 coarse:h-auto coarse:min-h-11">Use local/manual review now</Button>
        )}
        {canWrite && snapshot.can_cancel && (
          <Button size="sm" variant="outline" disabled={action.isPending}
            onClick={() => action.mutate("cancel")}>Cancel processing</Button>
        )}
        {canWrite && snapshot.can_retry && (
          <Button size="sm" variant="outline" disabled={action.isPending}
            onClick={() => action.mutate("retry")}>Retry processing</Button>
        )}
        {canWrite && !manual && <Button size="sm" variant="ghost" asChild><Link to="/items/new">Enter items manually</Link></Button>}
      </div>
      {active && <p className="text-2xs text-muted-foreground">Cancellation keeps the file and available local evidence. It does not undo saved changes or promise to stop provider charges.</p>}
    </section>
  );
}
