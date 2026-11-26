import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Camera,
  Check,
  ChevronRight,
  Download,
  MapPin,
  MoreHorizontal,
  MoveRight,
  PackageOpen,
  Pencil,
  Printer,
  QrCode,
  Trash2,
  Truck,
  Unlink,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ActivityTimeline } from "@/components/activity-timeline";
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
import {
  ContainerMoveDialog,
  ContainerQrDialog,
} from "@/components/container-dialogs";
import { Disclosure } from "@/components/disclosure";
import { ContainerOwnershipDialog } from "@/components/ownership-dialogs";
import { EmptyState } from "@/components/empty-state";
import { EntityPhotoManager } from "@/components/entity-photo-manager";
import { ErrorState } from "@/components/error-state";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { ItemCard, ItemRow } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { PlaceChipRow, PlaceLinkChip, PlaceListTools } from "@/components/place-chips";
import {
  PlaceTransferDialog,
  type PlaceTransferSource,
} from "@/components/place-transfer-dialog";
import { StocktakeEntry } from "@/components/stocktake-entry";
import { PageSkeleton } from "@/components/page-layout";
import { LocationIcon } from "@/components/room-card";
import { useItemsView } from "@/components/view-toggle";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import {
  queryKeys,
  useCanWrite,
  useContainer,
  useContainerHistory,
  useInvalidateInventory,
  useItems,
  useLocationPhotos,
  useLocations,
  useRooms,
  useStocktakeScopeSummary,
} from "@/lib/queries";
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { Container, ContainerType } from "@/lib/types";
import {
  CONTAINER_TYPE_LABELS,
  formatDate,
  formatRelativeDate,
  itemContainer,
  pluralize,
} from "@/lib/utils";
import { WARRANTY_STATUS_LABELS, WARRANTY_STATUS_TONE } from "@/lib/labels";

const TYPES: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];
const ITEM_SORTS = {
  name_asc: "Name A–Z",
  created_desc: "Newest first",
  updated_desc: "Recently updated",
} as const;

export function ContainerDetailPage() {
  const canWrite = useCanWrite();
  const { containerId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const containerQuery = useContainer(containerId);
  const historyQuery = useContainerHistory(containerId);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [qrOpen, setQrOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [ownershipOpen, setOwnershipOpen] = React.useState(false);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [emptyDeleteOpen, setEmptyDeleteOpen] = React.useState(false);
  const [transferMode, setTransferMode] = React.useState<"move" | "delete" | null>(null);
  const [photoAddOpen, setPhotoAddOpen] = React.useState(false);
  const photosQuery = useLocationPhotos(containerId || undefined);
  const stocktakeSummary = useStocktakeScopeSummary({ containerId }, Boolean(containerId));
  const [view, setView] = useItemsView();
  const scope = searchParams.get("scope") === "direct" ? "direct" : "nested";
  const sort = searchParams.get("sort") === "created_desc"
    ? "created_desc"
    : searchParams.get("sort") === "updated_desc"
      ? "updated_desc"
      : "name_asc";
  const qParam = searchParams.get("q") ?? "";
  const [search, setSearch] = React.useState(qParam);
  const debouncedSearch = useDebouncedValue(search, 300);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [editType, setEditType] = React.useState<ContainerType>("box");
  const container = containerQuery.data;
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const itemsQuery = useItems(
    {
      q: qParam || undefined,
      location_id: containerId || undefined,
      include_descendants: scope === "nested",
      sort,
    },
    24,
    Boolean(containerId),
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const totalItems = itemsQuery.data?.pages[0]?.total ?? 0;
  const filterSignature = JSON.stringify([containerId, scope, qParam, sort]);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
    onRequest: true,
  });
  useRegisterAssistantPageContext(
    selection.selectedItems.length
      ? selection.selectedItems.map((item) => ({ kind: "item", id: item.id, name: item.name }))
      : container && !containerQuery.isError
        ? [{ kind: "location", id: container.id, name: container.name }]
        : [],
  );
  const origin = itemOrigin(
    `${location.pathname}${location.search}`,
    container?.identifier ?? container?.name ?? "container",
  );
  useRestoreListScroll(items.length > 0, origin);
  const transferSource: PlaceTransferSource | null = container
    ? {
        kind: "location",
        id: container.id,
        label: container.identifier ?? container.name,
        roomId: container.room_id,
        propertyId: container.property?.id ?? "",
      }
    : null;
  const { openAddItems } = useAddItems();
  const addItemsContext = React.useMemo(
    () =>
      container
        ? {
            propertyId: container.property?.id,
            roomId: container.room_id,
            locationId: container.id,
            roomName: container.room.name,
            locationName: container.identifier ?? container.name,
          }
        : undefined,
    [container],
  );
  useRegisterAddItemsContext(addItemsContext ?? null);

  React.useEffect(() => {
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

  React.useEffect(() => {
    if (!container) return;
    setEditName(container.name);
    setEditDescription(container.description ?? "");
    setEditType(container.container_type ?? "box");
  }, [container]);

  const refreshContainer = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.container(containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
  };

  const update = useMutation({
    mutationFn: () =>
      api.patch<Container>(`/containers/${containerId}`, {
        name: editName.trim() || null,
        description: editDescription.trim() || null,
        container_type: container?.is_container ? editType : undefined,
      }),
    onSuccess: () => {
      refreshContainer();
      invalidate();
      setEditOpen(false);
      toast.success("Container updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const deleteEmpty = useMutation({
    mutationFn: () => api.delete<void>(`/containers/${containerId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Container deleted");
      navigate("/containers", { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "location_not_empty") {
        setEmptyDeleteOpen(false);
        setTransferMode("delete");
        return;
      }
      toast.error(getApiErrorMessage(error));
    },
  });

  const unlinkOwnership = useMutation({
    mutationFn: () => api.delete<Container>(`/containers/${containerId}/ownership`),
    onSuccess: () => {
      refreshContainer();
      invalidate();
      setUnlinkOpen(false);
      toast.success("Ownership unlinked; the container remains a storage place");
    },
    onError: (error) => {
      setUnlinkOpen(false);
      toast.error(getApiErrorMessage(error));
    },
  });

  if (containerQuery.isPending) return <PageSkeleton variant="detail" />;
  if (containerQuery.isError) {
    return (
      <ErrorState
        title="This container is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void containerQuery.refetch()}
      />
    );
  }
  const detail = containerQuery.data;
  const identifier = detail.identifier ?? detail.name;
  const roomLabel = detail.room.name;
  const ancestors = detail.path.slice(0, -1);
  const insideLabel = ancestors.map((entry) => entry.name).join(" / ");
  const parentPlace = ancestors[ancestors.length - 1];
  const hasContents = detail.total_item_count > 0 || detail.child_count > 0;
  const hasPhotos = (photosQuery.data?.items.length ?? 0) > 0;
  const stocktakeActive = Boolean(stocktakeSummary.data?.active_session);
  // Nested or direct only matters when this place holds other places.
  const showScope = scope === "direct" || detail.child_count > 0;
  const updateParam = (key: string, value: string, reason: string) => {
    selection.clearSelection(`Selection cleared because the ${reason} changed.`);
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
  const photoManager = (
    <EntityPhotoManager
      kind="location"
      entityId={detail.id}
      name={identifier}
      addOpen={photoAddOpen}
      onAddOpenChange={setPhotoAddOpen}
    />
  );

  return (
    <div className="animate-fade-up">
      <div className="mb-2 flex items-end justify-between gap-2">
        <PageHeader
          className="mb-0 min-w-0 flex-1 sm:mb-0 [&_h1]:[overflow-wrap:anywhere]"
          eyebrow={detail.is_container ? "Container" : "Storage place"}
          title={identifier}
          backTo={
            detail.parent_id ? `/containers/${detail.parent_id}` : `/rooms/${detail.room_id}`
          }
          backLabel={
            detail.parent_id
              ? (parentPlace?.identifier ?? parentPlace?.name ?? "Back")
              : roomLabel
          }
          titleAddon={
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="container-count">
              {detail.name !== identifier ? `${detail.name} · ` : ""}
              {pluralize(detail.total_item_count, "item")}
              {detail.child_count > 0
                ? ` · ${pluralize(detail.child_count, "nested place")}`
                : ""}
            </p>
          }
        />
        <div className="flex shrink-0 items-center gap-1">
          {canWrite && items.length > 0 && <BulkSelectButton selection={selection} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="Container options"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWrite && (
                <>
                  <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                  {photosQuery.isSuccess && !hasPhotos && (
                    <DropdownMenuItem onSelect={() => setPhotoAddOpen(true)}>
                      <Camera />
                      Add photo
                    </DropdownMenuItem>
                  )}
                  {detail.is_container && !detail.owner_item && (
                    <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                      <Truck />
                      Move container
                    </DropdownMenuItem>
                  )}
                  {hasContents && (
                    <DropdownMenuItem onSelect={() => setTransferMode("move")}>
                      <MoveRight />
                      Move contents
                    </DropdownMenuItem>
                  )}
                  {detail.owner_item ? (
                    <DropdownMenuItem onSelect={() => setUnlinkOpen(true)}>
                      <Unlink />
                      Unlink owned item
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => setOwnershipOpen(true)}>
                      <PackageOpen />
                      Add ownership details
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => setQrOpen(true)}>
                <QrCode />
                QR code
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem asChild>
                  <Link to={`/labels?ids=${detail.id}`}>
                    <Printer />
                    Print label
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setEvidenceOpen(true)}>
                <Download />
                Export evidence
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/containers">
                  <Boxes />
                  All containers
                </Link>
              </DropdownMenuItem>
              {canWrite && !detail.owner_item && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    destructive
                    onSelect={() => {
                      if (hasContents) setTransferMode("delete");
                      else setEmptyDeleteOpen(true);
                    }}
                  >
                    <Trash2 />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {stocktakeActive && (
        <StocktakeEntry
          containerId={detail.id}
          className="mb-3 rounded-xl border border-brass/25 bg-brass-soft/25 px-3 py-1"
        />
      )}

      {!hasPhotos && photoAddOpen && <div className="mb-3">{photoManager}</div>}

      {detail.children.length > 0 && (
        <PlaceChipRow label="Nested places" className="mb-2">
          {detail.children.map((child) => (
            <PlaceLinkChip
              key={child.id}
              to={`/containers/${child.id}`}
              name={child.identifier ? `${child.identifier} · ${child.name}` : child.name}
              count={child.total_item_count}
              icon={<LocationIcon kind={child.kind} className="size-3.5 shrink-0 opacity-70" />}
            />
          ))}
        </PlaceChipRow>
      )}

      <section aria-label={`Inside ${identifier}`} className="min-w-0">
        <PlaceListTools
          sort={sort}
          sortOptions={Object.entries(ITEM_SORTS)}
          sortLabel="Sort items inside this place"
          onSortChange={(value) => updateParam("sort", value === "name_asc" ? "" : value, "sort")}
          search={search}
          searchLabel="Search inside this place"
          onSearchChange={(value) => {
            setSearch(value);
            selection.clearSelection("Selection cleared because the search changed.");
          }}
          scope={scope}
          showScope={showScope}
          onScopeChange={(value) => updateParam("scope", value === "direct" ? "direct" : "", "scope")}
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
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        ) : itemsQuery.isError ? (
          <ErrorState
            message="We couldn't load the items in this place."
            onRetry={() => void itemsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={
              qParam
                ? "Nothing matches."
                : scope === "direct"
                  ? "No direct items here."
                  : "This container is empty."
            }
            description={
              qParam
                ? "Try a different search."
                : scope === "direct"
                  ? "Nested places may still contain items. Switch to Include nested to see them."
                  : "Add an item and assign it here, or move an existing item into this place."
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
                  <div key={item.id} className="min-w-0">
                    <ItemCard item={item} origin={origin} selection={selection.itemSelection(item)} />
                    {scope === "nested" &&
                      item.location?.id !== detail.id &&
                      item.location && (
                        <p className="mt-1.5 flex items-center gap-1 px-1 text-2xs text-muted-foreground">
                          <MapPin className="size-3" />
                          {itemContainer(item)?.identifier ?? item.location.name}
                        </p>
                      )}
                  </div>
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
        aria-label={`About ${identifier}`}
        className="mt-8 space-y-3 border-t border-border/60 pt-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={detail.is_container ? "sage" : "outline"}>
            {detail.is_container
              ? CONTAINER_TYPE_LABELS[detail.container_type ?? "other"]
              : "Fixed place"}
          </Badge>
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="size-3.5" aria-hidden="true" />
            {detail.property && (
              <>
                <span className="font-medium text-foreground/80">{detail.property.name}</span>
                <ChevronRight className="size-3" aria-hidden="true" />
              </>
            )}
            <Link
              to={`/rooms/${detail.room_id}`}
              className="font-medium text-foreground/80 underline-offset-4 hover:underline"
            >
              {roomLabel}
            </Link>
            {insideLabel && (
              <>
                <ChevronRight className="size-3" aria-hidden="true" />
                <span>{insideLabel}</span>
              </>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setQrOpen(true)}
          >
            <QrCode />
            QR
          </Button>
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground" data-testid="container-summary">
          {pluralize(detail.summary.item_count, "item")} · {detail.summary.total_quantity} units
          total · {pluralize(detail.summary.direct_item_count, "item")} ·{" "}
          {detail.summary.direct_total_quantity} directly here · updated{" "}
          {formatRelativeDate(detail.updated_at)}
          {detail.label_generated_at
            ? ` · label generated ${formatDate(detail.label_generated_at)}`
            : ""}
        </p>
        {detail.summary.categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.summary.categories.slice(0, 6).map((category) => (
              <Badge key={category.name} variant="outline">
                {category.name} · {category.item_count}
              </Badge>
            ))}
          </div>
        )}
        {detail.description && (
          <p className="max-w-3xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {detail.description}
          </p>
        )}
        {detail.owner_item && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <PackageOpen className="size-3.5" aria-hidden="true" />
            Owned item:
            <Link
              to={`/items/${detail.owner_item.id}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {detail.owner_item.name}
            </Link>
            {detail.owner_item_detail?.purchase && (
              <Badge variant="outline">Purchase recorded</Badge>
            )}
            {detail.owner_item_detail?.warranty && (
              <Badge variant={WARRANTY_STATUS_TONE[detail.owner_item_detail.warranty.status]}>
                {WARRANTY_STATUS_LABELS[detail.owner_item_detail.warranty.status]}
              </Badge>
            )}
          </p>
        )}
        {hasPhotos && photoManager}
        {!stocktakeActive && <StocktakeEntry containerId={detail.id} />}
        <BorrowedKeptHere locationId={detail.id} />

        {detail.documents.length > 0 && (
          <div>
            <h2 className="text-sm font-medium">Related documents</h2>
            <ul className="mt-1 divide-y divide-border/60">
              {detail.documents.map((document) => (
                <li key={document.id}>
                  <Link
                    to={`/documents/${document.id}`}
                    className="flex min-h-11 items-center justify-between gap-3 py-1.5 text-xs transition-colors hover:text-foreground"
                  >
                    <span className="min-w-0 truncate">{document.title}</span>
                    <Badge variant="outline" className="shrink-0">
                      {document.document_type.replace("_", " ")}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Disclosure
          label="Movement history"
          buttonClassName="text-sm text-foreground"
          contentClassName="pt-1"
        >
          <p className="text-2xs leading-relaxed text-muted-foreground">
            A container move covers everything inside it. The items do not get their own move
            entries.
          </p>
          <div className="mt-3">
            <ActivityTimeline
              events={historyQuery.data?.items ?? []}
              emptyText="No container moves recorded yet."
              onChanged={() => {
                void historyQuery.refetch();
                refreshContainer();
              }}
            />
          </div>
        </Disclosure>
      </section>

      <ContainerQrDialog container={detail} open={qrOpen} onOpenChange={setQrOpen} />
      <ContainerOwnershipDialog
        container={detail}
        open={ownershipOpen}
        onOpenChange={setOwnershipOpen}
        onLinked={() => refreshContainer()}
      />
      {detail.is_container && (
        <ContainerMoveDialog
          container={detail}
          open={moveOpen}
          onOpenChange={setMoveOpen}
          rooms={rooms}
          locations={locations}
          onMoved={() => refreshContainer()}
        />
      )}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {identifier}</DialogTitle>
            <DialogDescription>
              The identifier never changes. Moving is separate so its QR code and contents
              stay authoritative.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="container-edit-name" className="text-xs font-medium">
                  Display name
                </label>
                <Input
                  id="container-edit-name"
                  value={editName}
                  maxLength={120}
                  onChange={(event) => setEditName(event.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <label htmlFor="container-edit-type" className="text-xs font-medium">
                  Type
                </label>
                <Select
                  id="container-edit-type"
                  value={editType}
                  disabled={!detail.is_container}
                  onChange={(event) => setEditType(event.target.value as ContainerType)}
                  className="mt-1.5"
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CONTAINER_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <label htmlFor="container-edit-notes" className="text-xs font-medium">
                Notes
              </label>
              <Textarea
                id="container-edit-notes"
                value={editDescription}
                maxLength={4000}
                onChange={(event) => setEditDescription(event.target.value)}
                className="mt-1.5 min-h-28"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? <Spinner /> : <Check />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ container_ids: [detail.id] }}
        title={`Export ${identifier} with evidence`}
      />

      <ConfirmDialog
        open={unlinkOpen}
        onOpenChange={setUnlinkOpen}
        title={`Unlink ownership from ${identifier}?`}
        description="The container and its contents stay unchanged. The owned item remains in inventory at its current place. Open loans must be returned first."
        confirmLabel="Unlink ownership"
        onConfirm={async () => {
          await unlinkOwnership.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={emptyDeleteOpen}
        onOpenChange={setEmptyDeleteOpen}
        title={`Delete ${identifier}?`}
        description={
          (detail.recoverable_deleted_child_count ?? 0) > 0
            ? `This place has ${detail.recoverable_deleted_child_count} recoverable-deleted nested place(s). Deleting it leaves them without a live parent, so their item-move restoration becomes unavailable. Its own identity and photos are retained. This cannot be undone.`
            : "This place is empty and can be removed. Its identity and photos are retained for eligible item-move restoration. This cannot be undone."
        }
        confirmLabel="Delete place"
        onConfirm={async () => {
          await deleteEmpty.mutateAsync();
        }}
      />

      <PlaceTransferDialog
        open={transferMode !== null}
        onOpenChange={(open) => {
          if (!open) setTransferMode(null);
        }}
        source={transferSource}
        mode={transferMode ?? "move"}
        onCompleted={(result) => {
          if (result.deleted) {
            navigate("/containers", { replace: true });
          } else {
            refreshContainer();
          }
        }}
      />
    </div>
  );
}
