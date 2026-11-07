import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MapPin, Undo2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormError } from "@/components/form-field";
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
import { queryKeys } from "@/lib/queries";
import type {
  ActivityEvent,
  RestoreAssistedUndo,
  UndoResult,
} from "@/lib/types";
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
  "container.deleted": "destructive",
  "container.restored": "sage",
  "loan.created": "sage",
  "loan.returned": "sage",
  "loan.corrected": "brass",
  "loan.cancelled": "destructive",
  "borrowed.created": "brass",
  "borrowed.returned": "sage",
  "borrowed.corrected": "brass",
  "borrowed.cancelled": "destructive",
  "borrowed.photo_updated": "outline",
  "borrowed.photo_removed": "outline",
  "stocktake.quantity_corrected": "brass",
  "room.moved": "outline",
  "place.contents_moved": "brass",
  "place.contents_moved_and_deleted": "destructive",
  "room.contents_moved": "brass",
  "room.contents_moved_and_deleted": "destructive",
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
  "container.deleted": "Container deleted (recoverable)",
  "container.restored": "Container restored",
  "loan.created": "Lent",
  "loan.returned": "Returned",
  "loan.corrected": "Corrected",
  "loan.cancelled": "Cancelled",
  "borrowed.created": "Borrowed",
  "borrowed.returned": "Returned to owner",
  "borrowed.corrected": "Borrowed record corrected",
  "borrowed.cancelled": "Borrowed record cancelled",
  "borrowed.photo_updated": "Borrowed photo updated",
  "borrowed.photo_removed": "Borrowed photo removed",
  "stocktake.quantity_corrected": "Stocktake quantity corrected",
  "room.moved": "Room moved",
  "place.contents_moved": "Place contents moved",
  "place.contents_moved_and_deleted": "Place emptied and deleted",
  "room.contents_moved": "Room contents moved",
  "room.contents_moved_and_deleted": "Room emptied and deleted",
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

function restorePlaceLabel(
  roomName: string | null | undefined,
  locationName: string | null | undefined,
  identifier: string | null | undefined,
): string {
  const location = [identifier, locationName].filter(Boolean).join(" · ");
  return [roomName, location].filter(Boolean).join(" / ") || "No place";
}

function restoreContainerPath(preview: RestoreAssistedUndo): string {
  const container = preview.container;
  if (!container) return "Unknown container";
  return [
    container.property_name,
    container.room_name,
    container.parent_name,
    [container.identifier, container.name].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join(" / ");
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
  const [restoreTarget, setRestoreTarget] = React.useState<{
    event: ActivityEvent;
    requestId: string;
    preview: RestoreAssistedUndo | null;
    loading: boolean;
    error: string | null;
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

  const restore = useMutation({
    mutationFn: () =>
      api.post<UndoResult>(
        `/history/${restoreTarget?.event.id}/restore-undo`,
        { request_id: restoreTarget?.requestId },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.loans });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      void queryClient.invalidateQueries({ queryKey: ["item"] });
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      void queryClient.invalidateQueries({ queryKey: ["container"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      onChanged?.();
      toast.success(result.message);
      setRestoreTarget(null);
    },
  });

  const openRestore = (event: ActivityEvent) => {
    setRestoreTarget({
      event,
      requestId: crypto.randomUUID(),
      preview: event.restore_assisted ?? null,
      loading: true,
      error: null,
    });
    void api
      .get<RestoreAssistedUndo>(`/history/${event.id}/restore-preview`)
      .then((preview) => {
        setRestoreTarget((current) =>
          current?.event.id === event.id
            ? { ...current, preview, loading: false }
            : current,
        );
      })
      .catch((error) => {
        setRestoreTarget((current) =>
          current?.event.id === event.id
            ? {
                ...current,
                loading: false,
                error: getApiErrorMessage(error),
              }
            : current,
        );
      });
  };

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
          const restore = event.restore_assisted;
          const reasons = event.can_undo
            ? null
            : restore
              ? restore.reason
              : event.undo_blocked_reason && UNDOABLE_ACTIONS.has(event.action)
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
                    {restore ? "Restore unavailable" : "Undo unavailable"}: {reasons}
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
              {event.restore_assisted?.available && (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => openRestore(event)}
                >
                  <Undo2 className="size-3.5" />
                  Restore container and undo move…
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

      <Dialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setRestoreTarget(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Restore container and undo one move?</DialogTitle>
            <DialogDescription>
              This recreates only the original container identity and returns one
              eligible item. It does not restore the container&apos;s other former
              contents or invent a missing hierarchy.
            </DialogDescription>
          </DialogHeader>

          {restoreTarget?.loading ? (
            <div className="flex items-center gap-2 py-6 text-[0.76rem] text-muted-foreground">
              <Spinner /> Checking current item and container state…
            </div>
          ) : restoreTarget?.error ? (
            <FormError message={restoreTarget.error} />
          ) : restoreTarget?.preview ? (
            <div className="space-y-3 text-[0.74rem]">
              {!restoreTarget.preview.available && (
                <p className="flex items-start gap-2 rounded-xl border border-brass/25 bg-brass-soft/35 px-3 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass" />
                  <span>
                    {restoreTarget.preview.reason ||
                      "This move cannot be restored safely."}
                  </span>
                </p>
              )}

              {restoreTarget.preview.container && (
                <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
                  <p className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    Container identity to restore
                  </p>
                  <p className="mt-1 font-medium">
                    {restoreTarget.preview.container.identifier ||
                      restoreTarget.preview.container.name ||
                      "Deleted container"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {restoreContainerPath(restoreTarget.preview)}
                  </p>
                  {restoreTarget.preview.container.deleted_by_name && (
                    <p className="mt-1 text-[0.68rem] text-muted-foreground">
                      Deleted by {restoreTarget.preview.container.deleted_by_name}
                    </p>
                  )}
                </div>
              )}

              {restoreTarget.preview.item && (
                <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
                  <p className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    One item returned
                  </p>
                  <p className="mt-1 font-medium">
                    {restoreTarget.preview.item.name}
                    {restoreTarget.preview.item.quantity > 1
                      ? ` ×${restoreTarget.preview.item.quantity}`
                      : ""}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {restorePlaceLabel(
                      restoreTarget.preview.item.current_room_name,
                      restoreTarget.preview.item.current_location_name,
                      restoreTarget.preview.item.current_location_identifier,
                    )}{" "}
                    <span aria-hidden>→</span>{" "}
                    {restorePlaceLabel(
                      restoreTarget.preview.item.target_room_name,
                      restoreTarget.preview.item.target_location_name,
                      restoreTarget.preview.item.target_location_identifier,
                    )}
                  </p>
                </div>
              )}

              <p className="rounded-xl border border-border/60 bg-background/35 px-3 py-2.5 text-[0.7rem] leading-relaxed text-muted-foreground">
                Only this item move is reversed. The original container keeps its
                identity and QR identifier, no duplicate is created, and a newer
                item placement is never overwritten without this confirmation.
              </p>

              {restoreTarget.preview.legacy_unrecoverable && (
                <p className="rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5 text-[0.7rem] leading-relaxed text-destructive">
                  This place predates recoverable deletion metadata. Housetory will
                  not fabricate its identity or room from incomplete history.
                </p>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRestoreTarget(null)}
              disabled={restore.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                restore.isPending ||
                restoreTarget?.loading ||
                !restoreTarget?.preview?.available
              }
              onClick={async () => {
                try {
                  await restore.mutateAsync();
                } catch (error) {
                  toast.error(getApiErrorMessage(error));
                }
              }}
            >
              {restore.isPending ? <Spinner /> : <Undo2 />}
              {restore.isPending ? "Restoring…" : "Restore and undo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
