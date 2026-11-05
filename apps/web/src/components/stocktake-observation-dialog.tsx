import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, MapPin } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useRooms, useLocations } from "@/lib/queries";
import type { StocktakeItem, StocktakeObservationStatus } from "@/lib/types";
import { flattenLocations, flattenRoomTree, pluralize } from "@/lib/utils";

export type ItemObservationStatus = Exclude<StocktakeObservationStatus, "unexpected">;

const ACTION_LABELS: Record<ItemObservationStatus, string> = {
  present: "Present",
  missing: "Missing",
  moved: "Moved",
  quantity_discrepancy: "Quantity differs",
  unknown: "Couldn't check",
};

const TITLES: Record<ItemObservationStatus, string> = {
  present: "Mark as present",
  missing: "Mark as missing",
  moved: "Record a move",
  quantity_discrepancy: "Record a quantity discrepancy",
  unknown: "Record as not checked",
};

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StocktakeObservationDialog({
  open,
  onOpenChange,
  sessionId,
  row,
  status,
  onSaved,
  onStale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  row: StocktakeItem;
  status: ItemObservationStatus;
  onSaved: () => void;
  onStale: () => void;
}) {
  const queryClient = useQueryClient();
  const roomsQuery = useRooms();
  const [counted, setCounted] = React.useState("");
  const [roomId, setRoomId] = React.useState("");
  const [containerId, setContainerId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());

  const atHome = row.current.at_home_quantity;
  const onLoan = row.current.on_loan_quantity;
  const owned = row.current.quantity ?? row.expected_quantity;
  const rooms = React.useMemo(
    () => flattenRoomTree(roomsQuery.data?.items ?? []),
    [roomsQuery.data?.items],
  );
  const locationsQuery = useLocations(roomId || undefined);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setNotes("");
    setRoomId("");
    setContainerId("");
    requestId.current = newRequestId();
    if (status === "present" || status === "moved") {
      setCounted(String(atHome));
    } else if (status === "quantity_discrepancy") {
      setCounted(String(Math.max(0, atHome - 1)));
    } else {
      setCounted("0");
    }
  }, [open, status, atHome]);

  React.useEffect(() => {
    setContainerId("");
  }, [roomId]);

  const countedNumber = Number.parseInt(counted, 10);
  let localError: string | null = null;
  if (status === "present" && countedNumber !== atHome) {
    localError = `Present means all ${pluralize(atHome, "at-home unit")} were counted. Use Quantity differs for another number.`;
  }
  if (status === "quantity_discrepancy" && countedNumber === atHome) {
    localError = "The counted quantity matches the expected at-home quantity. Use Present instead.";
  }
  if (status === "moved" && !roomId) {
    localError = "Choose the existing room where the item was found.";
  }
  if (status !== "unknown" && (!Number.isFinite(countedNumber) || countedNumber < 0)) {
    localError = "Enter a counted quantity of zero or more.";
  }

  const submit = async () => {
    setError(null);
    if (localError) {
      setError(localError);
      return;
    }
    setPending(true);
    try {
      await api.post(`/stocktake/sessions/${sessionId}/observations`, {
        request_id: requestId.current,
        status,
        snapshot_item_id: row.snapshot_item_id,
        counted_quantity: status === "unknown" ? null : countedNumber,
        room_id: status === "moved" ? roomId : null,
        container_id: status === "moved" && containerId ? containerId : null,
        notes: notes.trim() || null,
        expected_item_updated_at: row.current.updated_at,
        expected_on_loan_quantity: onLoan,
      });
      requestId.current = newRequestId();
      await queryClient.invalidateQueries({ queryKey: ["stocktake"] });
      toast.success(`${row.item_name}: ${ACTION_LABELS[status].toLowerCase()} saved`);
      onSaved();
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiError && ["item_changed", "loans_changed", "item_deleted"].includes(caught.code)) {
        setError(caught.message);
        onStale();
        return;
      }
      setError(getApiErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const locationOptions = React.useMemo(
    () =>
      flattenLocations(
        (locationsQuery.data?.items ?? []).filter(
          (location) => location.room_id === roomId,
        ),
      ),
    [locationsQuery.data?.items, roomId],
  );
  const isMissing = status === "missing";
  const isMoved = status === "moved";
  const countedLocked = status === "unknown" || isMissing;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLES[status]}</DialogTitle>
          <DialogDescription className="break-words">
            {row.item_name} · expected {pluralize(row.expected_at_home_quantity, "at-home unit")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/65 bg-secondary/20 px-3 py-2.5 text-[0.72rem]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">Owned {owned}</span>
              <span className="text-muted-foreground">·</span>
              <span>At home {atHome}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-brass">On loan {onLoan}</span>
              {onLoan > 0 && <Badge variant="brass">Loans excluded</Badge>}
            </div>
            <p className="mt-1.5 flex items-start gap-1.5 text-[0.66rem] leading-relaxed text-muted-foreground">
              <MapPin className="mt-0.5 size-3 shrink-0" />
              <span className="break-words">{row.current.location_path || "No location recorded"}</span>
            </p>
            {onLoan > 0 && (
              <p className="mt-1.5 text-[0.66rem] leading-relaxed text-muted-foreground">
                Loaned units remain owned. They are not expected at home and will not be marked
                missing.
              </p>
            )}
          </div>

          {isMissing && (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/[0.06] px-3 py-2.5 text-[0.72rem] leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This records an observation only. The item will not be deleted, archived or written
              off. You can review any inventory change separately.
            </p>
          )}

          {!countedLocked && (
            <label className="block text-[0.74rem] font-medium" htmlFor="stocktake-counted">
              Counted at home
              <Input
                id="stocktake-counted"
                type="number"
                min="0"
                inputMode="numeric"
                value={counted}
                onChange={(event) => setCounted(event.target.value)}
                className="mt-1.5"
              />
            </label>
          )}

          {isMoved && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[0.74rem] font-medium" htmlFor="stocktake-room">
                Existing room
                <Select
                  id="stocktake-room"
                  className="mt-1.5"
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                >
                  <option value="">Choose a room</option>
                  {rooms.map(({ room, depth }) => (
                    <option key={room.id} value={room.id}>
                      {"\u00a0".repeat(depth * 2)}
                      {room.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-[0.74rem] font-medium" htmlFor="stocktake-container">
                Existing place (optional)
                <Select
                  id="stocktake-container"
                  className="mt-1.5"
                  value={containerId}
                  onChange={(event) => setContainerId(event.target.value)}
                  disabled={!roomId || locationsQuery.isPending}
                >
                  <option value="">Room only</option>
                  {locationOptions.map(({ location, depth }) => (
                    <option key={location.id} value={location.id}>
                      {"\u00a0".repeat(depth * 2)}
                      {location.identifier
                        ? `${location.identifier} · ${location.name}`
                        : location.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}

          {isMoved && roomId && (
            <p className="flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
              <ArrowRight className="size-3" />
              The recorded location changes only after you review and apply corrections.
            </p>
          )}

          <label className="block text-[0.74rem] font-medium" htmlFor="stocktake-notes">
            Notes (optional)
            <Textarea
              id="stocktake-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={2}
              className="mt-1.5"
              placeholder={
                status === "missing"
                  ? "Where you looked, or what you know."
                  : "Condition, packaging or other evidence."
              }
            />
          </label>

          {row.item_id && (
            <Link
              to={`/items/${row.item_id}`}
              className="inline-flex text-[0.7rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View item details and evidence
            </Link>
          )}

          {(error || localError) && <FormError message={error ?? localError ?? ""} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || Boolean(localError)}>
            {pending ? <Spinner /> : null}
            Save {ACTION_LABELS[status].toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
