import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ChevronRight,
  MapPin,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import {
  useInvalidateInventory,
  useLocations,
  usePlaceTransferPreview,
  useRooms,
} from "@/lib/queries";
import type { PlaceTransferResult } from "@/lib/types";
import {
  flattenLocations,
  locationLabel,
  locationPath,
  pluralize,
  roomDescendantsWithDepth,
  roomPath,
} from "@/lib/utils";

export interface PlaceTransferSource {
  kind: "location" | "room";
  id: string;
  label: string;
  roomId: string;
  propertyId: string;
}

function descendantLocationIds(
  locations: { id: string; parent_id: string | null }[],
  sourceId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const location of locations) {
    if (!location.parent_id) continue;
    const list = children.get(location.parent_id) ?? [];
    list.push(location.id);
    children.set(location.parent_id, list);
  }
  const result = new Set<string>([sourceId]);
  const stack = [sourceId];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const child of children.get(current) ?? []) {
      if (result.has(child)) continue;
      result.add(child);
      stack.push(child);
    }
  }
  return result;
}

export function PlaceTransferDialog({
  open,
  onOpenChange,
  source,
  mode,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: PlaceTransferSource | null;
  mode: "move" | "delete";
  onCompleted?: (result: PlaceTransferResult) => void;
}) {
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [destinationRoomId, setDestinationRoomId] = React.useState("");
  const [destinationLocationId, setDestinationLocationId] = React.useState("");
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  const [error, setError] = React.useState<string | null>(null);
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const previewQuery = usePlaceTransferPreview(
    source?.kind ?? "location",
    source?.id,
    destinationRoomId,
    destinationLocationId,
    open && Boolean(source),
  );
  const preview = previewQuery.data;

  React.useEffect(() => {
    if (!open) return;
    setDestinationRoomId("");
    setDestinationLocationId("");
    setRequestId(crypto.randomUUID());
    setError(null);
  }, [open, source?.id]);

  const excludedRoomIds = React.useMemo(() => {
    if (!source || source.kind !== "room") return new Set<string>();
    const ids = new Set<string>([source.id]);
    for (const entry of roomDescendantsWithDepth(rooms, source.id)) {
      ids.add(entry.room.id);
    }
    return ids;
  }, [rooms, source]);

  const excludedLocationIds = React.useMemo(() => {
    if (!source || source.kind !== "location") return new Set<string>();
    return descendantLocationIds(locations, source.id);
  }, [locations, source]);

  const destinationRooms = rooms.filter(
    (room) =>
      !excludedRoomIds.has(room.id) &&
      (source?.kind !== "room" || !source.propertyId || room.property_id === source.propertyId),
  );
  const destinationLocations = flattenLocations(locations).filter(
    ({ location }) =>
      location.room_id === destinationRoomId &&
      !excludedLocationIds.has(location.id),
  );

  const transfer = useMutation({
    mutationFn: async () => {
      if (!source || !preview) throw new Error("Review the move first.");
      return api.post<PlaceTransferResult>(
        `/place-management/${source.kind === "room" ? "rooms" : "locations"}/${source.id}/transfer`,
        {
          destination_room_id: destinationRoomId,
          destination_location_id: destinationLocationId || null,
          delete_source: mode === "delete",
          expected_fingerprint: preview.fingerprint,
          request_id: requestId,
        },
      );
    },
    onSuccess: (result) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["place-transfer-preview"] });
      toast.success(
        result.deleted
          ? `Moved ${pluralize(result.total_items_preserved, "item")} and deleted ${result.source_label}`
          : `Moved ${pluralize(result.total_items_preserved, "item")} out of ${result.source_label}`,
      );
      onCompleted?.(result);
      onOpenChange(false);
    },
    onError: (caught) => {
      setError(getApiErrorMessage(caught));
      void previewQuery.refetch();
    },
  });

  if (!source) return null;
  const deleting = mode === "delete";
  const title = deleting
    ? `Move contents and delete ${source.label}?`
    : `Move all contents out of ${source.label}?`;
  const destinationLabel = preview?.destination?.path.length
    ? preview.destination.path.join(" / ")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {deleting ? (
              <Trash2 className="size-4 text-destructive" />
            ) : (
              <Boxes className="size-4 text-brass" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>
            Inventory items are moved first and are never deleted. The source is
            removed only after a transactional check confirms that no direct
            contents, nested places or child rooms remain.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground/85">{source.label}</p>
            {preview ? (
              <>
                <p className="mt-1">
                  {pluralize(preview.total_item_count, "item")} ·{" "}
                  {pluralize(preview.total_quantity, "recorded unit")}
                  {preview.nested_place_count
                    ? ` · ${pluralize(preview.nested_place_count, "nested place")}`
                    : ""}
                  {preview.child_room_count
                    ? ` · ${pluralize(preview.child_room_count, "child room")}`
                    : ""}
                </p>
                <p className="mt-1">
                  {preview.direct_item_count} directly assigned ·{" "}
                  {preview.nested_item_count} inside nested places/rooms
                  {preview.archived_item_count
                    ? ` · ${preview.archived_item_count} archived`
                    : ""}
                  {preview.on_loan_quantity
                    ? ` · ${preview.on_loan_quantity} on loan`
                    : ""}
                </p>
              </>
            ) : (
              <p className="mt-1">Loading current contents…</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Destination room" htmlFor="place-destination-room">
              <Select
                id="place-destination-room"
                value={destinationRoomId}
                onChange={(event) => {
                  setDestinationRoomId(event.target.value);
                  setDestinationLocationId("");
                  setError(null);
                }}
              >
                <option value="">Choose a room</option>
                {destinationRooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {[
                      room.property?.name,
                      ...roomPath(rooms, room.id).map((entry) => entry.name),
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Destination storage place"
              htmlFor="place-destination-location"
              optional
            >
              <Select
                id="place-destination-location"
                value={destinationLocationId}
                disabled={!destinationRoomId}
                onChange={(event) => {
                  setDestinationLocationId(event.target.value);
                  setError(null);
                }}
              >
                <option value="">Room only</option>
                {destinationLocations.map(({ location }) => (
                  <option key={location.id} value={location.id}>
                    {locationPath(locations, location.id)
                      .map((entry) => locationLabel(entry))
                      .join(" / ")}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {preview?.destination && (
            <p className="flex items-start gap-1.5 rounded-xl border border-border/60 bg-background/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
              <MapPin className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Destination: <strong className="font-medium text-foreground/80">{destinationLabel}</strong>
              </span>
            </p>
          )}

          {preview?.items_preview.length ? (
            <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
              <p className="text-[0.7rem] font-medium text-foreground/80">
                First items in this move
              </p>
              <ul className="mt-2 space-y-1.5">
                {preview.items_preview.slice(0, 6).map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-[0.7rem]"
                  >
                    <span className="min-w-0 break-words">
                      {item.quantity > 1 ? `${item.quantity} × ` : ""}
                      {item.name}
                      {item.is_archived ? (
                        <Badge variant="outline" className="ml-1.5">
                          Archived
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-[0.64rem] text-muted-foreground">
                      {item.place_label}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.total_item_count > preview.items_preview.length && (
                <p className="mt-2 text-[0.66rem] text-muted-foreground">
                  and {preview.total_item_count - preview.items_preview.length} more item(s)
                </p>
              )}
            </div>
          ) : null}

          {preview?.nested_places_preview.length ? (
            <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
              <p className="text-[0.7rem] font-medium text-foreground/80">
                Nested places moved with their contents
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.nested_places_preview.map((location) => (
                  <Badge key={location.id} variant="secondary">
                    {location.identifier ?? location.name}
                    {location.total_item_count
                      ? ` · ${pluralize(location.total_item_count, "item")}`
                      : ""}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {preview?.child_rooms_preview.length ? (
            <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
              <p className="text-[0.7rem] font-medium text-foreground/80">
                Child rooms reparented under the destination room
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.child_rooms_preview.map((room) => (
                  <Badge key={room.id} variant="outline">
                    <ChevronRight className="size-3" />
                    {room.name}
                    {room.total_item_count
                      ? ` · ${pluralize(room.total_item_count, "item")}`
                      : ""}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {preview?.warnings.map((warning) => (
            <p
              key={warning}
              className="flex items-start gap-1.5 rounded-xl border border-brass/25 bg-brass-soft/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-brass" />
              <span>{warning}</span>
            </p>
          ))}

          {preview?.blockers.map((blocker) => (
            <p
              key={blocker}
              className="rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-destructive"
            >
              {blocker}
            </p>
          ))}

          {deleting && (
            <p className="rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-destructive">
              Deleting {source.label} is permanent. Its inventory moves to the
              destination first; this workflow does not promise undo for the deleted
              source.
            </p>
          )}

          {error && <FormError message={error} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={deleting ? "destructive" : "default"}
            disabled={
              !preview?.can_proceed ||
              !destinationRoomId ||
              transfer.isPending ||
              previewQuery.isFetching
            }
            onClick={() => {
              setError(null);
              transfer.mutate();
            }}
          >
            {transfer.isPending ? (
              <Spinner />
            ) : deleting ? (
              <Trash2 />
            ) : (
              <ArrowRight />
            )}
            {deleting ? "Move contents and delete" : "Move all contents"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
