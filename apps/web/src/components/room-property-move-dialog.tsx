import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, MoveRight } from "lucide-react";
import * as React from "react";
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
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory, useProperties } from "@/lib/queries";
import type { Room, RoomPropertyMoveResponse } from "@/lib/types";
import { pluralize } from "@/lib/utils";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function RoomPropertyMoveDialog({
  open,
  onOpenChange,
  room,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: Room;
}) {
  const propertiesQuery = useProperties();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const properties = propertiesQuery.data?.items ?? [];
  const destinationOptions = properties.filter(
    (property) => property.id !== room.property_id,
  );
  const [destinationId, setDestinationId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const requestId = React.useRef(newRequestId());

  React.useEffect(() => {
    if (!open) return;
    setDestinationId(destinationOptions[0]?.id ?? "");
    setError(null);
    requestId.current = newRequestId();
    // Only reset when the dialog opens or the room changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, room.id]);

  const previewQuery = useQuery({
    queryKey: ["rooms", room.id, "property-move", destinationId],
    queryFn: () =>
      api.get<RoomPropertyMoveResponse["preview"]>(
        `/rooms/${room.id}/property-move/preview?property_id=${destinationId}`,
      ),
    enabled: open && Boolean(destinationId),
    retry: false,
    staleTime: 0,
  });
  const preview = previewQuery.data;

  const move = useMutation({
    mutationFn: () =>
      api.post<RoomPropertyMoveResponse>(`/rooms/${room.id}/property-move`, {
        property_id: destinationId,
        preview_fingerprint: preview?.fingerprint,
        request_id: requestId.current,
      }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.properties });
      void queryClient.invalidateQueries({ queryKey: ["stocktake"] });
      toast.success("Room subtree moved to the selected property");
      onOpenChange(false);
    },
    onError: (caught) => {
      setError(getApiErrorMessage(caught));
      void previewQuery.refetch();
    },
  });

  const submit = async () => {
    setError(null);
    if (!preview?.can_move) {
      setError(preview?.warning ?? "This room cannot move to that property.");
      return;
    }
    setPending(true);
    try {
      await move.mutateAsync();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move room to another property</DialogTitle>
          <DialogDescription>
            The whole top-level room subtree moves together. Item, room, container, photo and
            document IDs stay unchanged; QR links keep pointing to the same records.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/65 bg-secondary/20 px-3 py-2.5 text-[0.74rem]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{room.name}</span>
              <Badge variant="outline">
                {room.property?.name ?? "Current property"}
              </Badge>
              <MoveRight className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">
                {preview?.destination_property.name ?? "Choose destination"}
              </span>
            </div>
          </div>

          <label className="block text-[0.74rem] font-medium" htmlFor="room-property-destination">
            Destination property
            <Select
              id="room-property-destination"
              className="mt-1.5"
              value={destinationId}
              onChange={(event) => setDestinationId(event.target.value)}
              disabled={destinationOptions.length === 0}
            >
              {destinationOptions.length === 0 && (
                <option value="">No other active property</option>
              )}
              {destinationOptions.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </label>

          {previewQuery.isPending ? (
            <div className="flex items-center gap-2 text-[0.74rem] text-muted-foreground">
              <Spinner />
              Calculating the affected subtree…
            </div>
          ) : preview ? (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/65 px-3 py-3 text-[0.74rem] sm:grid-cols-4">
              <Metric label="Rooms" value={preview.descendant_room_count} />
              <Metric label="Places" value={preview.descendant_container_count} />
              <Metric label="Items" value={preview.item_count} />
              <Metric label="On loan" value={preview.on_loan_quantity} tone="brass" />
            </div>
          ) : null}

          {preview && preview.item_count > 0 && (
            <p className="rounded-xl border border-brass/20 bg-brass-soft/25 px-3 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
              {pluralize(preview.total_quantity, "owned unit")} move with this subtree.{" "}
              {preview.on_loan_quantity > 0
                ? `${preview.on_loan_quantity} unit(s) remain on loan; moving the usual home does not return borrowed stock.`
                : "No units are on loan."}{" "}
              Existing item last-checked dates will show as changed because the property path changed.
            </p>
          )}

          {preview && !preview.can_move && (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/[0.06] px-3 py-2.5 text-[0.72rem] leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {preview.warning}
            </p>
          )}

          {previewQuery.error && <FormError message={getApiErrorMessage(previewQuery.error)} />}
          {error && <FormError message={error} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending || !preview?.can_move || previewQuery.isFetching}
          >
            {pending ? <Spinner /> : <Building2 />}
            Move subtree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "brass";
}) {
  return (
    <div>
      <p className="text-[0.62rem] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={tone === "brass" && value ? "mt-0.5 text-brass" : "mt-0.5"}>{value}</p>
    </div>
  );
}
