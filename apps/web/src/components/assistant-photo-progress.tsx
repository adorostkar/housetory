import { Loader2, RotateCcw, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import type { AssistantCaptureState } from "@/lib/assistant-conversation";
import { useRecognition } from "@/lib/queries";
import type { AiRecognition, ImportBatchDetail } from "@/lib/types";

export function AssistantPhotoProgress({
  capture,
  onChange,
  onSelectImport,
}: {
  capture: AssistantCaptureState;
  onChange: (patch: Partial<AssistantCaptureState>) => void;
  onSelectImport: (id: string) => void;
}) {
  const recognition = useRecognition(capture.recognitionId);
  const status = recognition.data?.status;
  const createImport = React.useCallback(async () => {
    if (!capture.recognitionId || capture.importing || capture.importId) return;
    onChange({ importing: true, importError: undefined });
    try {
      const batch = await api.post<ImportBatchDetail>(
        `/imports/from-recognition/${capture.recognitionId}`,
      );
      onSelectImport(batch.id);
      onChange({ importId: batch.id, importing: false, file: undefined });
    } catch (error) {
      onChange({ importing: false, importError: getApiErrorMessage(error) });
    }
  }, [capture.importId, capture.importing, capture.recognitionId, onChange, onSelectImport]);

  React.useEffect(() => {
    if (status === "failed" && !capture.error) {
      onChange({ error: recognition.data?.error || "Photo recognition failed." });
    }
  }, [capture.error, onChange, recognition.data?.error, status]);

  React.useEffect(() => {
    if (status !== "succeeded" || capture.importId || capture.importing || capture.importError) return;
    void createImport();
  }, [
    capture.importError,
    capture.importId,
    capture.importing,
    createImport,
    status,
  ]);

  const retry = async () => {
    if (!capture.recognitionId || capture.importing) return;
    onChange({ error: undefined, importError: undefined });
    try {
      const updated = await api.post<AiRecognition>(
        `/ai/recognitions/${capture.recognitionId}/retry`,
      );
      if (updated.status === "queued" || updated.status === "processing") {
        await recognition.refetch();
      }
    } catch (error) {
      onChange({ error: getApiErrorMessage(error) });
    }
  };

  const cancel = async () => {
    if (!capture.recognitionId || capture.importId || capture.importing) return;
    try {
      await api.delete(`/ai/recognitions/${capture.recognitionId}`);
      onChange({
        recognitionId: undefined,
        file: undefined,
        error: "Photo processing was cancelled. Nothing was added.",
      });
    } catch (error) {
      onChange({ error: getApiErrorMessage(error) });
    }
  };

  if (capture.importId) return <p role="status" className="text-xs text-muted-foreground">Item proposal is ready to review below.</p>;
  if (capture.importing) {
    return <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Preparing item review…</p>;
  }
  if (capture.importError) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-xs text-destructive">{capture.importError}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void createImport()}>
          <RotateCcw /> Retry review
        </Button>
      </div>
    );
  }
  if (status === "failed" || capture.error) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-xs text-destructive">{capture.error || recognition.data?.error || "Photo recognition failed."}</p>
        {capture.recognitionId && (
          <Button type="button" size="sm" variant="outline" onClick={() => void retry()}>
            <RotateCcw /> Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {status === "processing" ? "Interpreting inventory photo…" : "Waiting to interpret inventory photo…"}
      </p>
      <Button type="button" size="sm" variant="ghost" onClick={() => void cancel()}>
        <X /> Cancel
      </Button>
    </div>
  );
}
