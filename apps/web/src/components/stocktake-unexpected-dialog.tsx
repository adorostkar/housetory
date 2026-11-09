import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { FormError } from "@/components/form-field";
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
import { api, getApiErrorMessage } from "@/lib/api";
import { useItems, useLocations, useRooms } from "@/lib/queries";
import { flattenLocations, flattenRoomTree, itemContainer, locationLabel } from "@/lib/utils";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StocktakeUnexpectedDialog({
  open,
  onOpenChange,
  sessionId,
  defaultRoomId,
  defaultContainerId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  defaultRoomId?: string;
  defaultContainerId?: string;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const roomsQuery = useRooms();
  const [name, setName] = React.useState("");
  const [counted, setCounted] = React.useState("1");
  const [roomId, setRoomId] = React.useState(defaultRoomId ?? "");
  const [containerId, setContainerId] = React.useState(defaultContainerId ?? "");
  const [notes, setNotes] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [linkedItemId, setLinkedItemId] = React.useState("");
  const [linkedItemName, setLinkedItemName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());
  const locationsQuery = useLocations(roomId || undefined);
  const searchQuery = useItems(
    { q: search.trim(), include_archived: false },
    6,
    open && search.trim().length > 1,
  );
  const rooms = React.useMemo(
    () => flattenRoomTree(roomsQuery.data?.items ?? []),
    [roomsQuery.data?.items],
  );
  const locations = React.useMemo(
    () =>
      flattenLocations(
        (locationsQuery.data?.items ?? []).filter(
          (location) => location.room_id === roomId,
        ),
      ),
    [locationsQuery.data?.items, roomId],
  );

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setCounted("1");
    setRoomId(defaultRoomId ?? "");
    setContainerId(defaultContainerId ?? "");
    setNotes("");
    setSearch("");
    setLinkedItemId("");
    setLinkedItemName("");
    setError(null);
    requestId.current = newRequestId();
  }, [open, defaultRoomId, defaultContainerId]);

  React.useEffect(() => {
    setContainerId("");
  }, [roomId]);

  const countedNumber = Number.parseInt(counted, 10);
  const localError = !name.trim()
    ? "Enter a name for the unexpected finding."
    : !Number.isFinite(countedNumber) || countedNumber < 1
      ? "Enter at least one found unit."
      : null;

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
        status: "unexpected",
        unexpected_name: name.trim(),
        counted_quantity: countedNumber,
        room_id: roomId || null,
        container_id: roomId && containerId ? containerId : null,
        linked_item_id: linkedItemId || null,
        notes: notes.trim() || null,
      });
      requestId.current = newRequestId();
      await queryClient.invalidateQueries({ queryKey: ["stocktake"] });
      toast.success("Unexpected finding saved");
      onSaved();
      onOpenChange(false);
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const newItemHref = `/items/new?room_id=${encodeURIComponent(
    roomId || defaultRoomId || "",
  )}${containerId ? `&location_id=${encodeURIComponent(containerId)}` : ""}${
    name.trim() ? `&name=${encodeURIComponent(name.trim())}` : ""
  }`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record an unexpected item</DialogTitle>
          <DialogDescription>
            This records a finding only. Nothing is created or duplicated until you deliberately
            add or link an item.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block text-2xs font-medium" htmlFor="stocktake-unexpected-name">
            What did you find?
            <Input
              id="stocktake-unexpected-name"
              className="mt-1.5"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              placeholder="e.g. Old charger"
            />
          </label>

          <label className="block text-2xs font-medium" htmlFor="stocktake-unexpected-count">
            Found units
            <Input
              id="stocktake-unexpected-count"
              className="mt-1.5"
              type="number"
              min="1"
              inputMode="numeric"
              value={counted}
              onChange={(event) => setCounted(event.target.value)}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-2xs font-medium" htmlFor="stocktake-unexpected-room">
              Existing room (optional)
              <Select
                id="stocktake-unexpected-room"
                className="mt-1.5"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
              >
                <option value="">No room recorded</option>
                {rooms.map(({ room, depth }) => (
                  <option key={room.id} value={room.id}>
                    {"\u00a0".repeat(depth * 2)}
                    {room.name}
                  </option>
                ))}
              </Select>
            </label>
            <label
              className="block text-2xs font-medium"
              htmlFor="stocktake-unexpected-container"
            >
              Existing place (optional)
              <Select
                id="stocktake-unexpected-container"
                className="mt-1.5"
                value={containerId}
                onChange={(event) => setContainerId(event.target.value)}
                disabled={!roomId || locationsQuery.isPending}
              >
                <option value="">Room only</option>
                {locations.map(({ location, depth }) => (
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

          <div>
            <label className="block text-2xs font-medium" htmlFor="stocktake-unexpected-search">
              Link an existing item (optional)
            </label>
            {linkedItemId ? (
              <div className="mt-1.5 flex items-center justify-between gap-2 rounded-xl border border-border/70 px-3 py-2 text-2xs">
                <span className="min-w-0 truncate">{linkedItemName}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLinkedItemId("");
                    setLinkedItemName("");
                  }}
                >
                  Clear
                </Button>
              </div>
            ) : (
              <>
                <div className="relative mt-1.5">
                  <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="stocktake-unexpected-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="pl-9"
                    placeholder="Search your items"
                  />
                </div>
                {search.trim().length > 1 && (
                  <div className="mt-1.5 max-h-36 overflow-y-auto rounded-xl border border-border/65">
                    {searchQuery.isPending ? (
                      <p className="px-3 py-2 text-2xs text-muted-foreground">Searching…</p>
                    ) : searchQuery.data?.pages[0]?.items.length ? (
                      searchQuery.data.pages[0].items.map((item) => {
                        const container = itemContainer(item);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className="flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left text-2xs last:border-b-0 hover:bg-secondary/35"
                            onClick={() => {
                              setLinkedItemId(item.id);
                              setLinkedItemName(item.name);
                              if (!name.trim()) setName(item.name);
                              if (!roomId && item.room?.id) setRoomId(item.room.id);
                            }}
                          >
                            <span className="font-medium">{item.name}</span>
                            <span className="text-2xs text-muted-foreground">
                              {item.room?.name ?? "No room"}
                              {container ? ` / ${locationLabel(container)}` : ""}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="px-3 py-2 text-2xs text-muted-foreground">
                        No matching active items.
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
                  Linking records the finding only. To create a new item, use the normal reviewed
                  form:{" "}
                  <Link to={newItemHref} className="underline underline-offset-4">
                    Add item
                  </Link>
                  .
                </p>
              </>
            )}
          </div>

          <label className="block text-2xs font-medium" htmlFor="stocktake-unexpected-notes">
            Notes (optional)
            <Textarea
              id="stocktake-unexpected-notes"
              className="mt-1.5"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={2}
            />
          </label>

          {(error || localError) && <FormError message={error ?? localError ?? ""} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || Boolean(localError)}>
            {pending ? <Spinner /> : <Plus />}
            Save finding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
