import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, Printer, QrCode } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { queryKeys } from "@/lib/queries";
import type {
  Container,
  ContainerBulkResult,
  ContainerType,
  Room,
  StorageLocation,
} from "@/lib/types";
import {
  collectDescendantIds,
  CONTAINER_TYPE_LABELS,
  flattenLocations,
} from "@/lib/utils";

const CONTAINER_TYPES: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];

export function ContainerCreateDialog({
  open,
  onOpenChange,
  rooms,
  locations,
  defaultRoomId,
  defaultParentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Room[];
  locations: StorageLocation[];
  defaultRoomId?: string;
  defaultParentId?: string;
  onCreated?: (containers: Container[]) => void;
}) {
  const queryClient = useQueryClient();
  const [roomId, setRoomId] = React.useState(defaultRoomId ?? "");
  const [parentId, setParentId] = React.useState(defaultParentId ?? "");
  const [containerType, setContainerType] = React.useState<ContainerType>("box");
  const [quantity, setQuantity] = React.useState(1);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setRoomId(defaultRoomId ?? rooms[0]?.id ?? "");
    setParentId(defaultParentId ?? "");
    setContainerType("box");
    setQuantity(1);
    setName("");
    setDescription("");
  }, [open, defaultRoomId, defaultParentId, rooms]);

  const create = useMutation({
    mutationFn: () => {
      const body = {
        room_id: roomId,
        parent_id: parentId || null,
        container_type: containerType,
        quantity,
        name: name.trim() || null,
        description: description.trim() || null,
      };
      if (quantity > 1) {
        return api.post<ContainerBulkResult>("/containers/bulk", body);
      }
      return api
        .post<Container>("/containers", body)
        .then((container) => ({ items: [container], identifiers: [container.identifier ?? ""] }));
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(
        result.items.length === 1
          ? `${result.identifiers[0]} created`
          : `${result.items.length} containers created`,
      );
      onCreated?.(result.items);
      onOpenChange(false);
    },
  });

  const parentOptions = flattenLocations(
    locations.filter((location) => location.room_id === roomId),
  );
  const fieldErrors = create.error instanceof ApiError ? create.error.fields : undefined;
  const generalError = create.error && !fieldErrors ? getApiErrorMessage(create.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{quantity > 1 ? "Create containers" : "Create a container"}</DialogTitle>
          <DialogDescription>
            Leave the name empty and Housetory assigns a permanent identifier such as
            BOX-001. Identifiers stay with the container when it moves.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!roomId) return;
            create.mutate();
          }}
        >
          {generalError && <FormError message={generalError} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="container-type">
              <Select
                id="container-type"
                value={containerType}
                onChange={(event) => setContainerType(event.target.value as ContainerType)}
              >
                {CONTAINER_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {CONTAINER_TYPE_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How many?" htmlFor="container-quantity">
              <Input
                id="container-quantity"
                type="number"
                min={1}
                max={100}
                value={quantity}
                onChange={(event) =>
                  setQuantity(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                }
              />
            </Field>
            <Field label="Room" htmlFor="container-room">
              <Select
                id="container-room"
                value={roomId}
                onChange={(event) => {
                  setRoomId(event.target.value);
                  setParentId("");
                }}
              >
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Inside" htmlFor="container-parent" optional>
              <Select
                id="container-parent"
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
              >
                <option value="">Directly in this room</option>
                {parentOptions.map(({ location, depth }) => (
                  <option key={location.id} value={location.id}>
                    {depth > 0 ? `${"— ".repeat(depth)}` : ""}
                    {location.identifier
                      ? `${location.identifier} · ${location.name}`
                      : location.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Name"
            htmlFor="container-name"
            optional
            error={fieldErrors?.name}
            hint={
              quantity > 1
                ? "The number is appended to each name. Identifiers are assigned automatically."
                : "Leave empty to show the auto-assigned identifier."
            }
          >
            <Input
              id="container-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Winter clothing"
            />
          </Field>
          <Field label="Notes" htmlFor="container-notes" optional>
            <Textarea
              id="container-notes"
              className="min-h-20"
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Where it lives, what belongs inside, or a moving note"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !roomId}>
              {create.isPending ? <Spinner /> : <Check />}
              {quantity > 1 ? `Create ${quantity} containers` : "Create container"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContainerMoveDialog({
  container,
  open,
  onOpenChange,
  rooms,
  locations,
  onMoved,
}: {
  container: Container;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Room[];
  locations: StorageLocation[];
  onMoved?: (container: Container) => void;
}) {
  const queryClient = useQueryClient();
  const [roomId, setRoomId] = React.useState(container.room_id);
  const [parentId, setParentId] = React.useState(container.parent_id ?? "");

  React.useEffect(() => {
    if (!open) return;
    setRoomId(container.room_id);
    setParentId(container.parent_id ?? "");
  }, [open, container.room_id, container.parent_id]);

  const move = useMutation({
    mutationFn: () =>
      api.post<Container>(`/containers/${container.id}/move`, {
        room_id: roomId,
        parent_id: parentId || null,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.container(container.id) });
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.items });
      toast.success(`${container.identifier ?? container.name} moved`);
      onMoved?.(updated);
      onOpenChange(false);
    },
  });

  const excluded = new Set([container.id, ...collectDescendantIds(locations, container.id)]);
  const parentOptions = flattenLocations(
    locations.filter(
      (location) => location.room_id === roomId && !excluded.has(location.id),
    ),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {container.identifier ?? container.name}</DialogTitle>
          <DialogDescription>
            The identifier, QR code, contents and source links stay unchanged. Nested
            places move with the container.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            move.mutate();
          }}
        >
          {move.error && <FormError message={getApiErrorMessage(move.error)} />}
          <Field label="Destination room" htmlFor="move-room">
            <Select
              id="move-room"
              value={roomId}
              onChange={(event) => {
                setRoomId(event.target.value);
                setParentId("");
              }}
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Inside" htmlFor="move-parent" optional>
            <Select
              id="move-parent"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">Directly in this room</option>
              {parentOptions.map(({ location, depth }) => (
                <option key={location.id} value={location.id}>
                  {depth > 0 ? `${"— ".repeat(depth)}` : ""}
                  {location.identifier
                    ? `${location.identifier} · ${location.name}`
                    : location.name}
                </option>
              ))}
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={move.isPending}>
              {move.isPending ? <Spinner /> : <Check />}
              Move container
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContainerQrDialog({
  container,
  open,
  onOpenChange,
}: {
  container: Container;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(container.qr_payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy the link");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{container.identifier ?? container.name}</DialogTitle>
          <DialogDescription>
            Scan this code with a phone camera to open the authenticated container
            page. The code never contains inventory data.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="rounded-2xl border border-border bg-white p-4">
            <img
              src={container.qr_url}
              alt={`QR code for ${container.identifier ?? container.name}`}
              className="size-56"
            />
          </div>
          <code className="max-w-full break-all rounded-lg bg-secondary/50 px-3 py-2 text-center text-[0.68rem] text-muted-foreground">
            {container.qr_payload}
          </code>
          {container.qr_warning && (
            <p className="rounded-xl border border-brass/25 bg-brass-soft/50 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
              {container.qr_warning}
            </p>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="outline" asChild>
            <a href={`${container.qr_url}?download=true`}>
              <Download />
              Download SVG
            </a>
          </Button>
          <Button asChild>
            <Link to={`/labels?ids=${container.id}`} onClick={() => onOpenChange(false)}>
              <Printer />
              Print label
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContainerQrButton({ container }: { container: Container }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <QrCode />
        QR
      </Button>
      <ContainerQrDialog container={container} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ContainerExternalLink({ container }: { container: Container }) {
  return (
    <Link
      to={`/containers/${container.id}`}
      className="inline-flex items-center gap-1 text-[0.72rem] font-medium underline-offset-4 hover:underline"
    >
      {container.identifier ?? container.name}
      <ExternalLink className="size-3" />
    </Link>
  );
}

export function ContainerConvertDialog({
  location,
  open,
  onOpenChange,
  onConvert,
  busy,
}: {
  location: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConvert: (containerType: ContainerType) => void;
  busy: boolean;
}) {
  const [type, setType] = React.useState<ContainerType>("box");
  React.useEffect(() => {
    if (open) setType("box");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make {location?.name} movable</DialogTitle>
          <DialogDescription>
            The place keeps its UUID, items, children and documents. It gains a permanent
            identifier and can then move between rooms with everything inside it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Container type" htmlFor="convert-type">
            <Select
              id="convert-type"
              value={type}
              onChange={(event) => setType(event.target.value as ContainerType)}
            >
              {CONTAINER_TYPES.map((value) => (
                <option key={value} value={value}>
                  {CONTAINER_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <p className="rounded-xl border border-brass/20 bg-brass-soft/45 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
            Existing inventory and source links are preserved. The conversion is explicit;
            Housetory never converts places automatically.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => onConvert(type)}>
            {busy ? <Spinner /> : <Check />}
            Make movable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
