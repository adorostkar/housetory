import { useMutation } from "@tanstack/react-query";
import {
  Boxes,
  Building2,
  ChevronRight,
  Download,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import {
  AddItemsButton,
  useAddItems,
  useRegisterAddItemsContext,
} from "@/components/add-items";
import { BorrowedKeptHere } from "@/components/borrowed-kept-here";
import {
  BulkItemActionBar,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityPhotoManager } from "@/components/entity-photo-manager";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { ItemCard } from "@/components/item-card";
import { LocationDialog } from "@/components/location-dialog";
import { PageHeader } from "@/components/page-header";
import {
  PlaceTransferDialog,
  type PlaceTransferSource,
} from "@/components/place-transfer-dialog";
import { RoomDialog } from "@/components/room-dialog";
import { RoomPropertyMoveDialog } from "@/components/room-property-move-dialog";
import { StocktakeEntry } from "@/components/stocktake-entry";
import { LocationIcon, roomIcon } from "@/components/room-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import {
  useCanWrite,
  useInvalidateInventory,
  useItems,
  useLocations,
  useProperties,
  useRooms,
} from "@/lib/queries";
import type { StorageLocation } from "@/lib/types";
import {
  cn,
  flattenLocations,
  pluralize,
  roomDescendantsWithDepth,
  roomPath,
} from "@/lib/utils";

const ROOM_ITEM_SORTS = {
  created_desc: "Newest first",
  name_asc: "Name A–Z",
  name_desc: "Name Z–A",
  updated_desc: "Recently updated",
} as const;

export function RoomDetailPage() {
  const canWrite = useCanWrite();
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const invalidate = useInvalidateInventory();
  const roomsQuery = useRooms();
  const locationsQuery = useLocations(roomId);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedLocationId = searchParams.get("location_id");
  const scope = searchParams.get("scope") === "direct" ? "direct" : "nested";
  const qParam = searchParams.get("q") ?? "";
  const sortParam = searchParams.get("sort");
  const sort = sortParam && sortParam in ROOM_ITEM_SORTS
    ? (sortParam as keyof typeof ROOM_ITEM_SORTS)
    : "created_desc";
  const [search, setSearch] = useState(qParam);
  const debouncedSearch = useDebouncedValue(search, 300);
  const itemsQuery = useItems(
    {
      q: qParam || undefined,
      room_id: roomId || undefined,
      location_id: requestedLocationId ?? undefined,
      include_descendants: scope === "nested",
      sort,
    },
    24,
  );

  const [roomEditTarget, setRoomEditTarget] = useState<"edit" | "child" | null>(null);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<StorageLocation | undefined>();
  const [locationParentId, setLocationParentId] = useState<string | undefined>();
  const [deleteRoomOpen, setDeleteRoomOpen] = useState(false);
  const [deletingLocation, setDeletingLocation] = useState<StorageLocation | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [propertyMoveOpen, setPropertyMoveOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState<{
    source: PlaceTransferSource;
    mode: "move" | "delete";
  } | null>(null);
  const propertiesQuery = useProperties();

  const rooms = roomsQuery.data?.items ?? [];
  const room = rooms.find((entry) => entry.id === roomId);
  const childRooms = rooms.filter((entry) => entry.parent_id === roomId);
  const nestedRooms = roomDescendantsWithDepth(rooms, roomId);
  const locations = locationsQuery.data?.items ?? [];
  const flatLocations = flattenLocations(locations);
  const path = room ? roomPath(rooms, room.id) : [];
  const parent = path.length > 1 ? path[path.length - 2] : undefined;
  const selectedLocation = locations.find((location) => location.id === requestedLocationId);
  const selectedLocationId = selectedLocation?.id ?? null;
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const totalItems = itemsQuery.data?.pages[0]?.total ?? 0;
  const filterSignature = JSON.stringify([
    roomId,
    selectedLocationId,
    scope,
    qParam,
    sort,
  ]);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
  });
  const originLabel = selectedLocation
    ? selectedLocation.identifier ?? selectedLocation.name
    : room?.name ?? "room";
  const origin = itemOrigin(`${location.pathname}${location.search}`, originLabel);
  useRestoreListScroll(items.length > 0, origin);
  const { openAddItems } = useAddItems();
  const addItemsContext = room
    ? {
        propertyId: room.property_id,
        roomId: room.id,
        locationId: selectedLocationId ?? undefined,
        roomName: room.name,
        locationName: selectedLocation?.name,
      }
    : undefined;
  useRegisterAddItemsContext(addItemsContext ?? null);

  const selectLocation = (locationId: string | null) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (locationId) next.set("location_id", locationId);
        else next.delete("location_id");
        return next;
      },
      { replace: true },
    );
  };

  const updateItemsParam = (key: string, value: string) => {
    selection.clearSelection("Selection cleared because the view changed.");
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    const trimmed = debouncedSearch.trim();
    if (trimmed === qParam) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, qParam, setSearchParams]);

  useEffect(() => {
    if (
      requestedLocationId &&
      locationsQuery.isSuccess &&
      !locations.some((location) => location.id === requestedLocationId)
    ) {
      selectLocation(null);
    }
  }, [requestedLocationId, locationsQuery.isSuccess, locations]);

  const deleteRoom = useMutation({
    mutationFn: () => api.delete<void>(`/rooms/${roomId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Room deleted");
      navigate("/rooms", { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "room_not_empty") {
        setDeleteRoomOpen(false);
        setTransferTarget({ source: roomTransferSource, mode: "delete" });
        return;
      }
      toast.error(getApiErrorMessage(error));
    },
  });

  const deleteLocation = useMutation({
    mutationFn: (locationId: string) =>
      api.delete<void>(`/storage-locations/${locationId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Place deleted");
      setDeletingLocation(null);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === "location_not_empty" &&
        deletingLocation
      ) {
        setDeletingLocation(null);
        setTransferTarget({
          source: locationTransferSource(deletingLocation),
          mode: "delete",
        });
        return;
      }
      toast.error(getApiErrorMessage(error));
    },
  });

  if (roomsQuery.isPending) return <RoomDetailSkeleton />;
  if (roomsQuery.isError) {
    return (
      <ErrorState
        title="This room is out of reach"
        message="We couldn't load your rooms right now."
        onRetry={() => void roomsQuery.refetch()}
      />
    );
  }
  if (!room) {
    return (
      <div className="surface mx-auto max-w-lg px-6 py-16 text-center">
        <p className="eyebrow">Not found</p>
        <h1 className="mt-3 font-display text-3xl tracking-[-0.03em]">This room isn't here.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been deleted, or the link may be out of date.
        </p>
        <Button asChild className="mt-6">
          <Link to="/rooms">Back to rooms</Link>
        </Button>
      </div>
    );
  }

  const roomTransferSource: PlaceTransferSource = {
    kind: "room",
    id: room.id,
    label: room.name,
    roomId: room.id,
    propertyId: room.property_id ?? "",
  };

  const attemptRoomDelete = () => {
    if (
      room.total_item_count > 0 ||
      room.total_location_count > 0 ||
      childRooms.length > 0
    ) {
      setTransferTarget({ source: roomTransferSource, mode: "delete" });
      return;
    }
    setDeleteRoomOpen(true);
  };

  const moveRoomContents = () => {
    setTransferTarget({ source: roomTransferSource, mode: "move" });
  };

  const locationTransferSource = (location: StorageLocation): PlaceTransferSource => ({
    kind: "location",
    id: location.id,
    label: location.identifier ?? location.name,
    roomId: room.id,
    propertyId: room.property_id ?? "",
  });

  const attemptLocationDelete = (location: StorageLocation) => {
    const hasChildren = locations.some((entry) => entry.parent_id === location.id);
    if (location.total_item_count > 0 || hasChildren) {
      setTransferTarget({
        source: locationTransferSource(location),
        mode: "delete",
      });
      return;
    }
    setDeletingLocation(location);
  };

  const moveLocationContents = (location: StorageLocation) => {
    setTransferTarget({ source: locationTransferSource(location), mode: "move" });
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow={
          [
            room.property?.name,
            ...(path.length > 1
              ? path.slice(0, -1).map((entry) => entry.name)
              : ["Your rooms"]),
          ]
            .filter(Boolean)
            .join(" / ")
        }
        title={room.name}
        description={room.description ?? undefined}
        backTo={parent ? `/rooms/${parent.id}` : "/rooms"}
        backLabel={parent ? parent.name : "All rooms"}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/containers?room_id=${room.id}`}>
                <Boxes />
                Containers
              </Link>
            </Button>
            {canWrite && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditingLocation(undefined);
                  setLocationParentId(undefined);
                  setLocationDialogOpen(true);
                }}
              >
                <Plus />
                Add a place
              </Button>
            )}
            {canWrite && !room.parent_id && (propertiesQuery.data?.items.length ?? 0) > 1 && (
              <Button variant="outline" onClick={() => setPropertyMoveOpen(true)}>
                <Building2 />
                Move to property
              </Button>
            )}
            <Button variant="outline" onClick={() => setEvidenceOpen(true)}>
              <Download />
              Export evidence
            </Button>
            <AddItemsButton context={addItemsContext} />
            {canWrite && <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Room options">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{room.name}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setRoomEditTarget("edit")}>
                  <Pencil />
                  Edit room
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRoomEditTarget("child")}>
                  <Plus />
                  Add a sub-room
                </DropdownMenuItem>
                {(room.total_item_count > 0 ||
                  room.total_location_count > 0 ||
                  childRooms.length > 0) && (
                  <DropdownMenuItem onSelect={moveRoomContents}>
                    <MoveRight />
                    Move contents
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={attemptRoomDelete}>
                  <Trash2 />
                  Delete room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>}
          </>
        }
      />

      <StocktakeEntry roomId={room.id} />

      <BorrowedKeptHere roomId={room.id} />

      <section className="surface mb-5 p-4 sm:p-5">
        <EntityPhotoManager kind="room" entityId={room.id} name={room.name} />
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="surface p-4">
            <div className="flex items-center justify-between px-1 pb-3">
              <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                Places in this room
              </h2>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingLocation(undefined);
                    setLocationParentId(undefined);
                    setLocationDialogOpen(true);
                  }}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  aria-label="Add place"
                >
                  <Plus className="size-4" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => selectLocation(null)}
              className={cn(
                "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[0.8rem] transition-colors",
                selectedLocationId === null
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <span>Everything in {room.name}</span>
              <span className="text-[0.68rem] tabular-nums">{room.total_item_count}</span>
            </button>

            {flatLocations.length === 0 ? (
              <p className="px-2.5 pb-2 pt-3 text-[0.75rem] leading-relaxed text-muted-foreground">
                No storage places yet. Add a shelf, cabinet or drawer to be more exact.
              </p>
            ) : (
              <div className="mt-1 space-y-0.5">
                {flatLocations.map(({ location, depth }) => {
                  const active = selectedLocationId === location.id;
                  return (
                    <div
                      key={location.id}
                      className={cn(
                        "group flex items-center gap-0.5 rounded-lg pr-1 transition-colors",
                        active ? "bg-secondary" : "hover:bg-secondary/60",
                      )}
                      style={{ marginLeft: `${depth * 18}px` }}
                    >
                      <button
                        type="button"
                        onClick={() => selectLocation(active ? null : location.id)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
                        aria-pressed={active}
                      >
                        <LocationIcon
                          kind={location.kind}
                          className={cn(
                            "size-3.5 shrink-0",
                            active ? "text-foreground" : "text-muted-foreground/70",
                          )}
                        />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[0.79rem]",
                            active ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {location.identifier
                            ? `${location.identifier} · ${location.name}`
                            : location.name}
                        </span>
                        <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground/80">
                          {location.total_item_count}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                            aria-label={`Options for ${location.name}`}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link to={`/containers/${location.id}`}>
                              <Boxes />
                              Open container page
                            </Link>
                          </DropdownMenuItem>
                          {canWrite && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setEditingLocation(location);
                                  setLocationDialogOpen(true);
                                }}
                              >
                                <Pencil />
                                Edit place
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setEditingLocation(undefined);
                                  setLocationParentId(location.id);
                                  setLocationDialogOpen(true);
                                }}
                              >
                                <Plus />
                                Add nested place
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => moveLocationContents(location)}>
                                <MoveRight />
                                Move contents
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                destructive
                                onSelect={() => attemptLocationDelete(location)}
                              >
                                <Trash2 />
                                Delete place
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {childRooms.length > 0 && (
            <section className="surface p-4">
              <div className="flex items-center justify-between px-1 pb-3">
                <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Inside this room
                </h2>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setRoomEditTarget("child")}
                    className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label="Add sub-room"
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {nestedRooms.map(({ room: child, depth }) => {
                  const Icon = roomIcon(child.name);
                  return (
                    <Link
                      key={child.id}
                      to={`/rooms/${child.id}`}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.8rem] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                      style={{
                        marginLeft: `${depth * 18}px`,
                        paddingLeft: "10px",
                      }}
                    >
                      <Icon className="size-3.5 shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">{child.name}</span>
                      <ChevronRight className="size-3 opacity-50" />
                    </Link>
                  );
                })}
              </div>
            </section>
          )}
        </aside>

        <section className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="section-title">
                {selectedLocation
                  ? selectedLocation.identifier
                    ? `${selectedLocation.identifier} · ${selectedLocation.name}`
                    : selectedLocation.name
                  : "Everything here"}
              </h2>
              {selectedLocation && (
                <button
                  type="button"
                  onClick={() => selectLocation(null)}
                  className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[0.68rem] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear
                  <X className="size-3" />
                </button>
              )}
            </div>
            <p className="text-[0.75rem] text-muted-foreground">
              {itemsQuery.data ? pluralize(totalItems, "item") : ""}
            </p>
          </div>

          <div className="surface mb-4 p-3.5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    selection.clearSelection(
                      "Selection cleared because the search changed.",
                    );
                  }}
                  placeholder="Search in this room or place"
                  aria-label="Search in this room or place"
                  className="pl-10"
                />
              </div>
              <div
                className="inline-flex rounded-full border border-border/70 bg-background/50 p-1"
                role="group"
                aria-label="Contents scope"
              >
                {(["nested", "direct"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={scope === value}
                    onClick={() =>
                      updateItemsParam("scope", value === "direct" ? "direct" : "")
                    }
                    className={
                      scope === value
                        ? "rounded-full bg-primary px-3 py-1.5 text-[0.7rem] font-medium text-primary-foreground"
                        : "rounded-full px-3 py-1.5 text-[0.7rem] font-medium text-muted-foreground"
                    }
                  >
                    {value === "nested" ? "Include nested" : "Direct only"}
                  </button>
                ))}
              </div>
              <Select
                aria-label="Sort items in this room or place"
                value={sort}
                onChange={(event) =>
                  updateItemsParam(
                    "sort",
                    event.target.value === "created_desc" ? "" : event.target.value,
                  )
                }
                className="h-9 rounded-lg text-[0.8rem] lg:max-w-44"
              >
                {Object.entries(ROOM_ITEM_SORTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <BulkSelectionControls
                selection={selection}
                showing={items.length}
                total={totalItems}
              />
            </div>
          </div>

          <BulkSelectionNotice selection={selection} />
          <BulkItemActionBar
            items={selection.selectedItems}
            onClear={() => selection.clearSelection()}
            onNotice={selection.showNotice}
          />

          {itemsQuery.isPending ? (
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-60 rounded-2xl" />
              ))}
            </div>
          ) : itemsQuery.isError ? (
            <ErrorState
              message="We couldn't load the items in this room."
              onRetry={() => void itemsQuery.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title={
                selectedLocation
                  ? scope === "direct"
                    ? "No direct items here."
                    : "Nothing here yet."
                  : scope === "direct"
                    ? "No direct items in this room."
                    : "This room is waiting."
              }
              description={
                selectedLocation
                  ? scope === "direct"
                    ? "Nested places may still contain items. Switch to Include nested to see them."
                    : `No items are stored in ${selectedLocation.name}. Add something, or choose another place.`
                  : scope === "direct"
                    ? "Sub-rooms and nested places may still contain items. Switch to Include nested to see them."
                    : "Add the first item to this room and give it a precise place to live."
              }
              actionLabel="Add items"
              onAction={() => openAddItems(addItemsContext)}
              className="py-14"
            />
          ) : (
            <>
              <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
                {items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    origin={origin}
                    selection={
                      canWrite
                        ? {
                            selected: selection.selected.has(item.id),
                            onToggle: () => selection.toggleItem(item.id),
                            disabled: item.is_archived,
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              {itemsQuery.hasNextPage && (
                <div className="mt-6 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => void itemsQuery.fetchNextPage()}
                    disabled={itemsQuery.isFetchingNextPage}
                  >
                    {itemsQuery.isFetchingNextPage ? "Loading…" : "Load more items"}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <RoomDialog
        open={roomEditTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoomEditTarget(null);
        }}
        rooms={rooms}
        room={roomEditTarget === "edit" ? room : undefined}
        defaultParentId={roomEditTarget === "child" ? room.id : undefined}
      />

      <LocationDialog
        open={locationDialogOpen}
        onOpenChange={(open) => {
          setLocationDialogOpen(open);
          if (!open) {
            setEditingLocation(undefined);
            setLocationParentId(undefined);
          }
        }}
        roomId={room.id}
        locations={locations}
        location={editingLocation}
        defaultParentId={locationParentId}
      />

      <ConfirmDialog
        open={deleteRoomOpen}
        onOpenChange={setDeleteRoomOpen}
        title={`Delete ${room.name}?`}
        description={
          (room.recoverable_deleted_location_count ?? 0) > 0
            ? `This room has ${room.recoverable_deleted_location_count} recoverable-deleted place(s). Deleting the room keeps their audit and photos, but their item-move restoration becomes unavailable. This cannot be undone.`
            : "This room is empty and can be safely removed. This cannot be undone."
        }
        confirmLabel="Delete room"
        onConfirm={async () => {
          await deleteRoom.mutateAsync();
        }}
      />

      <RoomPropertyMoveDialog
        open={propertyMoveOpen}
        onOpenChange={setPropertyMoveOpen}
        room={room}
      />

      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ room_ids: [room.id] }}
        title={`Export ${room.name} with evidence`}
      />

      <ConfirmDialog
        open={Boolean(deletingLocation)}
        onOpenChange={(open) => {
          if (!open) setDeletingLocation(null);
        }}
        title={`Delete ${deletingLocation?.name ?? "place"}?`}
        description={
          (deletingLocation?.recoverable_deleted_child_count ?? 0) > 0
            ? `This storage place has ${deletingLocation?.recoverable_deleted_child_count} recoverable-deleted nested place(s). Deleting it leaves them without a live parent, so their item-move restoration becomes unavailable. Its own identity and photos are retained. This cannot be undone.`
            : "This storage place is empty and can be removed. Its identity and photos are retained for eligible item-move restoration. This cannot be undone."
        }
        confirmLabel="Delete place"
        onConfirm={async () => {
          if (!deletingLocation) return;
          await deleteLocation.mutateAsync(deletingLocation.id);
          if (selectedLocationId === deletingLocation.id) selectLocation(null);
          setDeletingLocation(null);
        }}
      />

      <PlaceTransferDialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        source={transferTarget?.source ?? null}
        mode={transferTarget?.mode ?? "move"}
        onCompleted={(result) => {
          if (result.deleted) {
            if (result.source_kind === "room") {
              navigate("/rooms", { replace: true });
            } else if (selectedLocationId === result.source_id) {
              selectLocation(null);
            }
          }
        }}
      />
    </div>
  );
}

function RoomDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-12 w-56" />
      <div className="mt-10 grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Skeleton className="h-72 rounded-2xl" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-60 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
