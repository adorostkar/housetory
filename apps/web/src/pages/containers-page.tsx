import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  MapPin,
  MoveRight,
  Printer,
  QrCode,
  Search,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ContainerConvertDialog,
  ContainerCreateDialog,
  ContainerMoveDialog,
  ContainerQrDialog,
} from "@/components/container-dialogs";
import { EmptyState } from "@/components/empty-state";
import {
  PlaceTransferDialog,
  type PlaceTransferSource,
} from "@/components/place-transfer-dialog";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { usePropertyFilter } from "@/hooks/use-property-filter";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCanWrite,
  useContainers,
  useInvalidateInventory,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type { Container, ContainerType } from "@/lib/types";
import {
  CONTAINER_TYPE_LABELS,
  cn,
  formatRelativeDate,
  pluralize,
} from "@/lib/utils";

const TYPES: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];

export function ContainersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { propertyId, setPropertyId, properties } = usePropertyFilter();
  const roomsQuery = useRooms(propertyId || undefined);
  const locationsQuery = useLocations();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [view, setView] = React.useState<"containers" | "fixed">("containers");
  const [search, setSearch] = React.useState(searchParams.get("q") ?? "");
  const debounced = useDebouncedValue(search, 300);
  const [roomId, setRoomId] = React.useState(searchParams.get("room_id") ?? "");
  const [containerType, setContainerType] = React.useState("");
  const [empty, setEmpty] = React.useState<"all" | "full" | "empty">("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [moveTarget, setMoveTarget] = React.useState<Container | null>(null);
  const [qrTarget, setQrTarget] = React.useState<Container | null>(null);
  const [convertTarget, setConvertTarget] = React.useState<Container | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Container | null>(null);
  const [transferTarget, setTransferTarget] = React.useState<{
    source: PlaceTransferSource;
    mode: "move" | "delete";
  } | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    setCreateOpen(true);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("create");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const containersQuery = useContainers({
    q: debounced.trim() || undefined,
    property_id: propertyId || undefined,
    room_id: roomId || undefined,
    container_type: containerType || undefined,
    empty: empty === "all" ? undefined : empty === "empty",
    include_fixed: true,
  });
  const canWrite = useCanWrite();
  const allContainers = containersQuery.data?.items ?? [];
  const containers = allContainers.filter((container) =>
    view === "containers" ? container.is_container : !container.is_container,
  );
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const roomMap = new Map(rooms.map((room) => [room.id, room]));

  React.useEffect(() => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (debounced.trim()) next.set("q", debounced.trim());
        else next.delete("q");
        if (roomId) next.set("room_id", roomId);
        else next.delete("room_id");
        return next;
      },
      { replace: true },
    );
  }, [debounced, roomId, setSearchParams]);

  const convert = useMutation({
    mutationFn: ({ locationId, containerType }: { locationId: string; containerType: string }) =>
      api.post<Container>("/containers/convert", {
        location_id: locationId,
        container_type: containerType,
      }),
    onSuccess: (container) => {
      invalidate();
      setConvertTarget(null);
      toast.success(`${container.identifier ?? container.name} is now a movable container`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const assignIdentifier = useMutation({
    mutationFn: (locationId: string) =>
      api.post<Container>(`/containers/${locationId}/identifier`),
    onSuccess: (container) => {
      invalidate();
      toast.success(`${container.identifier} assigned`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const deleteEmpty = useMutation({
    mutationFn: (containerId: string) =>
      api.delete<void>(`/containers/${containerId}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success("Container deleted");
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === "location_not_empty" &&
        deleteTarget
      ) {
        setTransferTarget({
          source: {
            kind: "location",
            id: deleteTarget.id,
            label: deleteTarget.identifier ?? deleteTarget.name,
            roomId: deleteTarget.room_id,
            propertyId: deleteTarget.property?.id ?? "",
          },
          mode: "delete",
        });
        setDeleteTarget(null);
        return;
      }
      toast.error(getApiErrorMessage(error));
    },
  });

  const requestDelete = (container: Container) => {
    const label = container.identifier ?? container.name;
    if (container.total_item_count === 0 && container.child_count === 0) {
      setDeleteTarget(container);
      return;
    }
    setTransferTarget({
      source: {
        kind: "location",
        id: container.id,
        label,
        roomId: container.room_id,
        propertyId: container.property?.id ?? "",
      },
      mode: "delete",
    });
  };

  const requestMoveContents = (container: Container) => {
    setTransferTarget({
      source: {
        kind: "location",
        id: container.id,
        label: container.identifier ?? container.name,
        roomId: container.room_id,
        propertyId: container.property?.id ?? "",
      },
      mode: "move",
    });
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = containers.length > 0 && containers.every((entry) => selected.has(entry.id));
  const selectedIds = containers.filter((entry) => selected.has(entry.id)).map((entry) => entry.id);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Physical storage"
        title="Containers"
        description="Boxes, bins, crates and bags with permanent identifiers, live contents and printable QR labels."
        actions={
          <>
            {canWrite && (
              <Button variant="outline" asChild>
                <Link to={selectedIds.length ? `/labels?ids=${selectedIds.join(",")}` : "/labels"}>
                  <Printer />
                  Print labels
                </Link>
              </Button>
            )}
            {canWrite && (
              <Button onClick={() => setCreateOpen(true)}>
                <Boxes />
                New container
              </Button>
            )}
          </>
        }
      />

      {containersQuery.data?.qr_warning && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-brass/25 bg-brass-soft/45 px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass" />
          <span>{containersQuery.data.qr_warning}</span>
        </div>
      )}

      <section className="surface p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="inline-flex shrink-0 rounded-full border border-border/70 bg-background/50 p-1">
            <button
              type="button"
              onClick={() => setView("containers")}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[0.72rem] font-medium",
                view === "containers"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground",
              )}
            >
              Containers
            </button>
            <button
              type="button"
              onClick={() => setView("fixed")}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[0.72rem] font-medium",
                view === "fixed"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground",
              )}
            >
              Fixed places
            </button>
          </div>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search BOX-001, name or room"
              aria-label="Search containers"
              className="pl-10"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Select
              aria-label="Filter by property"
              value={propertyId}
              onChange={(event) => {
                setPropertyId(event.target.value);
                setRoomId("");
                setSelected(new Set());
              }}
            >
              <option value="">All properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by room"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">All rooms</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.property?.name ? `${room.property.name} / ${room.name}` : room.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by type"
              value={containerType}
              onChange={(event) => setContainerType(event.target.value)}
            >
              <option value="">All types</option>
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONTAINER_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by contents"
              value={empty}
              onChange={(event) => setEmpty(event.target.value as typeof empty)}
            >
              <option value="all">Any contents</option>
              <option value="empty">Empty only</option>
              <option value="full">Has items</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[0.72rem] text-muted-foreground">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setSelected(
                  allSelected ? new Set() : new Set(containers.map((entry) => entry.id)),
                )
              }
              className="font-medium text-foreground/75 underline-offset-4 hover:underline"
            >
              {allSelected ? "Clear selection" : "Select all"}
            </button>
            <span>{selectedIds.length} selected</span>
          </div>
          <div className="flex items-center gap-2">
            {roomId && (
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/labels?room_id=${roomId}`}>
                  <Printer />
                  Print this room
                </Link>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild disabled={selectedIds.length === 0}>
              <Link
                to={selectedIds.length ? `/labels?ids=${selectedIds.join(",")}` : "/labels"}
                aria-disabled={selectedIds.length === 0}
              >
                <Printer />
                Print selected
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mt-6">
        {containersQuery.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-52 rounded-2xl" />
            ))}
          </div>
        ) : containers.length === 0 ? (
          <EmptyState
            title={view === "containers" ? "No containers yet." : "No fixed places yet."}
            description={
              view === "containers"
                ? "Create a box without naming it. Housetory assigns BOX-001, BOX-002 and so on, ready for a QR label."
                : "Shelves, cabinets and drawers live in Rooms. Assign an optional identifier here when you want a printable fixed-place label."
            }
            actionLabel={view === "containers" ? "Create a container" : undefined}
            onAction={() => setCreateOpen(true)}
            secondary={
              <Button variant="outline" asChild>
                <Link to="/rooms">Browse rooms</Link>
              </Button>
            }
          />
        ) : (
          <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {containers.map((container) => (
              <ContainerCard
                key={container.id}
                container={container}
                roomName={roomMap.get(container.room_id)?.name ?? container.room.name}
                selected={selected.has(container.id)}
                onToggle={() => toggleSelected(container.id)}
                onMove={() => setMoveTarget(container)}
                onQr={() => setQrTarget(container)}
                onConvert={() => setConvertTarget(container)}
                onAssignIdentifier={() => assignIdentifier.mutate(container.id)}
                onDelete={() => requestDelete(container)}
                onMoveContents={() => requestMoveContents(container)}
                busy={convert.isPending || assignIdentifier.isPending}
              />
            ))}
          </div>
        )}
      </section>

      <ContainerCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        rooms={rooms}
        locations={locations}
        defaultRoomId={roomId || undefined}
        onCreated={(created) => {
          if (created.length > 1) {
            setSelected(new Set(created.map((entry) => entry.id)));
          }
        }}
      />
      {moveTarget && (
        <ContainerMoveDialog
          container={moveTarget}
          open={Boolean(moveTarget)}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          rooms={rooms}
          locations={locations}
          onMoved={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
          }}
        />
      )}
      {qrTarget && (
        <ContainerQrDialog
          container={qrTarget}
          open={Boolean(qrTarget)}
          onOpenChange={(open) => {
            if (!open) setQrTarget(null);
          }}
        />
      )}
      <ContainerConvertDialog
        location={convertTarget}
        open={Boolean(convertTarget)}
        onOpenChange={(open) => {
          if (!open) setConvertTarget(null);
        }}
        busy={convert.isPending}
        onConvert={(containerType) => {
          if (convertTarget) convert.mutate({ locationId: convertTarget.id, containerType });
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.identifier ?? deleteTarget?.name ?? "container"}?`}
        description={
          (deleteTarget?.recoverable_deleted_child_count ?? 0) > 0
            ? `This container has ${deleteTarget?.recoverable_deleted_child_count} recoverable-deleted nested place(s). Deleting it leaves them without a live parent, so their item-move restoration becomes unavailable. Its own identity and photos are retained. This cannot be undone.`
            : "This container or fixed place is empty and can be removed. Its identity and photos are retained for eligible item-move restoration. This cannot be undone."
        }
        confirmLabel="Delete container"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteEmpty.mutateAsync(deleteTarget.id);
        }}
      />
      <PlaceTransferDialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        source={transferTarget?.source ?? null}
        mode={transferTarget?.mode ?? "move"}
      />
    </div>
  );
}

function ContainerCard({
  container,
  roomName,
  selected,
  onToggle,
  onMove,
  onQr,
  onConvert,
  onAssignIdentifier,
  onDelete,
  onMoveContents,
  busy,
}: {
  container: Container;
  roomName: string;
  selected: boolean;
  onToggle: () => void;
  onMove: () => void;
  onQr: () => void;
  onConvert: () => void;
  onAssignIdentifier: () => void;
  onDelete: () => void;
  onMoveContents: () => void;
  busy: boolean;
}) {
  const identifier = container.identifier ?? container.name;
  const canWrite = useCanWrite();
  return (
    <article
      className={cn(
        "surface flex min-w-0 flex-col p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:shadow-lift sm:p-5",
        selected && "border-sage/50",
      )}
    >
      <div className="flex items-start gap-3">
        {canWrite && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${identifier}`}
            className="mt-1 size-4 shrink-0 accent-primary"
          />
        )}
        <Link to={`/containers/${container.id}`} className="min-w-0 flex-1 group">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-[1.65rem] leading-none tracking-[-0.03em]">
              {identifier}
            </span>
            <Badge variant={container.is_container ? "sage" : "outline"}>
              {container.is_container
                ? CONTAINER_TYPE_LABELS[container.container_type ?? "other"]
                : "Fixed place"}
            </Badge>
          </div>
          <p className="mt-2 line-clamp-1 text-[0.84rem] text-foreground/75">
            {container.name !== identifier ? container.name : "Unnamed container"}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" />
              {roomName}
              {container.path.length > 1
                ? ` / ${container.path.slice(0, -1).map((entry) => entry.name).join(" / ")}`
                : ""}
            </span>
            <span>·</span>
            <span>
              {container.total_item_count === 0
                ? "Empty"
                : `${pluralize(container.total_item_count, "item")} · ${container.total_quantity} units`}
            </span>
          </p>
        </Link>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <span className="text-[0.66rem] text-muted-foreground">
          {container.label_generated_at
            ? `Label ${formatRelativeDate(container.label_generated_at)}`
            : container.is_container
              ? "No label printed"
              : "Optional fixed label"}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {canWrite && container.is_container && (
            <Button variant="ghost" size="sm" onClick={onMove}>
              Move
            </Button>
          )}
          {canWrite && !container.is_container && !container.identifier && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onAssignIdentifier}>
              Assign ID
            </Button>
          )}
          {canWrite && !container.is_container && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onConvert}>
              Make movable
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onQr}>
            <QrCode />
            QR
          </Button>
          {canWrite && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/labels?ids=${container.id}`}>
                <Printer />
                Label
              </Link>
            </Button>
          )}
          {(container.total_item_count > 0 || container.child_count > 0) && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onMoveContents}
              aria-label={`Move contents of ${identifier}`}
              title="Move all contents out without deleting"
            >
              <MoveRight className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${identifier}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" asChild aria-label={`Open ${identifier}`}>
            <Link to={`/containers/${container.id}`}>
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}
