import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MapPin, Undo2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { ActivityEvent, UndoResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const UNDOABLE_ACTIONS = new Set([
  "item.moved",
  "container.moved",
  "loan.created",
  "loan.returned",
]);

const ACTION_TONE: Record<
  string,
  "sage" | "brass" | "outline" | "secondary" | "destructive"
> = {
  "item.moved": "outline",
  "container.moved": "outline",
  "loan.created": "sage",
  "loan.returned": "sage",
  "loan.corrected": "brass",
  "loan.cancelled": "destructive",
  "stocktake.quantity_corrected": "brass",
  "item.move_undone": "secondary",
  "container.move_undone": "secondary",
  "loan.creation_undone": "secondary",
  "loan.return_undone": "secondary",
};

const ACTION_LABELS: Record<string, string> = {
  "item.moved": "Item moved",
  "items.bulk_moved": "Bulk move",
  "items.bulk_tagged": "Bulk tag update",
  "items.bulk_categorised": "Bulk category update",
  "container.moved": "Container moved",
  "loan.created": "Lent",
  "loan.returned": "Returned",
  "loan.corrected": "Corrected",
  "loan.cancelled": "Cancelled",
  "stocktake.quantity_corrected": "Stocktake quantity corrected",
  "item.move_undone": "Move undone",
  "container.move_undone": "Move undone",
  "loan.creation_undone": "Loan undone",
  "loan.return_undone": "Return undone",
};

function timestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function placeLabel(place: unknown): string | null {
  if (!place || typeof place !== "object") return null;
  const record = place as Record<string, unknown>;
  const location = typeof record.location_name === "string" ? record.location_name : null;
  const room = typeof record.room_name === "string" ? record.room_name : null;
  if (location && room) return `${room} / ${location}`;
  return location ?? room;
}

function batchContext(event: ActivityEvent): Record<string, unknown> | null {
  const batch = (event.details as Record<string, unknown> | undefined)?.batch;
  if (!batch || typeof batch !== "object") return null;
  const record = batch as Record<string, unknown>;
  return typeof record.batch_id === "string" ? record : null;
}

export function ActivityTimeline({
  events,
  emptyText = "No history recorded yet.",
  onChanged,
  compact = false,
}: {
  events: ActivityEvent[];
  emptyText?: string;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [undoTarget, setUndoTarget] = React.useState<{
    event: ActivityEvent;
    requestId: string;
  } | null>(null);

  const undo = useMutation({
    mutationFn: () =>
      api.post<UndoResult>(`/history/${undoTarget?.event.id}/undo`, {
        request_id: undoTarget?.requestId,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.loans });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      void queryClient.invalidateQueries({ queryKey: ["item"] });
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      void queryClient.invalidateQueries({ queryKey: ["container"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      onChanged?.();
      toast.success(result.message);
      setUndoTarget(null);
    },
  });

  if (events.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-[0.76rem] leading-relaxed text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  return (
    <>
      <ol className={cn("space-y-3", compact && "space-y-2")}>
        {events.map((event) => {
          const from = placeLabel(
            (event.details as Record<string, unknown>)?.from,
          );
          const to = placeLabel((event.details as Record<string, unknown>)?.to);
          const batch = batchContext(event);
          const reasons = event.can_undo
            ? null
            : event.undo_blocked_reason &&
              UNDOABLE_ACTIONS.has(event.action)
              ? event.undo_blocked_reason
              : null;
          return (
            <li
              key={event.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/30 px-3.5 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={ACTION_TONE[event.action] ?? "outline"}>
                    {ACTION_LABELS[event.action] ?? event.action.replaceAll(".", " ")}
                  </Badge>
                  <p className="text-[0.78rem] font-medium">{event.summary}</p>
                </div>
                {(from || to) && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[0.7rem] text-muted-foreground">
                    <MapPin className="size-3" />
                    {from ?? "No place"} <span aria-hidden>→</span> {to ?? "No place"}
                  </p>
                )}
                {batch && (
                  <p className="mt-1 text-[0.66rem] text-muted-foreground">
                    Part of a bulk move ·{" "}
                    {typeof batch.batch_item_count === "number"
                      ? batch.batch_item_count
                      : "?"}{" "}
                    item(s),{" "}
                    {typeof batch.batch_unit_count === "number"
                      ? batch.batch_unit_count
                      : "?"}{" "}
                    unit(s) selected
                  </p>
                )}
                <p className="mt-1 text-[0.66rem] text-muted-foreground">
                  {event.actor_name} · {timestamp(event.created_at)}
                  {event.undoes_event_id ? " · compensating event" : ""}
                </p>
                {reasons && (
                  <p className="mt-1 flex items-start gap-1 text-[0.66rem] text-brass">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    Undo unavailable: {reasons}
                  </p>
                )}
              </div>
              {event.can_undo && (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    setUndoTarget({
                      event,
                      requestId: crypto.randomUUID(),
                    })
                  }
                >
                  <Undo2 className="size-3.5" />
                  Undo
                </Button>
              )}
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={undoTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUndoTarget(null);
        }}
        title="Undo this action?"
        description={
          undoTarget
            ? `${undoTarget.event.summary}. Housetory will re-check permissions and the current item, container or loan state before creating a compensating history event.`
            : ""
        }
        confirmLabel="Undo safely"
        onConfirm={async () => {
          try {
            await undo.mutateAsync();
          } catch (error) {
            toast.error(getApiErrorMessage(error));
            throw error;
          }
        }}
      />
    </>
  );
}
