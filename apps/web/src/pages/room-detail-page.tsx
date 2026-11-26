import { useMutation } from "@tanstack/react-query";
import {
  Boxes,
  Building2,
  Camera,
  Download,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { useAddItems, useRegisterAddItemsContext } from "@/components/add-items";
import { BorrowedKeptHere } from "@/components/borrowed-kept-here";
import {
  BulkItemActionBar,
  BulkSelectButton,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityPhotoManager } from "@/components/entity-photo-manager";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { ItemCard, ItemRow } from "@/components/item-card";
import { LocationDialog } from "@/components/location-dialog";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-layout";
import {
  PlaceChipRow,
  PlaceFilterChip,
  PlaceLinkChip,
  PlaceListTools,
} from "@/components/place-chips";
import {
  PlaceTransferDialog,
  type PlaceTransferSource,
} from "@/components/place-transfer-dialog";
import { RoomDialog } from "@/components/room-dialog";
import { RoomPropertyMoveDialog } from "@/components/room-property-move-dialog";
import { StocktakeEntry } from "@/components/stocktake-entry";
import { LocationIcon, roomIcon } from "@/components/room-card";
import { useItemsView } from "@/components/view-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import {
  useCanWrite,
  useInvalidateInventory,
  useItems,
  useLocations,
  useProperties,
  useRoomPhotos,
  useRooms,
  useStocktakeScopeSummary,
} from "@/lib/queries";
import type { StorageLocation } from "@/lib/types";
import { flattenLocations, pluralize, roomPath } from "@/lib/utils";

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
  const [photoAddOpen, setPhotoAddOpen] = useState(false);
  const propertiesQuery = useProperties();
  const photosQuery = useRoomPhotos(roomId || undefined);
  const stocktakeSummary = useStocktakeScopeSummary({ roomId }, Boolean(roomId));
  const [view, setView] = useItemsView();

  const rooms = roomsQuery.data?.items ?? [];
  const room = rooms.find((entry) => entry.id === roomId);
  const childRooms = rooms.filter((entry) => entry.parent_id === roomId);
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
    onRequest: true,
  });
  useRegisterAssistantPageContext(
    selection.selectedItems.length
      ? selection.selectedItems.map((item) => ({ kind: "item", id: item.id, name: item.name }))
      : selectedLocation
        ? [{ kind: "location", id: selectedLocation.id, name: selectedLocation.name }]
        : room && !roomsQuery.isError
          ? [{ kind: "room", id: room.id, name: room.name }]
          : [],
  );
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

  if (roomsQuery.isPending) return <PageSkeleton variant="detail" />;
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

  const hasContents =
    room.total_item_count > 0 || room.total_location_count > 0 || childRooms.length > 0;
  const hasPhotos = (photosQuery.data?.items.length ?? 0) > 0;
  const stocktakeActive = Boolean(stocktakeSummary.data?.active_session);
  const propertyCount = propertiesQuery.data?.items.length ?? 0;
  // Nested or direct only matters when something can be nested here.
  const showScope =
    scope === "direct" || room.total_location_count > 0 || childRooms.length > 0;
  const locationLabel = (entry: StorageLocation) =>
    entry.identifier ? `${entry.identifier} · ${entry.name}` : entry.name;
  const openLocationDialog = (parentId?: string) => {
    setEditingLocation(undefined);
    setLocationParentId(parentId);
    setLocationDialogOpen(true);
  };
  const photoManager = (
    <EntityPhotoManager
      kind="room"
      entityId={room.id}
      name={room.name}
      addOpen={photoAddOpen}
      onAddOpenChange={setPhotoAddOpen}
    />
  );

  return (
    <div className="animate-fade-up">
      {/* A top-level room is a place in the rail, so it has no Back link. */}
      <div className="mb-2 flex items-end justify-between gap-2">
        <PageHeader
          className="mb-0 min-w-0 flex-1 sm:mb-0 [&_h1]:[overflow-wrap:anywhere]"
          eyebrow={[room.property?.name, ...path.slice(0, -1).map((entry) => entry.name)]
            .filter(Boolean)
            .join(" / ")}
          title={room.name}
          {...(parent ? { backTo: `/rooms/${parent.id}`, backLabel: parent.name } : {})}
          titleAddon={
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="room-count">
              {pluralize(room.total_item_count, "item")}
              {room.total_location_count > 0
                ? ` · ${pluralize(room.total_location_count, "place")}`
                : ""}
              {propertyCount > 1 && room.property?.name ? ` · ${room.property.name}` : ""}
            </p>
          }
        />
        <div className="flex shrink-0 items-center gap-1">
          {canWrite && items.length > 0 && <BulkSelectButton selection={selection} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Room options">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWrite && (
                <>
                  <DropdownMenuItem onSelect={() => openLocationDialog()}>
                    <Plus />
                    Add a place
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRoomEditTarget("child")}>
                    <Plus />
                    Add a sub-room
                  </DropdownMenuItem>
                  {photosQuery.isSuccess && !hasPhotos && (
                    <DropdownMenuItem onSelect={() => setPhotoAddOpen(true)}>
                      <Camera />
                      Add photo
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setRoomEditTarget("edit")}>
                    <Pencil />
                    Edit room
                  </DropdownMenuItem>
                  {hasContents && (
                    <DropdownMenuItem onSelect={moveRoomContents}>
                      <MoveRight />
                      Move contents
                    </DropdownMenuItem>
                  )}
                  {!room.parent_id && propertyCount > 1 && (
                    <DropdownMenuItem onSelect={() => setPropertyMoveOpen(true)}>
                      <Building2 />
                      Move to property
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild>
                <Link to={`/containers?room_id=${room.id}`}>
                  <Boxes />
                  Containers
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEvidenceOpen(true)}>
                <Download />
                Export evidence
              </DropdownMenuItem>
              {canWrite && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={attemptRoomDelete}>
                    <Trash2 />
                    Delete room
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {stocktakeActive && (
        <StocktakeEntry
          roomId={room.id}
          className="mb-3 rounded-xl border border-brass/25 bg-brass-soft/25 px-3 py-1"
        />
      )}

      {!hasPhotos && photoAddOpen && <div className="mb-3">{photoManager}</div>}

      {(flatLocations.length > 0 || childRooms.length > 0) && (
        <PlaceChipRow label="Places in this room" className="mb-2">
          <PlaceFilterChip
            name="All"
            count={room.total_item_count}
            active={selectedLocationId === null}
            onClick={() => selectLocation(null)}
          />
          {flatLocations.map(({ location: entry }) => (
            <PlaceFilterChip
              key={entry.id}
              name={locationLabel(entry)}
              count={entry.total_item_count}
              icon={<LocationIcon kind={entry.kind} className="size-3.5 shrink-0 opacity-70" />}
              active={selectedLocationId === entry.id}
              onClick={() => selectLocation(selectedLocationId === entry.id ? null : entry.id)}
            />
          ))}
          {childRooms.map((child) => {
            const Icon = roomIcon(child.name);
            return (
              <PlaceLinkChip
                key={child.id}
                to={`/rooms/${child.id}`}
                name={child.name}
                count={child.total_item_count}
                icon={<Icon className="size-3.5 shrink-0 opacity-70" strokeWidth={1.6} />}
              />
            );
          })}
        </PlaceChipRow>
      )}

      {selectedLocation && (
        <div
          className="mb-3 flex items-center gap-1 rounded-xl bg-secondary/55 py-0.5 pl-3 pr-1 text-xs"
          data-testid="selected-place"
        >
          <p className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Showing </span>
            <span className="font-medium">{locationLabel(selectedLocation)}</span>
          </p>
          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <Link
              to={`/containers/${selectedLocation.id}`}
              aria-label={`Open ${selectedLocation.name} page`}
            >
              Open
            </Link>
          </Button>
          {canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={`Options for ${selectedLocation.name}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setEditingLocation(selectedLocation);
                    setLocationDialogOpen(true);
                  }}
                >
                  <Pencil />
                  Edit place
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openLocationDialog(selectedLocation.id)}>
                  <Plus />
                  Add nested place
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => moveLocationContents(selectedLocation)}>
                  <MoveRight />
                  Move contents
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={() => attemptLocationDelete(selectedLocation)}
                >
                  <Trash2 />
                  Delete place
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <section aria-label={`Items in ${selectedLocation?.name ?? room.name}`} className="min-w-0">
        <PlaceListTools
          sort={sort}
          sortOptions={Object.entries(ROOM_ITEM_SORTS)}
          sortLabel="Sort items in this room or place"
          onSortChange={(value) => updateItemsParam("sort", value === "created_desc" ? "" : value)}
          search={search}
          searchLabel="Search in this room or place"
          onSearchChange={(value) => {
            setSearch(value);
            selection.clearSelection("Selection cleared because the search changed.");
          }}
          scope={scope}
          showScope={showScope}
          onScopeChange={(value) => updateItemsParam("scope", value === "direct" ? "direct" : "")}
          view={view}
          showView={items.length > 0}
          onViewChange={setView}
        />

        <BulkSelectionNotice selection={selection} />

        {items.length > 0 && selection.selecting && (
          <div className="mb-2">
            <BulkSelectionControls selection={selection} showing={items.length} total={totalItems} />
          </div>
        )}

        {/* Clear, and finishing an action, also leave selection mode. */}
        <BulkItemActionBar
          items={selection.selectedItems}
          onClear={selection.stopSelecting}
          onNotice={selection.showNotice}
        />

        {itemsQuery.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 rounded-2xl" />
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
              qParam
                ? "Nothing matches."
                : selectedLocation
                  ? scope === "direct"
                    ? "No direct items here."
                    : "Nothing here yet."
                  : scope === "direct"
                    ? "No direct items in this room."
                    : "This room is waiting."
            }
            description={
              qParam
                ? "Try a different search."
                : selectedLocation
                  ? scope === "direct"
                    ? "Nested places may still contain items. Switch to Include nested to see them."
                    : `No items are stored in ${selectedLocation.name}. Add something, or choose another place.`
                  : scope === "direct"
                    ? "Sub-rooms and nested places may still contain items. Switch to Include nested to see them."
                    : "Add the first item to this room and give it a precise place to live."
            }
            actionLabel={qParam ? undefined : "Add items"}
            onAction={qParam ? undefined : () => openAddItems(addItemsContext)}
            className="py-10"
          />
        ) : (
          <>
            {view === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3.5 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] sm:gap-4">
                {items.map((item) => (
                  <ItemCard key={item.id} item={item} origin={origin} selection={selection.itemSelection(item)} />
                ))}
              </div>
            ) : (
              <div className="surface divide-y divide-border/60 overflow-hidden p-1">
                {items.map((item) => (
                  <ItemRow key={item.id} item={item} origin={origin} selection={selection.itemSelection(item)} />
                ))}
              </div>
            )}
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
        {/* Room for the selection bar, so it never hides the end of the list. */}
        {selection.selectedItems.length > 0 && <div aria-hidden="true" className="h-24" />}
      </section>

      <section
        aria-label={`About ${room.name}`}
        className="mt-8 space-y-3 border-t border-border/60 pt-4"
      >
        {room.description && (
          <p className="max-w-2xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {room.description}
          </p>
        )}
        {hasPhotos && photoManager}
        {!stocktakeActive && <StocktakeEntry roomId={room.id} />}
        <BorrowedKeptHere roomId={room.id} />
      </section>

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
