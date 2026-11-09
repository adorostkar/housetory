import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ImagePlus,
  Loader2,
  Search,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

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
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory } from "@/lib/queries";
import type { ItemImageBatchJob, ItemImageBatchPreview, ItemSummary } from "@/lib/types";
import { pluralize } from "@/lib/utils";

function newRequestId() {
  return crypto.randomUUID();
}

function terminal(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

export function BulkImagesDialog({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemSummary[];
}) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const invalidateRef = React.useRef(invalidate);
  invalidateRef.current = invalidate;
  const action = "reference" as const;
  const [job, setJob] = React.useState<ItemImageBatchJob | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());
  const itemIds = items.map((item) => item.id);

  React.useEffect(() => {
    if (!open) return;
    setJob(null);
    setError(null);
    requestId.current = newRequestId();
  }, [open]);

  const previewQuery = useQuery({
    queryKey: ["items", "images", "batch-preview", itemIds, action],
    queryFn: () =>
      api.post<ItemImageBatchPreview>("/items/images/batch/preview", {
        item_ids: itemIds,
        action,
      }),
    enabled: open && itemIds.length > 0,
    staleTime: 0,
    retry: false,
  });
  const preview = previewQuery.data;

  const create = useMutation({
    mutationFn: () =>
      api.post<ItemImageBatchJob>("/items/images/batch", {
        item_ids: itemIds,
        action,
        request_id: requestId.current,
      }),
    onSuccess: (created) => {
      setJob(created);
      toast.success("Image batch queued");
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const jobQuery = useQuery({
    queryKey: ["items", "images", "batch-job", job?.job_id ?? ""],
    queryFn: () => api.get<ItemImageBatchJob>(`/items/images/batch/${job?.job_id}`),
    enabled: Boolean(job && !terminal(job.status)),
    refetchInterval: (query) => {
      const current = query.state.data as ItemImageBatchJob | undefined;
      return current && terminal(current.status) ? false : 1500;
    },
  });
  const current =
    job && terminal(job.status) ? job : (jobQuery.data ?? job);

  const currentStatus = current?.status;
  React.useEffect(() => {
    if (!currentStatus || !terminal(currentStatus)) return;
    invalidateRef.current();
    void queryClient.invalidateQueries({ queryKey: queryKeys.items });
    void queryClient.invalidateQueries({ queryKey: ["item"] });
  }, [currentStatus, queryClient]);

  const cancel = useMutation({
    mutationFn: () =>
      api.post<ItemImageBatchJob>(`/items/images/batch/${current?.job_id}/cancel`),
    onSuccess: (cancelled) => {
      setJob(cancelled);
      toast.success("Image batch cancelled");
    },
    onError: (caught) => toast.error(getApiErrorMessage(caught)),
  });

  const progress =
    current && current.total > 0
      ? Math.min(
          100,
          Math.round(
            ((current.completed + current.failed + current.skipped) / current.total) * 100,
          ),
        )
      : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Find images for selected items</DialogTitle>
          <DialogDescription>
            Explicit batch action over {pluralize(items.length, "selected item")}. Real
            photos always take priority; existing items are never changed on a timer or in
            the background.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/65 bg-background/40 px-3.5 py-3 text-xs">
            <Search className="mb-1.5 size-4" />
            <span className="block font-medium">Find reference images</span>
            <span className="mt-0.5 block text-2xs text-muted-foreground">
              Automatic public-web lookup; no AI generation.
            </span>
          </div>

          {previewQuery.isPending ? (
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Checking eligible items…
            </div>
          ) : previewQuery.isError ? (
            <p className="rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3 py-2 text-2xs text-destructive">
              {getApiErrorMessage(previewQuery.error)}
            </p>
          ) : preview ? (
            <div className="rounded-xl border border-border/65 bg-background/35 p-3.5 text-2xs">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Eligible" value={preview.eligible_count} />
                <Metric label="Has a real photo" value={preview.skipped_has_photo} />
                <Metric label="Unavailable" value={preview.skipped_unavailable} />
              </div>
              {preview.notices.length > 0 && (
                <ul className="mt-2 space-y-1 text-2xs leading-relaxed text-muted-foreground">
                  {preview.notices.map((notice) => (
                    <li key={notice} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-brass" />
                      {notice}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {current && (
            <div className="rounded-xl border border-border/65 bg-background/35 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-2xs">
                <span className="font-medium">
                  {current.status === "cancelled"
                    ? "Cancelled"
                    : current.status === "queued"
                      ? "Queued"
                      : current.status === "running"
                        ? "Running"
                        : current.status === "failed"
                          ? "Finished with errors"
                          : "Complete"}
                </span>
                <Badge variant="outline">
                  {current.completed} done · {current.failed} failed · {current.skipped} skipped
                </Badge>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-sage transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {current.error && (
                <p className="mt-2 text-2xs text-destructive">{current.error}</p>
              )}
            </div>
          )}
          {error && <p className="text-2xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            <X />
            Close
          </Button>
          {current && !terminal(current.status) ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? <Spinner /> : <X />}
              Cancel batch
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !preview ||
                preview.eligible_count === 0 ||
                Boolean(current && !terminal(current.status))
              }
            >
              {create.isPending ? <Spinner /> : <ImagePlus />}
              Start batch
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 tabular-nums">{value}</p>
    </div>
  );
}
